/** The sealed envelope: commit before the bets, mix with a slot that does not exist yet at the lock; a withheld reveal
 * cancels the round: every stake goes back. */
import { describe, expect, test } from 'bun:test';
import { commitmentOf, deriveOutcome, roundKey } from '../src/engine';
import {
  ROULETTE_ERROR__ALREADY_SETTLED, ROULETTE_ERROR__BANK_LIMIT, ROULETTE_ERROR__PAUSED,
  ROULETTE_ERROR__ENTROPY_GONE, ROULETTE_ERROR__ENTROPY_NOT_READY, ROULETTE_ERROR__NOT_DEALER, ROULETTE_ERROR__ROUND_RUNNING,
  ROULETTE_ERROR__TOO_EARLY_TO_FORFEIT, ROULETTE_ERROR__WRONG_ROUND_STATUS, ROULETTE_ERROR__WRONG_SEED, getOpenRoundInstruction, getRevealInstruction,
  getRoundDecoder, getSafeDecoder, getTableDecoder, roundPda, safePda,
} from '../src';
import { SLOT_HASHES, World, hashFor, usd } from './harness';

async function roundWithBets() {
  const w = await World.create();
  await w.invest(await w.wallet(1_000_000), 1_000_000);
  const { p, key } = await w.seated();
  const { id, round, seed } = await w.openRound();
  await w.placeBets(p, key, round, [['straight:17', 10], ['red', 20]]);
  return { w, p, key, id, round, seed };
}

describe('opening and locking', () => {
  test('the round\'s sealed envelope (sha256 of the seed) is public before any bet', async () => {
    const { w, round, seed } = await roundWithBets();
    expect(w.read(round, getRoundDecoder()).commitment).toEqual(commitmentOf(seed));
  });

  test('locking closes the bets and records the lock slot; only the dealer locks, only an open round', async () => {
    const { w, round } = await roundWithBets();
    const late = await w.seated();
    await w.chain.fails(w.lock(round, await w.chain.signer()), ROULETTE_ERROR__NOT_DEALER);
    await w.lock(round);
    const r = w.read(round, getRoundDecoder());
    expect(r).toMatchObject({ status: 2, lockSlot: w.chain.svm.getClock().slot, lockedAt: w.now() });
    expect(w.read(w.table, getTableDecoder()).roundStatus).toBe(2);
    await w.chain.fails(w.placeBets(late.p, late.key, round, [['red', 1]]), ROULETTE_ERROR__WRONG_ROUND_STATUS);
    await w.chain.fails(w.lock(round), ROULETTE_ERROR__WRONG_ROUND_STATUS);
    await w.chain.fails(w.chain.send(w.dealer, [getOpenRoundInstruction({ dealer: w.dealer, table: w.table, round: await roundPda(w.table, 2n), commitment: new Uint8Array(32) })]), ROULETTE_ERROR__ROUND_RUNNING);
  });
});

