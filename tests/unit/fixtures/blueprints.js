/**
 * Blueprint Fixtures for Testing
 *
 * Provides realistic blueprint data for testing manufacturing calculations
 * Uses actual Eve Online type IDs and material requirements
 */

// Simple T1 ammo blueprint (Scourge Light Missile)
const scourgeBlueprint = {
  typeID: 810,  // Scourge Light Missile Blueprint
  typeName: 'Scourge Light Missile Blueprint',
  productTypeID: 209,  // Scourge Light Missile
  productName: 'Scourge Light Missile',
  productQuantity: 100,
  baseTime: 40,
  materials: [
    { typeID: 34, typeName: 'Tritanium', quantity: 50 },
    { typeID: 35, typeName: 'Pyerite', quantity: 25 },
    { typeID: 36, typeName: 'Mexallon', quantity: 5 },
    { typeID: 11399, typeName: 'Morphite', quantity: 1 }
  ],
  metaGroupID: 1,  // T1
  categoryID: 8,  // Charge
  groupID: 88  // Light Missile
};

// T1 component blueprint (Capital Construction Parts)
const capitalConstructionPartsBlueprint = {
  typeID: 2870,  // Capital Construction Parts Blueprint
  typeName: 'Capital Construction Parts Blueprint',
  productTypeID: 3828,  // Capital Construction Parts
  productName: 'Capital Construction Parts',
  productQuantity: 1,
  baseTime: 720,
  materials: [
    { typeID: 34, typeName: 'Tritanium', quantity: 3000 },
    { typeID: 35, typeName: 'Pyerite', quantity: 750 },
    { typeID: 36, typeName: 'Mexallon', quantity: 150 }
  ],
  metaGroupID: 1,
  categoryID: 4,  // Material
  groupID: 964  // Intermediate Materials
};

// Complex ship blueprint with intermediate materials (Raven - Battleship)
const ravenBlueprint = {
  typeID: 638,  // Raven Blueprint
  typeName: 'Raven Blueprint',
  productTypeID: 637,  // Raven
  productName: 'Raven',
  productQuantity: 1,
  baseTime: 21600,
  materials: [
    // Raw materials
    { typeID: 34, typeName: 'Tritanium', quantity: 6750000 },
    { typeID: 35, typeName: 'Pyerite', quantity: 1687500 },
    { typeID: 36, typeName: 'Mexallon', quantity: 506250 },
    { typeID: 37, typeName: 'Isogen', quantity: 112500 },
    { typeID: 38, typeName: 'Nocxium', quantity: 32625 },
    { typeID: 39, typeName: 'Zydrine', quantity: 11250 },
    { typeID: 40, typeName: 'Megacyte', quantity: 2813 },
    // Intermediate components
    { typeID: 11539, typeName: 'Magpulse Thruster', quantity: 40 },
    { typeID: 11541, typeName: 'Fusion Reactor Unit', quantity: 40 },
    { typeID: 11543, typeName: 'Deflection Shield Emitter', quantity: 10 }
  ],
  metaGroupID: 1,
  categoryID: 6,  // Ship
  groupID: 27  // Battleship
};

// T2 invention blueprint (Scourge Fury Light Missile from Scourge)
const scourgeT2InventionData = {
  t1BlueprintTypeID: 810,  // Scourge Light Missile Blueprint
  t1ProductTypeID: 209,  // Scourge Light Missile
  t2BlueprintTypeID: 1216,  // Scourge Fury Light Missile Blueprint
  t2ProductTypeID: 2629,  // Scourge Fury Light Missile
  t2ProductName: 'Scourge Fury Light Missile',
  baseProbability: 0.34,  // 34% base invention chance
  inventionMaterials: [
    { typeID: 20410, typeName: 'Datacore - Missile Launcher Operation', quantity: 8 },
    { typeID: 20411, typeName: 'Datacore - Rocket Science', quantity: 8 },
    { typeID: 209, typeName: 'Scourge Light Missile', quantity: 2 }  // Data Interface
  ],
  requiredSkills: [
    { skillID: 3300, skillName: 'Missile Launcher Operation', level: null },  // Varies
    { skillID: 3319, skillName: 'Rocket Science', level: null }  // Varies
  ],
  encryptionSkill: { skillID: 21790, skillName: 'Caldari Encryption Methods' },
  runs: 10,  // T2 BPC runs from invention
  meLevel: 2,  // T2 BPC ME from invention
  teLevel: 4   // T2 BPC TE from invention
};

