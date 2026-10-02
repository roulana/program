/** Catalogue of every bet spot on a European table, plus table limits and bet validation. */

export type BetKind =
  | 'straight' | 'split' | 'street' | 'trio' | 'corner' | 'first-four' | 'line'
  | 'column' | 'dozen' | 'red' | 'black' | 'even' | 'odd' | 'low' | 'high';

export interface BetSpot {
  /** Stable id sent over the wire, e.g. "straight:17", "split:14-17", "corner:13". */
  readonly id: string;
  readonly kind: BetKind;
  /** Covered numbers, ascending. */
  readonly numbers: readonly number[];
  /** Winnings per unit staked (stake is returned on top). Always 36 / numbers.length - 1. */
  readonly payout: number;
}

export const TABLE_LIMITS = {
  /** Smallest unit any bet amount must be a multiple of (cents): chips are whole dollars. */
  minUnit: 100,
  /** Max total on a single-number spot ($100); other inside spots scale by numbers covered. */
  maxStraight: 10_000,
  /** Max total on an outside spot: column, dozen, red/black, even/odd, low/high ($2,000). */
  maxOutside: 200_000,
  /** Max total one player may have on the felt in one round ($10,000). */
  maxRoundTotal: 1_000_000,
  /** What a wallet needs in its safe to sit down ($20; the owner, 2026-10-01: "$20 ok"): a place at the table is a player's. */
  minToSit: 2_000,
} as const;

const OUTSIDE: ReadonlySet<BetKind> = new Set(['column', 'dozen', 'red', 'black', 'even', 'odd', 'low', 'high']);

export function isOutside(spot: BetSpot): boolean {
  return OUTSIDE.has(spot.kind);
}

function spot(id: string, kind: BetKind, numbers: number[]): BetSpot {
  const sorted = [...numbers].sort((a, b) => a - b);
  return { id, kind, numbers: sorted, payout: 36 / sorted.length - 1 };
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

function buildSpots(): BetSpot[] {
  const s: BetSpot[] = [];
  // Layout: 12 streets (s = 0..11) of 3 numbers each: 3s+1 (bottom row), 3s+2, 3s+3 (top row).
  for (let n = 0; n <= 36; n++) s.push(spot(`straight:${n}`, 'straight', [n]));
  for (const b of [1, 2, 3]) s.push(spot(`split:0-${b}`, 'split', [0, b]));
  for (let n = 1; n <= 36; n++) {
    if (n % 3 !== 0) s.push(spot(`split:${n}-${n + 1}`, 'split', [n, n + 1]));
    if (n <= 33) s.push(spot(`split:${n}-${n + 3}`, 'split', [n, n + 3]));
  }
  for (let st = 0; st < 12; st++) s.push(spot(`street:${st + 1}`, 'street', range(3 * st + 1, 3 * st + 3)));
  s.push(spot('trio:0-1-2', 'trio', [0, 1, 2]));
  s.push(spot('trio:0-2-3', 'trio', [0, 2, 3]));
  for (let n = 1; n <= 32; n++) {
    if (n % 3 !== 0) s.push(spot(`corner:${n}`, 'corner', [n, n + 1, n + 3, n + 4]));
  }
  s.push(spot('first-four', 'first-four', [0, 1, 2, 3]));
  for (let st = 0; st < 11; st++) s.push(spot(`line:${st + 1}`, 'line', range(3 * st + 1, 3 * st + 6)));
  for (const c of [1, 2, 3]) s.push(spot(`column:${c}`, 'column', range(1, 36).filter((n) => (n - c) % 3 === 0)));
  for (const d of [1, 2, 3]) s.push(spot(`dozen:${d}`, 'dozen', range(12 * (d - 1) + 1, 12 * d)));
  const red = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
  s.push(spot('red', 'red', red));
  s.push(spot('black', 'black', range(1, 36).filter((n) => !red.includes(n))));
  s.push(spot('even', 'even', range(1, 36).filter((n) => n % 2 === 0)));
  s.push(spot('odd', 'odd', range(1, 36).filter((n) => n % 2 === 1)));
  s.push(spot('low', 'low', range(1, 18)));
  s.push(spot('high', 'high', range(19, 36)));
  return s;
}

export const BET_SPOTS: readonly BetSpot[] = buildSpots();

const BY_ID = new Map(BET_SPOTS.map((b) => [b.id, b]));

export function getSpot(id: string): BetSpot | undefined {
  return BY_ID.get(id);
}

/** Maximum total one player may have on a spot. */
export function maxForSpot(spot: BetSpot): number {
  return isOutside(spot) ? TABLE_LIMITS.maxOutside : TABLE_LIMITS.maxStraight * spot.numbers.length;
}

export type BetErrorCode =
  | 'unknown_spot' | 'invalid_amount' | 'spot_limit' | 'round_limit' | 'insufficient_funds';

export interface BetContext {
  /** Amount the player already has on the target spot this round. */
  spotTotal: number;
  /** Amount the player already has staked this round, across all spots, excluding `amount`. */
  roundTotal: number;
  /** Cents the player can still commit: the value of their chips (for a move of an existing stack, the stack's value). */
  available: number;
}

export type BetCheck = { ok: true; spot: BetSpot } | { ok: false; code: BetErrorCode };

/** Validate adding `amount` cents to spot `spotId` for a player in context `ctx`. */
export function validateBet(spotId: string, amount: number, ctx: BetContext): BetCheck {
  for (const v of [ctx.spotTotal, ctx.roundTotal, ctx.available]) {
    // A corrupt context is a server bug; refuse loudly rather than let NaN comparisons approve the bet.
    if (!Number.isSafeInteger(v) || v < 0) throw new RangeError('bet context must hold non-negative integer cents');
  }
  const spot = getSpot(spotId);
  if (!spot) return { ok: false, code: 'unknown_spot' };
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount % TABLE_LIMITS.minUnit !== 0) {
    return { ok: false, code: 'invalid_amount' };
  }
  if (ctx.spotTotal + amount > maxForSpot(spot)) return { ok: false, code: 'spot_limit' };
  if (ctx.roundTotal + amount > TABLE_LIMITS.maxRoundTotal) return { ok: false, code: 'round_limit' };
  if (amount > ctx.available) return { ok: false, code: 'insufficient_funds' };
  return { ok: true, spot };
}
