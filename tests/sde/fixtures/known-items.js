/**
 * Known Eve Online items for testing SDE schema validity
 * These items are foundational to Eve and should never change
 */

module.exports = {
  // Basic materials - these are fundamental to Eve
  materials: {
    tritanium: { typeID: 34, typeName: 'Tritanium', groupID: 18 },
    pyerite: { typeID: 35, typeName: 'Pyerite', groupID: 18 },
    mexallon: { typeID: 36, typeName: 'Mexallon', groupID: 18 },
    isogen: { typeID: 37, typeName: 'Isogen', groupID: 18 },
    nocxium: { typeID: 38, typeName: 'Nocxium', groupID: 18 },
    zydrine: { typeID: 39, typeName: 'Zydrine', groupID: 18 },
    megacyte: { typeID: 40, typeName: 'Megacyte', groupID: 18 },
  },

  // Ores - won't change
  ores: {
    veldspar: { typeID: 1230, typeName: 'Veldspar', groupID: 1884 },
    scordite: { typeID: 1228, typeName: 'Scordite', groupID: 1884 },
  },

  // Ammunition - T1 and T2 examples
  ammunition: {
    scourgeHeavyMissile: {
      typeID: 209,
      typeName: 'Scourge Heavy Missile',
      metaGroupID: 1, // Tech I
      categoryName: 'Charge',
    },
    scourgeFuryHeavyMissile: {
      typeID: 2629,
      typeName: 'Scourge Fury Heavy Missile',
      metaGroupID: 2, // Tech II
      categoryName: 'Charge',
    },
  },

  // Ships - well-known ships
  ships: {
    raven: {
      typeID: 638,
      typeName: 'Raven',
      groupID: 27, // Battleship
      metaGroupID: 1, // Tech I
      categoryName: 'Ship',
    },
    rifter: {
      typeID: 587,
      typeName: 'Rifter',
      groupID: 25, // Frigate
      metaGroupID: 1, // Tech I
      categoryName: 'Ship',
    },
  },

  // Blueprints
  blueprints: {
    ravenBlueprint: {
      typeID: 638, // Raven Blueprint shares same typeID as product in some queries
      blueprintTypeID: 638,
      productTypeID: 638,
      typeName: 'Raven Blueprint',
    },
    scourgeHeavyMissileBlueprint: {
      blueprintTypeID: 810, // Correct typeID verified from SDE
      productTypeID: 209, // Produces Scourge Heavy Missile
      typeName: 'Scourge Heavy Missile Blueprint',
    },
    punisherBlueprint: {
      blueprintTypeID: 944,
      productTypeID: 597, // Produces Punisher
      typeName: 'Punisher Blueprint',
    },
  },

  // Structure types - commonly used
  structures: {
    raitaru: {
      typeID: 35825,
      typeName: 'Raitaru',
      groupID: 1404, // Engineering Complex
    },
    athanor: {
      typeID: 35835,
      typeName: 'Athanor',
      groupID: 1406, // Refinery
    },
  },

  // Structure rigs - commonly used for manufacturing
  rigs: {
    meRigT1: {
      typeID: 43920,
      typeName: 'Standup M-Set Equipment Manufacturing Material Efficiency I',
      groupID: 1713,
    },
    meRigT2: {
      typeID: 43921,
      typeName: 'Standup M-Set Equipment Manufacturing Material Efficiency II',
      groupID: 1713,
    },
  },

  // Systems and regions for location testing
  locations: {
    jita: {
      systemID: 30000142,
      systemName: 'Jita',
      regionID: 10000002,
      regionName: 'The Forge',
      securityStatus: 0.9,
    },
    amarr: {
      systemID: 30002187,
      systemName: 'Amarr',
      regionID: 10000043,
      regionName: 'Domain',
      securityStatus: 1.0,
    },
  },

  // Critical tables that must exist
  requiredTables: [
    'invTypes',
    'invGroups',
    'invCategories',
    'invMetaTypes',
    'invVolumes',
    'industryActivityMaterials',
    'industryActivityProducts',
    'industryActivity',
    'dgmTypeAttributes',
    'dgmAttributeTypes',
    'mapRegions',
    'mapSolarSystems',
    'staStations',
  ],

  // Critical columns in invTypes table
  invTypesColumns: [
    'typeID',
    'typeName',
    'groupID',
    'volume',
    'published',
  ],

  // Critical columns for blueprint queries
  industryActivityMaterialsColumns: [
    'typeID',
    'activityID',
    'materialTypeID',
    'quantity',
  ],

  industryActivityProductsColumns: [
    'typeID',
    'activityID',
    'productTypeID',
    'quantity',
  ],
};