// T2 blueprint (Scourge Fury - the invented result)
const scourgeFuryBlueprint = {
  typeID: 1216,  // Scourge Fury Light Missile Blueprint
  typeName: 'Scourge Fury Light Missile Blueprint',
  productTypeID: 2629,  // Scourge Fury Light Missile
  productName: 'Scourge Fury Light Missile',
  productQuantity: 1,
  groupID: 91,  // Blueprint group
  categoryID: 9,  // Blueprint category
  materials: [
    { typeID: 34, typeName: 'Tritanium', quantity: 100 },  // T2 items need more minerals
    { typeID: 35, typeName: 'Pyerite', quantity: 75 },
    { typeID: 36, typeName: 'Mexallon', quantity: 25 },
    { typeID: 11399, typeName: 'Morphite', quantity: 5 },  // T2-specific materials
    { typeID: 16670, typeName: 'Crystalline Carbonide', quantity: 10 },  // T2 construction component
    { typeID: 33360, typeName: 'Titanium Carbide', quantity: 8 }
  ]
};

// Decryptor data
const decryptors = [
  {
    typeID: 34201,
    typeName: 'Accelerant Decryptor',
    probabilityModifier: 1.2,
    meModifier: 2,
    teModifier: 10,
    runsModifier: 1
  },
  {
    typeID: 34202,
    typeName: 'Attainment Decryptor',
    probabilityModifier: 1.8,
    meModifier: 4,
    teModifier: 4,
    runsModifier: 3
  },
  {
    typeID: 34203,
    typeName: 'Augmentation Decryptor',
    probabilityModifier: 0.6,
    meModifier: -1,
    teModifier: 2,
    runsModifier: 9
  },
  {
    typeID: 34204,
    typeName: 'Optimized Attainment Decryptor',
    probabilityModifier: 0.9,
    meModifier: 2,
    teModifier: 0,
    runsModifier: 2
  },
  {
    typeID: 34205,
    typeName: 'Optimized Augmentation Decryptor',
    probabilityModifier: 0.9,
    meModifier: 1,
    teModifier: 2,
    runsModifier: 7
  },
  {
    typeID: 34206,
    typeName: 'Parity Decryptor',
    probabilityModifier: 1.5,
    meModifier: 3,
    teModifier: -2,
    runsModifier: 1
  },
  {
    typeID: 34207,
    typeName: 'Process Decryptor',
    probabilityModifier: 1.1,
    meModifier: 3,
    teModifier: 6,
    runsModifier: 0
  },
  {
    typeID: 34208,
    typeName: 'Symmetry Decryptor',
    probabilityModifier: 1.0,
    meModifier: 1,
    teModifier: 8,
    runsModifier: 2
  }
];

// Blueprint with no intermediates (pure raw materials)
const tritaniumBlueprint = {
  typeID: null,  // Tritanium has no blueprint (it's mined)
  typeName: null,
  productTypeID: 34,
  productName: 'Tritanium',
  productQuantity: 0,
  materials: []  // Raw material, no manufacturing
};

// Module blueprint (Light Missile Launcher I)
const lightMissileLauncherBlueprint = {
  typeID: 1204,  // Light Missile Launcher I Blueprint
  typeName: 'Light Missile Launcher I Blueprint',
  productTypeID: 507,  // Light Missile Launcher I
  productName: 'Light Missile Launcher I',
  productQuantity: 1,
  baseTime: 600,
  materials: [
    { typeID: 34, typeName: 'Tritanium', quantity: 150 },
    { typeID: 35, typeName: 'Pyerite', quantity: 112 },
    { typeID: 36, typeName: 'Mexallon', quantity: 35 },
    { typeID: 37, typeName: 'Isogen', quantity: 9 },
    { typeID: 11541, typeName: 'Fusion Reactor Unit', quantity: 4 }  // Intermediate
  ],
  metaGroupID: 1,
  categoryID: 7,  // Module
  groupID: 507,  // Missile Launcher
  productGroupID: 507  // For rig bonus matching
};

