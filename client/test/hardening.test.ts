// The self-audit's fixes (2026-09-30): each test is a way the table could be misused before 0.4.0.
import { describe, expect, test } from 'bun:test';
import {
  ROULETTE_ERROR__BANK_LIMIT_OUT_OF_RANGE, ROULETTE_ERROR__BELOW_MINIMUM, ROULETTE_ERROR__NO_PENDING_CHANGE, ROULETTE_ERROR__NOT_DEALER,
  ROULETTE_ERROR__NOT_OWNER, ROULETTE_ERROR__NOT_PENDING_OWNER, ROULETTE_ERROR__NOT_UPGRADE_AUTHORITY, ROULETTE_ERROR__REVEAL_WINDOW_PASSED,
  ROULETTE_ERROR__ROUND_RUNNING, ROULETTE_ERROR__TOO_EARLY_TO_CHANGE, ROULETTE_ERROR__TOO_EARLY_TO_RESUME, getPositionDecoder, getRoundDecoder,
  getSetBankLimitInstruction, getTableDecoder,
} from '../src';
import { generateKeyPairSigner, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { World, hashFor, usd } from './harness';
import { UPGRADEABLE_LOADER, getInitTableInstruction } from '../src';

const PROGRAM_SO = new URL('../../program/target/deploy/roulette.so', import.meta.url).pathname;

const HOUR = 3600n;
/** state.rs EXIT_WINDOW_SECS: longer than an investor's 24-hour notice. */
const EXIT_WINDOW = 25n * HOUR;

describe('setting up a table', () => {
  test('only the program\'s upgrade authority may, for any mint (real USDC\'s mint authority is Circle, not us)', async () => {
    const w = await World.bare({ mintAuthority: 'stranger' });
    const mintAuthority = w.mintAuthority;
    await w.chain.fails(w.initTable({}, mintAuthority), ROULETTE_ERROR__NOT_UPGRADE_AUTHORITY);
    await w.chain.fails(w.initTable({}, await w.chain.signer()), ROULETTE_ERROR__NOT_UPGRADE_AUTHORITY);
    await w.initTable();                                                    // the owner holds the upgrade key here
    expect(w.read(w.table, getTableDecoder())).toMatchObject({ owner: w.owner.address, mint: w.mint });
  });

  test('another program\'s upgrade record (naming the attacker) does not count: it must be this program\'s', async () => {
    const w = await World.bare();
    const attacker = await w.chain.signer();
    const other = (await generateKeyPairSigner()).address;                  // a program the attacker deployed, same code
    w.chain.svm.addProgramWithLoader(other, new Uint8Array(await Bun.file(PROGRAM_SO).arrayBuffer()), UPGRADEABLE_LOADER);
    const [otherData] = await getProgramDerivedAddress({ programAddress: UPGRADEABLE_LOADER, seeds: [getAddressEncoder().encode(other)] });
    const a = w.chain.svm.getAccount(otherData);
    if (!a.exists) throw new Error('no program data');
    const data = new Uint8Array(a.data);
    data[12] = 1;
    data.set(getAddressEncoder().encode(attacker.address), 13);
    w.chain.svm.setAccount({ ...a, data });
    const buyback = await w.tokenAccount(attacker.address);
    await w.chain.fails(w.chain.send(attacker, [getInitTableInstruction({
      payer: attacker, programData: otherData, mint: w.mint, table: w.table, vault: w.vault, buybackToken: buyback, owner: attacker.address,
      dealer: attacker.address, feeBps: 100, bankLimitBps: 200, libraryHash: new Uint8Array(32), throwCount: 1,
    })]), ROULETTE_ERROR__NOT_UPGRADE_AUTHORITY);
  });
});

describe('bets', () => {
  test('come only through the table: the dealer pays for them (a player cannot slip bets past the server)', async () => {
    const w = await World.create();
    await w.invest(await w.wallet(100_000), 100_000);
    const { p, key } = await w.seated();
    const { round } = await w.openRound();
    await w.chain.fails(w.placeBets(p, key, round, [['red', 10]], p.signer), ROULETTE_ERROR__NOT_DEALER);
    await w.placeBets(p, key, round, [['red', 10]]);
  });
});

async function lockedRound() {
  const w = await World.create();
  await w.invest(await w.wallet(1_000_000), 1_000_000);
  const { p, key } = await w.seated();
  const { round } = await w.openRound();
  await w.placeBets(p, key, round, [['red', 10]]);
  await w.lock(round);
  const r = w.read(round, getRoundDecoder());
  w.entropy(round, hashFor(1, w.seeds.get(round)!, r.id));
  return { w, round, lockedAt: r.lockedAt };
}

describe('a round not revealed within 2 minutes', () => {
  test('can no longer be revealed, only cancelled: nobody who sees a late reveal can choose between the two', async () => {
    const early = await lockedRound();
    early.w.setTime(early.lockedAt + 119n);
    await early.w.reveal(early.round);                                      // in time: the number counts
    const late = await lockedRound();
    late.w.setTime(late.lockedAt + 120n);
    await late.w.chain.fails(late.w.reveal(late.round), ROULETTE_ERROR__REVEAL_WINDOW_PASSED);
    await late.w.forfeit(late.round);
  });

  test('pauses the table for 25 hours (longer than an investor\'s notice); a pause the owner chose ends at once', async () => {
    const { w, round, lockedAt } = await lockedRound();
    w.setTime(lockedAt + 120n);
    await w.forfeit(round);
    expect(w.read(w.table, getTableDecoder())).toMatchObject({ paused: true, resumeAt: lockedAt + 120n + EXIT_WINDOW });
    w.setTime(lockedAt + 120n + EXIT_WINDOW - 1n);
    await w.chain.fails(w.setPaused(false), ROULETTE_ERROR__TOO_EARLY_TO_RESUME);
    await w.setPaused(true);                                                // pausing is always allowed
    w.setTime(lockedAt + 120n + EXIT_WINDOW);
    await w.setPaused(false);
    await w.setPaused(true);
    await w.setPaused(false);                                               // the owner's own pause: no wait
    expect(w.read(w.table, getTableDecoder()).paused).toBe(false);
  });
});

describe('a new dealer', () => {
  test('takes over only 25 hours after the owner names it (public meanwhile); naming the current dealer calls it off', async () => {
    const w = await World.create();
    const next = await w.chain.signer();
    await w.chain.fails(w.proposeDealer(next.address, next), ROULETTE_ERROR__NOT_OWNER);
    await w.chain.fails(w.applyDealer(), ROULETTE_ERROR__NO_PENDING_CHANGE);
    await w.proposeDealer(next.address);
    const at = w.now() + EXIT_WINDOW;
    expect(w.read(w.table, getTableDecoder())).toMatchObject({ dealer: w.dealer.address, pendingDealer: next.address, dealerChangeAt: at });
    w.setTime(at - 1n);
    await w.chain.fails(w.applyDealer(), ROULETTE_ERROR__TOO_EARLY_TO_CHANGE);
    await w.proposeDealer(w.dealer.address);                                // called off
    await w.chain.fails(w.applyDealer(), ROULETTE_ERROR__NO_PENDING_CHANGE);
    await w.proposeDealer(next.address);
    w.setTime(w.now() + EXIT_WINDOW);
    await w.applyDealer(await w.chain.signer());                            // anyone may apply it once due
    expect(w.read(w.table, getTableDecoder())).toMatchObject({ dealer: next.address, dealerChangeAt: 0n });
  });

  test('takes over only between rounds (a round is locked by the dealer that opened it)', async () => {
    const w = await World.create();
    const next = await w.chain.signer();
    await w.proposeDealer(next.address);
    w.setTime(w.now() + EXIT_WINDOW);
    const { round } = await w.openRound();
    await w.chain.fails(w.applyDealer(), ROULETTE_ERROR__ROUND_RUNNING);
    await w.lock(round);
    await w.chain.fails(w.applyDealer(), ROULETTE_ERROR__ROUND_RUNNING);
    await w.revealAs(round, 5);
    await w.applyDealer();
    expect(w.read(w.table, getTableDecoder()).dealer).toBe(next.address);
  });
});

describe('a new owner', () => {
  test('accepts with its own key 25 hours after being named (a typo cannot lock the table; a tricked signature can be called off)', async () => {
    const w = await World.create();
    const next = await w.chain.signer(), stranger = await w.chain.signer();
    await w.chain.fails(w.proposeOwner(next.address, stranger), ROULETTE_ERROR__NOT_OWNER);
    await w.proposeOwner(stranger.address);
    await w.proposeOwner(w.owner.address);                                  // called off
    await w.chain.fails(w.acceptOwner(stranger), ROULETTE_ERROR__NOT_PENDING_OWNER);
    await w.proposeOwner(next.address);
    const at = w.now() + EXIT_WINDOW;
    expect(w.read(w.table, getTableDecoder())).toMatchObject({ owner: w.owner.address, pendingOwner: next.address, ownerChangeAt: at });
    await w.chain.fails(w.acceptOwner(stranger), ROULETTE_ERROR__NOT_PENDING_OWNER);
    w.setTime(at - 1n);
    await w.chain.fails(w.acceptOwner(next), ROULETTE_ERROR__TOO_EARLY_TO_CHANGE);
    w.setTime(at);
    await w.acceptOwner(next);
    expect(w.read(w.table, getTableDecoder()).owner).toBe(next.address);
    await w.chain.fails(w.setPaused(true), ROULETTE_ERROR__NOT_OWNER);     // the old owner no longer can
    await w.setPaused(true, next);
  });
});

describe('the bank limit', () => {
  test('stays between 0.5 % and 2 % and changes only between rounds', async () => {
    const w = await World.create();
    const set = (bps: number) => w.chain.send(w.owner, [getSetBankLimitInstruction({ owner: w.owner, table: w.table, bps })]);
    await w.chain.fails(set(201), ROULETTE_ERROR__BANK_LIMIT_OUT_OF_RANGE);
    await w.chain.fails(set(49), ROULETTE_ERROR__BANK_LIMIT_OUT_OF_RANGE);
    await set(200);
    const { round } = await w.openRound();
    await w.chain.fails(set(100), ROULETTE_ERROR__ROUND_RUNNING);
    await w.lock(round);
    await w.chain.fails(set(100), ROULETTE_ERROR__ROUND_RUNNING);
    const bare = await World.bare();
    await bare.chain.fails(bare.initTable({ bankLimitBps: 201 }), ROULETTE_ERROR__BANK_LIMIT_OUT_OF_RANGE);
  });
});

describe('an investment', () => {
  test('costs only what its shares are worth: rounding cannot hand part of it to the others, even in a nearly empty bank', async () => {
    const w = await World.create({ feeBps: 50 });
    const first = await w.wallet(100);
    await w.invest(first, 100);                                             // 100,000,000 shares
    await w.requestWithdrawal(first, usd(100) - 1n);                        // leaves 1 share worth 1 base unit
    w.setTime(w.now() + 24n * HOUR);
    await w.executeWithdrawal(first);
    // the last investor, as a player, covers all 37 numbers: the bank cannot lose, so it is allowed; it gains 81.50 − fee rounding
    const { p, key } = await w.seated(3_700, 3_700);
    const { round } = await w.openRound();
    await w.placeBets(p, key, round, Array.from({ length: 37 }, (_, n) => [`straight:${n}`, 100] as [string, number]));
    await w.lock(round);
    await w.revealAs(round, 7);
    const t = w.read(w.table, getTableDecoder());
    expect(t).toMatchObject({ totalShares: 1n, pool: 81_500_001n });       // one share worth $81.50
    const victim = await w.wallet(1_000);
    await w.chain.fails(w.invest(victim, 99), ROULETTE_ERROR__BELOW_MINIMUM);
    // $160 buys 1 whole share for $81.500001 (before: all $160 taken for a share worth $120.75); the rest stays in the wallet
    await w.invest(victim, 160);
    expect(w.tokenBalance(victim.token)).toBe(usd(1_000) - 81_500_001n);
    const after = w.read(w.table, getTableDecoder());
    expect(after).toMatchObject({ totalShares: 2n, pool: 2n * 81_500_001n });
    expect(w.read(await w.positionOf(victim), getPositionDecoder())).toMatchObject({ shares: 1n, invested: 81_500_001n });
    expect(after.pool / after.totalShares).toBe(81_500_001n);              // the share is worth exactly what it cost
  });

  test('at the share value of 1 costs exactly the amount', async () => {
    const w = await World.create();
    const a = await w.wallet(1_500);
    await w.invest(a, 1_000);
    await w.invest(a, 500);
    expect(w.tokenBalance(a.token)).toBe(0n);
    expect(w.read(w.table, getTableDecoder())).toMatchObject({ pool: usd(1_500), totalShares: usd(1_500) });
  });
});
