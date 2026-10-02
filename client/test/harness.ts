/**
 * A simulated Solana (LiteSVM) with the roulette program loaded, and helpers to send transactions and expect failures.
 * Every program test builds its world from here.
 */
import { FailedTransactionMetadata, LiteSVM, type TransactionMetadata } from 'litesvm';
import {
  appendTransactionMessageInstructions, createTransactionMessage, generateKeyPairSigner, lamports, pipe,
  setTransactionMessageFeePayerSigner, signTransactionMessageWithSigners, type Instruction, type KeyPairSigner,
} from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getInitializeMint2Instruction,
  getMintSize, getMintToInstruction, getTokenDecoder,
} from '@solana-program/token';
import { address, assertAccountExists, type Address, type Decoder } from '@solana/kit';
import { loadProgram, setUpgradeAuthority } from '../src/testing/litesvm-port';
import { commitmentOf, deriveOutcome, roundKey } from '../src/engine';
import {
  getDepositInstruction, getExecuteWithdrawalInstruction, getInitTableInstruction, getInvestInstruction,
  getForfeitInstruction, getLockRoundInstruction, getRefundInstruction, getRevealInstruction, getSettleInstruction, getVoidRoundInstruction, getCloseBetsInstruction, getCloseRoundInstruction, getRoundBetsDecoder, getRoundDecoder,
  getOpenRoundInstruction, getOpenSessionInstruction, getPlaceBetsInstruction, getRequestWithdrawalInstruction, getTableDecoder, getWithdrawInstruction,
  betsPda, positionPda, roundPda, safePda, sessionPda, spotIndex, tablePda, vaultPda, getSetPausedInstruction,
  getApplyBuybackInstruction, getPayBuybackInstruction, getProposeBuybackInstruction, getProposeDealerInstruction, getApplyDealerInstruction,
  getProposeOwnerInstruction, getAcceptOwnerInstruction, programDataPda,
} from '../src';


export class TxError extends Error {
  constructor(readonly code: number | null, readonly logs: string[]) { super(`transaction failed (code ${code})\n${logs.join('\n')}`); }
}

export class Chain {
  private constructor(readonly svm: LiteSVM) {}

  static async create(): Promise<Chain> {
    const svm = new LiteSVM();
    loadProgram(svm);
    return new Chain(svm);
  }

  setUpgradeAuthority(authority: Address): Promise<void> { return setUpgradeAuthority(this.svm, authority); }

  /** A fresh keypair with `sol` SOL for fees. */
  async signer(sol = 10n): Promise<KeyPairSigner> {
    const s = await generateKeyPairSigner();
    this.svm.airdrop(s.address, lamports(sol * 1_000_000_000n));
    return s;
  }

  /** Send `ixs` paid by `payer`; signers inside the instructions sign automatically. Throws TxError on failure. */
  async send(payer: KeyPairSigner, ixs: Instruction[]): Promise<TransactionMetadata> {
    this.svm.expireBlockhash();                     // every transaction gets a fresh blockhash (no duplicate signatures)
    const tx = await pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => this.svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
      (m) => appendTransactionMessageInstructions(ixs, m),
      (m) => signTransactionMessageWithSigners(m),
    );
    const r = this.svm.sendTransaction(tx);
    if (r instanceof FailedTransactionMetadata) {
      const e = r.err() as { err?: () => unknown };
      const inner = typeof e.err === 'function' ? (e.err() as { code?: number }) : undefined;
      throw new TxError(typeof inner?.code === 'number' ? inner.code : null, r.meta().logs());
    }
    return r;
  }

  /** Expect `p` to fail with the program's custom error `code` (6000 + position in RouletteError). */
  async fails(p: Promise<unknown>, code: number): Promise<void> {
    try { await p; } catch (e) {
      if (e instanceof TxError && e.code === code) return;
      throw e;
    }
    throw new Error(`expected error ${code}, but the transaction succeeded`);
  }
}

export const SLOT_HASHES = address('SysvarS1otHashes111111111111111111111111111');
export const UNIT = 1_000_000n;
/** state.rs ROUND_GAP_SECS */
export const ROUND_GAP_SECS = 5n;
export const usd = (dollars: number | bigint) => BigInt(dollars) * UNIT;

export interface TableOptions { feeBps?: number; bankLimitBps?: number; throwCount?: number }
/** Who holds the test USDC's mint authority: the owner (default), or a stranger (as Circle holds real USDC's). */
export interface MintOptions { mintAuthority?: 'owner' | 'stranger' }
export interface Wallet { signer: KeyPairSigner; token: Address }

/** A table on a fresh test-USDC mint: owner (the program's upgrade authority; receives the fee), dealer, table, vault. */
export class World {
  /** The public buyback wallet and its test-USDC account (set up with the table). */
  buyback!: KeyPairSigner;
  buybackToken!: Address;

