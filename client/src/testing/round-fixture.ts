/**
 * A round's transactions as Solana keeps them, built with the program's real instruction encoders and log shapes: for the
 * checks (verify.ts), for reading them over JSON-RPC (the `rpc` answers getSignaturesForAddress and getTransaction the way a
 * Solana node does, encoding json), and for the verify-round.py script's tests.
 */
import { getBase58Decoder } from '@solana/kit';
import { commitmentOf, deriveOutcome, roundKey } from '../engine';
import {
  ROULETTE_PROGRAM_ADDRESS, getCloseBetsInstructionDataEncoder, getCloseRoundInstructionDataEncoder, getForfeitInstructionDataEncoder,
  getLockRoundInstructionDataEncoder, getOpenRoundInstructionDataEncoder, getPlaceBetsInstructionDataEncoder, getRevealInstructionDataEncoder,
  getSettleInstructionDataEncoder, getVoidRoundInstructionDataEncoder,
} from '../generated';
import type { RoundTx } from '../verify';

const b58 = (b: Uint8Array) => getBase58Decoder().decode(b);
/** A made-up address: 32 bytes of `n` (never a real key). */
export const fakeAddress = (n: number) => b58(new Uint8Array(32).fill(n));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';

export interface RoundFixture {
  program: string; table: string; round: string; id: bigint; seed: Uint8Array; hash: Uint8Array; number: number;
  lockSlot: number; txs: RoundTx[];
  /** A Solana node's JSON-RPC answer for the round's history (other addresses have none). */
  rpc: (method: string, params: unknown[]) => unknown;
}

export interface FixtureOptions {
  players?: number; id?: bigint; seed?: Uint8Array; hash?: Uint8Array;
  /** false: a round from before the receipt existed. */
  receipt?: boolean;
  outcome?: 'revealed' | 'forfeited' | 'voided' | 'running';
  tamper?: 'seed' | 'block' | 'foreign-receipt' | 'failed-reveal' | 'late-seal' | 'other-table';
  /** Attacks by others, all with the round's address appended to their own transactions (Solana allows it, the program
   * ignores extra accounts): 'copycat' — open, lock and reveal of a round on the attacker's own table (anyone can make one
   * with their own mint), before the real round, naming this round and Roulana's table, with a real receipt for another
   * number; 'appended-bet' — a real bet on the previous round with this round appended, before this round opens. */
  attack?: 'copycat' | 'appended-bet';
  /** Transactions of other programs naming the round's address: before it opens (its address is predictable), and
   * between its lock and its reveal. */
  spamBefore?: number; spamBetween?: number;
}

