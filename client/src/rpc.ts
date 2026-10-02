/** The real network over HTTP, and its WebSocket when given: confirmation is told over the WebSocket and polled as the backup; 429s are waited out. */
import {
  appendTransactionMessageInstructions, createDefaultRpcTransport, createSolanaRpc, createSolanaRpcFromTransport, createSolanaRpcSubscriptions, createTransactionMessage, getBase64EncodedWireTransaction, getBase64Encoder,
  getSignatureFromTransaction, getTransactionDecoder, pipe, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED, isSolanaError, type Base58EncodedBytes, type Base64EncodedWireTransaction,
  type Address, type Instruction, type Signature, type TransactionSigner,
} from '@solana/kit';
import { MAX_COMPUTE_UNITS, budget } from './compute-budget';
import { ROULETTE_PROGRAM_ADDRESS } from './generated';
import { ProgramError, budgetExceeded, customCode, type ProgramAccountFilter, type SolanaPort } from './port';
import { SENDER_MIN_PRICE, TIP_UNITS, tipInstruction } from './sender';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** getSignatureStatuses takes at most this many signatures; getMultipleAccounts this many accounts. */
const MAX_STATUSES = 256, MAX_ACCOUNTS = 100;
const text = (e: unknown) => String((e as Error)?.message ?? e);
/**
 * How long one request to the node may take before it counts as failed (and is asked again by whoever asked). Without it
 * a node that takes a request and never answers holds it for Bun's 5 minutes: longer than the 2 minutes a round's reveal has.
 */
export const REQUEST_MS = 15_000;

/**
 * How long a node answering 429 Too Many Requests is waited out before the request fails: whoever asked then logs it
 * and asks again (a 429 comes back at once, so REQUEST_MS never ends such a wait). Never a silent wait for ever.
 */
export const MAX_429_MS = 30_000;

/** A node answered that it has not reached the block the question asked for (minContextSlot): it is behind. */
const behind = (e: unknown) => isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED) || /-32016|Minimum context slot/i.test(text(e));

/** Runs `f`, waiting and retrying while the endpoint answers 429 Too Many Requests, at most `maxMs`. */
async function waitOut429<T>(f: () => Promise<T>, maxMs: number): Promise<T> {
  const until = Date.now() + maxMs;
  for (let wait = 500; ; wait = Math.min(wait * 2, 8_000)) {
    try { return await f(); } catch (e) {
      if (!text(e).includes('429') || Date.now() + wait > until) throw e;
      await sleep(wait);
    }
  }
}

/**
 * `retry429: false` gives up at once on 429 instead of waiting it out: for readers that must never pile up on an
 * endpoint the dealer shares (the Bank page); the dealer itself keeps waiting (the default). `priority`: the priority
 * fee (micro-lamports a compute unit) for transactions sent with a compute limit (default 0). `resendMs`: how often a
 * transaction waiting for its confirmation is sent again (the same bytes; default 1.5 s). `ws`: the node's WebSocket, which
 * tells the moment a transaction lands (the status questions stay as the backup).
 *
 * Never an answer older than what was already seen: a node address (Helius) is many nodes, each a split second behind
 * the others, so a question could reach a node that has not seen a transaction just confirmed, or the block a read just
 * showed (mainnet, 2026-10-01: a close refused as "not all settled", a reveal as "entropy slot not there", a payout sent
 * twice). Every read, and every send's check, asks for at least the newest block seen so far (minContextSlot): a node
 * behind says so and the question goes again after `behindWaitMs` (250 ms), at most `behindTries` times (12).
 *
 * `sender`: Helius Sender (src/sender.ts) for mainnet. Every transaction `send` makes then carries a priority fee and
 * the tip; each one is checked by a simulation on the node (the program's refusals as before), then sent, and sent
 * again until it lands, through Sender — and through the node when Sender does not take it, so the table never waits on
 * Sender.
 */
