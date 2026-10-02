/**
 * Checking a round with money on it from Solana alone — what roulana.com/verify runs in the visitor's browser (and
 * verify-round.py on their computer). A round's record is closed after payout, so everything comes from its transaction
 * history: the fingerprint (open_round), the bets (place_bets), the lock (lock_round), the seed (reveal) and the program's
 * receipt in the reveal's log (the number, the block mixed in and that block's hash). Only successful transactions of the
 * Roulana program that name the round count, and a receipt counts only when printed inside the program's own invocation.
 */
import { getBase58Encoder } from '@solana/kit';
import { commitmentOf, deriveOutcome, roundKey } from './engine';
import {
  FORFEIT_DISCRIMINATOR, LOCK_ROUND_DISCRIMINATOR, OPEN_ROUND_DISCRIMINATOR, PLACE_BETS_DISCRIMINATOR, REVEAL_DISCRIMINATOR, VOID_ROUND_DISCRIMINATOR,
} from './generated';

export interface RoundIx { program: string; accounts: string[]; data: Uint8Array }
/** A token account's balance before and after a transaction, as Solana reports it. */
export interface TokenChange { account: string; before: bigint; after: bigint }
export interface RoundTx { signature: string; slot: number; blockTime: number | null; ok: boolean; instructions: RoundIx[]; logs: string[]; tokens?: TokenChange[] }

export type Receipt =
  | { id: bigint; kind: 'revealed'; number: number; throwIndex: number; block: number; hash: Uint8Array }
  | { id: bigint; kind: 'forfeited' | 'voided' };

export type StepKey = 'table' | 'sealed' | 'closed' | 'seed' | 'block' | 'number';
export interface Step {
  key: StepKey;
  state: 'pass' | 'fail' | 'none';
  /** The transaction the step reads (its slot, time and signature, for an explorer link). */
  slot?: number; time?: number | null; signature?: string;
  /** What the step compares with: the first bet (sealed), the lock (block). */
  other?: { slot: number; time: number | null };
  /** The block mixed in (block), the number the program published (number). */
  value?: number;
  /** The number the formula gives (number). */
  computed?: number;
}
export interface RoundCheck {
  round: string;
  id: bigint | null;
  outcome: 'revealed' | 'forfeited' | 'voided' | 'running' | 'unknown';
  number: number | null;
  steps: Step[];
  verdict: 'checked' | 'failed' | 'partial' | 'not-a-round';
  /** The values read from Solana (hex), to recompute by hand; null when this is not a round of the table. */
  raw: { id: bigint | null; commitment: string; seed: string | null; block: number | null; hash: string | null } | null;
}

type Kind = 'open' | 'bets' | 'lock' | 'reveal' | 'forfeit' | 'void';
const KINDS: [Kind, Uint8Array][] = [
  ['open', OPEN_ROUND_DISCRIMINATOR as Uint8Array], ['bets', PLACE_BETS_DISCRIMINATOR as Uint8Array], ['lock', LOCK_ROUND_DISCRIMINATOR as Uint8Array],
  ['reveal', REVEAL_DISCRIMINATOR as Uint8Array], ['forfeit', FORFEIT_DISCRIMINATOR as Uint8Array], ['void', VOID_ROUND_DISCRIMINATOR as Uint8Array],
];
const kindOf = (data: Uint8Array): Kind | null => KINDS.find(([, d]) => d.every((b, i) => data[i] === b))?.[0] ?? null;
/** Where each instruction names the table and the round. The program checks both (the round is the table's), so only an
 * instruction with this round and this table in these places concerns them — anyone may append any address to their own
 * transactions, and anyone may open rounds on a table of their own in the same program. */
const AT: Record<Kind, { table: number; round: number }> = {
  open: { table: 1, round: 2 }, bets: { table: 2, round: 3 }, lock: { table: 1, round: 2 },
  reveal: { table: 0, round: 1 }, forfeit: { table: 0, round: 1 }, void: { table: 0, round: 1 },
};
/** What a Roulana instruction in a successful transaction does to this round of this table, if anything. */
function kindFor(i: RoundIx, o: { program: string; table: string; round: string }): Kind | null {
  if (i.program !== o.program) return null;
  const k = kindOf(i.data);
  return k && i.accounts[AT[k].round] === o.round && i.accounts[AT[k].table] === o.table ? k : null;
}
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

const REVEALED = /^receipt: round (\d{1,20}) number (\d{1,2}) throw (\d{1,10}) block (\d{1,20}) hash ([0-9a-f]{64})$/;
const ENDED = /^receipt: round (\d{1,20}) (forfeited|voided)$/;