export function roundFixture(o: FixtureOptions = {}): RoundFixture {
  const program = ROULETTE_PROGRAM_ADDRESS as string;
  const table = fakeAddress(7), round = fakeAddress(8), dealer = fakeAddress(9);
  const id = o.id ?? 2311n;
  const seed = o.seed ?? Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 255);
  const hash = o.hash ?? Uint8Array.from({ length: 32 }, (_, i) => (i * 91 + 200) & 255);
  const number = deriveOutcome(roundKey(seed, hash), id, 299).number;
  const throwIndex = deriveOutcome(roundKey(seed, hash), id, 299).throwIndex;
  const outcome = o.outcome ?? 'revealed';
  const players = o.players ?? 2;
  const base = 503_874_900, time = 1_790_000_000;
  const lockSlot = base + 30;
  let n = 0;
  const txs: RoundTx[] = [];
  const add = (slot: number, ix: { accounts: string[]; data: Uint8Array; name: string; log?: string[] }[], ok = true, logProgram = program) => {
    n++;
    const logs: string[] = [];
    for (const i of ix) {
      logs.push(`Program ${program} invoke [1]`, `Program log: Instruction: ${i.name}`);
      if (i.log && logProgram === program) logs.push(...i.log);
      logs.push(`Program ${program} consumed ${40_000 + n} of 200000 compute units`, ok ? `Program ${program} success` : `Program ${program} failed: custom program error: 0x1771`);
      if (i.log && logProgram !== program) logs.push(`Program ${logProgram} invoke [1]`, ...i.log, `Program ${logProgram} success`);
    }
    txs.push({
      signature: b58(Uint8Array.from({ length: 64 }, (_, k) => (k * 7 + n * 13) & 255)), slot, blockTime: time + Math.round((slot - base) / 2.5), ok,
      instructions: ix.map((i) => ({ program, accounts: i.accounts, data: i.data })), logs,
    });
  };

  const commitment = o.tamper === 'seed' ? commitmentOf(seed.map((x, i) => (i === 0 ? x ^ 1 : x))) : commitmentOf(seed);
  const openTable = o.tamper === 'other-table' ? fakeAddress(6) : table;
  // the program's account order: payer, session key, table, round, session, safe, round bets, system program
  const bet = (p: number, r = round) => ({ name: 'PlaceBets', accounts: [fakeAddress(20 + p), fakeAddress(40 + p), openTable, r, fakeAddress(60 + p), fakeAddress(100 + p), fakeAddress(80 + p), '11111111111111111111111111111111'], data: getPlaceBetsInstructionDataEncoder().encode({ bets: [{ spot: 17, dollars: 10 }] }) as Uint8Array });
  const spam = (slot: number) => {
    n++;
    txs.push({ signature: b58(Uint8Array.from({ length: 64 }, (_, k) => (k * 5 + n * 17 + 3) & 255)), slot, blockTime: time + Math.round((slot - base) / 2.5), ok: true,
      instructions: [{ program: '11111111111111111111111111111111', accounts: [fakeAddress(30), round], data: new Uint8Array([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) }],
      logs: ['Program 11111111111111111111111111111111 invoke [1]', 'Program 11111111111111111111111111111111 success'] });
  };
  for (let k = 0; k < (o.spamBefore ?? 0); k++) spam(base - 200 + k);
  if (o.attack === 'copycat') {
    const t2 = fakeAddress(5), r2 = fakeAddress(4), seed2 = new Uint8Array(32).fill(3), hash2 = new Uint8Array(32).fill(4);
    const n2 = deriveOutcome(roundKey(seed2, hash2), 1n, 299);
    const extra = [round, table];
    add(base - 60, [{ name: 'OpenRound', accounts: [fakeAddress(31), t2, r2, '11111111111111111111111111111111', ...extra], data: getOpenRoundInstructionDataEncoder().encode({ commitment: commitmentOf(seed2) }) as Uint8Array }]);
    add(base - 40, [{ name: 'LockRound', accounts: [fakeAddress(31), t2, r2, ...extra], data: getLockRoundInstructionDataEncoder().encode({}) as Uint8Array }]);
    add(base - 37, [{ name: 'Reveal', accounts: [t2, r2, 'SysvarS1otHashes111111111111111111111111111', fakeAddress(32), fakeAddress(33), fakeAddress(34), ...extra], data: getRevealInstructionDataEncoder().encode({ seed: seed2 }) as Uint8Array,
      log: [`Program log: receipt: round 1 number ${n2.number} throw ${n2.throwIndex} block ${base - 38} hash ${hex(hash2)}`] }]);
  }
  if (o.attack === 'appended-bet') add(base - 3, [{ ...bet(9, fakeAddress(2)), accounts: [...bet(9, fakeAddress(2)).accounts, round] }]);
  const open = { name: 'OpenRound', accounts: [dealer, openTable, round, '11111111111111111111111111111111'], data: getOpenRoundInstructionDataEncoder().encode({ commitment }) as Uint8Array };
  if (o.tamper === 'late-seal') { add(base - 5, [bet(0)]); add(base, [open]); } else add(base, [open]);
  for (let p = o.tamper === 'late-seal' ? 1 : 0; p < players; p++) add(base + 10 + p, [bet(p)]);
  if (outcome === 'voided') {
    add(base + 1500, [{ name: 'VoidRound', accounts: [openTable, round], data: getVoidRoundInstructionDataEncoder().encode({}) as Uint8Array, log: [`Program log: receipt: round ${id} voided`] }]);
  } else if (outcome !== 'running') {
    add(lockSlot, [{ name: 'LockRound', accounts: [dealer, openTable, round], data: getLockRoundInstructionDataEncoder().encode({}) as Uint8Array }]);
    if (outcome === 'forfeited') {
      add(lockSlot + 300, [{ name: 'Forfeit', accounts: [openTable, round], data: getForfeitInstructionDataEncoder().encode({}) as Uint8Array, log: [`Program log: receipt: round ${id} forfeited`] }]);
    } else {
      const block = o.tamper === 'block' ? lockSlot + 1 : lockSlot + 2;
      const receipt = o.receipt === false ? [] : [`Program log: receipt: round ${id} number ${number} throw ${throwIndex} block ${block} hash ${hex(hash)}`];
      const reveal = { name: 'Reveal', accounts: [openTable, round, 'SysvarS1otHashes111111111111111111111111111', fakeAddress(10), fakeAddress(11), fakeAddress(12)], data: getRevealInstructionDataEncoder().encode({ seed }) as Uint8Array, log: receipt };
      for (let k = 0; k < (o.spamBetween ?? 0); k++) spam(lockSlot + 1);
      if (o.tamper === 'failed-reveal') add(lockSlot + 3, [reveal], false);
      else add(lockSlot + 3, [reveal], true, o.tamper === 'foreign-receipt' ? fakeAddress(99) : program);
      for (let p = 0; p < players; p++) add(lockSlot + 10 + p, [
        { name: 'Settle', accounts: [openTable, round, fakeAddress(80 + p), fakeAddress(60 + p)], data: getSettleInstructionDataEncoder().encode({}) as Uint8Array },
        { name: 'CloseBets', accounts: [fakeAddress(80 + p), dealer], data: getCloseBetsInstructionDataEncoder().encode({}) as Uint8Array },
      ]);
      add(lockSlot + 20, [{ name: 'CloseRound', accounts: [openTable, round, dealer], data: getCloseRoundInstructionDataEncoder().encode({}) as Uint8Array }]);
    }
  }

  const rpc = (method: string, params: unknown[]): unknown => {
    if (method === 'getSignaturesForAddress') {
      // newest first, `limit` at a time, older than `before` when given — as a Solana node pages an address's history
      const { limit = 1000, before } = (params[1] ?? {}) as { limit?: number; before?: string };
      const named = [...txs].filter((t) => t.instructions.some((i) => i.accounts.includes(params[0] as string))).sort((a, b) => b.slot - a.slot);
      const from = before ? named.findIndex((t) => t.signature === before) + 1 : 0;
      return named.slice(from, from + limit).map((t) => ({ signature: t.signature, slot: t.slot, err: t.ok ? null : { InstructionError: [0, { Custom: 6001 }] }, blockTime: t.blockTime, memo: null, confirmationStatus: 'finalized' }));
    }
    if (method === 'getTransaction') {
      const t = txs.find((x) => x.signature === params[0]);
      if (!t) return null;
      // version 0: the first bet's accounts after the dealer arrive through a lookup table (loadedAddresses), as on Solana
      const lookup = t === txs[1];
      const keys: string[] = [t.instructions[0]!.accounts[0]!, COMPUTE_BUDGET];
      for (const i of t.instructions) if (!keys.includes(i.program)) keys.push(i.program);
      const loaded: string[] = [];
      for (const i of t.instructions) for (const a of i.accounts) {
        if (keys.includes(a) || loaded.includes(a)) continue;
        (lookup ? loaded : keys).push(a);
      }
      const all = [...keys, ...loaded];
      const instructions = [{ programIdIndex: 1, accounts: [], data: '3DTZbgwsozUF', stackHeight: null }, ...t.instructions.map((i) => ({
        programIdIndex: all.indexOf(i.program), accounts: i.accounts.map((a) => all.indexOf(a)), data: b58(i.data), stackHeight: null,
      }))];
      return {
        slot: t.slot, blockTime: t.blockTime, version: 0,
        meta: { err: t.ok ? null : { InstructionError: [1, { Custom: 6001 }] }, logMessages: t.logs, loadedAddresses: { writable: loaded, readonly: [] }, fee: 5000 },
        transaction: { signatures: [t.signature], message: { accountKeys: keys, instructions, recentBlockhash: fakeAddress(1), header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 } } },
      };
    }
    throw new Error(`the fixture node does not answer ${method}`);
  };
  return { program, table, round, id, seed, hash, number, lockSlot, txs, rpc };
}
