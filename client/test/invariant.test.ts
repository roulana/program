import { describe, expect, test } from 'bun:test';
import { BET_SPOTS } from '../src/engine';
import { getPositionDecoder, getSafeDecoder, getTableDecoder, positionPda, safePda } from '../src';
import { TxError, World, usd, type Wallet } from './harness';

/** Small deterministic PRNG, so a failing seed replays exactly. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1_103_515_245) + 12_345) >>> 0) / 0x1_0000_0000);
}

/** A refusal by the program (limits, nothing to settle) changes nothing; anything else is a real failure. */
async function refusedOk(p: Promise<unknown>): Promise<void> {
  try { await p; } catch (e) { if (!(e instanceof TxError)) throw e; }
}

describe('the vault always holds exactly what the ledger says', () => {
  test.each([1, 2, 3, 4])('random play, seed %d', async (seed) => {
    const rand = rng(seed);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
    const w = await World.create({ bankLimitBps: 200 });
    const investors: Wallet[] = [];
    for (let i = 0; i < 2; i++) { const inv = await w.wallet(2_000_000); await w.invest(inv, 200_000 + Math.floor(rand() * 300_000)); investors.push(inv); }
    const players: { p: Wallet; key: Awaited<ReturnType<World['openSession']>>['key'] }[] = [];
    for (let i = 0; i < 4; i++) {
      const p = await w.wallet(5_000);
      await w.deposit(p, 1_000 + Math.floor(rand() * 4_000));
      players.push({ p, key: (await w.openSession(p, 1_000_000, 7 * 86_400 - 1)).key });
    }
    const check = async () => {
      const t = w.read(w.table, getTableDecoder());
      expect(w.tokenBalance(w.vault)).toBe(t.safesTotal + t.pool + t.escrowTotal + t.owedTotal + t.buybackOwed);
      let safes = 0n;
      for (const { p } of players) safes += w.read(await safePda(w.table, p.signer.address), getSafeDecoder()).balance;
      expect(safes).toBe(t.safesTotal);
      let shares = 0n;
      for (const inv of investors) shares += w.read(await positionPda(w.table, inv.signer.address), getPositionDecoder()).shares;
      expect(shares).toBe(t.totalShares);
    };
    for (let n = 0; n < 15; n++) {
      const { id, round } = await w.openRound();
      const betting = players.filter(() => rand() < 0.75);
      for (const pl of betting) {
        const bets = Array.from({ length: 1 + Math.floor(rand() * 6) }, () => [pick(BET_SPOTS).id, 1 + Math.floor(rand() * 40)] as [string, number]);
        await refusedOk(w.placeBets(pl.p, pl.key, round, bets));
        await check();
      }
      const ending = rand();
      if (ending < 0.1) {                                                 // the dealer never locks: void and refund
        w.setTime(w.now() + 600n);
        await w.voidRound(round);
        for (const pl of betting) { await refusedOk(w.refund(round, pl.p.signer.address)); await check(); }
      } else {
        await w.lock(round);
        await check();
        if (ending < 0.2) {                                               // the dealer stays silent: forfeit
          w.setTime(w.now() + 120n);
          await w.forfeit(round);
          w.setTime(w.now() + 25n * 3600n);                                // the table resumes a day later
          await w.setPaused(false);
        } else {
          w.entropy(round, Uint8Array.from({ length: 32 }, () => Math.floor(rand() * 256)));
          await w.reveal(round);
        }
        await check();
        for (const pl of betting) { await refusedOk(ending < 0.2 ? w.refund(round, pl.p.signer.address) : w.settle(round, pl.p.signer.address)); await check(); }
      }
      if (rand() < 0.5) {                                                 // finished records return their rent
        for (const pl of betting) await refusedOk(w.closeBets(round, pl.p.signer.address));
        await refusedOk(w.closeRound(round));
        await check();
      }
      if (rand() < 0.4) { const pl = pick(players); await refusedOk(w.withdraw(pl.p, 1 + Math.floor(rand() * 50))); await check(); }
      if (rand() < 0.3) { const pl = pick(players); await w.deposit(pl.p, 1 + Math.floor(rand() * 50)); await check(); }
      if (n === 3) { await w.requestWithdrawal(investors[0]!, usd(50_000)); w.setTime(w.now() + 86_400n); }
      if (n === 7) { await w.executeWithdrawal(investors[0]!); await check(); }
      if (n === 9) { await w.invest(investors[1]!, 10_000); await check(); }
      expect(id).toBe(BigInt(n + 1));
    }
  }, 180_000);
});
