/**
 * A simulated Solana for tests: LiteSVM with the roulette program, where time moves like on the real network — every
 * transaction lands in the next slot, 400 ms later, and the SlotHashes sysvar remembers the slots before it (newest
 * first, at most 512), so a reveal right after the lock meets "not ready yet" exactly as on devnet.
 */
import { FailedTransactionMetadata, LiteSVM } from 'litesvm';
import {
  address, appendTransactionMessageInstructions, decompileTransactionMessage, getAddressEncoder, getCompiledTransactionMessageDecoder, createTransactionMessage,
  generateKeyPairSigner, getBase64Encoder, getTransactionDecoder, getTransactionEncoder, lamports, pipe, setTransactionMessageFeePayerSigner,
  signTransactionMessageWithSigners, getSignatureFromTransaction,
  type Address, type Base64EncodedWireTransaction, type Instruction, type KeyPairSigner, type Transaction, type TransactionSigner,
} from '@solana/kit';
import { budget } from '../compute-budget';
import { ROULETTE_PROGRAM_ADDRESS } from '../generated';
import { UPGRADEABLE_LOADER, programDataPda } from '../pdas';
import { ProgramError, type Lifetime, type ProgramAccountFilter, type SolanaPort } from '../port';

const PROGRAM_SO = new URL('../../../program/target/deploy/roulette.so', import.meta.url).pathname;
const SLOT_HASHES = address('SysvarS1otHashes111111111111111111111111111');
const HISTORY = 512;

/** Loads the program as Solana holds it: upgradeable, with a program-data account naming the upgrade authority (none
 * until `setUpgradeAuthority`). */
export function loadProgram(svm: LiteSVM): void {
  svm.addProgramWithLoader(ROULETTE_PROGRAM_ADDRESS, new Uint8Array(require('node:fs').readFileSync(PROGRAM_SO)), UPGRADEABLE_LOADER);
}

/** Names `authority` the program's upgrade authority (the program-data header: tag, slot, Option<authority>): the only key
 * that may set up a table. */
export async function setUpgradeAuthority(svm: LiteSVM, authority: Address): Promise<void> {
  const at = await programDataPda();
  const a = svm.getAccount(at);
  if (!a.exists) throw new Error('the program is not loaded');
  const data = new Uint8Array(a.data);
  data[12] = 1;
  data.set(getAddressEncoder().encode(authority), 13);
  svm.setAccount({ ...a, data });
}

export class LiteSvmPort implements SolanaPort {
  /** The current slot (the one the next transaction lands in). */
  slot = 1_000n;
  /** When true, every send fails like a network outage and nothing lands. */
  offline = false;
  private ms = 1_800_000_000_000;
  private hashes: [bigint, Uint8Array][] = [];

  private constructor(readonly svm: LiteSVM) {}

  static create(): LiteSvmPort {
    const svm = new LiteSVM().withBlockhashCheck(false);       // a bet signed a few slots ago must still land
    loadProgram(svm);
    const p = new LiteSvmPort(svm);
    p.setClock();
    return p;
  }

  /** Server time now (ms), in step with the chain's clock. */
  now(): number { return this.ms; }

  /** A fresh keypair holding `sol` SOL. */
  async signer(sol = 10n): Promise<KeyPairSigner> {
    const s = await generateKeyPairSigner();
    this.svm.airdrop(s.address, lamports(sol * 1_000_000_000n));
    return s;
  }

  /** Lets `seconds` pass; slots move on at 2.5 per second. */
  wait(seconds: number): void {
    const n = Math.round(seconds * 2.5), skip = Math.max(0, n - HISTORY);
    if (skip) { this.slot += BigInt(skip); this.ms += skip * 400; this.hashes = []; }   // a long wait: only the last slots stay in the history
    for (let i = skip; i < n; i++) this.nextSlot();
    this.ms += seconds * 1000 - n * 400;
    this.setClock();
  }

  /** Every landed transaction: the compute it used, its size on the wire, and its first roulette instruction's data. */
  readonly landed: { units: bigint; bytes: number; first: Uint8Array }[] = [];

  /** The priority fee each landed-or-refused send asked for (micro-lamports a compute unit), in order. */
  readonly fees: bigint[] = [];

