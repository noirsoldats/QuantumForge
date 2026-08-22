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

  /**
   * Parsed view templates, keyed by url. One entry per view, for the life of
   * the DOCUMENT - deliberately not the module.
   *
   * A module-scoped cache is wiped by `jest.resetModules()`, which the renderer
   * suites call in `beforeEach`. That is how the older per-renderer caches
   * ended up re-parsing their view on all ~292 tests of a suite while looking
   * like they cached. Parking it on `window` outlives the module registry, so
   * the parse really does happen once per worker.
   */
  const TEMPLATE_CACHE_KEY = '__qfViewTemplateCache';
  if (!window[TEMPLATE_CACHE_KEY]) window[TEMPLATE_CACHE_KEY] = new Map();
  const templateCache = window[TEMPLATE_CACHE_KEY];

  /**
   * Load a view's HTML into `container`.
   *
   * Replaces the `container.innerHTML = await (await fetch(url)).text()` that
   * every view renderer used to inline. That re-parsed the whole view on EVERY
   * mount; this parses once per url and clones thereafter, which measures ~3.3x
   * faster (12ms -> 3.6ms on an 8.6KB view under jsdom). Mounting happens on
   * every navigation and pop-out, so the win is real in the app and not just in
   * the test suite.
   *
   * The fetch is cached too: the response for a given url cannot change within
   * a session, since these are packaged files.
   *
   * @param {HTMLElement} container - emptied, then filled with the view
   * @param {string} url - e.g. 'assets.view.html'
   * @returns {Promise<void>}
   */
  async function loadViewTemplate(container, url) {
    let template = templateCache.get(url);

    if (!template) {
      const response = await fetch(url);
      const html = await response.text();
      // A <template> parses its contents inertly - no images load, no scripts
      // run - which is both faster and safer than assigning to a live element.
      template = document.createElement('template');
      template.innerHTML = html;
      templateCache.set(url, template);
    }

    container.textContent = '';
    // Clone, never append the cached nodes themselves: appending would MOVE
    // them out of the template and empty the cache entry, so the second mount
    // would silently render nothing.
    container.appendChild(template.content.cloneNode(true));
  }

  /**
   * A view's template CONTENT, ready to clone.
   *
   * The sibling of loadViewTemplate for the renderers that keep their markup
   * in an `<template id="…">` inside the view file and want the fragment
   * rather than having it written into a container. Same document-scoped
   * cache, so the parse happens once per worker here too.
   *
   * @param {string} url - e.g. 'market.view.html'
   * @param {string} templateId - the <template> element's id
   * @returns {Promise<DocumentFragment|null>} a fresh clone, or null if absent
   */
  async function loadViewFragment(url, templateId) {
    const key = `${url}#${templateId}`;
    let content = templateCache.get(key);

    if (!content) {
      const response = await fetch(url);
      const html = await response.text();
      const holder = document.createElement('template');
      holder.innerHTML = html;
      const found = holder.content.getElementById
        ? holder.content.getElementById(templateId)
        : holder.content.querySelector(`#${templateId}`);
      const template = found || holder.content.querySelector(`#${templateId}`);
      if (!template) return null;
      content = template.content;
      templateCache.set(key, content);
    }

    return document.importNode(content, true);
  }

  /**
   * Drop cached templates. Only needed by tests that swap a view's HTML
   * between cases; the app has no reason to call it.
   */
  function clearViewTemplateCache() {
    templateCache.clear();
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
    loadViewTemplate,
    loadViewFragment,
    clearViewTemplateCache,
  };
})();
