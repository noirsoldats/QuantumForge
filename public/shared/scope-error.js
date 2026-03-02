// Shared scope-error utility
// Provides a uniform modal for missing ESI OAuth scopes across all pages.
// Loaded as a plain script; exposes globals on window.

window.SCOPE_DESCRIPTIONS = {
  'esi-industry.read_character_jobs.v1':      "View your character's industry jobs",
  'esi-industry.read_corporation_jobs.v1':    "View your corporation's industry jobs",
  'esi-industry.read_character_mining.v1':    'View your mining ledger',
  'esi-markets.read_character_orders.v1':     "View your character's market orders",
  'esi-assets.read_assets.v1':                "View your character's assets",
  'esi-assets.read_corporation_assets.v1':    "View your corporation's assets",
  'esi-characters.read_blueprints.v1':        "View your character's blueprints",
  'esi-corporations.read_blueprints.v1':      "View your corporation's blueprints",
  'esi-wallet.read_character_wallet.v1':      'View your wallet transactions',
  'esi-universe.read_structures.v1':          'Look up player-owned structure details',
  'esi-skills.read_skills.v1':               "View your character's skills",
  'esi-corporations.read_divisions.v1':       "View your corporation's hangar and factory division names",
  'esi-search.search_structures.v1':          'Search for player-owned structures by name',
  'esi-markets.structure_markets.v1':         'View market orders inside player-owned structures',
};

/**
 * Show a modal informing the user that a character is missing ESI scopes,
 * with an option to re-authenticate immediately.
 *
 * @param {string}   characterName    - Display name of the affected character
 * @param {string[]} missingScopes    - Array of scope strings that are missing
 * @param {Function} [onReauthenticate] - Optional callback invoked after successful re-auth
 */
window.showMissingScopeModal = function (characterName, missingScopes, onReauthenticate) {
  if (!missingScopes || missingScopes.length === 0) return;

  // --- build scope list ---
  const scopeItems = missingScopes.map(scope => {
    const desc = window.SCOPE_DESCRIPTIONS[scope] || scope;
    return `<li><code>${scope}</code> &mdash; ${desc}</li>`;
  }).join('');

  // --- overlay ---
  const overlay = document.createElement('div');
  overlay.className = 'modal';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'scope-error-modal-title');
  overlay.style.cssText = 'display:flex;';

  overlay.innerHTML = `
    <div class="modal-content" style="max-width:520px;width:100%;">
      <div class="modal-header">
        <h2 id="scope-error-modal-title">Re-authentication Required</h2>
        <button class="modal-close" aria-label="Close dialog">&times;</button>
      </div>
      <div class="modal-body">
        <p>
          <strong>${characterName}</strong> is missing the following permissions
          that were added in a recent update:
        </p>
        <ul class="scope-list" style="margin:12px 0 12px 16px;padding:0;list-style:disc;">
          ${scopeItems}
        </ul>
        <p style="margin-top:8px;color:var(--color-text-muted, #888);font-size:0.9em;">
          Re-authenticating will not remove any of your existing data.
        </p>
      </div>
      <div class="modal-footer" style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="btn btn-secondary scope-modal-later">Later</button>
        <button class="btn btn-primary scope-modal-reauth">Re-authenticate Now</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (e.key === 'Escape') close();
  }

  overlay.querySelector('.modal-close').addEventListener('click', close);
  overlay.querySelector('.scope-modal-later').addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  overlay.querySelector('.scope-modal-reauth').addEventListener('click', async () => {
    const reauthBtn = overlay.querySelector('.scope-modal-reauth');
    reauthBtn.disabled = true;
    reauthBtn.textContent = 'Authenticating…';

    try {
      const result = await window.electronAPI.esi.authenticate();
      close();
      if (result && result.success) {
        onReauthenticate && onReauthenticate();
      }
    } catch (err) {
      console.error('Re-authentication failed:', err);
      reauthBtn.disabled = false;
      reauthBtn.textContent = 'Re-authenticate Now';
    }
  });
};

/**
 * Check whether a character is missing required scopes and, if so,
 * show the missing-scope modal.
 *
 * @param {number}   characterId    - Character ID to check
 * @param {string}   characterName  - Display name (for the modal)
 * @param {string[]} requiredScopes - Scopes needed for the action
 * @param {string}   action         - Human-readable action description (for logging)
 * @param {Function} onSuccess      - Called immediately when no scopes are missing
 * @param {Function} [onScopeError] - Optional override; default shows the modal
 */
window.checkAndHandleScopeError = async function (
  characterId,
  characterName,
  requiredScopes,
  action,
  onSuccess,
  onScopeError
) {
  try {
    const info = await window.electronAPI.esi.checkMissingScopes(characterId);
    const missing = (info.missing || []).filter(s => requiredScopes.includes(s));

    if (missing.length === 0) {
      onSuccess && onSuccess();
      return;
    }

    console.warn(`[scope-error] "${action}" blocked — missing scopes for ${characterName}:`, missing);

    if (onScopeError) {
      onScopeError(missing);
    } else {
      window.showMissingScopeModal(characterName, missing, onSuccess);
    }
  } catch (err) {
    console.error('[scope-error] checkAndHandleScopeError failed:', err);
    onSuccess && onSuccess();
  }
};