describe('revealing', () => {
  test('the number comes from the seed and the entropy slot\'s hash; the owner\'s fee is paid; winners\' payouts are set aside', async () => {
    const { w, id, round, seed } = await roundWithBets();
    await w.lock(round);
    const hash = hashFor(17, seed, id);
    w.entropy(round, hash);
    await w.reveal(round);
    const r = w.read(round, getRoundDecoder());
    expect(r).toMatchObject({ number: 17, throwIndex: deriveOutcome(roundKey(seed, hash), id, 299).throwIndex, fee: 150_000n, owed: usd(360), status: 3, forfeited: false });
    expect(r.seed).toEqual(seed);
    expect(r.entropyHash).toEqual(hash);
    expect(r.entropySlot).toBe(r.lockSlot + 2n);
    expect(w.tokenBalance(await w.tokenAccount(w.owner.address))).toBe(75_000n);          // the owner's half of the fee
    const t = w.read(w.table, getTableDecoder());
    expect(t).toMatchObject({ pool: usd(1_000_000) + usd(30) - 150_000n - usd(360), owedTotal: usd(360), escrowTotal: 0n, feesPaid: 150_000n, buybackOwed: 75_000n, roundStatus: 3 });
    expect(w.tokenBalance(w.vault)).toBe(t.safesTotal + t.pool + t.escrowTotal + t.owedTotal + t.buybackOwed);
    await w.chain.fails(w.reveal(round), ROULETTE_ERROR__WRONG_ROUND_STATUS);          // only once
  });

  test('only the seed in the envelope opens it — the dealer cannot swap the seed after seeing the bets', async () => {
    const { w, round, seed } = await roundWithBets();
    await w.lock(round);
    w.entropy(round, new Uint8Array(32).fill(5));
    const other = seed.slice();
    other[0] = other[0]! ^ 1;
    await w.chain.fails(w.reveal(round, other), ROULETTE_ERROR__WRONG_SEED);
    await w.reveal(round, seed, await w.chain.signer());                               // whoever holds the seed may reveal
  });

  test('the entropy slot does not exist yet when the bets close, so nobody can compute the result at the lock', async () => {
    const { w, round } = await roundWithBets();
    await w.lock(round);
    const lockSlot = w.read(round, getRoundDecoder()).lockSlot;
    w.entropy(round, new Uint8Array(32), [[lockSlot + 1n, new Uint8Array(32).fill(1)], [lockSlot, new Uint8Array(32).fill(2)]]);   // chain only at lock + 1
    await w.chain.fails(w.reveal(round), ROULETTE_ERROR__ENTROPY_NOT_READY);
  });

  test('a skipped entropy slot: the next slot that exists counts', async () => {
    const { w, id, round, seed } = await roundWithBets();
    await w.lock(round);
    const lockSlot = w.read(round, getRoundDecoder()).lockSlot;
    const hash = hashFor(7, seed, id);
    w.entropy(round, hash, [[lockSlot + 4n, new Uint8Array(32).fill(4)], [lockSlot + 3n, hash], [lockSlot + 1n, new Uint8Array(32).fill(1)]]);   // lock + 2 skipped
    await w.reveal(round);
    expect(w.read(round, getRoundDecoder())).toMatchObject({ number: 7, entropySlot: lockSlot + 3n });
  });

  test('once the entropy slot has left Solana\'s history the round cannot be revealed — only cancelled by a forfeit', async () => {
    const { w, round } = await roundWithBets();
    await w.lock(round);
    const lockSlot = w.read(round, getRoundDecoder()).lockSlot;
    w.entropy(round, new Uint8Array(32), [[lockSlot + 600n, new Uint8Array(32).fill(6)], [lockSlot + 599n, new Uint8Array(32).fill(5)]]);
    await w.chain.fails(w.reveal(round), ROULETTE_ERROR__ENTROPY_GONE);
  });

  test('the SlotHashes account must be the real sysvar', async () => {
    const { w, round, seed } = await roundWithBets();
    await w.lock(round);
    w.entropy(round, new Uint8Array(32));
    const fake = await w.chain.signer();
    await expect(w.chain.send(w.dealer, [getRevealInstruction({
      table: w.table, round, slotHashes: fake.address, mint: w.mint, vault: w.vault, ownerToken: await w.tokenAccount(w.owner.address), seed,
    })])).rejects.toThrow();
    expect(SLOT_HASHES as string).toBe('SysvarS1otHashes111111111111111111111111111');
  });

  test('a round without bets still gets its number, and the next round can open', async () => {
    const w = await World.create();
    const { round } = await w.openRound();
    await w.lock(round);
    await w.revealAs(round, 0);
    expect(w.read(round, getRoundDecoder())).toMatchObject({ number: 0, fee: 0n, owed: 0n });
    expect((await w.openRound()).id).toBe(2n);
  });
});

