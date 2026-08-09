/**
 * Shared renderer helpers.
 *
 * The application shell loads several renderers into ONE document, so anything
 * declared at top level in more than one of them collides - a duplicate
 * top-level `const` is a SyntaxError that silently kills the whole script.
 * Helpers used by more than one renderer live here instead.
 *
 * Attached to `window.QFUI` rather than bare globals so the ownership is
 * obvious at the call site.
 */

(function () {
  'use strict';

  const PORTRAIT_PLACEHOLDER =
    'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22128%22 height=%22128%22%3E%3Crect fill=%22%232d2d44%22 width=%22128%22 height=%22128%22/%3E%3C/svg%3E';

  /**
   * Set a button's visible label without destroying its icon.
   *
   * Buttons put their text in a `<span class="btn-label">` alongside an SVG;
   * writing `button.textContent` would remove the icon permanently (it did,
   * on the SDE buttons, before this existed).
   *
   * @param {HTMLElement} btn
   * @param {string} text
   */
  function setButtonLabel(btn, text) {
    if (!btn) return;
    const label = btn.querySelector('.btn-label');
    if (label) {
      label.textContent = text;
    } else {
      btn.textContent = text;
    }
  }

  /**
   * Read a button's current visible label (counterpart to setButtonLabel).
   * @param {HTMLElement} btn
   * @returns {string}
   */
  function getButtonLabel(btn) {
    if (!btn) return '';
    const label = btn.querySelector('.btn-label');
    return (label ? label.textContent : btn.textContent) || '';
  }

  /**
   * Wire the placeholder fallback for character portraits inside `root`.
   *
   * This must be a real listener: the pages' CSP (`script-src 'self'`) blocks
   * inline `onerror=`, so a failed portrait would render as a broken image.
   * Call after injecting any markup containing `img[data-fallback="portrait"]`.
   *
   * @param {ParentNode} root
   */
  function attachPortraitFallbacks(root) {
    if (!root) return;
    root.querySelectorAll('img[data-fallback="portrait"]').forEach((img) => {
      img.addEventListener('error', function handleError() {
        // Detach first, so a failing placeholder cannot loop.
        img.removeEventListener('error', handleError);
        img.src = PORTRAIT_PLACEHOLDER;
      });
    });
  }

  // Also exposed as a bare `QFUI` for terse call sites in renderers.
  window.QFUI = {
    PORTRAIT_PLACEHOLDER,
    setButtonLabel,
    getButtonLabel,
    attachPortraitFallbacks,
  };
})();
