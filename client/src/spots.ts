/** Bet spots on-chain are numbered by their position in the engine's catalogue (0 … 156). */
import { BET_SPOTS } from './engine';

const INDEX = new Map(BET_SPOTS.map((s, i) => [s.id, i]));

export function spotIndex(id: string): number {
  const i = INDEX.get(id);
  if (i === undefined) throw new RangeError(`unknown spot ${id}`);
  return i;
}

export function spotId(index: number): string {
  const s = BET_SPOTS[index];
  if (!s) throw new RangeError(`unknown spot index ${index}`);
  return s.id;
}
