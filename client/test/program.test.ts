import { describe, expect, test } from 'bun:test';
import { getVersionInstruction } from '../src';
import { Chain } from './harness';

describe('the roulette program', () => {
  test('is loaded and answers a call', async () => {
    const chain = await Chain.create();
    const payer = await chain.signer();
    const meta = await chain.send(payer, [getVersionInstruction()]);
    expect(meta.logs().join('\n')).toContain('roulette 0.4.0');
  });
});
