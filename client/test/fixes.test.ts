/** The final review's findings: the operator must not be able to cancel, starve or overcharge. */
import { describe, expect, test } from 'bun:test';
import type { Address } from '@solana/kit';
import {
  ROULETTE_ERROR__ALREADY_SETTLED, ROULETTE_ERROR__NOT_ALL_SETTLED, ROULETTE_ERROR__ROUND_RUNNING, ROULETTE_ERROR__WRONG_ROUND_STATUS,
  ROULETTE_ERROR__TOO_SOON, getOpenRoundInstruction, getRoundDecoder, getSetFeeInstruction, getTableDecoder, betsPda, roundPda,
} from '../src';
import { ROUND_GAP_SECS, World, usd } from './harness';

/** An account's SOL balance in lamports (0 when it does not exist). */
const sol = (w: World, a: Address): bigint => BigInt(w.chain.svm.getBalance(a) ?? 0n);

async function setup() {
  const w = await World.create();
  const investor = await w.wallet(1_000_000);
  await w.invest(investor, 1_000_000);
  const a = await w.seated(), b = await w.seated();
  const { id, round } = await w.openRound();
  await w.placeBets(a.p, a.key, round, [['straight:17', 10]]);
  await w.placeBets(b.p, b.key, round, [['black', 20]]);
  return { w, investor, a, b, id, round };
}

describe('a locked round cannot be cancelled (Critical 1)', () => {
  test('whoever sees a loss coming cannot get the round cancelled: after 10 minutes it is still only revealed or cancelled by a forfeit', async () => {
    const { w, a, round } = await setup();
    await w.lock(round);
    w.setTime(w.now() + 3_600n);                                        // nobody reveals for an hour
    await w.chain.fails(w.voidRound(round, await w.chain.signer()), ROULETTE_ERROR__WRONG_ROUND_STATUS);
    await w.forfeit(round, await w.chain.signer());                     // anyone cancels it: every stake goes back
    await w.refund(round, a.p.signer.address);
    expect(w.read(round, getRoundDecoder())).toMatchObject({ number: 255, forfeited: true, status: 4 });
  });
});

describe('the gap between rounds', () => {
  test('the next round opens only a few seconds after the last one ends, so investors can always withdraw (Important 2)', async () => {
    const { w, investor, id, round } = await setup();
    await w.requestWithdrawal(investor, usd(1_000));
    w.setTime(w.now() + 86_400n);
    await w.lock(round);
    await w.revealAs(round, 0);
    const next = await roundPda(w.table, id + 1n);
    const open = () => w.chain.send(w.dealer, [getOpenRoundInstruction({ dealer: w.dealer, table: w.table, round: next, commitment: new Uint8Array(32) })]);
    await w.chain.fails(open(), ROULETTE_ERROR__TOO_SOON);                // the dealer cannot chain rounds back to back …
    await w.executeWithdrawal(investor);                                  // … so the withdrawal gets its window
    w.setTime(w.read(w.table, getTableDecoder()).roundClosedAt + ROUND_GAP_SECS - 1n);
    await w.chain.fails(open(), ROULETTE_ERROR__TOO_SOON);
    w.setTime(w.now() + 1n);
    await open();
  });

  test('a voided round also starts the gap', async () => {
    const { w, round } = await setup();
    w.setTime(w.now() + 600n);
    await w.voidRound(round);
    expect(w.read(w.table, getTableDecoder()).roundClosedAt).toBe(w.now());
  });
});

describe('the owner\'s fee', () => {
  test('cannot change while a round is open or locked (only between rounds)', async () => {
    const { w, id, round } = await setup();
    const setFee = (bps: number) => w.chain.send(w.owner, [getSetFeeInstruction({ owner: w.owner, table: w.table, bps })]);
    await w.chain.fails(setFee(100), ROULETTE_ERROR__ROUND_RUNNING);
    await w.lock(round);
    await w.chain.fails(setFee(100), ROULETTE_ERROR__ROUND_RUNNING);
    await w.revealAs(round, 3);
    expect(w.read(round, getRoundDecoder()).fee).toBe(150_000n);         // 0.5 % of $30, as when the bets closed
    await setFee(100);
  });
});

describe('closing finished records (rent comes back)', () => {
  test('a player\'s bets record closes once settled; its rent goes back to whoever paid it', async () => {
    const { w, a, id, round } = await setup();
    await w.lock(round);
    await w.chain.fails(w.closeBets(round, a.p.signer.address), ROULETTE_ERROR__NOT_ALL_SETTLED);
    await w.revealAs(round, 17);
    await w.settle(round, a.p.signer.address);
    const bets = await betsPda(round, a.p.signer.address);
    const before = sol(w, w.dealer.address);
    const rent = sol(w, bets);
    await w.closeBets(round, a.p.signer.address, await w.chain.signer());   // anyone may close it
    expect(w.exists(bets)).toBe(false);
    expect(sol(w, w.dealer.address)).toBe(before + rent);
    await w.chain.fails(w.settle(round, a.p.signer.address), 3012 /* AccountNotInitialized */);
  });

  test('a round closes once revealed or voided and every player is settled or refunded; its rent goes back', async () => {
    const { w, a, b, id, round } = await setup();
    await w.lock(round);
    await w.revealAs(round, 17);
    await w.settle(round, a.p.signer.address);
    await w.chain.fails(w.closeRound(round), ROULETTE_ERROR__NOT_ALL_SETTLED);          // b is not settled yet
    await w.settle(round, b.p.signer.address);
    const before = sol(w, w.dealer.address);
    const rent = sol(w, round);
    await w.closeRound(round, await w.chain.signer());
    expect(w.exists(round)).toBe(false);
    expect(sol(w, w.dealer.address)).toBe(before + rent);
    await w.openRound();                                                  // the table goes on
  });

  test('an open round never closes, and a voided one only after every refund', async () => {
    const { w, a, b, round } = await setup();
    await w.chain.fails(w.closeRound(round), ROULETTE_ERROR__NOT_ALL_SETTLED);          // open
    w.setTime(w.now() + 600n);
    await w.voidRound(round);
    await w.refund(round, a.p.signer.address);
    await w.chain.fails(w.closeRound(round), ROULETTE_ERROR__NOT_ALL_SETTLED);
    await w.refund(round, b.p.signer.address);
    await w.chain.fails(w.refund(round, b.p.signer.address), ROULETTE_ERROR__ALREADY_SETTLED);
    await w.closeRound(round);
  });
});
