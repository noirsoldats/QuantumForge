/**
 * Manufacturing Facility Fixtures for Testing
 *
 * Provides realistic facility configurations with structure types and rigs
 * for testing manufacturing bonuses
 */

// NPC Station (no bonuses)
const npcStation = {
  id: 'npc-jita',
  name: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant',
  usage: 'standard',
  facilityType: 'station',
  stationId: 60003760,
  regionId: 10000002,  // The Forge
  systemId: 30000142,  // Jita
  securityStatus: 0.95,
  structureTypeId: null,
  rigs: [],
  bonuses: {
    materialEfficiency: 0,
    timeEfficiency: 0,
    costReduction: 0
  }
};

// Raitaru (Medium Engineering Complex) - No rigs
const raitaruNoRigs = {
  id: 'raitaru-basic',
  name: 'Test Raitaru',
  usage: 'default',
  facilityType: 'structure',
  stationId: null,
  regionId: 10000002,
  systemId: 30000142,
  securityStatus: 0.95,
  structureTypeId: 35825,  // Raitaru
  rigs: [],
  bonuses: {
    materialEfficiency: 1.0,  // 1% ME bonus (Upwell structure)
    timeEfficiency: 15.0,     // 15% TE bonus
    costReduction: 0
  }
};

// Raitaru with T1 ME Rig
const raitaruT1MERig = {
  id: 'raitaru-me-t1',
  name: 'Raitaru with T1 ME Rig',
  usage: 'default',
  facilityType: 'structure',
  stationId: null,
  regionId: 10000002,
  systemId: 30000142,
  securityStatus: 0.95,
  structureTypeId: 35825,
  rigs: [
    {
      typeId: 43920,  // Standup M-Set Basic Material Efficiency I
      name: 'Standup M-Set Basic Material Efficiency I',
      bonusType: 'materialEfficiency',
      bonusValue: 1.9  // Additional 1.9% ME reduction (negative bonus)
    }
  ],
  bonuses: {
    materialEfficiency: 2.9,  // 1% structure + 1.9% rig
    timeEfficiency: 15.0,
    costReduction: 0
  }
};

// Raitaru with T2 ME Rig
const raitaruT2MERig = {
  id: 'raitaru-me-t2',
  name: 'Raitaru with T2 ME Rig',
  usage: 'standard',
  facilityType: 'structure',
  stationId: null,
  regionId: 10000002,
  systemId: 30000142,
  securityStatus: 0.95,
  structureTypeId: 35825,
  rigs: [
    {
      typeId: 43921,  // Standup M-Set Advanced Material Efficiency II
      name: 'Standup M-Set Advanced Material Efficiency II',
      bonusType: 'materialEfficiency',
      bonusValue: 2.4  // 2.4% ME reduction
    }
  ],
  bonuses: {
    materialEfficiency: 3.4,  // 1% structure + 2.4% rig
    timeEfficiency: 15.0,
    costReduction: 0
  }
};

// Raitaru with T1 TE Rig
const raitaruT1TERig = {
  id: 'raitaru-te-t1',
  name: 'Raitaru with T1 TE Rig',
  usage: 'standard',
  facilityType: 'structure',
  stationId: null,
  regionId: 10000002,
  systemId: 30000142,
  securityStatus: 0.95,
  structureTypeId: 35825,
  rigs: [
    {
      typeId: 43922,  // Standup M-Set Basic Time Efficiency I
      name: 'Standup M-Set Basic Time Efficiency I',
      bonusType: 'timeEfficiency',
      bonusValue: 20.0  // 20% TE reduction
    }
  ],
  bonuses: {
    materialEfficiency: 1.0,
    timeEfficiency: 35.0,  // 15% structure + 20% rig
    costReduction: 0
  }
};

// Azbel (Large Engineering Complex) - No rigs
const azbelNoRigs = {
  id: 'azbel-basic',
  name: 'Test Azbel',
  usage: 'standard',
  facilityType: 'structure',
  stationId: null,
  regionId: 10000002,
  systemId: 30000142,
  securityStatus: 0.95,
  structureTypeId: 35826,  // Azbel
  rigs: [],
  bonuses: {
    materialEfficiency: 1.0,  // 1% ME bonus (Upwell structure)
    timeEfficiency: 20.0,     // 20% TE bonus (Large structure)
    costReduction: 0
  }
};

// Azbel with multiple rigs
const azbelMultipleRigs = {
  id: 'azbel-multi-rig',
  name: 'Azbel with Multiple Rigs',
  usage: 'default',
  facilityType: 'structure',
  stationId: null,
  regionId: 10000002,
  systemId: 30000142,
  securityStatus: 0.95,
  structureTypeId: 35826,
  rigs: [
    {
      typeId: 43924,  // Standup L-Set Basic Material Efficiency I
      name: 'Standup L-Set Basic Material Efficiency I',
      bonusType: 'materialEfficiency',
      bonusValue: 1.9
    },
    {
      typeId: 43926,  // Standup L-Set Basic Time Efficiency I
      name: 'Standup L-Set Basic Time Efficiency I',
      bonusType: 'timeEfficiency',
      bonusValue: 20.0
    },
    {
      typeId: 43928,  // Standup L-Set Basic Cost Reduction I
      name: 'Standup L-Set Basic Cost Reduction I',
      bonusType: 'costReduction',
      bonusValue: 1.0  // 1% cost reduction
    }
  ],
  bonuses: {
    materialEfficiency: 2.9,  // 1% + 1.9%
    timeEfficiency: 40.0,     // 20% + 20%
    costReduction: 1.0
  }
};

