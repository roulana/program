import { describe, expect, test } from 'bun:test';
import {
  ROULETTE_ERROR__ALREADY_SETTLED, ROULETTE_ERROR__ROUND_RUNNING, ROULETTE_ERROR__STAKE_IN_ROUND, ROULETTE_ERROR__TOO_EARLY_TO_VOID,
  ROULETTE_ERROR__WRONG_ROUND_STATUS, getRoundBetsDecoder, getRoundDecoder, getSafeDecoder, getTableDecoder, betsPda, safePda,
} from '../src';
import { World, usd } from './harness';

async function setup() {
  const w = await World.create();
  const investor = await w.wallet(1_000_000);
  await w.invest(investor, 1_000_000);
  const { p, key } = await w.seated();
  const { id, round } = await w.openRound();
  await w.placeBets(p, key, round, [['straight:17', 10], ['red', 20]]);
  return { w, investor, p, key, id, round };
}

const ledgerMatchesVault = (w: World) => {
  const t = w.read(w.table, getTableDecoder());
  expect(w.tokenBalance(w.vault)).toBe(t.safesTotal + t.pool + t.escrowTotal + t.owedTotal + t.buybackOwed);
};

describe('paying winners', () => {
  test('anyone settles a winner: stake back + winnings land in the safe, which can then be withdrawn', async () => {
    const { w, p, id, round } = await setup();
    await w.lock(round);
    await w.chain.fails(w.withdraw(p, 1), ROULETTE_ERROR__STAKE_IN_ROUND);
    await w.chain.fails(w.settle(round, p.signer.address), ROULETTE_ERROR__WRONG_ROUND_STATUS);   // not revealed yet
    await w.revealAs(round, 17);
    await w.settle(round, p.signer.address, await w.chain.signer());
    const safe = await safePda(w.table, p.signer.address);
    expect(w.read(safe, getSafeDecoder())).toMatchObject({ balance: usd(970 + 360), pendingRound: 0n });
    expect(w.read(await betsPda(round, p.signer.address), getRoundBetsDecoder())).toMatchObject({ payout: usd(360), done: true });
    expect(w.read(round, getRoundDecoder())).toMatchObject({ owed: 0n, settled: 1 });
    expect(w.read(w.table, getTableDecoder()).owedTotal).toBe(0n);
    await w.chain.fails(w.settle(round, p.signer.address), ROULETTE_ERROR__ALREADY_SETTLED);
    ledgerMatchesVault(w);
    await w.withdraw(p, 1_330);
    expect(w.tokenBalance(p.token)).toBe(usd(1_330));
  });

  test('a losing player is settled with nothing; the pool keeps the stakes minus the fee', async () => {
    const { w, p, id, round } = await setup();
    await w.lock(round);
    await w.revealAs(round, 0);
    await w.settle(round, p.signer.address);
    expect(w.read(await safePda(w.table, p.signer.address), getSafeDecoder())).toMatchObject({ balance: usd(970), pendingRound: 0n });
    expect(w.read(w.table, getTableDecoder()).pool).toBe(usd(1_000_030) - 150_000n);
    ledgerMatchesVault(w);
  });

  test('a player not yet settled from the last round cannot bet in the next; once settled they can', async () => {
    const { w, p, key, id, round } = await setup();
    await w.lock(round);
    await w.revealAs(round, 1);
    const next = await w.openRound();
    await w.chain.fails(w.placeBets(p, key, next.round, [['red', 1]]), ROULETTE_ERROR__STAKE_IN_ROUND);
    await w.settle(round, p.signer.address);
    await w.placeBets(p, key, next.round, [['red', 1]]);
  });
});

describe('stuck rounds', () => {
  test('a round the dealer opens but never locks is voided by anyone after 10 minutes and every stake is refunded, with no fee', async () => {
    const { w, p, round } = await setup();
    await w.chain.fails(w.voidRound(round), ROULETTE_ERROR__TOO_EARLY_TO_VOID);
    w.setTime(w.now() + 599n);
    await w.chain.fails(w.voidRound(round), ROULETTE_ERROR__TOO_EARLY_TO_VOID);
    w.setTime(w.now() + 1n);
    await w.chain.fails(w.refund(round, p.signer.address), ROULETTE_ERROR__WRONG_ROUND_STATUS);  // not voided yet
    await w.voidRound(round, await w.chain.signer());
    await w.refund(round, p.signer.address, await w.chain.signer());
    await w.chain.fails(w.refund(round, p.signer.address), ROULETTE_ERROR__ALREADY_SETTLED);
    expect(w.read(await safePda(w.table, p.signer.address), getSafeDecoder())).toMatchObject({ balance: usd(1_000), pendingRound: 0n });
    expect(w.read(w.table, getTableDecoder())).toMatchObject({ escrowTotal: 0n, pool: usd(1_000_000), feesPaid: 0n, roundStatus: 4 });
    expect(w.tokenBalance(await w.tokenAccount(w.owner.address))).toBe(0n);
    ledgerMatchesVault(w);
    await w.openRound();                                                 // the table goes on
  });

  test('a locked round is never voided (it is revealed, or cancelled by a forfeit), nor is a revealed one', async () => {
    const { w, round } = await setup();
    await w.lock(round);
    w.setTime(w.now() + 3_600n);
    await w.chain.fails(w.voidRound(round), ROULETTE_ERROR__WRONG_ROUND_STATUS);
    await w.forfeit(round);
    w.setTime(w.now() + 25n * 3_600n);                                     // the table resumes a day after a cancel
    await w.setPaused(false);
    const next = await w.openRound();
    await w.lock(next.round);
    await w.revealAs(next.round, 3);
    w.setTime(w.now() + 3_600n);
    await w.chain.fails(w.voidRound(next.round), ROULETTE_ERROR__WRONG_ROUND_STATUS);
  });

  test('an investor cannot execute a withdrawal while a round is locked (Review Focus 4)', async () => {
    const { w, investor, round } = await setup();
    await w.requestWithdrawal(investor, usd(1));
    w.setTime(w.now() + 86_400n);
    await w.chain.fails(w.executeWithdrawal(investor), ROULETTE_ERROR__ROUND_RUNNING);   // Open: bets allowed by the bank limit are on the table
    await w.lock(round);
    await w.chain.fails(w.executeWithdrawal(investor), ROULETTE_ERROR__ROUND_RUNNING);
    await w.chain.fails(w.invest(investor, 1), ROULETTE_ERROR__ROUND_RUNNING);          // nor invest while the randomness may be visible
    await w.revealAs(round, 5);
    await w.executeWithdrawal(investor);
    ledgerMatchesVault(w);
  });
});
