/** The fee's buyback half: set aside in the vault at every reveal, sent to the public buyback account by anyone, that
 * account changed only with 7 days' notice — and rounds never depend on it. */
import { describe, expect, test } from 'bun:test';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, getCloseAccountInstruction, getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMint2Instruction, getMintSize,
} from '@solana-program/token';
import { generateKeyPairSigner } from '@solana/kit';
import {
  ROULETTE_ERROR__NOT_OWNER, ROULETTE_ERROR__NO_PENDING_CHANGE, ROULETTE_ERROR__TOO_EARLY_TO_CHANGE, ROULETTE_ERROR__WRONG_BUYBACK_ACCOUNT,
  getTableDecoder,
} from '../src';
import { World, usd } from './harness';

const BUYBACK_NOTICE = 7n * 24n * 3600n;

/** A round with $30 on the table (red 20, straight 17 × 10) landing on 4: both bets lose; fee 0.5 % (harness) = $0.15. */
async function playedRound(w: World) {
  const { p, key } = await w.seated();
  const { round } = await w.openRound();
  await w.placeBets(p, key, round, [['red', 20], ['straight:17', 10]]);
  await w.lock(round);
  await w.revealAs(round, 4);
  return round;
}

const ledger = (w: World) => {
  const t = w.read(w.table, getTableDecoder());
  return t.safesTotal + t.pool + t.escrowTotal + t.owedTotal + t.buybackOwed;
};

describe('the buyback half of the fee', () => {
  test('every reveal sets half of the fee aside in the vault; the owner gets the other half at once', async () => {
    const w = await World.create();
    await w.invest(await w.wallet(1_000_000), 1_000_000);
    const ownerToken = await w.tokenAccount(w.owner.address), had = w.tokenBalance(ownerToken);
    await playedRound(w);
    const fee = usd(30) * 50n / 10_000n;
    expect(w.tokenBalance(ownerToken)).toBe(had + fee - fee / 2n);
    const t = w.read(w.table, getTableDecoder());
    expect(t.buybackOwed).toBe(fee / 2n);
    expect(t.feesPaid).toBe(fee);
    expect(w.tokenBalance(w.vault)).toBe(ledger(w));
    expect(w.tokenBalance(w.buybackToken)).toBe(0n);
  });

  test('anyone sends it to the buyback account, and only there', async () => {
    const w = await World.create();
    await w.invest(await w.wallet(1_000_000), 1_000_000);
    await playedRound(w);
    const owed = w.read(w.table, getTableDecoder()).buybackOwed;
    const stranger = await w.chain.signer(), elsewhere = await w.tokenAccount(stranger.address);
    await w.chain.fails(w.payBuyback(stranger, elsewhere), ROULETTE_ERROR__WRONG_BUYBACK_ACCOUNT);
    await w.payBuyback(stranger);
    expect(w.tokenBalance(w.buybackToken)).toBe(owed);
    const t = w.read(w.table, getTableDecoder());
    expect([t.buybackOwed, t.buybackPaid]).toEqual([0n, owed]);
    expect(w.tokenBalance(w.vault)).toBe(ledger(w));
    await w.payBuyback(stranger);                                        // nothing waiting: nothing moves
    expect(w.tokenBalance(w.buybackToken)).toBe(owed);
  });

  test('a closed buyback account stops only the sending, never a round', async () => {
    const w = await World.create();
    await w.invest(await w.wallet(1_000_000), 1_000_000);
    await w.chain.send(w.buyback, [getCloseAccountInstruction({ account: w.buybackToken, destination: w.buyback.address, owner: w.buyback })]);
    await playedRound(w);
    await playedRound(w);
    const fee = usd(30) * 50n / 10_000n;
    expect(w.read(w.table, getTableDecoder()).buybackOwed).toBe(2n * (fee / 2n));
    await expect(w.payBuyback()).rejects.toThrow();
    expect(w.tokenBalance(w.vault)).toBe(ledger(w));
  });

  test('a new buyback account takes 7 days\' public notice; only the owner proposes, anyone applies; proposing the current one cancels', async () => {
    const w = await World.create();
    const stranger = await w.chain.signer();
    const next = await w.tokenAccount(stranger.address);
    await w.chain.fails(w.proposeBuyback(next, stranger), ROULETTE_ERROR__NOT_OWNER);
    await w.chain.fails(w.applyBuyback(stranger), ROULETTE_ERROR__NO_PENDING_CHANGE);
    await w.proposeBuyback(next);
    let t = w.read(w.table, getTableDecoder());
    expect(t.pendingBuybackToken).toBe(next);
    expect(t.buybackChangeAt).toBe(w.now() + BUYBACK_NOTICE);
    w.setTime(t.buybackChangeAt - 1n);
    await w.chain.fails(w.applyBuyback(stranger), ROULETTE_ERROR__TOO_EARLY_TO_CHANGE);
    w.setTime(t.buybackChangeAt);
    await w.applyBuyback(stranger);
    t = w.read(w.table, getTableDecoder());
    expect([t.buybackToken, t.buybackChangeAt]).toEqual([next, 0n]);
    await w.chain.fails(w.applyBuyback(stranger), ROULETTE_ERROR__NO_PENDING_CHANGE);

    await w.proposeBuyback(w.buybackToken);                             // the old one again: a new 7-day notice
    expect(w.read(w.table, getTableDecoder()).pendingBuybackToken).toBe(w.buybackToken);
    await w.proposeBuyback(next);                                       // the current one: cancels
    t = w.read(w.table, getTableDecoder());
    expect(t.buybackChangeAt).toBe(0n);
    await w.chain.fails(w.applyBuyback(stranger), ROULETTE_ERROR__NO_PENDING_CHANGE);
  });

  test('the table\'s own vault can never be named the buyback account (the money would be stuck and reported as sent)', async () => {
    const w = await World.create();
    await w.chain.fails(w.proposeBuyback(w.vault), ROULETTE_ERROR__WRONG_BUYBACK_ACCOUNT);
  });

  test('an account of another currency is refused as the buyback account', async () => {
    const w = await World.create();
    const other = await generateKeyPairSigner(), space = BigInt(getMintSize());
    await w.chain.send(w.owner, [
      getCreateAccountInstruction({ payer: w.owner, newAccount: other, lamports: w.chain.svm.minimumBalanceForRentExemption(space), space, programAddress: TOKEN_PROGRAM_ADDRESS }),
      getInitializeMint2Instruction({ mint: other.address, decimals: 6, mintAuthority: w.owner.address }),
    ]);
    const [foreign] = await findAssociatedTokenPda({ owner: w.owner.address, mint: other.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    await w.chain.send(w.owner, [getCreateAssociatedTokenIdempotentInstruction({ payer: w.owner, owner: w.owner.address, mint: other.address, ata: foreign })]);
    await w.chain.fails(w.proposeBuyback(foreign), ROULETTE_ERROR__WRONG_BUYBACK_ACCOUNT);
  });
});
