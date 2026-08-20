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
   * Put a button into (or out of) its "action in flight" state.
   *
   * Disables it, swaps the label, and shows a spinner. Prefer
   * `withButtonBusy` - this imperative form exists for the handful of call
   * sites that already own their original label.
   *
   * Safe to call on a detached or missing node: handlers routinely re-render
   * the list containing the button, so by the time the `finally` runs the
   * element may no longer be in the document.
   *
   * @param {HTMLElement} btn
   * @param {boolean} on
   * @param {string} [busyLabel] label to show while busy (ignored when off)
   */
  function setBusy(btn, on, busyLabel) {
    if (!btn) return;

    if (on) {
      // Remember what to restore. Stored on the node so the imperative form
      // survives across separate setBusy(true)/setBusy(false) calls.
      if (!btn.dataset.qfBusyLabel) {
        btn.dataset.qfBusyLabel = getButtonLabel(btn);
      }
      btn.dataset.qfBusy = '1';
      btn.disabled = true;
      btn.classList.add('is-busy');
      btn.setAttribute('aria-busy', 'true');

      if (!btn.querySelector('.qf-spinner')) {
        const spinner = document.createElement('span');
        spinner.className = 'qf-spinner qf-spinner-sm';
        spinner.setAttribute('aria-hidden', 'true');
        // First child so it reads left of the label, where the icon sat.
        btn.insertBefore(spinner, btn.firstChild);
      }
      if (busyLabel) setButtonLabel(btn, busyLabel);
      return;
    }

    const spinner = btn.querySelector('.qf-spinner');
    if (spinner) spinner.remove();

    const original = btn.dataset.qfBusyLabel;
    if (original !== undefined) {
      setButtonLabel(btn, original);
      delete btn.dataset.qfBusyLabel;
    }
    delete btn.dataset.qfBusy;
    btn.disabled = false;
    btn.classList.remove('is-busy');
    btn.removeAttribute('aria-busy');
  }

  /** True while `btn` is mid-action. */
  function isBusy(btn) {
    return !!(btn && btn.dataset && btn.dataset.qfBusy === '1');
  }

  /**
   * Run an async action with `btn` showing a busy state for its duration.
   *
   * This is the double-submit guard as much as it is the spinner: several
   * handlers await two or three round trips (create -> reload -> select) with
   * the button live the whole time, and a second click really did create a
   * second record.
   *
   *   await QFUI.withButtonBusy(btn, 'Saving…', () => save(row));
   *
   * Returns whatever `fn` returns, and re-throws whatever it throws, so the
   * caller keeps its own try/catch and toast. Returns `undefined` without
   * running `fn` if the button is already busy.
   *
   * @param {HTMLElement} btn
   * @param {string} busyLabel
   * @param {function(): (Promise|*)} fn
   */
  async function withButtonBusy(btn, busyLabel, fn) {
    if (isBusy(btn)) return undefined;

    setBusy(btn, true, busyLabel);
    try {
      return await fn();
    } finally {
      // Always restores, including when fn threw or the node was replaced
      // mid-flight (setBusy no-ops on a detached node rather than throwing).
      setBusy(btn, false);
    }
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
    setBusy,
    isBusy,
    withButtonBusy,
    attachPortraitFallbacks,
  };
})();
