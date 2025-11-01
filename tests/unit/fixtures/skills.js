/**
 * Character Skills Fixtures for Testing
 *
 * Provides character skill data for testing invention probability
 * and manufacturing calculations
 */

// Character with no skills (new character)
const noSkills = {
  characterId: 100001,
  characterName: 'Newbie Pilot',
  skills: {},
  skillOverrides: {}
};

// Character with basic manufacturing skills (level 3)
const basicManufacturingSkills = {
  characterId: 100002,
  characterName: 'Basic Manufacturer',
  skills: {
    3380: { skillId: 3380, trainedSkillLevel: 3, activeSkillLevel: 3 },  // Industry
    3387: { skillId: 3387, trainedSkillLevel: 3, activeSkillLevel: 3 },  // Mass Production
    24625: { skillId: 24625, trainedSkillLevel: 3, activeSkillLevel: 3 } // Advanced Industry
  },
  skillOverrides: {}
};

// Character with maxed manufacturing skills (level 5)
const maxManufacturingSkills = {
  characterId: 100003,
  characterName: 'Master Manufacturer',
  skills: {
    3380: { skillId: 3380, trainedSkillLevel: 5, activeSkillLevel: 5 },  // Industry
    3387: { skillId: 3387, trainedSkillLevel: 5, activeSkillLevel: 5 },  // Mass Production
    24625: { skillId: 24625, trainedSkillLevel: 5, activeSkillLevel: 5 } // Advanced Industry
  },
  skillOverrides: {}
};

// Character with invention skills (Caldari encryption)
const basicInventionSkills = {
  characterId: 100004,
  characterName: 'Basic Inventor',
  skills: {
    3300: { skillId: 3300, trainedSkillLevel: 3, activeSkillLevel: 3 },  // Missile Launcher Operation
    3319: { skillId: 3319, trainedSkillLevel: 3, activeSkillLevel: 3 },  // Rocket Science
    21790: { skillId: 21790, trainedSkillLevel: 3, activeSkillLevel: 3 }, // Caldari Encryption Methods
    11441: { skillId: 11441, trainedSkillLevel: 3, activeSkillLevel: 3 }, // Laboratory Operation
    11450: { skillId: 11450, trainedSkillLevel: 3, activeSkillLevel: 3 }  // Advanced Laboratory Operation
  },
  skillOverrides: {}
};

// Character with maxed invention skills
const maxInventionSkills = {
  characterId: 100005,
  characterName: 'Master Inventor',
  skills: {
    3300: { skillId: 3300, trainedSkillLevel: 5, activeSkillLevel: 5 },  // Missile Launcher Operation
    3319: { skillId: 3319, trainedSkillLevel: 5, activeSkillLevel: 5 },  // Rocket Science
    21790: { skillId: 21790, trainedSkillLevel: 5, activeSkillLevel: 5 }, // Caldari Encryption Methods
    11441: { skillId: 11441, trainedSkillLevel: 5, activeSkillLevel: 5 }, // Laboratory Operation
    11450: { skillId: 11450, trainedSkillLevel: 5, activeSkillLevel: 5 }  // Advanced Laboratory Operation
  },
  skillOverrides: {}
};

// Simplified skills for calculateInventionProbability testing
const advancedSkills = {
  encryption: 5,
  datacore1: 5,
  datacore2: 5
};

// Character with skill overrides
const skillsWithOverrides = {
  characterId: 100006,
  characterName: 'Pilot with Overrides',
  skills: {
    3300: { skillId: 3300, trainedSkillLevel: 3, activeSkillLevel: 3 },  // Missile Launcher Operation
    3319: { skillId: 3319, trainedSkillLevel: 2, activeSkillLevel: 2 }   // Rocket Science
  },
  skillOverrides: {
    3300: 5,  // Override to level 5 for "what-if" planning
    3319: 5   // Override to level 5
  }
};

// Invention-related skill IDs (for reference)
const inventionSkillIds = {
  // Caldari (Missiles/Rockets)
  MISSILE_LAUNCHER_OPERATION: 3300,
  ROCKET_SCIENCE: 3319,
  CALDARI_ENCRYPTION: 21790,

  // Gallente (Drones/Hybrid)
  GALLENTE_ENCRYPTION: 21791,
  MECHANICAL_ENGINEERING: 3392,
  NANITE_ENGINEERING: 11454,

  // Amarr (Energy/Laser)
  AMARR_ENCRYPTION: 23087,
  ELECTROMAGNETIC_PHYSICS: 3427,
  QUANTUM_PHYSICS: 11433,

  // Minmatar (Projectile)
  MINMATAR_ENCRYPTION: 23121,
  MOLECULAR_ENGINEERING: 11453,
  ROCKET_SCIENCE: 3319,

  // Laboratory
  LABORATORY_OPERATION: 11441,
  ADVANCED_LABORATORY_OPERATION: 11450,
  SCIENCE: 3402
};