describe('forfeit: a silent dealer cancels the round, and nobody gains', () => {
  test('2 minutes after the lock anyone cancels the round: every stake goes back, nothing else moves, no fee; the table pauses', async () => {
    const { w, p, round } = await roundWithBets();                            // $10 on 17, $20 on red
    await w.lock(round);
    w.entropy(round, new Uint8Array(32).fill(3));                          // the dealer could know the result now …
    await w.chain.fails(w.forfeit(round), ROULETTE_ERROR__TOO_EARLY_TO_FORFEIT);
    w.setTime(w.now() + 119n);
    await w.chain.fails(w.forfeit(round), ROULETTE_ERROR__TOO_EARLY_TO_FORFEIT);
    w.setTime(w.now() + 1n);
    const before = w.read(w.table, getTableDecoder());
    await w.forfeit(round, await w.chain.signer());                         // … but stays silent: anyone cancels
    expect(w.read(round, getRoundDecoder())).toMatchObject({ status: 4, forfeited: true, number: 255, fee: 0n, owed: 0n });
    const t = w.read(w.table, getTableDecoder());
    expect(t).toMatchObject({ pool: before.pool, feesPaid: before.feesPaid, totalStaked: before.totalStaked, owedTotal: before.owedTotal, escrowTotal: usd(30), paused: true, roundStatus: 4 });
    expect(w.tokenBalance(w.vault)).toBe(t.safesTotal + t.pool + t.escrowTotal + t.owedTotal + t.buybackOwed);
    await w.chain.fails(w.reveal(round), ROULETTE_ERROR__WRONG_ROUND_STATUS);          // too late to reveal instead
    await w.chain.fails(w.settle(round, p.signer.address), ROULETTE_ERROR__WRONG_ROUND_STATUS);   // no number: nothing to settle
    await w.refund(round, p.signer.address, await w.chain.signer());       // anyone gives the stake back
    expect(w.read(await safePda(w.table, p.signer.address), getSafeDecoder())).toMatchObject({ balance: usd(1_000), pendingRound: 0n });
    await w.chain.fails(w.refund(round, p.signer.address), ROULETTE_ERROR__ALREADY_SETTLED);
    const after = w.read(w.table, getTableDecoder());
    expect(after).toMatchObject({ escrowTotal: 0n, pool: before.pool });
    expect(w.tokenBalance(w.vault)).toBe(after.safesTotal + after.pool + after.escrowTotal + after.owedTotal + after.buybackOwed);
    await w.closeBets(round, p.signer.address);
    await w.closeRound(round);
    await w.chain.fails(w.openRound(), ROULETTE_ERROR__PAUSED);                          // the owner looks into it first
    w.setTime(w.now() + 25n * 3600n);                                       // … and may resume a day later (after investors could leave)
    await w.setPaused(false);
    await w.openRound();
  });

  test('on red and black, each player gets exactly the stake back: a partner of the dealer takes nothing', async () => {
    const w = await World.create();
    await w.invest(await w.wallet(1_000_000), 1_000_000);
    const honest = await w.seated(), partner = await w.seated();
    const { round } = await w.openRound();
    await w.placeBets(honest.p, honest.key, round, [['black', 100]]);
    await w.placeBets(partner.p, partner.key, round, [['red', 100]]);
    await w.lock(round);
    w.setTime(w.now() + 120n);
    const before = w.read(w.table, getTableDecoder());
    await w.forfeit(round);
    for (const { p } of [honest, partner]) {
      await w.refund(round, p.signer.address);
      expect(w.read(await safePda(w.table, p.signer.address), getSafeDecoder()).balance).toBe(usd(1_000));
    }
    expect(w.read(w.table, getTableDecoder()).pool).toBe(before.pool);
  });

  test('a table with no guarantee takes bets; only the bank limit refuses', async () => {
    const w = await World.create();
    await w.invest(await w.wallet(50_000), 50_000);                        // bank limit 1 %: $500
    const a = await w.seated(), b = await w.seated();
    const { round } = await w.openRound();
    await w.placeBets(a.p, a.key, round, [['straight:17', 10]]);            // the bank could lose 350 + fee
    await w.chain.fails(w.placeBets(b.p, b.key, round, [['straight:17', 10]]), ROULETTE_ERROR__BANK_LIMIT);   // 700 > 500
    await w.placeBets(b.p, b.key, round, [['straight:5', 10]]);             // another number: 17 still the worst
  });

  test('a timely reveal is never forfeited', async () => {
    const { w, round } = await roundWithBets();
    await w.lock(round);
    await w.revealAs(round, 0);
    w.setTime(w.now() + 3_600n);
    await w.chain.fails(w.forfeit(round), ROULETTE_ERROR__WRONG_ROUND_STATUS);
  });
});
