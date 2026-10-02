import { describe, expect, test } from 'bun:test';
import {
  ROULETTE_ERROR__BANK_LIMIT_OUT_OF_RANGE, ROULETTE_ERROR__FEE_ABOVE_CAP, ROULETTE_ERROR__INSUFFICIENT_SAFE, ROULETTE_ERROR__NOT_UPGRADE_AUTHORITY,
  ROULETTE_ERROR__NO_THROWS, ROULETTE_ERROR__ZERO_AMOUNT, getSafeDecoder, getTableDecoder, safePda, vaultPda,
} from '../src';
import { World, usd } from './harness';

describe('the table', () => {
  test('is set up by the upgrade authority with the owner, dealer, fee, bank limit and throw library', async () => {
    const w = await World.create();
    const t = w.read(w.table, getTableDecoder());
    expect(t).toMatchObject({ owner: w.owner.address, dealer: w.dealer.address, mint: w.mint, feeBps: 50, bankLimitBps: 100, throwCount: 299, unit: 1_000_000n, roundId: 0n, pool: 0n });
  });

  test('nobody but the upgrade authority can set up a table, and the fee, bank limit and throw count are checked', async () => {
    const w = await World.bare();
    await w.chain.fails(w.initTable({}, await w.chain.signer()), ROULETTE_ERROR__NOT_UPGRADE_AUTHORITY);
    await w.chain.fails(w.initTable({ feeBps: 101 }), ROULETTE_ERROR__FEE_ABOVE_CAP);
    await w.chain.fails(w.initTable({ bankLimitBps: 201 }), ROULETTE_ERROR__BANK_LIMIT_OUT_OF_RANGE);
    await w.chain.fails(w.initTable({ bankLimitBps: 49 }), ROULETTE_ERROR__BANK_LIMIT_OUT_OF_RANGE);
    await w.chain.fails(w.initTable({ throwCount: 0 }), ROULETTE_ERROR__NO_THROWS);
    await w.initTable({ feeBps: 100, bankLimitBps: 200 });
    await expect(w.initTable()).rejects.toThrow();                                        // only once
  });
});

describe('a player\'s safe', () => {
  test('deposit moves USDC from the wallet into the safe; withdraw sends it back to the wallet', async () => {
    const w = await World.create();
    const p = await w.wallet(1_000);
    const safe = await w.deposit(p, 400);
    expect(w.read(safe, getSafeDecoder())).toMatchObject({ wallet: p.signer.address, balance: usd(400), pendingRound: 0n });
    expect(w.tokenBalance(p.token)).toBe(usd(600));
    expect(w.tokenBalance(w.vault)).toBe(usd(400));
    await w.deposit(p, 100);
    await w.withdraw(p, 150);
    expect(w.read(safe, getSafeDecoder()).balance).toBe(usd(350));
    expect(w.tokenBalance(p.token)).toBe(usd(650));
    expect(w.tokenBalance(w.vault)).toBe(usd(350));
    expect(w.read(w.table, getTableDecoder()).safesTotal).toBe(usd(350));
  });

  test('nobody else can withdraw from a safe, it only pays its own wallet, and never more than it holds', async () => {
    const w = await World.create();
    const p = await w.wallet(100), thief = await w.wallet(0);
    await w.deposit(p, 100);
    await expect(w.withdraw(thief, 1, thief.token, p.signer.address)).rejects.toThrow();   // the thief names the victim's safe
    await expect(w.withdraw(p, 1, thief.token)).rejects.toThrow();                         // the owner cannot pay someone else
    await w.chain.fails(w.withdraw(p, 101), ROULETTE_ERROR__INSUFFICIENT_SAFE);
    await w.chain.fails(w.deposit(p, 0), ROULETTE_ERROR__ZERO_AMOUNT);
    await w.chain.fails(w.withdraw(p, 0), ROULETTE_ERROR__ZERO_AMOUNT);
    expect(w.tokenBalance(w.vault)).toBe(usd(100));
    expect(w.read(await safePda(w.table, p.signer.address), getSafeDecoder()).balance).toBe(usd(100));
    expect(await vaultPda(w.table)).toBe(w.vault);
  });
});