// Manufacturing skill IDs
const manufacturingSkillIds = {
  INDUSTRY: 3380,
  MASS_PRODUCTION: 3387,
  ADVANCED_INDUSTRY: 24625,
  ADVANCED_MASS_PRODUCTION: 24624
};

// Expected invention probability calculations
const expectedInventionProbabilities = {
  // Base probability: 0.34 (34%) for Scourge Fury invention
  // Formula: baseProbability × (1 + encryption/40) × (1 + (datacore1 + datacore2)/30) × decryptorMultiplier

  noSkills: {
    noDecryptor: 0.34,  // 34% (no skill bonuses)
    accelerantDecryptor: 0.408  // 34% × 1.2 = 40.8%
  },

  basic: {
    // Skills: Encryption 3, Datacore1 3, Datacore2 3
    // (1 + 3/40) × (1 + (3 + 3)/30) = 1.075 × 1.2 = 1.29
    noDecryptor: 0.4386,  // 34% × 1.29 = 43.86%
    accelerantDecryptor: 0.5263,  // 34% × 1.29 × 1.2 = 52.63%
    attainmentDecryptor: 0.7895  // 34% × 1.29 × 1.8 = 78.95%
  },

  max: {
    // Skills: Encryption 5, Datacore1 5, Datacore2 5
    // (1 + 5/40) × (1 + (5 + 5)/30) = 1.125 × 1.3333 = 1.5
    noDecryptor: 0.51,  // 34% × 1.5 = 51%
    accelerantDecryptor: 0.612,  // 34% × 1.5 × 1.2 = 61.2%
    attainmentDecryptor: 0.918,  // 34% × 1.5 × 1.8 = 91.8%
    augmentationDecryptor: 0.306  // 34% × 1.5 × 0.6 = 30.6%
  },

  // Probability cap test (should never exceed 100%)
  cappedAt100: {
    // Even with best skills and best decryptor, cap at 100%
    maxPossible: 1.0
  }
};

// Character data in ESI format (for mocking)
const esiCharacterData = {
  basicManufacturer: {
    characterId: 100002,
    characterName: 'Basic Manufacturer',
    corporationId: 98000001,
    allianceId: null,
    scopes: ['esi-skills.read_skills.v1', 'esi-universe.read_structures.v1'],
    portrait: 'https://images.evetech.net/characters/100002/portrait',
    accessToken: 'mock_access_token',
    refreshToken: 'mock_refresh_token',
    expiresAt: Date.now() + 3600000,
    tokenType: 'Bearer',
    skills: basicManufacturingSkills.skills,
    skillOverrides: {}
  },

  masterInventor: {
    characterId: 100005,
    characterName: 'Master Inventor',
    corporationId: 98000001,
    allianceId: null,
    scopes: ['esi-skills.read_skills.v1', 'esi-universe.read_structures.v1'],
    portrait: 'https://images.evetech.net/characters/100005/portrait',
    accessToken: 'mock_access_token',
    refreshToken: 'mock_refresh_token',
    expiresAt: Date.now() + 3600000,
    tokenType: 'Bearer',
    skills: maxInventionSkills.skills,
    skillOverrides: {}
  }
};

// Skill bonus multiplier calculations (for reference)
const skillBonusCalculations = {
  encryptionBonus: (level) => 1 + (level / 40),  // 2.5% per level
  datacoreBonus: (level1, level2) => 1 + ((level1 + level2) / 30),  // 3.33% per level combined
  combinedBonus: (encryptionLevel, datacoreLevel1, datacoreLevel2) => {
    const encryption = 1 + (encryptionLevel / 40);
    const datacore = 1 + ((datacoreLevel1 + datacoreLevel2) / 30);
    return encryption * datacore;
  }
};

// Expected skill levels for testing getEffectiveSkillLevel
const effectiveSkillLevels = {
  noOverride: {
    characterId: 100002,
    skillId: 3300,
    expected: 3  // Actual trained level
  },
  withOverride: {
    characterId: 100006,
    skillId: 3300,
    expected: 5  // Override takes precedence
  },
  untrainedSkill: {
    characterId: 100002,
    skillId: 99999,  // Skill not trained
    expected: 0
  }
};

module.exports = {
  // Character skill fixtures
  noSkills,
  basicManufacturingSkills,
  maxManufacturingSkills,
  basicInventionSkills,
  maxInventionSkills,
  advancedSkills,
  skillsWithOverrides,

  // ESI format data
  esiCharacterData,

  // Skill IDs
  inventionSkillIds,
  manufacturingSkillIds,

  // Expected calculations
  expectedInventionProbabilities,
  skillBonusCalculations,
  effectiveSkillLevels,

  // Helper function to create skill data
  createSkill: (skillId, level) => ({
    skillId,
    trainedSkillLevel: level,
    activeSkillLevel: level
  })
};
