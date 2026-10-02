import { describe, expect, test } from 'bun:test';
import { address, generateKeyPairSigner, getBase64Decoder } from '@solana/kit';
import { getInvestInstruction, getPositionEncoder, getPositionSize, positionPda, rpcPort, tablePositions, USD } from '../src';
import { createTestTable, tokenOf } from '../src/testing';
import { findAssociatedTokenPda, getTokenDecoder, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import {
  applyBuybackIx, cancelBuybackIx, executeWithdrawalIx, getPositionDecoder, getTableDecoder, investIx, ProgramError,
  acceptOwnerIx, applyDealerIx, proposeBuybackIxs, proposeDealerIx, proposeOwnerIx, requestWithdrawalIx, setBankLimitIx, setLibraryIx, setPausedIx,
} from '../src';
import type { TestTable } from '../src/testing';

const tableOf = async (t: TestTable) => getTableDecoder().decode((await t.port.account(t.table))!);
const code = async (p: Promise<unknown>) => p.then(() => null, (e) => (e as ProgramError).code);

describe('a table’s investors', () => {
  test('every position of this table, the seed investment included; none for another table', async () => {
    const t = await createTestTable();
    const a = await t.port.signer();
    const token = await tokenOf(t, a.address, 500n);
    await t.port.send(a, [getInvestInstruction({ investor: a, table: t.table, mint: t.mint, vault: t.vault, investorToken: token, position: await positionPda(t.table, a.address), amount: 250n * USD })]);
    const list = await tablePositions(t.port, t.table);
    expect(list.map((p) => [p.position.investor, p.position.invested]).sort()).toEqual([[a.address, 250n * USD], [t.owner.address, 1_000_000n * USD]].sort());
    expect(await tablePositions(t.port, (await generateKeyPairSigner()).address)).toEqual([]);
  });

  test('over RPC: one getProgramAccounts call filtered by the position size and the table address at byte 8', async () => {
    const table = (await generateKeyPairSigner()).address, investor = (await generateKeyPairSigner()).address;
    const data = new Uint8Array(getPositionEncoder().encode({ table, investor, shares: 7n, pendingShares: 0n, unlockAt: 0n, invested: 7n, withdrawn: 0n, joinedAt: 1n, bump: 255 }));
    let asked: any = null;
    const server = Bun.serve({ port: 0, async fetch(req) {
      const body = await req.json() as any;
      asked = body;
      return Response.json({ jsonrpc: '2.0', id: body.id, result: [{ pubkey: investor, account: { data: [getBase64Decoder().decode(data), 'base64'], executable: false, lamports: 1, owner: table, rentEpoch: 0, space: data.length } }] });
    } });
    try {
      const list = await tablePositions(rpcPort(`http://127.0.0.1:${server.port}`), table);
      expect(asked.method).toBe('getProgramAccounts');
      expect(asked.params[1].filters).toEqual([{ dataSize: getPositionSize() }, { memcmp: { offset: 8, bytes: table, encoding: 'base58' } }]);
      expect(list).toEqual([{ address: investor, position: expect.objectContaining({ table, investor, shares: 7n }) }]);
    } finally { server.stop(true); }
  });
});

describe('an investor from the Bank page', () => {
  test('invests $100 (not $99.99), asks to withdraw, and is paid after 24 hours', async () => {
    const t = await createTestTable(), ref = { table: t.table, mint: t.mint };
    const a = await t.port.signer();
    const token = await tokenOf(t, a.address, 300n);
    expect(await code(t.port.send(a, [await investIx(ref, a, 99_990_000n)]))).toBe(6042);
    await t.port.send(a, [await investIx(ref, a, 100n * USD)]);
    const pos = getPositionDecoder().decode((await t.port.account(await positionPda(t.table, a.address)))!);
    expect([pos.shares, pos.invested]).toEqual([100n * USD, 100n * USD]);
    await t.port.send(a, [await requestWithdrawalIx(ref, a, pos.shares)]);
    expect(await code(t.port.send(a, [await executeWithdrawalIx(ref, a)]))).toBe(6031);
    t.port.wait(24 * 3600);
    await t.port.send(a, [await executeWithdrawalIx(ref, a)]);
    expect(getTokenDecoder().decode((await t.port.account(token))!).amount).toBe(300n * USD);
  });
});

describe('the owner from the Owner page', () => {
  test('pauses and resumes, sets the bank limit, names a new dealer (due 25 hours later) and a new owner (who accepts)', async () => {
    const t = await createTestTable(), ref = { table: t.table, mint: t.mint };
    await t.port.send(t.owner, [setPausedIx(ref, t.owner, true)]);
    expect((await tableOf(t)).paused).toBe(true);
    await t.port.send(t.owner, [setPausedIx(ref, t.owner, false), setBankLimitIx(ref, t.owner, 150)]);
    expect([(await tableOf(t)).paused, (await tableOf(t)).bankLimitBps]).toEqual([false, 150]);
    const dealer = await t.port.signer(), owner = await t.port.signer();
    await t.port.send(t.owner, [proposeDealerIx(ref, t.owner, dealer.address), proposeOwnerIx(ref, t.owner, owner.address)]);
    expect(await code(t.port.send(t.dealer, [applyDealerIx(ref)]))).not.toBeNull();   // not due yet
    t.port.wait(25 * 3600);                                                // both are due now
    await t.port.send(t.dealer, [applyDealerIx(ref)]);
    await t.port.send(owner, [acceptOwnerIx(ref, owner)]);
    expect(await tableOf(t)).toMatchObject({ dealer: dealer.address, owner: owner.address });
  });

  test('the owner names a new set of spins between rounds; nobody else can', async () => {
    const t = await createTestTable({ throwCount: 299 }), ref = { table: t.table, mint: t.mint };
    const hash = new Uint8Array(32).fill(7);
    const stranger = await t.port.signer();
    expect(await code(t.port.send(stranger, [setLibraryIx(ref, stranger, hash, 300)]))).not.toBeNull();
    await t.port.send(t.owner, [setLibraryIx(ref, t.owner, hash, 300)]);
    const after = await tableOf(t);
    expect(after.libraryHash).toEqual(hash); expect(after.throwCount).toBe(300);
  });

  test('proposes a new buyback wallet (its USDC account is made if missing), cancels, proposes again, and anyone applies it after 7 days', async () => {
    const t = await createTestTable(), ref = { table: t.table, mint: t.mint };
    const fresh = (await generateKeyPairSigner()).address;
    const [token] = await findAssociatedTokenPda({ owner: fresh, mint: t.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    await t.port.send(t.owner, await proposeBuybackIxs(ref, t.owner, fresh));
    expect((await tableOf(t)).pendingBuybackToken).toBe(token);
    await t.port.send(t.owner, [cancelBuybackIx(ref, t.owner, t.buybackToken)]);
    expect((await tableOf(t)).pendingBuybackToken).toBe(address('11111111111111111111111111111111'));
    await t.port.send(t.owner, await proposeBuybackIxs(ref, t.owner, fresh));      // the account exists now: made only once
    const anyone = await t.port.signer();
    expect(await code(t.port.send(anyone, [applyBuybackIx(ref)]))).toBe(6043);
    t.port.wait(7 * 24 * 3600);
    await t.port.send(anyone, [applyBuybackIx(ref)]);
    expect((await tableOf(t)).buybackToken).toBe(token);
  });

  test('another wallet is refused every owner action', async () => {
    const t = await createTestTable(), ref = { table: t.table, mint: t.mint };
    const x = await t.port.signer();
    expect(await code(t.port.send(x, [setPausedIx(ref, x, true)]))).toBe(6001);
    expect(await code(t.port.send(x, [setBankLimitIx(ref, x, 150)]))).toBe(6001);
  });
});

describe('final review fixes', () => {
  test('I4: a port that gives up on 429 (for the Bank page) answers at once instead of retrying forever', async () => {
    let asked = 0;
    const server = Bun.serve({ port: 0, fetch() { asked++; return new Response('Too Many Requests', { status: 429 }); } });
    try {
      const t0 = Date.now();
      const table = (await generateKeyPairSigner()).address;
      expect(await rpcPort(`http://127.0.0.1:${server.port}`, { retry429: false }).account(table).then(() => 'answered', () => 'refused')).toBe('refused');
      expect(Date.now() - t0).toBeLessThan(1_000);
      expect(asked).toBe(1);
    } finally { server.stop(true); }
  });
});