  async send(payer: TransactionSigner, ixs: Instruction[], units?: number, fee?: bigint): Promise<string> {
    this.fees.push(fee ?? 0n);
    const all = units === undefined ? ixs : [...budget(units, fee ?? 0n), ...ixs];
    const tx = await pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => this.svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
      (m) => appendTransactionMessageInstructions(all, m),
      (m) => signTransactionMessageWithSigners(m),
    );
    return this.land(tx);
  }

  async sendWire(wire: Base64EncodedWireTransaction): Promise<string> {
    return this.land(getTransactionDecoder().decode(getBase64Encoder().encode(wire)));
  }

  /** The signatures of every landed transaction (a transaction lands at once here: landed is confirmed). */
  private readonly signatures = new Set<string>();

  async confirmed(signature: string): Promise<string> {
    if (!this.signatures.has(signature)) throw new Error(`transaction ${signature} not found`);
    return signature;
  }

  async lifetime(): Promise<Lifetime> {
    return { blockhash: this.svm.latestBlockhash() as Lifetime['blockhash'], lastValidBlockHeight: 1_000_000_000n };
  }

  async account(a: Address): Promise<Uint8Array | null> {
    const acc = this.svm.getAccount(a);
    return acc.exists ? Uint8Array.from(acc.data) : null;
  }

  async accounts(list: readonly Address[]): Promise<(Uint8Array | null)[]> {
    return Promise.all(list.map((a) => this.account(a)));
  }

  async sol(a: Address): Promise<bigint> {
    return this.svm.getBalance(a) ?? 0n;
  }

  async programAccounts(f: ProgramAccountFilter): Promise<{ address: Address; data: Uint8Array }[]> {
    const want = getAddressEncoder().encode(f.bytes);
    return this.svm.getProgramAccounts(ROULETTE_PROGRAM_ADDRESS)
      .filter((a) => (f.size === undefined || a.data.length === f.size) && want.every((b, i) => a.data[f.offset + i] === b))
      .map((a) => ({ address: a.address, data: Uint8Array.from(a.data) }));
  }

  private land(tx: Transaction): string {
    if (this.offline) throw new Error('offline: the network did not answer');
    this.nextSlot();
    this.setClock();
    const r = this.svm.sendTransaction(tx as never);
    if (r instanceof FailedTransactionMetadata) {
      const e = r.err() as { err?: () => unknown };
      const inner = typeof e.err === 'function' ? (e.err() as { code?: number }) : undefined;
      throw new ProgramError(typeof inner?.code === 'number' ? inner.code : null, r.meta().logs().join('\n'));
    }
    const ixs = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(tx.messageBytes)).instructions;
    const first = ixs.find((ix) => ix.programAddress === ROULETTE_PROGRAM_ADDRESS)?.data;
    this.landed.push({ units: r.computeUnitsConsumed(), bytes: getTransactionEncoder().encode(tx).length, first: Uint8Array.from(first ?? []) });
    const sig = getSignatureFromTransaction(tx);
    this.signatures.add(sig);
    return sig;
  }

  /** The current slot is done: it enters SlotHashes (with a random hash), and the chain moves to the next one. */
  private nextSlot(): void {
    this.hashes.unshift([this.slot, crypto.getRandomValues(new Uint8Array(32))]);
    if (this.hashes.length > HISTORY) this.hashes.length = HISTORY;
    this.slot += 1n;
    this.ms += 400;
    this.svm.expireBlockhash();                                  // every transaction gets its own blockhash
  }

  private setClock(): void {
    const data = new Uint8Array(8 + this.hashes.length * 40);
    const view = new DataView(data.buffer);
    view.setBigUint64(0, BigInt(this.hashes.length), true);
    this.hashes.forEach(([slot, h], i) => { view.setBigUint64(8 + i * 40, slot, true); data.set(h, 16 + i * 40); });
    const acc = this.svm.getAccount(SLOT_HASHES);
    this.svm.setAccount({ ...acc, address: SLOT_HASHES, data, space: BigInt(data.length) } as never);
    const c = this.svm.getClock();
    c.slot = this.slot;
    c.unixTimestamp = BigInt(Math.floor(this.ms / 1000));
    this.svm.setClock(c);
  }
}