  private constructor(readonly chain: Chain, readonly mint: Address, readonly owner: KeyPairSigner, readonly dealer: KeyPairSigner,
    readonly table: Address, readonly vault: Address, readonly mintAuthority: KeyPairSigner) {}

  /** A table set up on a fresh mint. */
  static async create(o: TableOptions = {}): Promise<World> {
    const w = await World.bare();
    await w.initTable(o);
    await w.tokenAccount(w.owner.address);                           // the owner's fee account exists from the start
    return w;
  }

  /** Only the mint; the table is not set up yet. The owner holds the program's upgrade key. */
  static async bare(o: MintOptions = {}): Promise<World> {
    const chain = await Chain.create();
    const owner = await chain.signer(100n), dealer = await chain.signer(100n), mint = await generateKeyPairSigner();
    await chain.setUpgradeAuthority(owner.address);
    const mintAuthority = o.mintAuthority === 'stranger' ? await chain.signer(100n) : owner;
    const space = BigInt(getMintSize());
    await chain.send(owner, [
      getCreateAccountInstruction({ payer: owner, newAccount: mint, lamports: chain.svm.minimumBalanceForRentExemption(space), space, programAddress: TOKEN_PROGRAM_ADDRESS }),
      getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: mintAuthority.address }),
    ]);
    const table = await tablePda(mint.address);
    return new World(chain, mint.address, owner, dealer, table, await vaultPda(table), mintAuthority);
  }

  async initTable(o: TableOptions = {}, payer = this.owner): Promise<void> {
    this.buyback = await this.chain.signer();
    this.buybackToken = await this.tokenAccount(this.buyback.address);
    await this.chain.send(payer, [getInitTableInstruction({
      payer, programData: await programDataPda(), mint: this.mint, table: this.table, vault: this.vault, buybackToken: this.buybackToken, owner: this.owner.address, dealer: this.dealer.address,
      feeBps: o.feeBps ?? 50, bankLimitBps: o.bankLimitBps ?? 100, libraryHash: new Uint8Array(32), throwCount: o.throwCount ?? 299,
    })]);
  }

  /** The associated token account of `owner` for the test USDC (created if missing). */
  async tokenAccount(owner: Address): Promise<Address> {
    const [ata] = await findAssociatedTokenPda({ owner, mint: this.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    await this.chain.send(this.owner, [getCreateAssociatedTokenIdempotentInstruction({ payer: this.owner, owner, mint: this.mint, ata })]);
    return ata;
  }

  /** A player or investor wallet holding `dollars` test USDC. */
  async wallet(dollars = 0): Promise<Wallet> {
    const signer = await this.chain.signer();
    const token = await this.tokenAccount(signer.address);
    if (dollars > 0) await this.chain.send(this.owner, [getMintToInstruction({ mint: this.mint, token, mintAuthority: this.mintAuthority, amount: usd(dollars) })]);
    return { signer, token };
  }

  async deposit(p: Wallet, dollars: number | bigint): Promise<Address> {
    const safe = await safePda(this.table, p.signer.address);
    await this.chain.send(p.signer, [getDepositInstruction({ wallet: p.signer, table: this.table, mint: this.mint, vault: this.vault, walletToken: p.token, safe, amount: usd(dollars) })]);
    return safe;
  }

  async withdraw(p: Wallet, dollars: number | bigint, to = p.token, safeOf = p.signer.address): Promise<void> {
    const safe = await safePda(this.table, safeOf);
    await this.chain.send(p.signer, [getWithdrawInstruction({ wallet: p.signer, table: this.table, mint: this.mint, vault: this.vault, walletToken: to, safe, amount: usd(dollars) })]);
  }

  async invest(p: Wallet, dollars: number | bigint): Promise<Address> {
    const position = await positionPda(this.table, p.signer.address);
    await this.chain.send(p.signer, [getInvestInstruction({ investor: p.signer, table: this.table, mint: this.mint, vault: this.vault, investorToken: p.token, position, amount: usd(dollars) })]);
    return position;
  }

  async requestWithdrawal(p: Wallet, shares: bigint): Promise<void> {
    await this.chain.send(p.signer, [getRequestWithdrawalInstruction({ investor: p.signer, table: this.table, position: await positionPda(this.table, p.signer.address), shares })]);
  }

  async executeWithdrawal(p: Wallet): Promise<void> {
    await this.chain.send(p.signer, [getExecuteWithdrawalInstruction({
      investor: p.signer, table: this.table, mint: this.mint, vault: this.vault, investorToken: p.token, position: await positionPda(this.table, p.signer.address),
    })]);
  }

  /** Opens a betting session for `p`: a fresh browser key that may bet up to `dollars` for `seconds`. */
  async openSession(p: Wallet, dollars: number | bigint, seconds: number | bigint = 4 * 3600): Promise<{ key: KeyPairSigner; session: Address }> {
    const key = await generateKeyPairSigner();
    const session = await sessionPda(this.table, p.signer.address);
    await this.chain.send(p.signer, [getOpenSessionInstruction({ wallet: p.signer, table: this.table, session, key: key.address, cap: usd(dollars), expiresAt: this.now() + BigInt(seconds) })]);
    return { key, session };
  }

  /** Opens the next round; like the real table, it first lets the minimum gap after the previous round pass. */
  /** The secret seed of each round this world opened (the dealer's side of the sealed envelope). */
  readonly seeds = new Map<Address, Uint8Array>();

  async openRound(): Promise<{ id: bigint; round: Address; seed: Uint8Array }> {
    const t = this.read(this.table, getTableDecoder());
    if (t.roundId > 0n && this.now() < t.roundClosedAt + ROUND_GAP_SECS) this.setTime(t.roundClosedAt + ROUND_GAP_SECS);
    const id = t.roundId + 1n;
    const round = await roundPda(this.table, id);
    const seed = crypto.getRandomValues(new Uint8Array(32));
    await this.chain.send(this.dealer, [getOpenRoundInstruction({ dealer: this.dealer, table: this.table, round, commitment: commitmentOf(seed) })]);
    this.seeds.set(round, seed);
    return { id, round, seed };
  }

  /** `p`'s bet set for `round`, signed by the session `key`; the table (dealer) pays the fee unless `payer` is given. */
  async placeBets(p: Wallet, key: KeyPairSigner, round: Address, bets: [spot: string, dollars: number][], payer = this.dealer): Promise<Address> {
    const roundBets = await betsPda(round, p.signer.address);
    await this.chain.send(payer, [getPlaceBetsInstruction({
      payer, sessionKey: key, table: this.table, round, session: await sessionPda(this.table, p.signer.address),
      safe: await safePda(this.table, p.signer.address), roundBets, bets: bets.map(([id, dollars]) => ({ spot: spotIndex(id), dollars })),
    })]);
    return roundBets;
  }

  /** A player with `dollars` in their safe and a session allowing `cap`. */
  async seated(dollars = 1_000, cap = 500): Promise<{ p: Wallet; key: KeyPairSigner }> {
    const p = await this.wallet(dollars);
    await this.deposit(p, dollars);
    const { key } = await this.openSession(p, cap);
    return { p, key };
  }

  /** No more bets. */
  async lock(round: Address, dealer = this.dealer): Promise<void> {
    await this.chain.send(dealer, [getLockRoundInstruction({ dealer, table: this.table, round })]);
  }

  /** Moves the chain one slot past the newest SlotHashes entry (as on Solana: a transaction's slot is never in its own
   * SlotHashes), which by default hold the lock slot's neighbours up to lock + 3; the entropy slot (lock + 2) has `hash`. */
  entropy(round: Address, hash: Uint8Array, entries?: [slot: bigint, hash: Uint8Array][]): void {
    const lockSlot = this.read(round, getRoundDecoder()).lockSlot;
    const list = entries ?? [[lockSlot + 3n, new Uint8Array(32).fill(0xee)], [lockSlot + 2n, hash], [lockSlot + 1n, new Uint8Array(32).fill(0xdd)], [lockSlot, new Uint8Array(32).fill(0xcc)]];
    const newest = list.reduce((m, [slot]) => (slot > m ? slot : m), 0n);
    this.setSlotHashes(list);
    const c = this.chain.svm.getClock();
    c.slot = newest + 1n;
    this.chain.svm.setClock(c);
  }

  /** Writes the SlotHashes sysvar (newest first), as Solana keeps it. */
  setSlotHashes(entries: [slot: bigint, hash: Uint8Array][]): void {
    const sorted = [...entries].sort((x, y) => (x[0] < y[0] ? 1 : -1));
    const data = new Uint8Array(8 + sorted.length * 40);
    const view = new DataView(data.buffer);
    view.setBigUint64(0, BigInt(sorted.length), true);
    sorted.forEach(([slot, h], i) => { view.setBigUint64(8 + i * 40, slot, true); data.set(h, 16 + i * 40); });
    const a = this.chain.svm.getAccount(SLOT_HASHES);
    assertAccountExists(a);
    this.chain.svm.setAccount({ ...a, data, space: BigInt(data.length) });
  }

  /** Opens the envelope: reveals the round's seed (by default the one this world committed). */
  async reveal(round: Address, seed = this.seeds.get(round)!, by = this.dealer): Promise<void> {
    await this.chain.send(by, [getRevealInstruction({
      table: this.table, round, slotHashes: SLOT_HASHES, mint: this.mint, vault: this.vault, ownerToken: await this.tokenAccount(this.owner.address), seed,
    })]);
  }

  /** Lets the round land on `number`: picks an entropy-slot hash that, with the committed seed, gives that number; then reveals. */
  async revealAs(round: Address, number: number, by = this.dealer): Promise<void> {
    const r = this.read(round, getRoundDecoder());
    this.entropy(round, hashFor(number, this.seeds.get(round)!, r.id, this.read(this.table, getTableDecoder()).throwCount));
    await this.reveal(round, undefined, by);
  }

  async forfeit(round: Address, by = this.dealer): Promise<void> {
    await this.chain.send(by, [getForfeitInstruction({ table: this.table, round })]);
  }

  async settle(round: Address, wallet: Address, by = this.dealer): Promise<void> {
    await this.chain.send(by, [getSettleInstruction({ table: this.table, round, roundBets: await betsPda(round, wallet), safe: await safePda(this.table, wallet) })]);
  }

  async voidRound(round: Address, by = this.dealer): Promise<void> {
    await this.chain.send(by, [getVoidRoundInstruction({ table: this.table, round })]);
  }

  async refund(round: Address, wallet: Address, by = this.dealer): Promise<void> {
    await this.chain.send(by, [getRefundInstruction({ table: this.table, round, roundBets: await betsPda(round, wallet), safe: await safePda(this.table, wallet) })]);
  }

  async closeBets(round: Address, wallet: Address, by = this.dealer): Promise<void> {
    const roundBets = await betsPda(round, wallet);
    await this.chain.send(by, [getCloseBetsInstruction({ roundBets, payer: this.read(roundBets, getRoundBetsDecoder()).payer })]);
  }

  async closeRound(round: Address, by = this.dealer): Promise<void> {
    await this.chain.send(by, [getCloseRoundInstruction({ table: this.table, round, payer: this.read(round, getRoundDecoder()).payer })]);
  }

  /** The owner names a new dealer (it takes over EXIT_WINDOW_SECS later, when anyone applies it). */
  async proposeDealer(dealer: Address, by = this.owner): Promise<void> {
    await this.chain.send(by, [getProposeDealerInstruction({ owner: by, table: this.table, dealer })]);
  }

  async applyDealer(by = this.dealer): Promise<void> {
    await this.chain.send(by, [getApplyDealerInstruction({ table: this.table })]);
  }

  /** The owner names a new owner, which takes over when it accepts. */
  async proposeOwner(newOwner: Address, by = this.owner): Promise<void> {
    await this.chain.send(by, [getProposeOwnerInstruction({ owner: by, table: this.table, newOwner })]);
  }

  async acceptOwner(by: KeyPairSigner): Promise<void> {
    await this.chain.send(by, [getAcceptOwnerInstruction({ newOwner: by, table: this.table })]);
  }

  positionOf(p: Wallet): Promise<Address> { return positionPda(this.table, p.signer.address); }

  async setPaused(paused: boolean, by = this.owner): Promise<void> {
    await this.chain.send(by, [getSetPausedInstruction({ owner: by, table: this.table, paused })]);
  }

  async payBuyback(by = this.dealer, to = this.buybackToken): Promise<void> {
    await this.chain.send(by, [getPayBuybackInstruction({ table: this.table, mint: this.mint, vault: this.vault, buybackToken: to })]);
  }

  async proposeBuyback(token: Address, by = this.owner): Promise<void> {
    await this.chain.send(by, [getProposeBuybackInstruction({ owner: by, table: this.table, newBuybackToken: token })]);
  }

  async applyBuyback(by = this.dealer): Promise<void> {
    await this.chain.send(by, [getApplyBuybackInstruction({ table: this.table })]);
  }

  now(): bigint { return this.chain.svm.getClock().unixTimestamp; }

  setTime(unix: bigint): void {
    const c = this.chain.svm.getClock();
    c.unixTimestamp = unix;
    this.chain.svm.setClock(c);
  }

  tokenBalance(account: Address): bigint {
    const a = this.chain.svm.getAccount(account);
    assertAccountExists(a);
    return getTokenDecoder().decode(a.data).amount;
  }

  read<T extends object>(address: Address, decoder: Decoder<T>): T {
    const a = this.chain.svm.getAccount(address);
    assertAccountExists(a);
    return decoder.decode(a.data);
  }

  exists(address: Address): boolean { return this.chain.svm.getAccount(address).exists; }
}

/** An entropy-slot hash that, with `seed`, makes round `roundId` land on `number` (found by trying counters). */
export function hashFor(number: number, seed: Uint8Array, roundId: bigint, throwCount = 299): Uint8Array {
  const h = new Uint8Array(32);
  for (let i = 0; ; i++) {
    new DataView(h.buffer).setUint32(28, i);
    if (deriveOutcome(roundKey(seed, h), roundId, throwCount).number === number) return h;
  }
}
