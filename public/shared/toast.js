/**
 * QFToast - the one toast implementation.
 *
 * Replaces the per-renderer copies that had drifted into three different
 * signatures. Styling already lives in components.css (`.toast`,
 * `.toast-success` and friends); this owns the behaviour and the container.
 *
 *   QFToast.show('Saved', 'success');
 *   QFToast.show('Could not reach ESI', 'error', { title: 'Offline' });
 *   QFToast.show('Copied', 'info', { position: 'bottom-left' });
 *
 * Placement is a per-screen default with a per-call override:
 *
 *   QFToast.setDefaultPosition('bottom-right');   // once, per screen
 *   QFToast.show('...', 'info', { position: 'top-center' });  // this one only
 *
 * Per-call matters because placement is sometimes a property of the ACTION,
 * not the screen - a toast raised while a right-hand drawer is open wants to
 * move out from under it, and only that call site knows.
 */
(function () {
  'use strict';

  const POSITIONS = [
    'top-right',
    'top-left',
    'top-center',
    'bottom-right',
    'bottom-left',
    'bottom-center',
  ];

  const DEFAULT_POSITION = 'top-right';
  const DEFAULT_DURATION = 5000;

  const ICONS = {
    success: '✓',
    error: '✕',
    warning: '⚠',
    info: 'ℹ',
  };

  let defaultPosition = DEFAULT_POSITION;

  /**
   * The container for a position, created on first use.
   * One per position so several can coexist on a screen.
   */
  function containerFor(position) {
    const id = `qf-toasts-${position}`;
    let host = document.getElementById(id);
    if (!host) {
      host = document.createElement('div');
      host.id = id;
      host.className = `toast-container toast-container-${position}`;
      host.setAttribute('role', 'region');
      host.setAttribute('aria-label', 'Notifications');
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    return host;
  }

  /**
   * Show a toast.
   *
   * @param {string} message
   * @param {'info'|'success'|'warning'|'error'} [type='info']
   * @param {{title?: string, duration?: number, position?: string}} [options]
   * @returns {{dismiss: function}} handle, so a caller can close it early
   */
  function show(message, type = 'info', options = {}) {
    const {
      title = null,
      duration = DEFAULT_DURATION,
      position = defaultPosition,
    } = options;

    const resolved = POSITIONS.includes(position) ? position : defaultPosition;
    const host = containerFor(resolved);

    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');

    const icon = document.createElement('span');
    icon.className = `toast-icon ${type}`;
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = ICONS[type] || ICONS.info;
    el.appendChild(icon);

    const body = document.createElement('div');
    body.className = 'toast-body';
    if (title) {
      const t = document.createElement('div');
      t.className = 'toast-title';
      t.textContent = title;
      body.appendChild(t);
    }
    const m = document.createElement('div');
    m.className = 'toast-message';
    // textContent, never innerHTML: messages routinely carry item names and
    // API error strings.
    m.textContent = message;
    body.appendChild(m);
    el.appendChild(body);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    el.appendChild(close);

    host.appendChild(el);

    let timer = null;
    let done = false;

    function dismiss() {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      el.classList.add('toast-leaving');
      setTimeout(() => {
        el.remove();
        // Leave no empty containers behind.
        if (host.childElementCount === 0) host.remove();
      }, 200);
    }

    close.addEventListener('click', dismiss);

    // duration <= 0 means "stay until dismissed".
    if (duration > 0) timer = setTimeout(dismiss, duration);

    return { dismiss };
  }

  /** Set this screen's default placement. */
  function setDefaultPosition(position) {
    if (!POSITIONS.includes(position)) {
      console.warn(`[QFToast] Unknown position "${position}"; keeping "${defaultPosition}"`);
      return;
    }
    defaultPosition = position;
  }

  /** Remove every visible toast (e.g. when a view unmounts). */
  function dismissAll() {
    POSITIONS.forEach((p) => {
      const host = document.getElementById(`qf-toasts-${p}`);
      if (host) host.remove();
    });
  }

  window.QFToast = {
    show,
    setDefaultPosition,
    dismissAll,
    POSITIONS,
    DEFAULT_POSITION,
  };
})();
