/**
 * Where a round's entropy slot stands in the SlotHashes sysvar, read exactly as the program reads it
 * (solana/programs/roulette/src/derive.rs entropy_after): the dealer sends the seed only once the slot is there, so the
 * seed never leaves our server before that slot's hash exists.
 */
export type Entropy = { slot: bigint; hash: Uint8Array } | 'not-yet' | 'gone';

/** In SlotHashes' data (u64 count, then (slot u64, hash 32 bytes), newest first): the first slot at or after `minSlot`,
 * counted only when an older entry follows it (proof that no earlier slot ≥ `minSlot` exists). */
export function entropyAfter(sysvar: Uint8Array, minSlot: bigint): Entropy {
  if (sysvar.length < 8) return 'not-yet';
  const v = new DataView(sysvar.buffer, sysvar.byteOffset, sysvar.byteLength);
  const count = Number(v.getBigUint64(0, true));
  let found: { slot: bigint; hash: Uint8Array } | null = null;
  for (let i = 0; i < count; i++) {
    const at = 8 + i * 40;
    if (at + 40 > sysvar.length) break;
    const slot = v.getBigUint64(at, true);
    if (slot < minSlot) return found ?? 'not-yet';
    found = { slot, hash: sysvar.slice(at + 8, at + 40) };
  }
  return found ? 'gone' : 'not-yet';
}
