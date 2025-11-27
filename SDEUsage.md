Currently Used SDE Tables (19 tables)

Core Type/Item Tables (5)

1. invTypes - All item/blueprint/skill type definitions
2. invGroups - Item groupings (Frigates, Missiles, etc.)
3. invCategories - High-level categories (Ships, Modules, Skills)
4. invMetaTypes - Tech levels (T1, T2, Faction, Officer)
5. invVolumes - Packaged volumes for logistics

Industry/Manufacturing Tables (5)

6. industryActivityMaterials - Blueprint input materials
7. industryActivityProducts - Blueprint output products
8. industryActivity - Manufacturing times and activities
9. industryActivityProbabilities - Invention success rates
10. industryActivitySkills - Required invention skills

Dogma/Attributes Tables (2)

11. dgmTypeAttributes - Numeric attributes (bonuses, modifiers)
12. dgmAttributeTypes - Attribute names and descriptions

Location/Geography Tables (3)

13. mapRegions - EVE regions for market data
14. mapSolarSystems - Solar systems with security status
15. staStations - NPC stations

  ---
High-Priority Unused Tables (Future Features)

Immediate Opportunities

- invTypeMaterials - Reprocessing yields (for buy-vs-reprocess analysis)
- invMarketGroups - Market category hierarchy (better UI/UX)
- industryBlueprints - Blueprint research metadata

Major Features

- planetSchematics, planetSchematicsPinMap, planetSchematicsTypeMap - Planetary Interaction calculator
- invTypeReactions - Moon mining reaction chains
- certCerts, certMasteries, certSkills - Skill planning/certificates

Advanced Features

- agtAgents, agtResearchAgents - Research agent income calculator
- crpNPCCorporations, crpNPCCorporationTrades - LP store profitability
- mapJumps, mapSolarSystemJumps - Route planning/logistics

  ---
All Available SDE Tables (99 total)

84 unused tables include: translation tables, graphics/icons, ship traits, wormhole data, contraband, faction warfare zones, skins, legacy POS data, and various other
specialized datasets.

  ---
Top Recommendations for Future Development

1. Reprocessing Calculator (invTypeMaterials) - Quick win, high value
2. PI Profitability (planet tables) - Highly requested feature
3. Reaction Calculator (invTypeReactions) - Moon mining optimization
4. Market Browser (invMarketGroups) - UX improvement
5. Skill Planning (cert tables) - Player progression aid

Currently, Quantum Forge uses 19.2% of available SDE tables, focusing effectively on manufacturing and invention. The biggest opportunities lie in expanding to reprocessing,
reactions, planetary interaction, and skill planning features.