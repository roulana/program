import { describe, expect, test } from 'bun:test';
import { BET_SPOTS } from '../src/engine';
import { spotsRust } from '../scripts/gen-spots';
import { spotId, spotIndex } from '../src';

describe('bet spots on-chain', () => {
  test('the program\'s spots.rs is exactly what the engine generates (regenerate with `bun run spots`)', async () => {
    const onDisk = await Bun.file(new URL('../../program/programs/roulette/src/spots.rs', import.meta.url)).text();
    expect(onDisk).toBe(spotsRust());
  });

  test('every spot has a stable index', () => {
    expect(BET_SPOTS.length).toBe(157);
    expect(spotIndex('straight:0')).toBe(0);
    expect(spotIndex('straight:17')).toBe(17);
    expect(spotId(spotIndex('corner:13'))).toBe('corner:13');
    expect(() => spotIndex('straight:37')).toThrow();
  });
});
