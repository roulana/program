/**
 * Solana's Compute Budget program: how much compute a transaction may use, and what it pays a unit (the priority fee,
 * paid by whoever pays the transaction's fee). Two instructions, encoded by hand — a byte for the kind, then a
 * little-endian number — so no extra dependency.
 */
import { address, type Address, type Instruction, type ReadonlyUint8Array } from '@solana/kit';

export const COMPUTE_BUDGET_PROGRAM: Address = address('ComputeBudget111111111111111111111111111111');
/** The most compute a transaction may ask for. */
export const MAX_COMPUTE_UNITS = 1_400_000;
const SET_LIMIT = 2, SET_PRICE = 3;

/** At most `units` of compute for the whole transaction. */
export function computeLimit(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = SET_LIMIT;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM, data };
}

/** The priority fee: `microLamports` for each unit of compute asked for. */
export function computePrice(microLamports: bigint): Instruction {
  const data = new Uint8Array(9);
  data[0] = SET_PRICE;
  new DataView(data.buffer).setBigUint64(1, microLamports, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM, data };
}

/** The two instructions a dealer's transaction starts with. */
export function budget(units: number, microLamports: bigint): Instruction[] {
  return [computeLimit(units), computePrice(microLamports)];
}

/** A compute limit or price read back; null for anything else (another program or kind, accounts, a wrong length). */
export function readComputeBudget(ix: { programAddress: string; data?: ReadonlyUint8Array; accounts?: readonly unknown[] }):
  { kind: 'limit'; units: number } | { kind: 'price'; microLamports: bigint } | null {
  const d = ix.data;
  if (ix.programAddress !== COMPUTE_BUDGET_PROGRAM || !d || (ix.accounts?.length ?? 0) > 0) return null;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (d[0] === SET_LIMIT && d.length === 5) return { kind: 'limit', units: v.getUint32(1, true) };
  if (d[0] === SET_PRICE && d.length === 9) return { kind: 'price', microLamports: v.getBigUint64(1, true) };
  return null;
}
