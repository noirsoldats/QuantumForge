const { getCharacterDatabase } = require('./character-database');
const { loadSettings, saveSettings } = require('./settings-manager');

/**
 * Check if character data migration is needed
 * @returns {boolean} True if migration is needed
 */
function needsCharacterDataMigration() {
  const settings = loadSettings();

  // Check if migration already done
  if (settings.general?.characterDataMigratedToSqlite) {
    console.log('[Character Data Migration] Already completed');
    return false;
  }

  // Check if there's data to migrate
  const hasCharacters = settings.accounts?.characters?.length > 0;
  const hasBlueprints = settings.owned_blueprints?.length > 0;

  if (hasCharacters || hasBlueprints) {
    console.log('[Character Data Migration] Migration needed:', {
      characters: settings.accounts?.characters?.length || 0,
      blueprints: settings.owned_blueprints?.length || 0
    });
    return true;
  }

  console.log('[Character Data Migration] No data to migrate');
  return false;
}

/**
 * Migrate character data from JSON to SQLite
 * @returns {Promise<void>}
 */
async function migrateCharacterDataToSqlite() {
  console.log('[Character Data Migration] Starting migration to SQLite...');

  const settings = loadSettings();
  const db = getCharacterDatabase();

  try {
    // Begin transaction for atomic migration
    db.exec('BEGIN TRANSACTION');

    // Migrate characters
    const characters = settings.accounts?.characters || [];
    console.log(`[Character Data Migration] Migrating ${characters.length} characters...`);

    for (const char of characters) {
      // Insert character
      db.prepare(`
        INSERT OR REPLACE INTO characters (
          character_id, character_name, corporation_id, alliance_id,
          portrait, access_token, refresh_token, expires_at,
          token_type, scopes, added_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        char.characterId,
        char.characterName,
        char.corporationId || null,
        char.allianceId || null,
        char.portrait || null,
        char.accessToken,
        char.refreshToken,
        char.expiresAt,
        char.tokenType || 'Bearer',
        JSON.stringify(char.scopes || []),
        char.addedAt || Date.now(),
        Date.now()
      );

      // Migrate skills
      if (char.skills?.skills) {
        const skillsMetadata = db.prepare(`
          INSERT OR REPLACE INTO skills_metadata (
            character_id, total_sp, unallocated_sp, last_updated, cache_expires_at
          ) VALUES (?, ?, ?, ?, ?)
        `);

        skillsMetadata.run(
          char.characterId,
          char.skills.totalSp || 0,
          char.skills.unallocatedSp || 0,
          char.skills.lastUpdated || Date.now(),
          char.skills.cacheExpiresAt || null
        );

        const insertSkill = db.prepare(`
          INSERT OR REPLACE INTO skills (
            character_id, skill_id, active_skill_level,
            trained_skill_level, skillpoints_in_skill
          ) VALUES (?, ?, ?, ?, ?)
        `);

        for (const [skillId, skillData] of Object.entries(char.skills.skills)) {
          insertSkill.run(
            char.characterId,
            parseInt(skillId),
            skillData.activeSkillLevel,
            skillData.trainedSkillLevel,
            skillData.skillpointsInSkill
          );
        }

        console.log(`[Character Data Migration] Migrated ${Object.keys(char.skills.skills).length} skills for ${char.characterName}`);
      }

      // Migrate skill overrides
      if (char.skillOverrides) {
        const insertOverride = db.prepare(`
          INSERT OR REPLACE INTO skill_overrides (character_id, skill_id, override_level)
          VALUES (?, ?, ?)
        `);

        for (const [skillId, level] of Object.entries(char.skillOverrides)) {
          insertOverride.run(char.characterId, parseInt(skillId), level);
        }

        console.log(`[Character Data Migration] Migrated ${Object.keys(char.skillOverrides).length} skill overrides for ${char.characterName}`);
      }
    }

    // Migrate blueprints
    const blueprints = settings.owned_blueprints || [];
    console.log(`[Character Data Migration] Migrating ${blueprints.length} blueprints...`);

    const insertBlueprint = db.prepare(`
      INSERT OR REPLACE INTO blueprints (
        item_id, type_id, character_id, corporation_id, location_id,
        location_flag, quantity, time_efficiency, material_efficiency,
        runs, is_copy, is_corporation, source, manually_added,
        fetched_at, last_updated, cache_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const bp of blueprints) {
      insertBlueprint.run(
        bp.itemId,
        bp.typeId,
        bp.characterId,
        bp.corporationId || null,
        bp.locationId || null,
        bp.locationFlag || null,
        bp.quantity,
        bp.timeEfficiency || 0,
        bp.materialEfficiency || 0,
        bp.runs || -1,
        bp.isCopy ? 1 : 0,
        bp.isCorporation ? 1 : 0,
        bp.source,
        bp.manuallyAdded ? 1 : 0,
        bp.fetchedAt || null,
        bp.lastUpdated || Date.now(),
        bp.cacheExpiresAt || null
      );

      // Migrate blueprint overrides
      if (bp.overrides) {
        const insertBpOverride = db.prepare(`
          INSERT OR REPLACE INTO blueprint_overrides (item_id, field, value)
          VALUES (?, ?, ?)
        `);

        for (const [field, value] of Object.entries(bp.overrides)) {
          insertBpOverride.run(bp.itemId, field, String(value));
        }
      }
    }

    // Commit transaction
    db.exec('COMMIT');

    console.log(`[Character Data Migration] Successfully migrated ${characters.length} characters and ${blueprints.length} blueprints`);

    // Remove from JSON config
    delete settings.accounts.characters;
    delete settings.owned_blueprints;

    // Mark migration complete
    settings.general = settings.general || {};
    settings.general.characterDataMigratedToSqlite = true;
    settings.general.characterDataMigrationDate = Date.now();

    saveSettings(settings);

    console.log('[Character Data Migration] Migration complete - data removed from JSON config');
  } catch (error) {
    // Rollback on error
    db.exec('ROLLBACK');
    console.error('[Character Data Migration] Migration failed, rolled back:', error);
    throw error;
  }
}

module.exports = {
  needsCharacterDataMigration,
  migrateCharacterDataToSqlite,
};
