/**
 * The round's result from its randomness (the sealed seed followed by a later slot's hash, 64 bytes), exactly as the
 * Solana program derives it:
 * a stream of 32-bit big-endian words from HMAC-SHA256(key = randomness, "roulette3:<roundId>:<counter>"), counter
 * 0, 1, 2 …; the number by rejection sampling over 37, then the throw index over the library size.
 */
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

function* words(randomness: Uint8Array, roundId: bigint): Generator<number, never> {
  for (let counter = 0; ; counter++) {
    const h = hmac(sha256, randomness, utf8ToBytes(`roulette3:${roundId}:${counter}`));
    const view = new DataView(h.buffer, h.byteOffset, h.byteLength);
    for (let i = 0; i < 32; i += 4) yield view.getUint32(i, false);
  }
}

/** Uniform integer in [0, n) by rejection sampling, so no value is favoured. */
function uniform(w: Generator<number, never>, n: number): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  for (;;) {
    const x = w.next().value;
    if (x < limit) return x % n;
  }
}

export function deriveOutcome(randomness: Uint8Array, roundId: bigint, throwCount: number): { number: number; throwIndex: number } {
  if (randomness.length !== 64) throw new RangeError('randomness must be 64 bytes');
  if (!Number.isInteger(throwCount) || throwCount < 1 || throwCount > 0xffff_ffff) throw new RangeError('throwCount must be an integer in 1..2^32-1');
  if (roundId < 0n || roundId > 0xffff_ffff_ffff_ffffn) throw new RangeError('roundId must fit in a u64');
  const w = words(randomness, roundId);
  const number = uniform(w, 37);
  return { number, throwIndex: uniform(w, throwCount) };
}

/** The sealed envelope: what the dealer publishes when the round opens (sha256 of its 32-byte secret seed). */
export function commitmentOf(seed: Uint8Array): Uint8Array {
  if (seed.length !== 32) throw new RangeError('seed must be 32 bytes');
  return sha256(seed);
}

/** The round's randomness: the dealer's seed followed by the hash of the entropy slot (the first slot ≥ lock slot + 2). */
export function roundKey(seed: Uint8Array, slotHash: Uint8Array): Uint8Array {
  if (seed.length !== 32 || slotHash.length !== 32) throw new RangeError('seed and slot hash must be 32 bytes');
  const k = new Uint8Array(64);
  k.set(seed);
  k.set(slotHash, 32);
  return k;
}
