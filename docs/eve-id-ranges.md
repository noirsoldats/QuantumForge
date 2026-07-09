# EVE Online ID Ranges (reference)

Source: https://developers.eveonline.com/docs/guides/id-ranges/
Captured: 2026-07 (verify against the live page if IDs behave unexpectedly).

EVE assigns numeric IDs to entities in fixed ranges. Code that classifies an ID
by its value (e.g. `detectLocationType` in `src/main/sde-database.js`) must use
these ranges. **When in doubt, prefer resolving via SDE/ESI over range guessing.**

## Ranges

| Range (inclusive)                     | Entity type |
|---------------------------------------|-------------|
| 10,000,000 – 19,999,999               | Regions |
| 20,000,000 – 26,999,999               | Constellations |
| 30,000,000 – 30,999,999               | Solar systems — New Eden (known space) |
| 31,000,000 – 31,999,999               | Solar systems — Wormhole |
| 32,000,000 – 32,999,999               | Solar systems — Abyssal |
| 34,000,000 – 34,999,999               | Solar systems — Void |
| 36,000,000 – 36,999,999               | Solar systems — Hidden |
| 40,000,000 – 49,999,999               | Celestials (planets, moons, belts, etc.) |
| 50,000,000 – 59,999,999               | Stargates |
| 60,000,000 – 60,999,999               | **NPC stations** |
| 61,000,000 – 63,999,999               | Outposts (legacy conquerable/player outposts) |
| 66,000,000 – 67,999,999               | Station folders — corp office hangars |
| 68,000,000 – 68,999,999               | Station folders — NPC stations |
| 69,000,000 – 69,999,999               | Station folders — outposts |
| 90,000,000 – 97,999,999               | Characters created 2010-11-03 … 2016-05-30 |
| 98,000,000 – 98,999,999               | Corporations created after 2010-11-03 |
| 99,000,000 – 99,999,999               | Alliances created after 2010-11-03 |
| 100,000,000 – 2,099,999,999           | Characters, corporations, alliances created **before** 2010-11-03 |
| 2,100,000,000 – 2,111,999,999         | EVE / DUST characters created after 2016-05-30 |
| 2,112,000,000 – 2,129,999,999         | EVE characters created after 2016-05-30 |
| 1,000,000,000,000+ (≥ 1 trillion)     | **Spawned/dynamic items** |

## Notes & gotchas

- **NPC stations are ONLY 60,000,000–60,999,999.** The old code treated the
  whole 60M–69M band as "npc-station," but 61M–63M are outposts and 66M–69M are
  station *folders* (containers). Only 60M–60.999M resolve via `staStations`.
- **Solar systems span 30M–36M** across five sub-ranges (known space, wormhole,
  abyssal, void, hidden), not a single 30M–39M block.
- **Player-owned Upwell structures / citadels have NO distinct range.** They live
  in the **≥ 1 trillion "spawned items"** pool ALONGSIDE asset `item_id`s. You
  **cannot** tell a structure from an asset container by ID alone — you must try
  to resolve it (SDE has no structure names; use ESI
  `/universe/structures/{id}/`, which needs `esi-universe.read_structures.v1`).
  This is why `esi-structures.js` attempts an ESI lookup for non-container ≥1T
  IDs and falls back to a labeled placeholder on failure.
- The page documents allocation up to ~2.13 billion, then jumps to 1 trillion.
  IDs between ~2.13B and 1T are unspecified.