export function rpcPort(url: string, o: { requestMs?: number; max429Ms?: number; confirmTimeoutMs?: number; pollMs?: number; retry429?: boolean; blockhashReuseMs?: number; priority?: () => Promise<bigint>; resendMs?: number; ws?: string; behindWaitMs?: number; behindTries?: number; minSlot?: bigint;
  sender?: { url: string; fetch?: typeof fetch; log?: (m: string) => void } } = {}): SolanaPort & { rpc: ReturnType<typeof createSolanaRpc> } {
  // every request with its own deadline, besides any the caller gives
  const base = createDefaultRpcTransport({ url }), requestMs = o.requestMs ?? REQUEST_MS;
  const rpc = createSolanaRpcFromTransport(((config: Parameters<typeof base>[0]) => base({
    ...config, signal: config.signal ? AbortSignal.any([config.signal, AbortSignal.timeout(requestMs)]) : AbortSignal.timeout(requestMs),
  })) as typeof base);
  const patient: <T>(f: () => Promise<T>) => Promise<T> = o.retry429 === false ? (f) => f() : (f) => waitOut429(f, o.max429Ms ?? MAX_429_MS);
  const timeout = o.confirmTimeoutMs ?? 60_000, poll = o.pollMs ?? 400, reuse = o.blockhashReuseMs ?? 5_000, resend = o.resendMs ?? 1_500;
  const priority = o.priority ?? (async () => 0n);
  /** The newest block any answer (or a confirmed transaction) showed: no later answer may come from an older one. */
  let seen = o.minSlot ?? 0n;
  const saw = (slot: bigint | number | null | undefined) => { if (slot !== null && slot !== undefined && BigInt(slot) > seen) seen = BigInt(slot); };
  const atLeast = () => (seen > 0n ? { minContextSlot: seen } : {});
  /** `f` asked of a node that has seen block `seen`: one behind says so, and the question goes again a moment later. */
  async function current<T>(f: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try { return await patient(f); } catch (e) {
        if (!behind(e) || attempt >= (o.behindTries ?? 12)) throw e;
        await sleep(o.behindWaitMs ?? 250);
      }
    }
  }

  /**
   * Every transaction waiting for its confirmation is asked about in one question (up to 256 at a time), so a table
   * where many players bet at once costs the node one request per poll, not one per player.
   */
  type Waiter = { resolve: (sig: string) => void; reject: (e: unknown) => void };
  const waiting = new Map<string, { until: number; waiters: Waiter[]; stop?: () => void }>();
  /** A wait ends once, by whichever answers first (a status question or the WebSocket); its watch is stopped. */
  const settle = (sig: string, done: (w: Waiter) => void) => {
    const w = waiting.get(sig);
    waiting.delete(sig);
    w?.stop?.();
    for (const x of w?.waiters ?? []) done(x);
  };

  // the node's WebSocket tells the moment a transaction lands; the status questions stay as the backup, asked less
  // often while it is up (1 s) than while it is not (`poll`)
  const subs = o.ws ? createSolanaRpcSubscriptions(o.ws) : null;
  let wsUp = false;
  function watch(sig: Signature): void {
    const w = waiting.get(sig);
    if (!subs || !w || w.stop) return;
    const stop = new AbortController();
    w.stop = () => stop.abort();
    void (async () => {
      try {
        const notices = await subs.signatureNotifications(sig, { commitment: 'confirmed' }).subscribe({ abortSignal: stop.signal });
        wsUp = true;
        for await (const n of notices) {
          const err = n.value.err;
          if (!err) saw(n.context.slot);
          if (err) settle(sig, (x) => x.reject(new ProgramError(customCode(err), JSON.stringify(err, (_, v) => (typeof v === 'bigint' ? String(v) : v)))));
          else settle(sig, (x) => x.resolve(sig));
          return;
        }
      } catch { if (!stop.signal.aborted) wsUp = false; }
    })();
  }

  let polling = false;
  async function pollAll(): Promise<void> {
    while (waiting.size) {
      await sleep(subs && wsUp ? Math.max(poll, 1_000) : poll);            // nothing lands at once: the burst of a close is asked about together
      const sigs = [...waiting.keys()].slice(0, MAX_STATUSES) as Signature[];
      if (!sigs.length) continue;
      try {
        const { value } = await patient(() => rpc.getSignatureStatuses(sigs).send());
        value.forEach((s, i) => {
          const sig = sigs[i]!;
          if (s?.err) {
            const e = new ProgramError(customCode(s.err), JSON.stringify(s.err, (_, v) => (typeof v === 'bigint' ? String(v) : v)));
            settle(sig, (w) => w.reject(e));
          } else if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) { saw(s.slot); settle(sig, (w) => w.resolve(sig)); }
        });
      } catch (e) {
        // the node failed this question (or it outlasted REQUEST_MS): without the WebSocket each sender decides again; with
        // it up, the WebSocket still tells each one, and each wait ends at its own time — one slow question never fails
        // every bet, lock and payout of a close at once
        if (!(subs && wsUp)) for (const sig of sigs) settle(sig, (w) => w.reject(e));
      }
      const now = Date.now();
      for (const [sig, w] of [...waiting]) if (now >= w.until) settle(sig, (x) => x.reject(new Error(`transaction ${sig} not confirmed within ${timeout / 1000} s`)));
    }
    polling = false;
  }
  function confirm(sig: Signature): Promise<string> {
    return new Promise((resolve, reject) => {
      const w = waiting.get(sig) ?? { until: Date.now() + timeout, waiters: [] };
      w.waiters.push({ resolve, reject });
      waiting.set(sig, w);
      watch(sig);
      if (!polling) { polling = true; void pollAll(); }
    });
  }

  /** A blockhash stays good for about a minute: bets prepared within moments of each other share one (one request, not one per player). */
  let fresh: { at: number; value: Promise<Awaited<ReturnType<SolanaPort['lifetime']>>> } | null = null;
  function lifetime(): ReturnType<SolanaPort['lifetime']> {
    if (!fresh || Date.now() - fresh.at >= reuse) {
      const value = current(() => rpc.getLatestBlockhash({ commitment: 'confirmed', ...atLeast() }).send()).then((r) => { saw(r.context.slot); return r.value; });
      const mine = { at: Date.now(), value };
      fresh = mine;
      value.catch(() => { if (fresh === mine) fresh = null; });            // a failed request is not kept
    }
    return fresh.value;
  }

  /** Sender said no (or did not answer) at most this often in the log: the node takes the transaction instead. */
  let senderToldAt = -Infinity;
  /** The transaction to Helius Sender, not simulated; when Sender does not take it, to the node. */
  async function viaSender(wire: Base64EncodedWireTransaction, s: NonNullable<typeof o.sender>): Promise<void> {
    try {
      const r = await (s.fetch ?? fetch)(s.url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5_000),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [wire, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }] }),
      });
      // taken only when Sender answers with the transaction's signature: a refusal comes in more than one shape
      const j = (await r.json().catch(() => ({}))) as { result?: unknown; error?: { message?: string }; message?: string };
      if (!r.ok || typeof j.result !== 'string') throw new Error(j.error?.message ?? j.message ?? `HTTP ${r.status}`);
    } catch (e) {
      if (Date.now() - senderToldAt >= 60_000) {
        senderToldAt = Date.now();
        (s.log ?? ((m: string) => console.error(m)))(`solana: Helius Sender did not take a transaction (${text(e).split('\n')[0]}) — sent through the node instead`);
      }
      await patient(() => rpc.sendTransaction(wire, { encoding: 'base64', skipPreflight: true, maxRetries: 0n }).send());
    }
  }

  async function sendWire(wire: Base64EncodedWireTransaction): Promise<string> {
    const sig = getSignatureFromTransaction(getTransactionDecoder().decode(getBase64Encoder().encode(wire)));
    const s = o.sender;
    if (s) {
      // checked as the node would check it, without spending the plan's sends; then into Sender's fast lane
      const sim = await current(() => rpc.simulateTransaction(wire, { encoding: 'base64', commitment: 'confirmed', ...atLeast() }).send());
      saw(sim.context.slot);
      const err = sim.value.err;
      if (err) {
        const detail = `simulation: ${JSON.stringify(err, (_, v) => (typeof v === 'bigint' ? String(v) : v))} ${(sim.value.logs ?? []).slice(-3).join(' | ')}`;
        const code = customCode(err);
        throw code !== null ? new ProgramError(code, detail) : new Error(`Transaction ${detail}`);   // refused: nothing was sent
      }
      await viaSender(wire, s);
    } else {
      try {
        await current(() => rpc.sendTransaction(wire, { encoding: 'base64', preflightCommitment: 'confirmed', ...atLeast() }).send());
      } catch (e) {
        const code = customCode(e);
        throw code !== null ? new ProgramError(code, text(e)) : e;          // refused in simulation: nothing was sent
      }
    }
    // the same transaction again every `resend` ms, not simulated, until the wait ends: a node or leader that dropped
    // it gets it again, and the same transaction can never happen twice; a refusal (its blockhash gone) changes nothing
    const again = setInterval(() => {
      (s ? viaSender(wire, s) : rpc.sendTransaction(wire, { encoding: 'base64', skipPreflight: true, maxRetries: 0n }).send()).catch(() => {});
    }, resend);
    try { return await confirm(sig); } finally { clearInterval(again); }
  }

  return {
    rpc,
    sendWire,
    confirmed: (signature: string) => confirm(signature as Signature),
    async send(payer: TransactionSigner, ixs: Instruction[], units?: number, fee?: bigint) {
      const once = async (limit: number | undefined, price: bigint | undefined) => {
        // through Sender: always a limit (with room for the tip) and a priority fee, and the tip last
        const tipped = o.sender !== undefined;
        const units = limit === undefined ? undefined : tipped ? Math.min(limit + TIP_UNITS, MAX_COMPUTE_UNITS) : limit;
        const fee = tipped ? (p: bigint) => (p > SENDER_MIN_PRICE ? p : SENDER_MIN_PRICE) : (p: bigint) => p;
        const all = units === undefined && !tipped ? ixs
          : [...budget(units ?? 200_000, fee(price ?? await priority())), ...ixs, ...(tipped ? [tipInstruction(payer)] : [])];
        const answer = await current(() => rpc.getLatestBlockhash({ commitment: 'confirmed', ...atLeast() }).send());
        saw(answer.context.slot);
        const blockhash = answer.value;
        const tx = await pipe(
          createTransactionMessage({ version: 0 }),
          (m) => setTransactionMessageFeePayerSigner(payer, m),
          (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
          (m) => appendTransactionMessageInstructions(all, m),
          (m) => signTransactionMessageWithSigners(m),
        );
        return sendWire(getBase64EncodedWireTransaction(tx));
      };
      try { return await once(units, fee); } catch (e) {
        // a budget too small is no network trouble to retry, nor a refusal: sent once more with the most there is, and
        // said loudly so the budget gets raised (the same budget would fail the same way every time)
        if (units === undefined || units >= MAX_COMPUTE_UNITS || !budgetExceeded(e)) throw e;
        console.error(`solana: compute budget ${units} too small for ${ixs.length} instruction(s) — sent again with ${MAX_COMPUTE_UNITS}; raise the budget`);
        return once(MAX_COMPUTE_UNITS, undefined);                       // the usual price: a raised one times 1.4M units would cost SOL
      }
    },
    lifetime,
    async account(a) {
      const r = await current(() => rpc.getAccountInfo(a, { encoding: 'base64', commitment: 'confirmed', ...atLeast() }).send());
      saw(r.context.slot);
      return r.value ? getBase64Encoder().encode(r.value.data[0]) as Uint8Array : null;
    },
    async accounts(list) {
      const out: (Uint8Array | null)[] = [];
      for (let i = 0; i < list.length; i += MAX_ACCOUNTS) {
        const part = list.slice(i, i + MAX_ACCOUNTS);
        const { context, value } = await current(() => rpc.getMultipleAccounts(part, { encoding: 'base64', commitment: 'confirmed', ...atLeast() }).send());
        saw(context.slot);
        for (const v of value) out.push(v ? getBase64Encoder().encode(v.data[0]) as Uint8Array : null);
      }
      return out;
    },
    async sol(a) {
      const r = await current(() => rpc.getBalance(a, { commitment: 'confirmed', ...atLeast() }).send());
      saw(r.context.slot);
      return r.value;
    },
    async programAccounts(f: ProgramAccountFilter) {
      const answer: unknown = await current(() => rpc.getProgramAccounts(ROULETTE_PROGRAM_ADDRESS, {
        encoding: 'base64', commitment: 'confirmed', withContext: true, ...atLeast(),
        filters: [
          ...(f.size === undefined ? [] : [{ dataSize: BigInt(f.size) }]),
          { memcmp: { offset: BigInt(f.offset), bytes: f.bytes as string as Base58EncodedBytes, encoding: 'base58' as const } },
        ],
      }).send());
      // with the block it was read at, as asked; a node that leaves the block out answers the list alone
      type Listed = { pubkey: Address; account: { data: [string, string] } };
      const list = Array.isArray(answer) ? answer as Listed[] : (answer as { context: { slot: bigint }; value: Listed[] }).value;
      if (!Array.isArray(answer)) saw((answer as { context: { slot: bigint } }).context.slot);
      return list.map((a) => ({ address: a.pubkey, data: getBase64Encoder().encode(a.account.data[0]) as Uint8Array }));
    },
  };
}