/** The program's receipt in a transaction's log: only a line printed inside `program`'s own (outermost) invocation. */
export function receiptOf(logs: readonly string[], program: string): Receipt | null {
  const stack: string[] = [];
  for (const line of logs) {
    const invoke = /^Program (\w+) invoke \[\d+\]$/.exec(line);
    if (invoke) { stack.push(invoke[1]!); continue; }
    if (/^Program \w+ (success|failed)/.test(line)) { stack.pop(); continue; }
    if (stack.length !== 1 || stack[0] !== program || !line.startsWith('Program log: receipt: ')) continue;
    const text = line.slice('Program log: '.length);
    const r = REVEALED.exec(text);
    if (r) {
      const number = Number(r[2]);
      if (number > 36) return null;
      const hash = Uint8Array.from(r[5]!.match(/../g)!, (h) => parseInt(h, 16));
      return { id: BigInt(r[1]!), kind: 'revealed', number, throwIndex: Number(r[3]), block: Number(r[4]), hash };
    }
    const e = ENDED.exec(text);
    if (e) return { id: BigInt(e[1]!), kind: e[2] as 'forfeited' | 'voided' };
    return null;
  }
  return null;
}

/** The checks of one round, from its transactions (any order). */
export function checkRound(o: { program: string; table: string; round: string }, txs: readonly RoundTx[]): RoundCheck {
  const ours = [...txs].filter((t) => t.ok).sort((a, b) => a.slot - b.slot).flatMap((t) =>
    t.instructions.map((i) => ({ t, i, kind: kindFor(i, o) })).filter((x) => x.kind !== null));
  const first = (k: Kind) => ours.find((x) => x.kind === k);
  const open = first('open');
  if (!open) return { round: o.round, id: null, outcome: 'unknown', number: null, steps: [], verdict: 'not-a-round', raw: null };
  const at = (x: { t: RoundTx }) => ({ slot: x.t.slot, time: x.t.blockTime, signature: x.t.signature });
  const raw: NonNullable<RoundCheck['raw']> = { id: null, commitment: hex(open.i.data.slice(8, 40)), seed: null, block: null, hash: null };
  const finish = (id: bigint | null, outcome: RoundCheck['outcome'], number: number | null, steps: Step[]): RoundCheck => {
    const verdict = steps.some((s) => s.state === 'fail') ? 'failed' : steps.some((s) => s.state === 'none') || outcome === 'running' ? 'partial' : 'checked';
    return { round: o.round, id, outcome, number, steps, verdict, raw: { ...raw, id } };
  };
  const steps: Step[] = [{ key: 'table', state: 'pass', ...at(open) }];

  const firstBet = first('bets')?.t;
  // a bet in the same block as the opening comes after it (the program takes no bet on a round that is not open)
  steps.push({ key: 'sealed', state: !firstBet || open.t.slot <= firstBet.slot ? 'pass' : 'fail', ...at(open), ...(firstBet ? { other: { slot: firstBet.slot, time: firstBet.blockTime } } : {}) });

  const voided = first('void');
  if (voided) return finish(receiptOf(voided.t.logs, o.program)?.id ?? null, 'voided', null, steps);
  const lock = first('lock');
  if (!lock) return finish(null, 'running', null, [...steps, { key: 'closed', state: 'none' }]);
  steps.push({ key: 'closed', state: 'pass', ...at(lock) });
  const forfeit = first('forfeit');
  if (forfeit) return finish(receiptOf(forfeit.t.logs, o.program)?.id ?? null, 'forfeited', null, steps);
  const reveal = first('reveal');
  if (!reveal) return finish(null, 'running', null, steps);

  const seed = reveal.i.data.slice(8, 40);
  const commitment = open.i.data.slice(8, 40);
  raw.seed = hex(seed);
  steps.push({ key: 'seed', state: seed.length === 32 && same(commitmentOf(seed), commitment) ? 'pass' : 'fail', ...at(reveal) });
  const receipt = receiptOf(reveal.t.logs, o.program);
  if (!receipt || receipt.kind !== 'revealed') {
    steps.push({ key: 'block', state: 'none', ...at(reveal) }, { key: 'number', state: 'none', ...at(reveal) });
    return finish(null, 'revealed', null, steps);
  }
  raw.block = receipt.block;
  raw.hash = hex(receipt.hash);
  steps.push({ key: 'block', state: receipt.block >= lock.t.slot + 2 ? 'pass' : 'fail', ...at(reveal), value: receipt.block, other: { slot: lock.t.slot, time: lock.t.blockTime } });
  const computed = seed.length === 32 ? deriveOutcome(roundKey(seed, receipt.hash), receipt.id, 1).number : -1;
  steps.push({ key: 'number', state: computed === receipt.number ? 'pass' : 'fail', ...at(reveal), value: receipt.number, computed });
  return finish(receipt.id, 'revealed', receipt.number, steps);
}

