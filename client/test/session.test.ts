import { describe, expect, test } from 'bun:test';
import { ROULETTE_ERROR__SESSION_EXPIRED, ROULETTE_ERROR__SESSION_TOO_LONG, getCloseSessionInstruction, getOpenSessionInstruction, getSessionDecoder, sessionPda } from '../src';
import { World, usd } from './harness';

describe('a betting session', () => {
  test('one approval records the browser key, the cap and the expiry; a new one replaces it', async () => {
    const w = await World.create();
    const p = await w.wallet(0);
    const { key, session } = await w.openSession(p, 500);
    expect(w.read(session, getSessionDecoder())).toMatchObject({ wallet: p.signer.address, key: key.address, capRemaining: usd(500), expiresAt: w.now() + 4n * 3600n });
    const again = await w.openSession(p, 50, 60);
    expect(w.read(session, getSessionDecoder())).toMatchObject({ key: again.key.address, capRemaining: usd(50), expiresAt: w.now() + 60n });
  });

  test('a session must end in the future and last at most 7 days; closing it removes it', async () => {
    const w = await World.create();
    const p = await w.wallet(0);
    const session = await sessionPda(w.table, p.signer.address);
    const open = (expiresAt: bigint) => w.chain.send(p.signer, [getOpenSessionInstruction({ wallet: p.signer, table: w.table, session, key: p.signer.address, cap: 1n, expiresAt })]);
    await w.chain.fails(open(w.now()), ROULETTE_ERROR__SESSION_EXPIRED);
    await w.chain.fails(open(w.now() + 7n * 86_400n + 1n), ROULETTE_ERROR__SESSION_TOO_LONG);
    await open(w.now() + 7n * 86_400n);
    await w.chain.send(p.signer, [getCloseSessionInstruction({ wallet: p.signer, table: w.table, session })]);
    expect(w.exists(session)).toBe(false);
  });

  test('only the wallet itself opens or closes its session', async () => {
    const w = await World.create();
    const p = await w.wallet(0), other = await w.wallet(0);
    const { session } = await w.openSession(p, 10);
    await expect(w.chain.send(other.signer, [getCloseSessionInstruction({ wallet: other.signer, table: w.table, session })])).rejects.toThrow();
    await expect(w.chain.send(other.signer, [getOpenSessionInstruction({ wallet: other.signer, table: w.table, session, key: other.signer.address, cap: usd(1_000), expiresAt: w.now() + 60n })])).rejects.toThrow();
    expect(w.read(session, getSessionDecoder()).capRemaining).toBe(usd(10));
  });
});
