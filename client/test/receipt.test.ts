/** The receipt: when a round ends, the program writes its result into the transaction's log, which Solana keeps for good —
 * the round's own record is closed after payout, and the block hash it used leaves Solana's SlotHashes within minutes. */
import { describe, expect, test } from 'bun:test';
import { getForfeitInstruction, getRevealInstruction, getRoundDecoder, getVoidRoundInstruction } from '../src';
import { SLOT_HASHES, World, hashFor } from './harness';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

async function roundWithBets() {
  const w = await World.create();
  await w.invest(await w.wallet(1_000_000), 1_000_000);
  const { p, key } = await w.seated();
  const { id, round, seed } = await w.openRound();
  await w.placeBets(p, key, round, [['straight:17', 10], ['red', 20]]);
  return { w, id, round, seed };
}

describe('the receipt', () => {
  test('a revealed round: its id, number, throw, the block and that block’s hash, exactly as the round record holds them', async () => {
    const { w, id, round, seed } = await roundWithBets();
    await w.lock(round);
    w.entropy(round, hashFor(17, seed, id));
    const meta = await w.chain.send(w.dealer, [getRevealInstruction({
      table: w.table, round, slotHashes: SLOT_HASHES, mint: w.mint, vault: w.vault, ownerToken: await w.tokenAccount(w.owner.address), seed,
    })]);
    const r = w.read(round, getRoundDecoder());
    expect(r.number).toBe(17);
    expect(meta.logs()).toContain(`Program log: receipt: round ${id} number ${r.number} throw ${r.throwIndex} block ${r.entropySlot} hash ${hex(r.entropyHash as Uint8Array)}`);
    expect(meta.computeUnitsConsumed()).toBeLessThan(200_000n);
  });

  test('a forfeited round says so', async () => {
    const { w, id, round } = await roundWithBets();
    await w.lock(round);
    w.setTime(w.now() + 120n);
    const meta = await w.chain.send(await w.chain.signer(), [getForfeitInstruction({ table: w.table, round })]);
    expect(meta.logs()).toContain(`Program log: receipt: round ${id} forfeited`);
  });

  test('a voided round says so', async () => {
    const { w, id, round } = await roundWithBets();
    w.setTime(w.now() + 600n);
    const meta = await w.chain.send(await w.chain.signer(), [getVoidRoundInstruction({ table: w.table, round })]);
    expect(meta.logs()).toContain(`Program log: receipt: round ${id} voided`);
  });
});
