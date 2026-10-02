/**
 * How the game talks to Solana: the real network (rpc.ts) or a simulated one in tests (testing/litesvm-port.ts).
 * Everything else — the server's dealer, the browser's wallet actions — only sees this interface.
 */
import {
  SOLANA_ERROR__INSTRUCTION_ERROR__COMPUTATIONAL_BUDGET_EXCEEDED, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM, isSolanaError,
  type Address, type Base64EncodedWireTransaction, type Blockhash, type Instruction, type TransactionSigner,
} from '@solana/kit';

/** Base units of test USDC per dollar (6 decimals, like USDC). */
export const USD = 1_000_000n;

export interface Lifetime { blockhash: Blockhash; lastValidBlockHeight: bigint }

/** Program accounts (of exactly `size` bytes, when given) whose data holds the address `bytes` at `offset`. */
export interface ProgramAccountFilter { size?: number; offset: number; bytes: Address }

export interface SolanaPort {
  /**
   * Signs with `payer` (who pays the fee) and every signer inside the instructions, sends, and resolves with the
   * signature once confirmed. With `units`, the transaction starts with a compute limit of `units` and the priority fee:
   * `fee` (micro-lamports a compute unit) when given, else the usual one.
   */
  send(payer: TransactionSigner, ixs: Instruction[], units?: number, fee?: bigint): Promise<string>;
  /** Sends a transaction that is already fully signed; resolves with its signature once confirmed. */
  sendWire(wire: Base64EncodedWireTransaction): Promise<string>;
  /** Waits for a transaction someone else sent (a phone wallet that signs and sends): its signature once confirmed. */
  confirmed(signature: string): Promise<string>;
  /** A recent blockhash to build a transaction on. */
  lifetime(): Promise<Lifetime>;
  /** An account's data (confirmed), or null when it does not exist. */
  account(a: Address): Promise<Uint8Array | null>;
  /** Many accounts' data in as few requests as the node allows (100 a request), in order; null for one that does not exist. */
  accounts(list: readonly Address[]): Promise<(Uint8Array | null)[]>;
  /** Lamports held by an address. */
  sol(a: Address): Promise<bigint>;
  /** The roulette program's accounts matching `f` (confirmed): one getProgramAccounts call. */
  programAccounts(f: ProgramAccountFilter): Promise<{ address: Address; data: Uint8Array }[]>;
}

/** The program (or the runtime) refused a transaction. `code` is the program's custom error (6000 + …) when there is one. */
export class ProgramError extends Error {
  constructor(readonly code: number | null, detail: string) {
    super(`transaction failed (code ${code}): ${detail}`);
  }
}

const json = (v: unknown) => { try { return JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? Number(x) : x)) ?? ''; } catch { return ''; } };

/**
 * The transaction ran out of the compute it asked for — in the node's simulation, on chain, or in the simulator — in
 * any shape the error comes in (kit's SolanaError chain, the runtime's error, the program log).
 */
export function budgetExceeded(err: unknown): boolean {
  for (let e = err as { cause?: unknown; context?: unknown; message?: unknown } | undefined, depth = 0; e && depth < 8; e = e.cause as typeof e, depth++) {
    if (isSolanaError(e, SOLANA_ERROR__INSTRUCTION_ERROR__COMPUTATIONAL_BUDGET_EXCEEDED)) return true;
    if (/ComputationalBudgetExceeded|Computational budget exceeded|exceeded CUs meter/.test(`${String(e.message ?? '')} ${json(e.context ?? e)}`)) return true;
  }
  return false;
}

/** The custom program error inside any shape a Solana error comes in (kit's SolanaError chain, or `{"Custom": n}` anywhere), or null. */
export function customCode(err: unknown): number | null {
  for (let e = err as { cause?: unknown; context?: unknown } | undefined, depth = 0; e && depth < 8; e = e.cause as typeof e, depth++) {
    if (isSolanaError(e, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM)) return Number(e.context.code);
    const m = /"Custom"\s*:\s*(\d+)/.exec(json(e.context ?? e));
    if (m) return Number(m[1]);
  }
  return null;
}
