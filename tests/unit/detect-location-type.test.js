/**
 * Locks in detectLocationType against the official EVE ID ranges.
 * Reference: docs/eve-id-ranges.md
 */

// sde-database → sde-manager → portable-mode needs Electron's `app`; stub the
// manager so we can require the pure detectLocationType function.
jest.mock('../../src/main/sde-manager', () => ({
  getSdePath: jest.fn(() => '/nonexistent/sde.db'),
  sdeExists: jest.fn(() => false),
}));

const { detectLocationType } = require('../../src/main/sde-database');

describe('detectLocationType', () => {
  test('NPC stations are exactly 60,000,000–60,999,999', () => {
    expect(detectLocationType(60000000)).toBe('npc-station');
    expect(detectLocationType(60003760)).toBe('npc-station'); // Jita 4-4
    expect(detectLocationType(60999999)).toBe('npc-station');
  });

  test('outposts and station folders are NOT npc-station', () => {
    expect(detectLocationType(61000001)).not.toBe('npc-station'); // outpost
    expect(detectLocationType(63000000)).not.toBe('npc-station'); // outpost
    expect(detectLocationType(66000000)).not.toBe('npc-station'); // corp office folder
    expect(detectLocationType(68000000)).not.toBe('npc-station'); // NPC station folder
    expect(detectLocationType(69000000)).not.toBe('npc-station'); // outpost folder
  });

  test('solar systems span 30M–36M across sub-ranges', () => {
    expect(detectLocationType(30000142)).toBe('system'); // Jita (known space)
    expect(detectLocationType(31000001)).toBe('system'); // wormhole
    expect(detectLocationType(32000001)).toBe('system'); // abyssal
    expect(detectLocationType(34000001)).toBe('system'); // void
    expect(detectLocationType(36000001)).toBe('system'); // hidden
  });

  test('does not classify 37M–39M as system (undocumented)', () => {
    expect(detectLocationType(37000000)).toBe('unknown');
    expect(detectLocationType(39999999)).toBe('unknown');
  });

  test('>= 1 trillion is asset (spawned items: item_ids AND structures)', () => {
    expect(detectLocationType(1000000000000)).toBe('asset');
    expect(detectLocationType(1035000000001)).toBe('asset'); // typical structure/asset id
  });

  test('regions/constellations/celestials/stargates are unknown here', () => {
    expect(detectLocationType(10000002)).toBe('unknown'); // region (The Forge)
    expect(detectLocationType(20000020)).toBe('unknown'); // constellation
    expect(detectLocationType(40000001)).toBe('unknown'); // celestial
    expect(detectLocationType(50000001)).toBe('unknown'); // stargate
  });
});