const NO_RECEIPT = 'The program started keeping this for good on 25 September 2026; for older rounds';

/** One step in plain words; `when` formats a Solana block time (seconds). */
export function stepText(s: Step, _c: RoundCheck, when: (t: number | null) => string): string {
  const t = when(s.time ?? null);
  switch (s.key) {
    case 'table': return 'This round belongs to Roulana’s table.';
    case 'sealed':
      if (!s.other) return `The fingerprint was sealed on Solana at ${t}, before any bet.`;
      return s.state === 'pass'
        ? `The fingerprint was sealed on Solana at ${t}, before the first bet (${when(s.other.time)}).`
        : `The fingerprint was sealed at ${t}, AFTER a bet (${when(s.other.time)}).`;
    case 'closed': return s.state === 'pass' ? `Betting closed at ${t}.` : 'Betting has not closed yet.';
    case 'seed': return s.state === 'pass' ? `The seed revealed at ${t} matches the fingerprint.` : `The seed revealed at ${t} does NOT match the fingerprint.`;
    case 'block':
      if (s.state === 'none') return `${NO_RECEIPT} the block mixed in can’t be checked.`;
      return s.state === 'pass'
        ? `The block mixed in (${s.value}) was made after betting closed (${s.other!.slot}).`
        : `The block mixed in (${s.value}) was NOT made after betting closed (${s.other!.slot}).`;
    case 'number':
      if (s.state === 'none') return `${NO_RECEIPT} the number can’t be recomputed from Solana alone.`;
      return s.state === 'pass'
        ? `The formula gives ${s.computed}, the number the program published and paid.`
        : `The formula gives ${s.computed}, but the program published ${s.value}.`;
  }
}

/** What happened to the round, in plain words (the verdict line). */
export function outcomeText(c: RoundCheck): string {
  if (c.verdict === 'not-a-round') return 'This is not a round of Roulana’s table: no opening of a Roulana round was found in its history.';
  if (c.outcome === 'forfeited') return 'Betting closed but the number was not published in time: the round was cancelled, and every bet went back to its safe.';
  if (c.outcome === 'voided') return 'The round was called off before betting closed: every stake went back.';
  if (c.outcome === 'running') return 'This round is still running: check again in a minute.';
  if (c.verdict === 'failed') return 'A check FAILED.';
  if (c.verdict === 'partial') return `Checked as far as Solana allows for this round: the number was ${c.number ?? 'published before the receipt existed'}.`;
  return `Every check passed: the number was ${c.number}.`;
}

/** The Solana node did not answer (busy, down, or the transaction is not there yet): try again later — never a guess. */
export class SolanaUnavailable extends Error {}
/** More transactions name the address than a public node lets a browser read: "could not check", never a guess. */
export class TooManyTransactions extends Error {}

/**
 * Reads before the round's opening is found. Its address is predictable, so others may put transactions before its
 * opening: with more than this many and no opening among them, the round could not be checked (never "not a round").
 */
const BEFORE_OPEN = 20;
/** Reads in all, and pages of the address's history. */
const MAX_READS = 60, MAX_PAGES = 5;

/** A Solana address (base58, 32 bytes) — what a round's link carries. */
export function isRoundAddress(s: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try { return getBase58Encoder().encode(s).length === 32; } catch { return false; }
}

interface RpcTx {
  slot: number; blockTime: number | null;
  meta: {
    err: unknown; logMessages?: string[] | null; loadedAddresses?: { writable: string[]; readonly: string[] };
    preTokenBalances?: TokenBalance[] | null; postTokenBalances?: TokenBalance[] | null;
  } | null;
  transaction: { message: { accountKeys: string[]; instructions: { programIdIndex: number; accounts: number[]; data: string }[] } };
}

interface TokenBalance { accountIndex: number; uiTokenAmount: { amount: string } }

/** Token balances before and after, by account; an account missing on one side had 0 there. */
export function tokenChanges(keys: readonly string[], meta: { preTokenBalances?: TokenBalance[] | null; postTokenBalances?: TokenBalance[] | null }): TokenChange[] {
  const out = new Map<string, TokenChange>();
  const at = (i: number) => {
    const account = keys[i]!;
    let c = out.get(account);
    if (!c) out.set(account, (c = { account, before: 0n, after: 0n }));
    return c;
  };
  for (const b of meta.preTokenBalances ?? []) at(b.accountIndex).before = BigInt(b.uiTokenAmount.amount);
  for (const b of meta.postTokenBalances ?? []) at(b.accountIndex).after = BigInt(b.uiTokenAmount.amount);
  return [...out.values()];
}

