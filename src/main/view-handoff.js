/**
 * One-shot handoff slots for popping a view into its own window.
 *
 * WHY THIS EXISTS
 * ---------------
 * Popping out a tool used to mean the new window re-derived everything from
 * its mount params. That is fine for the Blueprint Calculator (a fast SDE
 * lookup) but not for Manufacturing Summary or What Can I Build?, where the
 * result is a multi-second sweep over hundreds of blueprints. Paying that cost
 * again to move a window is not acceptable.
 *
 * Electron cannot move DOM or live objects between windows - each is a separate
 * renderer process with its own heap - so the thing itself cannot be
 * reparented. But the expensive part is producing the ROWS, and rendering them
 * is cheap. Both engines already return plain serialisable data across IPC, so
 * the results can simply be handed over and re-rendered.
 *
 * WHY NOT THROUGH PARAMS
 * ----------------------
 * `openViewWindow` puts params in the window's query string AND in its
 * `windowKey`. A 79 KB result set (a 212-blueprint summary) in a URL is
 * unpleasant, and it would make the window key unique per payload - so saved
 * bounds would never match and every popped window would open at defaults.
 * Only a short token travels in params; the payload stays here.
 *
 * LIFETIME
 * --------
 * A slot is consumed by the first reader and dropped, so a stale handoff cannot
 * resurrect old results into a later window. Slots also expire, in case a
 * window is never opened (the user cancelled the OS dialog, the renderer threw
 * during mount) - without that, a big payload would be pinned for the rest of
 * the session.
 */

/** How long an unclaimed slot survives. Generous: a cold window can take a
 *  moment to load the shell, register views and mount. */
const SLOT_TTL_MS = 60 * 1000;

/** token -> { viewId, payload, createdAt } */
const slots = new Map();

let nextToken = 1;

/**
 * Store a payload for a window that is about to open.
 *
 * @param {string} viewId - the view the payload belongs to
 * @param {*} payload - anything structured-cloneable
 * @returns {string} token to pass in the new window's mount params
 */
function createHandoff(viewId, payload) {
  pruneExpired();

  const token = `h${nextToken++}-${Date.now().toString(36)}`;
  slots.set(token, { viewId, payload, createdAt: Date.now() });
  return token;
}

/**
 * Claim a payload. Returns null if the token is unknown, expired, or belongs to
 * a different view.
 *
 * The viewId check is not paranoia: params are visible in the window query, and
 * handing Summary's rows to What Can I Build? would render nonsense rather than
 * fail loudly.
 *
 * @param {string} token
 * @param {string} viewId - the view claiming it
 */
function claimHandoff(token, viewId) {
  pruneExpired();

  const slot = slots.get(token);
  if (!slot) return null;

  // Consumed either way: a mismatched claim is a bug, and leaving the slot
  // behind would let it be claimed again later.
  slots.delete(token);

  if (slot.viewId !== viewId) {
    console.error(
      `[handoff] token ${token} belongs to "${slot.viewId}", claimed by "${viewId}"`
    );
    return null;
  }

  return slot.payload;
}

/** Drop slots nothing ever claimed, so a large payload is not pinned forever. */
function pruneExpired() {
  const cutoff = Date.now() - SLOT_TTL_MS;
  slots.forEach((slot, token) => {
    if (slot.createdAt < cutoff) slots.delete(token);
  });
}

/** Number of live slots. Tests and diagnostics. */
function pendingCount() {
  pruneExpired();
  return slots.size;
}

/** Drop everything. Tests only. */
function clearAll() {
  slots.clear();
}

function registerHandoffHandlers() {
  const { ipcMain } = require('electron');

  ipcMain.handle('handoff:create', (event, viewId, payload) => createHandoff(viewId, payload));
  ipcMain.handle('handoff:claim', (event, token, viewId) => claimHandoff(token, viewId));
}

module.exports = {
  createHandoff,
  claimHandoff,
  pendingCount,
  clearAll,
  registerHandoffHandlers,
  SLOT_TTL_MS,
};
