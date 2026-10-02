/**
 * Helius Sender (mainnet): a fast lane that hands a transaction straight to the validators making the next blocks
 * through Helius's staked connections — 50 transactions a second (the plan's normal entrance takes 5), no API credits.
 * The SWQoS-only lane asks a tip of 0.000005 SOL inside every transaction, sent to one of Helius's tip addresses, beside a
 * priority fee. The dealer pays it, as it pays every network fee; a player never does.
 */
import { getTransferSolInstruction } from '@solana-program/system';
import { address, lamports, type Address, type Instruction, type ReadonlyUint8Array, type TransactionSigner } from '@solana/kit';

/** Helius's tip addresses (docs: Sender; each checked on Solana 2026-10-01: about 100 tips every few seconds). */
export const HELIUS_TIP_ACCOUNTS: readonly Address[] = [
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE', 'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ', '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
  '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn', '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD', '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
  'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF', '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT', '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
  '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
].map((a) => address(a));

/** The SWQoS-only lane's minimum tip: 0.000005 SOL. */
export const SENDER_TIP = 5_000n;
/** The most a tip beside a bet may be for the browser to sign it (0.0001 SOL; the dealer pays it, never the player). */
export const MAX_TIP = 100_000n;
/** Compute a SOL transfer takes (about 150), with room: added to a transaction's limit when it carries a tip. */
export const TIP_UNITS = 300;
/** The lowest priority fee (micro-lamports a unit) a transaction through Sender carries: Sender asks for one. */
export const SENDER_MIN_PRICE = 1_000n;
/**
 * Helius Sender's secure global address, the SWQoS-only lane (13–16 ms from this server on a kept connection). It takes
 * the plan's 50 a second only with our Helius key (?api-key=, measured 2026-10-01: without it about 1 a second), and
 * the key travels only over https — Frankfurt's regional address has none.
 */
export const SENDER_URL = 'https://sender.helius-rpc.com/fast?swqos_only=true';

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TIPS = new Set<string>(HELIUS_TIP_ACCOUNTS);

/** A tip from `payer` to one of the tip addresses (picked at random, so the tips spread over the ten). */
export function tipInstruction(payer: TransactionSigner, pick: () => number = Math.random): Instruction {
  const to = HELIUS_TIP_ACCOUNTS[Math.min(HELIUS_TIP_ACCOUNTS.length - 1, Math.floor(pick() * HELIUS_TIP_ACCOUNTS.length))]!;
  return getTransferSolInstruction({ source: payer, destination: to, amount: lamports(SENDER_TIP) });
}

/**
 * The instruction is a tip and nothing more: a System transfer (kind 2) of at most MAX_TIP lamports from `payer` to one
 * of Helius's tip addresses, with exactly those two accounts.
 */
export function isTip(ix: { programAddress: string; data?: ReadonlyUint8Array; accounts?: readonly { address: string }[] }, payer: string): boolean {
  const d = ix.data, accounts = ix.accounts ?? [];
  if (ix.programAddress !== SYSTEM_PROGRAM || !d || d.length !== 12 || accounts.length !== 2) return false;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength), amount = v.getBigUint64(4, true);
  return v.getUint32(0, true) === 2 && amount > 0n && amount <= MAX_TIP && accounts[0]!.address === payer && TIPS.has(accounts[1]!.address);
}