/**
 * A round's transactions from any Solana node's JSON-RPC, oldest first. A public node allows about 10 transaction reads
 * per 10 seconds, so it reads as little as the checks need: never a failed transaction (it never counts), and — given the
 * program — nothing after the round's end (reveal, forfeit or void: the payouts and closing that follow are not checked).
 * A busy node is waited for (as long as it asks, up to about half a minute in all), one read at a time.
 */
export async function fetchRoundTxs(rpcUrl: string, round: string, o: {
  fetch?: typeof fetch; pause?: number; program?: string; table?: string; progress?: (done: number, total: number) => void;
  /** Milliseconds a single answer may take (a hung connection must not leave the page reading for ever). */
  timeout?: number; pageSize?: number;
} = {}): Promise<RoundTx[]> {
  const f = o.fetch ?? fetch, pause = o.pause ?? 500, pageSize = o.pageSize ?? 1000;
  let n = 0;
  const call = async (method: string, params: unknown[]): Promise<unknown> => {
    let wait = 0, unreachable = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      if (attempt && pause) await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(8_000, pause * 2 ** attempt);
      let res: Response;
      try {
        res = await f(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }), signal: AbortSignal.timeout(o.timeout ?? 20_000) });
      } catch {
        if (++unreachable >= 3) break;                 // not busy but unreachable: no point waiting half a minute
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        const after = Number(res.headers.get('retry-after'));
        if (after > 0) wait = Math.min(10_000, after * 1000);
        continue;
      }
      if (!res.ok) throw new SolanaUnavailable(`Solana answered ${res.status}`);
      const j = (await res.json()) as { result?: unknown; error?: unknown };
      if (j.error !== undefined) continue;
      return j.result;
    }
    throw new SolanaUnavailable('Solana did not answer');
  };
  type Sig = { signature: string; slot: number; err: unknown };
  const sigs: Sig[] = [];
  for (let page = 0; ; page++) {
    if (page === MAX_PAGES) throw new TooManyTransactions(`more than ${MAX_PAGES * pageSize} transactions name this address`);
    const before = sigs.at(-1)?.signature;
    const got = ((await call('getSignaturesForAddress', [round, { limit: pageSize, commitment: 'confirmed', ...(before ? { before } : {}) }])) as Sig[] | null) ?? [];
    sigs.push(...got);
    if (got.length < pageSize) break;
  }
  const wanted = sigs.filter((s) => s.err === null).sort((a, b) => a.slot - b.slot);
  const b58 = getBase58Encoder();
  const who = o.program && o.table ? { program: o.program, table: o.table, round } : null;
  let opened = false;
  const out: RoundTx[] = [];
  o.progress?.(0, wanted.length);
  for (const { signature } of wanted) {
    if (who && !opened && out.length === BEFORE_OPEN) throw new TooManyTransactions(`no opening among the first ${BEFORE_OPEN} transactions`);
    if (out.length === MAX_READS) throw new TooManyTransactions(`more than ${MAX_READS} transactions to read`);
    const t = (await call('getTransaction', [signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }])) as RpcTx | null;
    if (!t || !t.meta) throw new SolanaUnavailable(`Solana does not have transaction ${signature} yet`);
    const keys = [...t.transaction.message.accountKeys, ...(t.meta.loadedAddresses?.writable ?? []), ...(t.meta.loadedAddresses?.readonly ?? [])];
    const tx: RoundTx = {
      signature, slot: t.slot, blockTime: t.blockTime ?? null, ok: t.meta.err === null, logs: t.meta.logMessages ?? [],
      instructions: t.transaction.message.instructions.map((ix) => ({ program: keys[ix.programIdIndex]!, accounts: ix.accounts.map((k) => keys[k]!), data: b58.encode(ix.data) as Uint8Array })),
      tokens: tokenChanges(keys, t.meta),
    };
    out.push(tx);
    o.progress?.(out.length, wanted.length);
    if (!who || !tx.ok) continue;
    const kinds = tx.instructions.map((i) => kindFor(i, who));
    if (kinds.includes('open')) opened = true;
    if (opened && kinds.some((k) => k === 'reveal' || k === 'forfeit' || k === 'void')) break;
  }
  return out;
}
