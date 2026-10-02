import { describe, expect, test } from 'bun:test';
import { getMintToInstruction } from '@solana-program/token';
import {
  ROULETTE_ERROR__BANK_LIMIT_OUT_OF_RANGE, ROULETTE_ERROR__BELOW_MINIMUM, ROULETTE_ERROR__FEE_ABOVE_CAP, ROULETTE_ERROR__INSUFFICIENT_SHARES, ROULETTE_ERROR__NOTICE_NOT_PASSED,
  ROULETTE_ERROR__NOT_OWNER, ROULETTE_ERROR__NO_SHARES, ROULETTE_ERROR__NO_THROWS, ROULETTE_ERROR__ZERO_AMOUNT, getDepositInstruction,
  getPositionDecoder, getSafeDecoder, getSetBankLimitInstruction, getProposeDealerInstruction, getSetFeeInstruction, getSetLibraryInstruction,
  getProposeOwnerInstruction, getAcceptOwnerInstruction, getSetPausedInstruction, getTableDecoder, getInvestInstruction, positionPda, safePda,
} from '../src';
import { World, usd } from './harness';

describe('the bank pool', () => {
  test('an investment is at least $100; positions count what was put in and taken out, and when the investor joined', async () => {
    const w = await World.create();
    const a = await w.wallet(10_000);
    const position = await positionPda(w.table, a.signer.address);
    await w.chain.fails(w.chain.send(a.signer, [getInvestInstruction({
      investor: a.signer, table: w.table, mint: w.mint, vault: w.vault, investorToken: a.token, position, amount: usd(100) - 1n,
    })]), ROULETTE_ERROR__BELOW_MINIMUM);
    const joined = w.now();
    await w.invest(a, 100);
    w.setTime(joined + 3_600n);
    await w.invest(a, 250);
    let p = w.read(position, getPositionDecoder());
    expect([p.table, p.investor, p.invested, p.withdrawn, p.joinedAt]).toEqual([w.table, a.signer.address, usd(350), 0n, joined]);
    await w.requestWithdrawal(a, p.shares);
    w.setTime(joined + 3_600n + 24n * 3600n);
    const before = w.tokenBalance(a.token);
    await w.executeWithdrawal(a);
    p = w.read(position, getPositionDecoder());
    expect(p.withdrawn).toBe(w.tokenBalance(a.token) - before);
    expect(p.withdrawn).toBe(usd(350));
  });

  test('investors get shares in proportion to what they put in', async () => {
    const w = await World.create();
    const a = await w.wallet(10_000), b = await w.wallet(10_000);
    const pa = await w.invest(a, 6_000), pb = await w.invest(b, 2_000);
    expect(w.read(pa, getPositionDecoder())).toMatchObject({ investor: a.signer.address, shares: usd(6_000), pendingShares: 0n });
    expect(w.read(pb, getPositionDecoder()).shares).toBe(usd(2_000));
    expect(w.read(w.table, getTableDecoder())).toMatchObject({ pool: usd(8_000), totalShares: usd(8_000) });
    expect(w.tokenBalance(w.vault)).toBe(usd(8_000));
    expect(w.tokenBalance(a.token)).toBe(usd(4_000));
    await w.chain.fails(w.invest(a, 0), ROULETTE_ERROR__ZERO_AMOUNT);
  });

  test('withdrawing needs 24 hours\' notice, then pays the shares\' value at that moment', async () => {
    const w = await World.create();
    const a = await w.wallet(5_000);
    const pos = await w.invest(a, 5_000);
    await w.chain.fails(w.requestWithdrawal(a, usd(5_001)), ROULETTE_ERROR__INSUFFICIENT_SHARES);
    await w.chain.fails(w.requestWithdrawal(a, 0n), ROULETTE_ERROR__ZERO_AMOUNT);
    await w.chain.fails(w.executeWithdrawal(a), ROULETTE_ERROR__NO_SHARES);
    await w.requestWithdrawal(a, usd(2_000));
    await w.chain.fails(w.requestWithdrawal(a, usd(3_001)), ROULETTE_ERROR__INSUFFICIENT_SHARES);   // pending counts
    await w.chain.fails(w.executeWithdrawal(a), ROULETTE_ERROR__NOTICE_NOT_PASSED);
    w.setTime(w.now() + 24n * 3600n - 1n);
    await w.chain.fails(w.executeWithdrawal(a), ROULETTE_ERROR__NOTICE_NOT_PASSED);
    w.setTime(w.now() + 1n);
    await w.executeWithdrawal(a);
    expect(w.tokenBalance(a.token)).toBe(usd(2_000));
    expect(w.read(pos, getPositionDecoder())).toMatchObject({ shares: usd(3_000), pendingShares: 0n });
    expect(w.read(w.table, getTableDecoder())).toMatchObject({ pool: usd(3_000), totalShares: usd(3_000) });
    expect(w.tokenBalance(w.vault)).toBe(usd(3_000));
  });

  test('nobody can request or take another investor\'s shares', async () => {
    const w = await World.create();
    const a = await w.wallet(1_000), thief = await w.wallet(0);
    await w.invest(a, 1_000);
    await w.invest(thief, 0).catch(() => {});                           // (zero is refused; the thief has no position)
    await expect(w.requestWithdrawal(thief, 1n)).rejects.toThrow();
    expect(w.tokenBalance(w.vault)).toBe(usd(1_000));
  });

  test('the largest possible amounts are counted exactly, never wrapped around (Review Focus 5)', async () => {
    const w = await World.create();
    const a = await w.wallet(0), b = await w.wallet(0);
    const half = 2n ** 63n;
    await w.chain.send(w.owner, [getMintToInstruction({ mint: w.mint, token: a.token, mintAuthority: w.owner, amount: half })]);
    await w.chain.send(w.owner, [getMintToInstruction({ mint: w.mint, token: b.token, mintAuthority: w.owner, amount: half - 1n })]);
    for (const p of [a, b]) {
      const amount = w.tokenBalance(p.token);
      await w.chain.send(p.signer, [getDepositInstruction({ wallet: p.signer, table: w.table, mint: w.mint, vault: w.vault, walletToken: p.token, safe: await safePda(w.table, p.signer.address), amount })]);
    }
    expect(w.read(w.table, getTableDecoder()).safesTotal).toBe(2n ** 64n - 1n);
    expect(w.read(await safePda(w.table, a.signer.address), getSafeDecoder()).balance).toBe(half);
  });
});

