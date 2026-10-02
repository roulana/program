/**
 * The Bank and Owner pages' side of the program: reading a table's investors, and the instructions an investor or the
 * owner signs with their own wallet. Nothing here decides money: the program checks every rule.
 */
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import type { Address, Instruction, TransactionSigner } from '@solana/kit';
import {
  getAcceptOwnerInstruction, getApplyBuybackInstruction, getApplyDealerInstruction, getExecuteWithdrawalInstruction, getInvestInstruction,
  getPositionDecoder, getPositionSize, getProposeBuybackInstruction, getProposeDealerInstruction, getProposeOwnerInstruction,
  getRequestWithdrawalInstruction, getSetBankLimitInstruction, getSetLibraryInstruction, getSetPausedInstruction,
  type Position,
} from './generated';
import { positionPda, vaultPda } from './pdas';
import type { SolanaPort } from './port';

/** Every investor position of `table` (the position's first field after the discriminator is its table). */
export async function tablePositions(port: SolanaPort, table: Address): Promise<{ address: Address; position: Position }[]> {
  const list = await port.programAccounts({ size: getPositionSize(), offset: 8, bytes: table });
  return list.map((a) => ({ address: a.address, position: getPositionDecoder().decode(a.data) }));
}

/** The table an action is for: its address and its USDC mint. */
export interface TableRef { table: Address; mint: Address }

const usdcOf = async (owner: Address, mint: Address) => (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];

/** Buys as many whole shares as `amount` of the investor's USDC pays for, and takes only what they cost (at least $100: the
 * program checks); the rest stays in the wallet. */
export async function investIx(t: TableRef, investor: TransactionSigner, amount: bigint): Promise<Instruction> {
  return getInvestInstruction({
    investor, table: t.table, mint: t.mint, vault: await vaultPda(t.table), investorToken: await usdcOf(investor.address, t.mint),
    position: await positionPda(t.table, investor.address), amount,
  });
}

/** Gives 24 hours' notice for `shares` (a new request restarts the notice for everything pending). */
export async function requestWithdrawalIx(t: TableRef, investor: TransactionSigner, shares: bigint): Promise<Instruction> {
  return getRequestWithdrawalInstruction({ investor, table: t.table, position: await positionPda(t.table, investor.address), shares });
}

/** After the notice, between rounds: pays the pending shares at the share value of that moment. */
export async function executeWithdrawalIx(t: TableRef, investor: TransactionSigner): Promise<Instruction> {
  return getExecuteWithdrawalInstruction({
    investor, table: t.table, mint: t.mint, vault: await vaultPda(t.table), investorToken: await usdcOf(investor.address, t.mint),
    position: await positionPda(t.table, investor.address),
  });
}

export function setPausedIx(t: TableRef, owner: TransactionSigner, paused: boolean): Instruction {
  return getSetPausedInstruction({ owner, table: t.table, paused });
}

/** The most one round may risk, in basis points of the bank (the program allows 50–200, only between rounds). */
export function setBankLimitIx(t: TableRef, owner: TransactionSigner, bps: number): Instruction {
  return getSetBankLimitInstruction({ owner, table: t.table, bps });
}

/** Names the set of spins the table shows (sha256 of its index and its size); only between rounds (the program checks). */
export function setLibraryIx(t: TableRef, owner: TransactionSigner, hash: Uint8Array, throwCount: number): Instruction {
  return getSetLibraryInstruction({ owner, table: t.table, hash, throwCount });
}

/** Names `dealer` the table's next dealer: it takes over 25 hours later (public meanwhile); naming the current dealer
 * calls a pending change off. */
export function proposeDealerIx(t: TableRef, owner: TransactionSigner, dealer: Address): Instruction {
  return getProposeDealerInstruction({ owner, table: t.table, dealer });
}

/** Anyone, once a named dealer is due: it becomes the dealer. */
export function applyDealerIx(t: TableRef): Instruction {
  return getApplyDealerInstruction({ table: t.table });
}

/** Names `wallet` the next owner; it takes over when it accepts (naming the current owner calls it off). */
export function proposeOwnerIx(t: TableRef, owner: TransactionSigner, wallet: Address): Instruction {
  return getProposeOwnerInstruction({ owner, table: t.table, newOwner: wallet });
}

/** Signed by the named owner: it takes the table over. */
export function acceptOwnerIx(t: TableRef, newOwner: TransactionSigner): Instruction {
  return getAcceptOwnerInstruction({ newOwner, table: t.table });
}

/** Proposes `wallet` as the new public buyback wallet; its USDC account is made first if missing (the owner pays the rent). */
export async function proposeBuybackIxs(t: TableRef, owner: TransactionSigner, wallet: Address): Promise<Instruction[]> {
  const token = await usdcOf(wallet, t.mint);
  return [
    getCreateAssociatedTokenIdempotentInstruction({ payer: owner, owner: wallet, mint: t.mint, ata: token }),
    getProposeBuybackInstruction({ owner, table: t.table, newBuybackToken: token }),
  ];
}

/** Cancels a pending change: proposing the current buyback account again. */
export function cancelBuybackIx(t: TableRef, owner: TransactionSigner, current: Address): Instruction {
  return getProposeBuybackInstruction({ owner, table: t.table, newBuybackToken: current });
}

/** Anyone, 7 days after a proposal: the proposed account becomes the buyback account. */
export function applyBuybackIx(t: TableRef): Instruction {
  return getApplyBuybackInstruction({ table: t.table });
}