// Sotiyo (XL Engineering Complex) - Maximum bonuses
const sotiyoMaxRigs = {
  id: 'sotiyo-max',
  name: 'Sotiyo with Max Rigs',
  usage: 'standard',
  facilityType: 'structure',
  stationId: null,
  regionId: 10000002,
  systemId: 30000142,
  securityStatus: 0.95,
  structureTypeId: 35827,  // Sotiyo
  rigs: [
    {
      typeId: 43931,  // Standup XL-Set Advanced Material Efficiency II
      name: 'Standup XL-Set Advanced Material Efficiency II',
      bonusType: 'materialEfficiency',
      bonusValue: 2.4
    },
    {
      typeId: 43933,  // Standup XL-Set Advanced Time Efficiency II
      name: 'Standup XL-Set Advanced Time Efficiency II',
      bonusType: 'timeEfficiency',
      bonusValue: 24.0
    }
  ],
  bonuses: {
    materialEfficiency: 3.4,  // 1% + 2.4%
    timeEfficiency: 49.0,     // 25% (XL structure) + 24% (rig)
    costReduction: 0
  }
};

// Low-sec facility (higher system cost index)
const lowsecFacility = {
  id: 'lowsec-raitaru',
  name: 'Lowsec Raitaru',
  usage: 'standard',
  facilityType: 'structure',
  stationId: null,
  regionId: 10000002,
  systemId: 30000144,  // Different system (hypothetical lowsec)
  securityStatus: 0.4,
  structureTypeId: 35825,
  rigs: [],
  bonuses: {
    materialEfficiency: 1.0,
    timeEfficiency: 15.0,
    costReduction: 0
  },
  systemCostIndex: 0.05  // 5% cost index (higher than highsec)
};

// Null-sec facility (lower system cost index)
const nullsecFacility = {
  id: 'nullsec-azbel',
  name: 'Nullsec Azbel',
  usage: 'standard',
  facilityType: 'structure',
  stationId: null,
  regionId: 10000060,  // Different region (hypothetical null)
  systemId: 30004738,  // Hypothetical nullsec system
  securityStatus: -0.3,
  structureTypeId: 35826,
  rigs: [
    {
      typeId: 43924,
      name: 'Standup L-Set Basic Material Efficiency I',
      bonusType: 'materialEfficiency',
      bonusValue: 1.9
    }
  ],
  bonuses: {
    materialEfficiency: 2.9,
    timeEfficiency: 20.0,
    costReduction: 0
  },
  systemCostIndex: 0.001  // Very low cost index in null
};

// Rig type data (for reference)
const rigTypes = {
  // Medium (Raitaru) rigs
  M_ME_T1: { typeId: 43920, bonus: 1.9, type: 'ME' },
  M_ME_T2: { typeId: 43921, bonus: 2.4, type: 'ME' },
  M_TE_T1: { typeId: 43922, bonus: 20.0, type: 'TE' },
  M_TE_T2: { typeId: 43923, bonus: 24.0, type: 'TE' },

  // Large (Azbel) rigs
  L_ME_T1: { typeId: 43924, bonus: 1.9, type: 'ME' },
  L_ME_T2: { typeId: 43925, bonus: 2.4, type: 'ME' },
  L_TE_T1: { typeId: 43926, bonus: 20.0, type: 'TE' },
  L_TE_T2: { typeId: 43927, bonus: 24.0, type: 'TE' },
  L_COST_T1: { typeId: 43928, bonus: 1.0, type: 'COST' },

  // XL (Sotiyo) rigs
  XL_ME_T1: { typeId: 43930, bonus: 1.9, type: 'ME' },
  XL_ME_T2: { typeId: 43931, bonus: 2.4, type: 'ME' },
  XL_TE_T1: { typeId: 43932, bonus: 20.0, type: 'TE' },
  XL_TE_T2: { typeId: 43933, bonus: 24.0, type: 'TE' }
};

// Structure type IDs
const structureTypes = {
  RAITARU: 35825,   // Medium Engineering Complex
  AZBEL: 35826,     // Large Engineering Complex
  SOTIYO: 35827,    // XL Engineering Complex
  ATHANOR: 35835,   // Medium Refinery
  TATARA: 35836     // Large Refinery
};

// Expected bonus calculations
const expectedBonuses = {
  npcStation: {
    meMultiplier: 1.0,     // No bonus
    teMultiplier: 1.0,
    costMultiplier: 1.0
  },
  raitaruNoRigs: {
    meMultiplier: 0.99,    // 1% reduction
    teMultiplier: 0.85,    // 15% reduction
    costMultiplier: 1.0
  },
  raitaruT1MERig: {
    meMultiplier: 0.971,   // 1% + 1.9% = 2.9% reduction
    teMultiplier: 0.85,
    costMultiplier: 1.0
  },
  azbelMultipleRigs: {
    meMultiplier: 0.971,   // 2.9% reduction
    teMultiplier: 0.6,     // 40% reduction
    costMultiplier: 0.99   // 1% reduction
  },
  sotiyoMaxRigs: {
    meMultiplier: 0.966,   // 3.4% reduction
    teMultiplier: 0.51,    // 49% reduction
    costMultiplier: 1.0
  }
};

module.exports = {
  // Facilities
  npcStation,
  raitaruNoRigs,
  raitaruT1MERig,
  raitaruT2MERig,
  raitaruT1TERig,
  azbelNoRigs,
  azbelMultipleRigs,
  sotiyoMaxRigs,
  lowsecFacility,
  nullsecFacility,

  // Reference data
  rigTypes,
  structureTypes,
  expectedBonuses,

  // Common system/location IDs
  JITA_SYSTEM_ID: 30000142,
  JITA_STATION_ID: 60003760,
  THE_FORGE_REGION_ID: 10000002
};
