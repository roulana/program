import { describe, expect, test } from 'bun:test';
import {
  ROULETTE_ERROR__BANK_LIMIT, ROULETTE_ERROR__INSUFFICIENT_SAFE, ROULETTE_ERROR__NOT_DEALER, ROULETTE_ERROR__PAUSED, ROULETTE_ERROR__ROUND_LIMIT,
  ROULETTE_ERROR__ROUND_RUNNING, ROULETTE_ERROR__SESSION_CAP, ROULETTE_ERROR__SESSION_EXPIRED, ROULETTE_ERROR__SPOT_LIMIT, ROULETTE_ERROR__UNKNOWN_SPOT,
  ROULETTE_ERROR__WRONG_SESSION_KEY, getOpenRoundInstruction, getPlaceBetsInstruction, getRoundBetsDecoder, getRoundDecoder, getSafeDecoder,
  getSessionDecoder, getSetPausedInstruction, getTableDecoder, betsPda, roundPda, safePda, sessionPda,
  ROULETTE_ERROR__TOO_MANY_BETS, spotId,
} from '../src';
import type { Address } from '@solana/kit';
import { World, usd, type Wallet } from './harness';

async function funded() {
  const w = await World.create();
  await w.invest(await w.wallet(1_000_000), 1_000_000);
  return w;
}

describe('rounds', () => {
  test('only the dealer opens rounds, one at a time, numbered 1, 2, 3 …, and not while paused', async () => {
    const w = await World.create();
    const stranger = await w.chain.signer();
    await w.chain.fails(w.chain.send(stranger, [getOpenRoundInstruction({ dealer: stranger, table: w.table, round: await roundPda(w.table, 1n), commitment: new Uint8Array(32) })]), ROULETTE_ERROR__NOT_DEALER);
    const { id, round } = await w.openRound();
    expect(id).toBe(1n);
    expect(w.read(round, getRoundDecoder())).toMatchObject({ id: 1n, table: w.table, totalStake: 0n, players: 0, openedAt: w.now() });
    expect(w.read(w.table, getTableDecoder()).roundId).toBe(1n);
    await w.chain.fails(w.chain.send(w.dealer, [getOpenRoundInstruction({ dealer: w.dealer, table: w.table, round: await roundPda(w.table, 2n), commitment: new Uint8Array(32) })]), ROULETTE_ERROR__ROUND_RUNNING);
    const paused = await World.create();
    await paused.chain.send(paused.owner, [getSetPausedInstruction({ owner: paused.owner, table: paused.table, paused: true })]);
    await paused.chain.fails(paused.chain.send(paused.dealer, [getOpenRoundInstruction({ dealer: paused.dealer, table: paused.table, round: await roundPda(paused.table, 1n), commitment: new Uint8Array(32) })]), ROULETTE_ERROR__PAUSED);
  });
});