// Expected material calculation results (for validation)
const scourgeExpectedMaterials = {
  // No ME, no facility bonuses, 1 run
  noBonus: [
    { typeID: 34, quantity: 50 },
    { typeID: 35, quantity: 25 },
    { typeID: 36, quantity: 5 },
    { typeID: 11399, quantity: 1 }
  ],
  // ME 10, no facility, 1 run
  me10: [
    { typeID: 34, quantity: 45 },   // 50 * 0.9 = 45
    { typeID: 35, quantity: 23 },   // ceil(25 * 0.9) = 23
    { typeID: 36, quantity: 5 },    // ceil(5 * 0.9) = 5 (can't go below runs)
    { typeID: 11399, quantity: 1 }  // 1 (can't go below runs)
  ],
  // ME 10, Upwell structure (1% bonus), no rigs, 1 run
  me10Upwell: [
    { typeID: 34, quantity: 45 },   // ceil(50 * 0.9 * 0.99) = 45
    { typeID: 35, quantity: 23 },   // ceil(25 * 0.9 * 0.99) = 23
    { typeID: 36, quantity: 5 },    // 5
    { typeID: 11399, quantity: 1 }  // 1
  ],
  // ME 10, Upwell + T1 ME rig (1.9% bonus), 1 run
  me10UpwellT1Rig: [
    { typeID: 34, quantity: 45 },   // ceil(50 * 0.9 * 0.99 * 1.019) = 46 (rig negative bonus)
    { typeID: 35, quantity: 23 },   // 23
    { typeID: 36, quantity: 5 },    // 5
    { typeID: 11399, quantity: 1 }  // 1
  ],
  // ME 10, 10 runs
  me10Runs10: [
    { typeID: 34, quantity: 450 },   // 50 * 10 * 0.9 = 450
    { typeID: 35, quantity: 225 },   // 25 * 10 * 0.9 = 225
    { typeID: 36, quantity: 45 },    // ceil(5 * 10 * 0.9) = 45
    { typeID: 11399, quantity: 10 }  // max(10, ceil(1 * 10 * 0.9)) = 10
  ]
};

// Character-owned blueprint data
const characterBlueprints = [
  {
    itemId: '1234567890',
    typeId: 810,  // Scourge Blueprint
    characterId: 123456,
    quantity: -1,  // BPO
    timeEfficiency: 20,
    materialEfficiency: 10,
    runs: -1,
    isCopy: false,
    source: 'esi',
    locationId: 60003760,
    locationFlag: 'Hangar'
  },
  {
    itemId: '1234567891',
    typeId: 638,  // Raven Blueprint
    characterId: 123456,
    quantity: -2,  // BPC
    timeEfficiency: 14,
    materialEfficiency: 5,
    runs: 10,
    isCopy: true,
    source: 'esi',
    locationId: 60003760,
    locationFlag: 'Hangar'
  }
];

// Recursive blueprint tree (simplified Raven with intermediates)
const ravenMaterialTree = {
  blueprint: ravenBlueprint,
  totalMaterials: {
    // Raw materials after recursion
    34: 6750000,   // Tritanium (from ship + from intermediates)
    35: 1687500,   // Pyerite
    36: 506250,    // Mexallon
    37: 112500,    // Isogen
    38: 32625,     // Nocxium
    39: 11250,     // Zydrine
    40: 2813       // Megacyte
  },
  intermediateMaterials: {
    11539: 40,  // Magpulse Thruster
    11541: 40,  // Fusion Reactor Unit
    11543: 10   // Deflection Shield Emitter
  },
  depth: 2  // Ship -> Intermediate components
};

module.exports = {
  // Simple blueprints
  scourgeBlueprint,
  tritaniumBlueprint,
  capitalConstructionPartsBlueprint,
  lightMissileLauncherBlueprint,

  // Complex blueprints
  ravenBlueprint,
  ravenMaterialTree,

  // Invention data
  scourgeT2InventionData,
  scourgeFuryBlueprint,
  decryptors,

  // Character blueprints
  characterBlueprints,

  // Expected calculations
  scourgeExpectedMaterials,

  // Common type IDs for testing
  TYPE_IDS: {
    TRITANIUM: 34,
    PYERITE: 35,
    MEXALLON: 36,
    ISOGEN: 37,
    NOCXIUM: 38,
    ZYDRINE: 39,
    MEGACYTE: 40,
    MORPHITE: 11399,
    SCOURGE_MISSILE: 209,
    SCOURGE_BLUEPRINT: 810,
    LIGHT_MISSILE_LAUNCHER: 507,
    LIGHT_MISSILE_LAUNCHER_BLUEPRINT: 1204,
    RAVEN: 637,
    RAVEN_BLUEPRINT: 638
  }
};
