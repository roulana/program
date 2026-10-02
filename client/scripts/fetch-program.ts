/**
 * Downloads the program running on Solana into program/target/deploy/roulette.so, so the tests run against the exact
 * bytes on chain (instead of, or beside, a build of this code).
 *   bun scripts/fetch-program.ts [rpc]        (default: Solana's public mainnet node)
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';

const PROGRAM = '7FqVwLDtBPC1YsKpiXUw8HxCJP63hqQKGFcnYXgYgHBn';
const rpc = process.argv[2] ?? 'https://api.mainnet-beta.solana.com';
const out = new URL('../../program/target/deploy/roulette.so', import.meta.url).pathname;

async function ask(method: string, params: unknown[]): Promise<any> {
  const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = (await r.json()) as { result?: any; error?: { message: string } };
  if (j.error || !j.result?.value) throw new Error(`${method}: ${j.error?.message ?? 'not found'}`);
  return j.result;
}

// an upgradeable program's code lives in its program-data account, after a 45-byte header (the upgrade authority, the slot)
const program = await ask('getAccountInfo', [PROGRAM, { encoding: 'jsonParsed' }]);
const dataAddress: string = program.value.data.parsed.info.programData;
const data = await ask('getAccountInfo', [dataAddress, { encoding: 'jsonParsed' }]);
const raw = await ask('getAccountInfo', [dataAddress, { encoding: 'base64' }]);
const code = Buffer.from(raw.value.data[0], 'base64').subarray(45);
mkdirSync(new URL('.', `file://${out}`).pathname, { recursive: true });
await Bun.write(out, code);
console.log(`program ${PROGRAM}: ${code.length} bytes, deployed at slot ${data.value.data.parsed.info.slot}, upgrade authority ${data.value.data.parsed.info.authority}`);
console.log(`sha256 ${createHash('sha256').update(code).digest('hex')} → ${out}`);