describe('the owner\'s controls', () => {
  test('only the owner changes the fee, the bank limit, the library, pauses or names a dealer — never beyond the caps', async () => {
    const w = await World.create();
    const stranger = await w.chain.signer();
    const as = (who: typeof stranger) => ({ owner: who, table: w.table });
    await w.chain.fails(w.chain.send(stranger, [getSetFeeInstruction({ ...as(stranger), bps: 10 })]), ROULETTE_ERROR__NOT_OWNER);
    await w.chain.fails(w.chain.send(stranger, [getSetPausedInstruction({ ...as(stranger), paused: true })]), ROULETTE_ERROR__NOT_OWNER);
    await w.chain.fails(w.chain.send(w.owner, [getSetFeeInstruction({ ...as(w.owner), bps: 101 })]), ROULETTE_ERROR__FEE_ABOVE_CAP);
    await w.chain.fails(w.chain.send(w.owner, [getSetBankLimitInstruction({ ...as(w.owner), bps: 201 })]), ROULETTE_ERROR__BANK_LIMIT_OUT_OF_RANGE);
    await w.chain.fails(w.chain.send(w.owner, [getSetBankLimitInstruction({ ...as(w.owner), bps: 49 })]), ROULETTE_ERROR__BANK_LIMIT_OUT_OF_RANGE);
    await w.chain.fails(w.chain.send(w.owner, [getSetLibraryInstruction({ ...as(w.owner), hash: new Uint8Array(32), throwCount: 0 })]), ROULETTE_ERROR__NO_THROWS);
    await w.chain.send(w.owner, [
      getSetFeeInstruction({ ...as(w.owner), bps: 100 }),
      getSetBankLimitInstruction({ ...as(w.owner), bps: 200 }),
      getSetPausedInstruction({ ...as(w.owner), paused: true }),
      getProposeDealerInstruction({ ...as(w.owner), dealer: stranger.address }),
      getSetLibraryInstruction({ ...as(w.owner), hash: new Uint8Array(32).fill(1), throwCount: 42 }),
    ]);
    expect(w.read(w.table, getTableDecoder())).toMatchObject({ feeBps: 100, bankLimitBps: 200, paused: true, dealer: w.dealer.address, pendingDealer: stranger.address, throwCount: 42 });
    expect(w.read(w.table, getTableDecoder()).libraryHash).toEqual(new Uint8Array(32).fill(1));
  });

  test('the owner can hand the table to another wallet, which then owns it alone once it accepts', async () => {
    const w = await World.create();
    const next = await w.chain.signer();
    await w.chain.send(w.owner, [getProposeOwnerInstruction({ owner: w.owner, table: w.table, newOwner: next.address })]);
    w.setTime(w.now() + 25n * 3600n);
    await w.chain.send(next, [getAcceptOwnerInstruction({ newOwner: next, table: w.table })]);
    await w.chain.fails(w.chain.send(w.owner, [getSetFeeInstruction({ owner: w.owner, table: w.table, bps: 10 })]), ROULETTE_ERROR__NOT_OWNER);
    await w.chain.send(next, [getSetFeeInstruction({ owner: next, table: w.table, bps: 10 })]);
    expect(w.read(w.table, getTableDecoder())).toMatchObject({ owner: next.address, feeBps: 10 });
  });
});
