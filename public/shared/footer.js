/**
 * Shared Footer Module
 *
 * Injects the canonical status footer HTML into the current page and
 * initialises footer-utils.js live data (clock, server status, ESI status).
 *
 * Usage: add ONE script tag at the bottom of <body>, AFTER footer-utils.js:
 *   <script src="../src/renderer/footer-utils.js"></script>
 *   <script src="shared/footer.js"></script>
 *
 * The footer is appended as the last child of the first element that matches
 * .page-layout, or falls back to document.body.
 */

(function () {
  const FOOTER_HTML = `
    <footer id="status-footer" class="status-footer">
      <div class="footer-content">
        <div class="footer-item" id="character-count-item">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
            <circle cx="12" cy="7" r="4"></circle>
          </svg>
          <span id="character-count">0</span> <span class="label">Characters</span>
        </div>

        <div class="footer-item" id="eve-time-item">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="12" cy="12" r="10"></circle>
            <polyline points="12 6 12 12 16 14"></polyline>
          </svg>
          <span id="eve-time">--:--:--</span> <span class="label">EVE Time</span>
        </div>

        <div class="footer-item" id="players-online-item">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
            <circle cx="9" cy="7" r="4"></circle>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
          </svg>
          <span id="players-online">--</span> <span class="label">Players</span>
        </div>

        <div class="footer-item" id="server-status-item" title="Server Status: Loading...">
          <span id="server-pulse-dot" class="pulse-dot" aria-hidden="true"></span>
          <svg id="server-status-icon" class="status-icon status-loading" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          <span id="server-status-text" class="label">Loading</span>
        </div>

        <div class="footer-item footer-clickable" id="esi-status-item" title="ESI Status: Loading..." role="button" aria-label="View ESI Status">
          <span id="esi-pulse-dot" class="pulse-dot" aria-hidden="true"></span>
          <svg id="esi-status-icon" class="status-icon status-loading" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="12" cy="12" r="10"></circle>
            <path d="M12 6v6l4 2"></path>
          </svg>
          <span id="esi-status-text" class="label">ESI Status</span>
        </div>
      </div>
    </footer>`;

  function inject() {
    // Don't inject if already present
    if (document.getElementById('status-footer')) return;

    const container = document.querySelector('.page-layout') || document.body;
    container.insertAdjacentHTML('beforeend', FOOTER_HTML);

    // Wire up ESI status click handler
    const esiStatusItem = document.getElementById('esi-status-item');
    if (esiStatusItem) {
      esiStatusItem.addEventListener('click', () => {
        window.electronAPI.esiStatus.openWindow();
      });
    }

    // Note: footer live-data (clock, server status, ESI status) is started by
    // calling window.footerUtils.initializeFooter() in each page's own renderer.
    // footer.js only injects the HTML structure.
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