describe('a player\'s bets', () => {
  test('signed by the session key, they move the stake from the safe into the round; the table pays the fee', async () => {
    const w = await funded();
    const { p, key } = await w.seated();
    const { round } = await w.openRound();
    const before = w.chain.svm.getBalance(p.signer.address);
    const rb = await w.placeBets(p, key, round, [['straight:17', 10], ['red', 20]]);
    expect(w.chain.svm.getBalance(p.signer.address)).toBe(before);                    // the player paid no SOL
    expect(w.read(rb, getRoundBetsDecoder())).toMatchObject({ wallet: p.signer.address, round, payer: w.dealer.address, stake: usd(30), payout: 0n, done: false });
    expect(w.read(rb, getRoundBetsDecoder()).bets).toEqual([{ spot: 17, dollars: 10 }, { spot: 151, dollars: 20 }]);
    expect(w.read(await safePda(w.table, p.signer.address), getSafeDecoder())).toMatchObject({ balance: usd(970), pendingRound: 1n });
    expect(w.read(await sessionPda(w.table, p.signer.address), getSessionDecoder()).capRemaining).toBe(usd(470));
    const r = w.read(round, getRoundDecoder());
    expect(r).toMatchObject({ totalStake: usd(30), players: 1 });
    expect(r.liabilities[17]).toBe(usd(360));
    expect(r.liabilities[1]).toBe(usd(40));
    expect(r.liabilities[2]).toBe(0n);
    expect(w.read(w.table, getTableDecoder())).toMatchObject({ escrowTotal: usd(30), safesTotal: usd(970), pool: usd(1_000_000) });
    expect(w.tokenBalance(w.vault)).toBe(usd(1_000_970) + usd(30));
  });

  test('two players\' liabilities add up per number', async () => {
    const w = await funded();
    const a = await w.seated(), b = await w.seated();
    const { round } = await w.openRound();
    await w.placeBets(a.p, a.key, round, [['straight:17', 10]]);
    await w.placeBets(b.p, b.key, round, [['split:14-17', 5], ['black', 5]]);
    const r = w.read(round, getRoundDecoder());
    expect(r.liabilities[17]).toBe(usd(360 + 90 + 10));
    expect(r.liabilities[14]).toBe(usd(90));
    expect(r).toMatchObject({ totalStake: usd(20), players: 2 });
  });

  test('the same player cannot place a second set in one round (Review Focus 1)', async () => {
    const w = await funded();
    const { p, key } = await w.seated();
    const { round } = await w.openRound();
    await w.placeBets(p, key, round, [['red', 5]]);
    await expect(w.placeBets(p, key, round, [['black', 5]])).rejects.toThrow();
    expect(w.read(round, getRoundDecoder()).totalStake).toBe(usd(5));
    expect(w.read(await safePda(w.table, p.signer.address), getSafeDecoder()).balance).toBe(usd(995));
  });

  test('a session key only bets for its own wallet (Review Focus 2)', async () => {
    const w = await funded();
    const a = await w.seated(), b = await w.seated();
    const { round } = await w.openRound();
    await w.chain.fails(w.placeBets(b.p, a.key, round, [['red', 5]]), ROULETTE_ERROR__WRONG_SESSION_KEY);   // a's key on b's session
    // a's key and session, but b's safe: the safe must belong to the session's wallet
    await expect(w.chain.send(w.dealer, [getPlaceBetsInstruction({
      payer: w.dealer, sessionKey: a.key, table: w.table, round, session: await sessionPda(w.table, a.p.signer.address),
      safe: await safePda(w.table, b.p.signer.address), roundBets: await betsPda(round, a.p.signer.address), bets: [{ spot: 151, dollars: 5 }],
    })])).rejects.toThrow();
    expect(w.read(await safePda(w.table, b.p.signer.address), getSafeDecoder()).balance).toBe(usd(1_000));
  });

  test('bets stay within the session cap and expiry, the safe, and the table limits', async () => {
    const w = await funded();
    const a = await w.seated(1_000, 50), rich = await w.seated(20_000, 20_000), poor = await w.seated(10);
    const { round } = await w.openRound();
    await w.chain.fails(w.placeBets(a.p, a.key, round, [['red', 51]]), ROULETTE_ERROR__SESSION_CAP);
    await w.chain.fails(w.placeBets(poor.p, poor.key, round, [['red', 11]]), ROULETTE_ERROR__INSUFFICIENT_SAFE);
    await w.chain.fails(w.placeBets(rich.p, rich.key, round, [['straight:5', 101]]), ROULETTE_ERROR__SPOT_LIMIT);
    await w.chain.fails(w.placeBets(rich.p, rich.key, round, [['red', 2_000], ['black', 2_000], ['even', 2_000], ['odd', 2_000], ['low', 2_000], ['high', 1]]), ROULETTE_ERROR__ROUND_LIMIT);
    await w.chain.fails(w.chain.send(w.dealer, [getPlaceBetsInstruction({
      payer: w.dealer, sessionKey: rich.key, table: w.table, round, session: await sessionPda(w.table, rich.p.signer.address),
      safe: await safePda(w.table, rich.p.signer.address), roundBets: await betsPda(round, rich.p.signer.address), bets: [{ spot: 157, dollars: 1 }],
    })]), ROULETTE_ERROR__UNKNOWN_SPOT);
    w.setTime(w.now() + 5n * 3600n);
    await w.chain.fails(w.placeBets(a.p, a.key, round, [['red', 5]]), ROULETTE_ERROR__SESSION_EXPIRED);
    expect(w.read(round, getRoundDecoder()).totalStake).toBe(0n);
  });

  test('the bank limit: the pool can never lose more than 1 % of itself in one spin', async () => {
    const w = await World.create();
    await w.invest(await w.wallet(10_000), 10_000);                  // limit $100
    const a = await w.seated(), b = await w.seated();
    const { round } = await w.openRound();
    await w.chain.fails(w.placeBets(a.p, a.key, round, [['straight:7', 3]]), ROULETTE_ERROR__BANK_LIMIT);   // could lose 3 × 36 − 3 + fee > $100
    await w.placeBets(a.p, a.key, round, [['straight:7', 2]]);                                             // could lose ≈ $70
    await w.chain.fails(w.placeBets(b.p, b.key, round, [['straight:7', 1]]), ROULETTE_ERROR__BANK_LIMIT);   // together ≈ $105 on number 7
    await w.placeBets(b.p, b.key, round, [['straight:8', 1]]);                                             // a different number: fine
  });
});

describe('a bets record holds room for its bets only (0.2.0)', () => {
  const stacks = (n: number) => Array.from({ length: n }, (_, k) => [spotId(k), 1] as [string, number]);

  test('1, 3 and 64 stacks: 131, 141 and 446 bytes, each with just the deposit its size needs; closing gives it all back', async () => {
    const w = await funded();
    const { round } = await w.openRound();
    const made: { p: Wallet; rb: Address; lamports: bigint }[] = [];
    for (const [n, size] of [[1, 131], [3, 141], [64, 446]] as const) {
      const { p, key } = await w.seated(1_000, 500);
      const rb = await w.placeBets(p, key, round, stacks(n));
      const acc = w.chain.svm.getAccount(rb);
      if (!acc.exists) throw new Error(`no bets record for ${n} stacks`);
      expect(acc.data.length).toBe(size);
      expect(BigInt(acc.lamports)).toBe(w.chain.svm.minimumBalanceForRentExemption(BigInt(size)));
      made.push({ p, rb, lamports: BigInt(acc.lamports) });
    }
    await w.lock(round);
    await w.revealAs(round, 17);
    for (const m of made) {
      await w.settle(round, m.p.signer.address);
      const before = w.chain.svm.getBalance(w.dealer.address)!;
      await w.closeBets(round, m.p.signer.address);
      expect(w.chain.svm.getAccount(m.rb).exists).toBe(false);
      expect(w.chain.svm.getBalance(w.dealer.address)! - before).toBe(m.lamports - 5_000n);   // back in full, less the fee
    }
  });

  test('65 stacks are still refused, and no record is made', async () => {
    const w = await funded();
    const { round } = await w.openRound();
    const { p, key } = await w.seated(1_000, 500);
    await w.chain.fails(w.placeBets(p, key, round, stacks(65)), ROULETTE_ERROR__TOO_MANY_BETS);
    expect(w.chain.svm.getAccount(await betsPda(round, p.signer.address)).exists).toBe(false);
  });
});
