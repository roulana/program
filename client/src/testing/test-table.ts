/** A ready table in the simulated Solana: test-USDC mint, table, investors' pool; players with a session. */
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getInitializeMint2Instruction, getMintSize, getMintToInstruction,
} from '@solana-program/token';
import { generateKeyPairSigner, type Address, type KeyPairSigner } from '@solana/kit';
import { getDepositInstruction, getInitTableInstruction, getInvestInstruction, getOpenSessionInstruction } from '../generated';
import { positionPda, programDataPda, safePda, sessionPda, tablePda, vaultPda } from '../pdas';
import type { Deployment } from '../devnet-types';
import { USD } from '../port';
import { LiteSvmPort, setUpgradeAuthority } from './litesvm-port';

export interface TestTable {
  port: LiteSvmPort; mint: Address; table: Address; vault: Address;
  owner: KeyPairSigner; dealer: KeyPairSigner; mintAuthority: KeyPairSigner; deployment: Deployment; throwCount: number;
  /** The public buyback wallet and its test-USDC account. */
  buyback: KeyPairSigner; buybackToken: Address;
}
export interface TestPlayer { wallet: KeyPairSigner; sessionKey: KeyPairSigner; token: Address }

export async function createTestTable(o: { throwCount?: number; pool?: number; feeBps?: number; bankLimitBps?: number } = {}): Promise<TestTable> {
  const port = LiteSvmPort.create();
  const owner = await port.signer(100n), dealer = await port.signer(100n), mint = await generateKeyPairSigner();
  await setUpgradeAuthority(port.svm, owner.address);                  // the owner sets the table up
  const space = BigInt(getMintSize());
  await port.send(owner, [
    getCreateAccountInstruction({ payer: owner, newAccount: mint, lamports: port.svm.minimumBalanceForRentExemption(space), space, programAddress: TOKEN_PROGRAM_ADDRESS }),
    getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: owner.address }),
  ]);
  const table = await tablePda(mint.address), vault = await vaultPda(table);
  const throwCount = o.throwCount ?? 299;
  const buyback = await port.signer(1n);
  const [buybackToken] = await findAssociatedTokenPda({ owner: buyback.address, mint: mint.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  await port.send(owner, [getCreateAssociatedTokenIdempotentInstruction({ payer: owner, owner: buyback.address, mint: mint.address, ata: buybackToken })]);
  await port.send(owner, [getInitTableInstruction({
    payer: owner, programData: await programDataPda(), mint: mint.address, table, vault, buybackToken, owner: owner.address, dealer: dealer.address,
    feeBps: o.feeBps ?? 100, bankLimitBps: o.bankLimitBps ?? 100, libraryHash: new Uint8Array(32), throwCount,
  })]);
  const t: TestTable = {
    port, mint: mint.address, table, vault, owner, dealer, mintAuthority: owner, throwCount, buyback, buybackToken,
    deployment: { programId: table /* unused by callers */ as never, mint: mint.address, table, vault, dealer: dealer.address, owner: owner.address, buyback: buyback.address, buybackToken },
  };
  const ownerToken = await tokenOf(t, owner.address, BigInt(o.pool ?? 1_000_000));
  if ((o.pool ?? 1_000_000) > 0) await port.send(owner, [getInvestInstruction({ investor: owner, table, mint: mint.address, vault, investorToken: ownerToken, position: await positionPda(table, owner.address), amount: BigInt(o.pool ?? 1_000_000) * USD })]);
  return t;
}

/** The token account of `owner` for the test USDC, created and topped up with `dollars`. */
export async function tokenOf(t: TestTable, owner: Address, dollars = 0n): Promise<Address> {
  const [ata] = await findAssociatedTokenPda({ owner, mint: t.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  await t.port.send(t.mintAuthority, [
    getCreateAssociatedTokenIdempotentInstruction({ payer: t.mintAuthority, owner, mint: t.mint, ata }),
    ...(dollars > 0n ? [getMintToInstruction({ mint: t.mint, token: ata, mintAuthority: t.mintAuthority, amount: dollars * USD })] : []),
  ]);
  return ata;
}

/** A player wallet with `deposit` dollars in its safe and a session key allowed `cap` dollars for `hours`. */
export async function testPlayer(t: TestTable, o: { deposit?: number; cap?: number; hours?: number } = {}): Promise<TestPlayer> {
  const wallet = await t.port.signer(), sessionKey = await generateKeyPairSigner();
  const deposit = BigInt(o.deposit ?? 1_000);
  const token = await tokenOf(t, wallet.address, deposit);
  await t.port.send(wallet, [
    ...(deposit > 0n ? [getDepositInstruction({ wallet, table: t.table, mint: t.mint, vault: t.vault, walletToken: token, safe: await safePda(t.table, wallet.address), amount: deposit * USD })] : []),
    getOpenSessionInstruction({ wallet, table: t.table, session: await sessionPda(t.table, wallet.address), key: sessionKey.address, cap: BigInt(o.cap ?? 500) * USD, expiresAt: BigInt(Math.floor(t.port.now() / 1000) + (o.hours ?? 4) * 3600) }),
  ]);
  return { wallet, sessionKey, token };
}
