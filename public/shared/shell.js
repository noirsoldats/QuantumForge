/**
 * Quantum Forge Application Shell
 *
 * Builds the persistent chrome (frameless title bar, activity rail, view host,
 * status footer) and hosts the view router.
 *
 * The shell is constructed ONCE per window and is never torn down. Switching
 * tools swaps only the contents of #view-host, so the rail and footer are the
 * same DOM nodes for the lifetime of the window. That is what makes their
 * consistency structural rather than a convention each page has to re-honour.
 *
 * Roles, read from the ?role= query param:
 *   main       - rail + (disabled) search. Exactly one of these.
 *   popout     - a single tool in its own window. No rail, no search.
 *   standalone - Settings / Audit Log / ESI Status. Same chrome as popout,
 *                but never mounted in the main window's view host.
 *
 * Views are registered with ShellRouter.register() and may be either:
 *   - native: a JS module with mount(container, params) / destroy()
 *   - legacy: an existing public/*.html page, hosted in a same-origin iframe
 *             until its renderer is converted.
 * Both mount into #view-host; the chrome never reloads either way.
 */

(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';

  /* ------------------------------------------------------------- icon defs */

  // Feather-recipe outline icons, matching the mockups: 24x24 viewBox,
  // currentColor stroke, round caps/joins, no fill.
  var ICONS = {
    // Grid of panes - reads as "overview" rather than a house.
    dashboard: [
      ['rect', { x: 3, y: 3, width: 7, height: 9, rx: 1 }],
      ['rect', { x: 14, y: 3, width: 7, height: 5, rx: 1 }],
      ['rect', { x: 14, y: 12, width: 7, height: 9, rx: 1 }],
      ['rect', { x: 3, y: 16, width: 7, height: 5, rx: 1 }],
    ],
    characters: [
      ['path', { d: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2' }],
      ['circle', { cx: 9, cy: 7, r: 4 }],
      ['path', { d: 'M23 21v-2a4 4 0 0 0-3-3.87' }],
      ['path', { d: 'M16 3.13a4 4 0 0 1 0 7.75' }],
    ],
    market: [
      ['path', { d: 'M3 3v18h18' }],
      ['path', { d: 'M7 14l4-4 3 3 5-6' }],
    ],
    blueprint: [
      ['path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }],
      ['polyline', { points: '14 2 14 8 20 8' }],
    ],
    plans: [
      ['rect', { x: 6, y: 4, width: 12, height: 17, rx: 2 }],
      ['path', { d: 'M9 11l2 2 4-4' }],
    ],
    summary: [
      ['line', { x1: 18, y1: 20, x2: 18, y2: 10 }],
      ['line', { x1: 12, y1: 20, x2: 12, y2: 4 }],
      ['line', { x1: 6, y1: 20, x2: 6, y2: 14 }],
    ],
    facilities: [
      ['path', { d: 'M3 21V9l7-4v4l7-4v16z' }],
      ['line', { x1: 10, y1: 9, x2: 10, y2: 13 }],
    ],
    reactions: [
      ['circle', { cx: 12, cy: 12, r: 2 }],
      ['ellipse', { cx: 12, cy: 12, rx: 10, ry: 4.5 }],
      ['ellipse', { cx: 12, cy: 12, rx: 10, ry: 4.5, transform: 'rotate(60 12 12)' }],
      ['ellipse', { cx: 12, cy: 12, rx: 10, ry: 4.5, transform: 'rotate(120 12 12)' }],
    ],
    loot: [
      ['circle', { cx: 11, cy: 11, r: 8 }],
      ['line', { x1: 21, y1: 21, x2: 16.65, y2: 16.65 }],
    ],
    build: [
      ['path', { d: 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z' }],
      ['polyline', { points: '3.27 6.96 12 12.01 20.73 6.96' }],
      ['line', { x1: 12, y1: 22.08, x2: 12, y2: 12 }],
    ],
    settings: [
      ['circle', { cx: 12, cy: 12, r: 3 }],
      ['path', { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' }],
    ],
    search: [
      ['circle', { cx: 11, cy: 11, r: 8 }],
      ['line', { x1: 21, y1: 21, x2: 16.65, y2: 16.65 }],
    ],
    chevronRight: [['path', { d: 'M9 18l6-6-6-6' }]],
    // Box with an arrow leaving it - the conventional "open in new window".
    popout: [
      ['path', { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }],
      ['polyline', { points: '15 3 21 3 21 9' }],
      ['line', { x1: 10, y1: 14, x2: 21, y2: 3 }],
    ],
    minimize: [['line', { x1: 5, y1: 12, x2: 19, y2: 12 }]],
    maximize: [['rect', { x: 5, y: 5, width: 14, height: 14, rx: 1 }]],
    restore: [
      ['rect', { x: 8, y: 3, width: 13, height: 13, rx: 1 }],
      ['path', { d: 'M16 16v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h3' }],
    ],
    close: [
      ['line', { x1: 6, y1: 6, x2: 18, y2: 18 }],
      ['line', { x1: 18, y1: 6, x2: 6, y2: 18 }],
    ],
  };

  function makeIcon(name, size, strokeWidth) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', size || 21);
    svg.setAttribute('height', size || 21);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', strokeWidth || 1.8);
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    (ICONS[name] || []).forEach(function (def) {
      var node = document.createElementNS(SVG_NS, def[0]);
      Object.keys(def[1]).forEach(function (k) {
        node.setAttribute(k, def[1][k]);
      });
      svg.appendChild(node);
    });
    return svg;
  }

  /* ------------------------------------------------------------ rail model */

  // Order matches the mockups. `poppable: false` marks tools that always own
  // their window (Settings) - they are opened as separate windows, never mounted
  // in the main window's view host.
  var RAIL = [
    { id: 'dashboard', title: 'Dashboard', icon: 'dashboard', sub: 'Overview and tools' },
    { id: 'characters', title: 'Characters', icon: 'characters', sub: 'Connected characters' },
    { divider: true },
    { id: 'market', title: 'Market Manager', icon: 'market', sub: 'Pricing and market sets' },
    { id: 'blueprint-calculator', title: 'Blueprint Calculator', icon: 'blueprint', sub: 'Manufacturing calculator' },
    { id: 'manufacturing-plans', title: 'Manufacturing Plans', icon: 'plans', sub: 'Plan management' },
    { id: 'manufacturing-summary', title: 'Manufacturing Summary', icon: 'summary', sub: 'Profitability analysis' },
    { id: 'facilities', title: 'Facilities', icon: 'facilities', sub: 'Structures and rigs' },
    { id: 'reactions', title: 'Reactions', icon: 'reactions', sub: 'Reaction calculator' },
    { id: 'loot-analyzer', title: 'Loot Analyzer', icon: 'loot', sub: 'Reprocess vs. market' },
    { id: 'what-can-i-build', title: 'What Can I Build?', icon: 'build', sub: 'Buildable from on-hand' },
    { spacer: true },
    { id: 'settings', title: 'Settings', icon: 'settings', sub: 'Preferences', standalone: true },
  ];

  /* ---------------------------------------------------------------- router */

  var views = {};            // viewId -> definition
  var active = null;         // { id, params, instance, el }

  // viewId -> params, for views currently open in their own window. Kept as the
  // params (not just `true`) so a click on the rail can focus the RIGHT window
  // when a view is popped per-character.
  var poppedViews = {};
  var railItems = {};        // viewId -> rail <div>
  var shellEl = null;
  var hostEl = null;
  var breadcrumbEl = null;
  var popOutBtn = null;
  var role = 'main';

  /**
   * Per-mount resource tracker handed to every native view.
   *
   * Anything registered here is torn down automatically when the view is
   * unmounted, so a view cannot leak a subscription, interval or listener into
   * the next one. Views may still return their own `destroy()` for state that
   * this does not cover.
   *
   * @param {string} viewId
   * @constructor
   */
  function ViewContext(viewId) {
    this.viewId = viewId;
    this._disposers = [];
    this._disposed = false;
  }

  /**
   * Track an unsubscribe function - typically the return value of an
   * `electronAPI.*.on*()` call.
   * @param {Function} disposer
   * @returns {Function} the same disposer, for chaining
   */
  ViewContext.prototype.track = function (disposer) {
    if (typeof disposer === 'function') this._disposers.push(disposer);
    return disposer;
  };

  /** setInterval that is cleared on unmount. */
  ViewContext.prototype.setInterval = function (fn, ms) {
    var id = window.setInterval(fn, ms);
    this._disposers.push(function () { window.clearInterval(id); });
    return id;
  };

  /** setTimeout that is cleared on unmount. */
  ViewContext.prototype.setTimeout = function (fn, ms) {
    var id = window.setTimeout(fn, ms);
    this._disposers.push(function () { window.clearTimeout(id); });
    return id;
  };

  /** addEventListener that is removed on unmount. */
  ViewContext.prototype.on = function (target, type, handler, options) {
    target.addEventListener(type, handler, options);
    this._disposers.push(function () {
      target.removeEventListener(type, handler, options);
    });
  };

  /** Run every tracked disposer. Safe to call more than once. */
  ViewContext.prototype.dispose = function () {
    if (this._disposed) return;
    this._disposed = true;
    // Reverse order, so teardown mirrors setup.
    for (var i = this._disposers.length - 1; i >= 0; i--) {
      try {
        this._disposers[i]();
      } catch (err) {
        console.error('[shell] disposer failed in view "' + this.viewId + '":', err);
      }
    }
    this._disposers.length = 0;
  };

  /** Number of live tracked resources (used by tests). */
  ViewContext.prototype.size = function () {
    return this._disposers.length;
  };

  var ShellRouter = {
    /**
     * Register a view.
     * @param {string} id
     * @param {Object} def
     * @param {string} def.title
     * @param {boolean} [def.poppable=true]
     * @param {Function}[def.mount]    Native view: mount(container, params, ctx) -> instance
     * @param {Function}[def.destroy]  Native view teardown.
     */
    register: function (id, def) {
      views[id] = def || {};
      return ShellRouter;
    },

    getActive: function () {
      return active ? active.id : null;
    },

    /**
     * Mount a view into the host, tearing the previous one down first.
     * Teardown is mandatory: without it, repeated mounts accumulate duplicate
     * IPC subscriptions (the leak the old page-per-navigation model masked).
     */
    show: function (id, params) {
      var def = views[id];
      if (!def) {
        console.error('[shell] unknown view:', id);
        return;
      }

      // A view being open in its own window does NOT block mounting it here.
      // Two Blueprint Calculators side by side - one popped, one in main - is a
      // legitimate thing to want, and the rail is the way to get the second.
      // The identity rule that prevents genuine duplicates lives in
      // `view-window.js`: windows are keyed on (viewId, params), so asking for
      // `skills?characterId=42` twice focuses the existing window while
      // characters 42 and 99 get one each.
      ShellRouter._destroyActive();

      var container = document.createElement('div');
      var instance = null;
      var ctx = new ViewContext(id);

      if (typeof def.mount === 'function') {
        container.className = 'qf-view-native';
        hostEl.appendChild(container);
        try {
          // The context is passed third so existing two-arg mounts keep working.
          instance = def.mount(container, params || {}, ctx);
        } catch (err) {
          console.error('[shell] view mount failed:', id, err);
        }
      } else {
        console.error('[shell] view has no mount():', id);
        return;
      }

      active = { id: id, params: params || {}, instance: instance, el: container, ctx: ctx };
      ShellRouter._setActiveRail(id);
      ShellRouter.setBreadcrumb(def.title || id);
      ShellRouter._syncPopOutButton();

      // Every view's mount() is async, so `instance` is a PROMISE. Resolve it
      // onto `active` so later callers - pop-out asking for getHandoff, the
      // close guard asking isDirty - see the real instance rather than a
      // promise whose methods all read as undefined.
      var mountedFor = active;
      Promise.resolve(instance)
        .then(function (resolved) {
          // Ignore a late resolution for a view that has since been replaced.
          if (active !== mountedFor) return;
          if (resolved) active.instance = resolved;
        })
        .catch(function (err) {
          console.error('[shell] view mount rejected:', id, err);
        });

      // Deliver a popped-out view's state, if this mount carries a token.
      // Done here rather than in each view so no view can forget to claim -
      // and so the one-shot semantics live in one place.
      if (params && params.handoffToken) {
        ShellRouter._deliverHandoff(id, params.handoffToken, instance);
      }
    },

    /**
     * Claim a parked payload and hand it to the view.
     *
     * `mount` may be async, so the instance can be a promise; the payload is
     * applied once it resolves. A failure at any step is logged and ignored -
     * the view is already mounted and simply shows its normal empty state,
     * which is exactly the behaviour before handoff existed.
     */
    _deliverHandoff: function (id, token, instance) {
      var api = window.electronAPI && window.electronAPI.window;
      if (!api || !api.claimHandoff) return;

      Promise.resolve(instance)
        .then(function (resolved) {
          if (!resolved || typeof resolved.applyHandoff !== 'function') return null;
          return api.claimHandoff(token, id).then(function (payload) {
            // A null payload means the slot was already consumed or expired.
            if (payload) resolved.applyHandoff(payload);
            return null;
          });
        })
        .catch(function (err) {
          console.error('[shell] handoff delivery failed:', id, err);
        });
    },

    /**
     * Show the pop-out button only when the active view can actually pop out.
     *
     * The Dashboard is not a tool, and a view marked `poppable: false` always
     * owns its own window - offering the button for either would be a dead
     * control.
     */
    _syncPopOutButton: function () {
      if (!popOutBtn) return;
      var def = (active && views[active.id]) || null;
      var canPop = !!def && def.poppable !== false && active.id !== 'dashboard';
      popOutBtn.hidden = !canPop;
    },

    /**
     * Move a view into its own window.
     *
     * The main window hands the tool off: it tears its copy down and falls back
     * to the Dashboard, so the same view is not running twice over one set of
     * data at the moment of the hand-off. The user can then mount a second copy
     * from the rail if they want them side by side - that is a deliberate act,
     * not an accident of popping out.
     *
     * Windows are keyed on (viewId, params) in `view-window.js`, so popping the
     * same target twice focuses the existing window rather than duplicating it.
     * Different params - two characters' Skills - are two windows.
     *
     * @param {string} [id]      defaults to the active view
     * @param {Object} [params]  defaults to the active view's params
     */
    popOut: function (id, params) {
      var viewId = id || (active && active.id);
      if (!viewId) return false;

      var def = views[viewId] || {};
      if (def.poppable === false) {
        console.error('[shell] view is not poppable:', viewId);
        return false;
      }

      var api = window.electronAPI && window.electronAPI.window;
      if (!api || !api.openView) {
        console.error('[shell] pop-out needs the window API');
        return false;
      }

      var useParams = params || (active && active.id === viewId ? active.params : {}) || {};
      var isActiveView = !!(active && active.id === viewId);

      // Ask the view to hand its state over, so the new window renders what is
      // already on screen instead of recomputing it. A Manufacturing Summary or
      // What Can I Build? sweep costs seconds; paying that again just to move a
      // window is not acceptable.
      //
      // Collected BEFORE teardown - destroy() may release the very data we are
      // trying to move.
      var handoff = null;
      if (isActiveView && active.instance && typeof active.instance.getHandoff === 'function') {
        try {
          handoff = active.instance.getHandoff();
        } catch (err) {
          // A failed handoff must not block the pop-out; the new window simply
          // starts empty, which is the old behaviour.
          console.error('[shell] getHandoff failed:', viewId, err);
        }
      }

      var open = function (extraParams) {
        // Tear the local copy down before the window opens, so the same view is
        // not running twice over one set of data at the moment of hand-off.
        if (isActiveView) ShellRouter.show('dashboard');
        api.openView(viewId, extraParams, { title: def.title || viewId });
      };

      if (handoff && api.createHandoff) {
        api.createHandoff(viewId, handoff)
          .then(function (token) {
            var merged = {};
            Object.keys(useParams).forEach(function (k) { merged[k] = useParams[k]; });
            // Only the TOKEN travels in params. The payload would otherwise
            // land in the window key and break saved bounds.
            merged.handoffToken = token;
            open(merged);
          })
          .catch(function (err) {
            console.error('[shell] could not park handoff:', err);
            open(useParams);
          });
      } else {
        open(useParams);
      }

      return true;
    },

    _destroyActive: function () {
      if (!active) return;
      var def = views[active.id] || {};

      // 1. The view's own teardown, for anything the context does not cover.
      //
      // The instance is normally resolved onto `active` by show(), but a view
      // switched away from before its async mount() settled still holds the
      // promise. Chain off it so its destroy() runs whenever it lands, rather
      // than being skipped because a promise has no destroy method.
      var instance = active.instance;
      var viewId = active.id;
      var runDestroy = function (resolved) {
        try {
          if (resolved && typeof resolved.destroy === 'function') {
            resolved.destroy();
          } else if (typeof def.destroy === 'function') {
            def.destroy();
          }
        } catch (err) {
          console.error('[shell] view destroy failed:', viewId, err);
        }
      };

      if (instance && typeof instance.then === 'function') {
        instance.then(runDestroy, function () { /* mount rejected; nothing to tear down */ });
      } else {
        runDestroy(instance);
      }

      // 2. Tracked resources - subscriptions, intervals, listeners. Runs even if
      //    the view's own destroy() threw, so one bad view cannot leak the rest.
      try {
        active.ctx.dispose();
      } catch (err) {
        console.error('[shell] context dispose failed:', active.id, err);
      }

      if (active.el && active.el.parentNode) {
        active.el.parentNode.removeChild(active.el);
      }
      active = null;
    },

    _setActiveRail: function (id) {
      Object.keys(railItems).forEach(function (key) {
        railItems[key].classList.toggle('is-active', key === id);
      });
    },

    /**
     * Mark a rail item as also open in its own window.
     *
     * Informational only - clicking the item still mounts the tool here. Two
     * copies side by side (one popped, one in main) is a supported thing to
     * want; the marker just tells the user a window already exists.
     */
    setPopped: function (id, popped) {
      if (railItems[id]) railItems[id].classList.toggle('is-popped', !!popped);
    },

    /**
     * Adopt the current set of open view windows.
     *
     * Takes the FULL set rather than a delta, so a window that starts late
     * cannot miss an event and desync its rail.
     *
     * @param {Array} list - [{ key, viewId, params }]
     */
    setViewWindows: function (list) {
      var next = {};
      (list || []).forEach(function (entry) {
        if (entry && entry.viewId) next[entry.viewId] = entry.params || {};
      });

      // Clear markers for views no longer open, then set the current ones.
      Object.keys(poppedViews).forEach(function (id) {
        if (!next[id]) ShellRouter.setPopped(id, false);
      });
      Object.keys(next).forEach(function (id) {
        ShellRouter.setPopped(id, true);
      });

      poppedViews = next;

      // Deliberately does NOT unmount a view that has just gained a window.
      // Another window opening the same tool is not a reason to close this
      // one - that is exactly the side-by-side case. Only `popOut()` from THIS
      // window falls back to the Dashboard, because there the user asked for
      // the tool to move.
    },

    /** Params of the window a view is popped into, or null. */
    getPopped: function (id) {
      return Object.prototype.hasOwnProperty.call(poppedViews, id) ? poppedViews[id] : null;
    },

    setBreadcrumb: function (text) {
      ShellRouter.setBreadcrumbTrail([{ label: text }]);
    },

    /**
     * Render a hierarchical breadcrumb, e.g.
     *   Quantum Forge / Market Manager > Pricing
     *
     * Entries with an `onClick` (or a `view` to route to) render as clickable
     * ancestors; the last entry is always the inert current location. The brand
     * to the left is always the way back to the Dashboard.
     *
     * @param {Array<{label: string, view?: string, onClick?: Function}>} trail
     */
    setBreadcrumbTrail: function (trail) {
      var crumb = document.getElementById('qf-breadcrumb');
      if (!crumb) return;

      crumb.textContent = '';
      var items = (trail || []).filter(function (t) { return t && t.label; });

      items.forEach(function (item, i) {
        // Separator: '/' after the brand, chevrons between deeper levels.
        var sep = document.createElement('span');
        sep.className = 'qf-breadcrumb-sep';
        if (i === 0) {
          sep.textContent = '/';
        } else {
          sep.appendChild(makeIcon('chevronRight', 13, 2));
        }
        crumb.appendChild(sep);

        var isLast = i === items.length - 1;
        var canClick = !isLast && (item.view || typeof item.onClick === 'function');

        var el = document.createElement(canClick ? 'button' : 'span');
        el.className = 'qf-breadcrumb-item' + (isLast ? ' qf-breadcrumb-current' : '');
        el.textContent = item.label;
        if (canClick) {
          el.type = 'button';
          el.classList.add('is-clickable');
          el.addEventListener('click', function () {
            if (item.onClick) item.onClick();
            else ShellRouter.show(item.view);
          });
        }
        crumb.appendChild(el);
      });

      // Keep the legacy single-element reference pointing at the current crumb.
      breadcrumbEl = crumb.querySelector('.qf-breadcrumb-current');
    },

    /** Ask the active view whether it has unsaved changes. */
    isDirty: function () {
      if (!active || !active.instance) return false;
      try {
        return typeof active.instance.isDirty === 'function'
          ? !!active.instance.isDirty()
          : false;
      } catch (_) {
        return false;
      }
    },
  };

  /* ----------------------------------------------------------- title bar */

  function buildTitleBar(opts) {
    var bar = document.createElement('div');
    bar.className = 'qf-titlebar';

    // In the main window the brand is the way home. Pop-out/standalone windows
    // cannot navigate, so theirs stays inert.
    var homeable = role === 'main';
    var brand = document.createElement(homeable ? 'button' : 'div');
    brand.className = 'qf-titlebar-brand' + (homeable ? ' is-clickable' : '');
    if (homeable) {
      brand.type = 'button';
      brand.title = 'Back to Dashboard';
      brand.setAttribute('aria-label', 'Back to Dashboard');
      brand.addEventListener('click', function () {
        ShellRouter.show('dashboard');
      });
    }
    var mark = document.createElement('img');
    mark.className = 'qf-titlebar-mark';
    mark.src = 'assets/quantum-forge-mark.png';
    mark.alt = '';
    var name = document.createElement('span');
    name.className = 'qf-titlebar-name';
    name.textContent = 'Quantum Forge';
    brand.appendChild(mark);
    brand.appendChild(name);
    bar.appendChild(brand);

    var crumb = document.createElement('div');
    crumb.className = 'qf-breadcrumb';
    crumb.id = 'qf-breadcrumb';
    var sep = document.createElement('span');
    sep.className = 'qf-breadcrumb-sep';
    sep.textContent = '/';
    breadcrumbEl = document.createElement('span');
    breadcrumbEl.className = 'qf-breadcrumb-current';
    breadcrumbEl.textContent = opts.title || '';
    crumb.appendChild(sep);
    crumb.appendChild(breadcrumbEl);
    bar.appendChild(crumb);

    // Search sits in a flex:1 centring wrapper, so it is centred in the bar
    // rather than pushed to the right (per the mockup). Rendered only in the
    // main window and intentionally disabled - the command palette is a later
    // phase, and a window that cannot navigate has no use for it.
    if (role === 'main') {
      var searchWrap = document.createElement('div');
      searchWrap.className = 'qf-titlebar-search-wrap';

      var search = document.createElement('div');
      search.className = 'qf-titlebar-search';
      search.setAttribute('aria-disabled', 'true');
      search.title = 'Command palette - coming soon';
      search.appendChild(makeIcon('search', 14, 1.8));

      var label = document.createElement('span');
      label.className = 'qf-titlebar-search-label';
      label.textContent = 'Search (coming soon)';
      search.appendChild(label);

      var kbd = document.createElement('kbd');
      kbd.className = 'qf-titlebar-kbd';
      kbd.textContent = isMacPlatform() ? '⌘K' : 'Ctrl K';
      search.appendChild(kbd);

      searchWrap.appendChild(search);
      bar.appendChild(searchWrap);
    }

    // Always present: pushes the trailing items (avatar, window controls) right.
    // The search field is absolutely centred and sits outside this flow.
    var spacer = document.createElement('div');
    spacer.className = 'qf-titlebar-spacer';
    bar.appendChild(spacer);

    // Pop-out. Main window only: a popped or standalone window has nowhere to
    // pop to. Hidden until a poppable view is showing - the Dashboard is not a
    // tool, and Settings is standalone.
    if (role === 'main') {
      popOutBtn = document.createElement('button');
      popOutBtn.type = 'button';
      popOutBtn.className = 'qf-titlebar-popout';
      popOutBtn.id = 'qf-popout-btn';
      popOutBtn.title = 'Open in a new window';
      popOutBtn.setAttribute('aria-label', 'Open in a new window');
      popOutBtn.hidden = true;
      popOutBtn.appendChild(makeIcon('popout', 15, 1.8));
      popOutBtn.addEventListener('click', function () {
        ShellRouter.popOut();
      });
      bar.appendChild(popOutBtn);
    }

    // Slot the character avatar lives in, so it participates in the title bar's
    // flex flow instead of overlapping it. renderer.js moves the avatar here.
    var trailing = document.createElement('div');
    trailing.className = 'qf-titlebar-trailing';
    trailing.id = 'titlebar-trailing';
    bar.appendChild(trailing);

    bar.appendChild(buildWindowControls());
    return bar;
  }

  function isMacPlatform() {
    return (window.navigator.platform || '').toLowerCase().indexOf('mac') !== -1;
  }

  function buildWindowControls() {
    var wrap = document.createElement('div');
    wrap.className = 'qf-window-controls';

    function btn(iconName, label, cls, onClick) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'qf-window-btn' + (cls ? ' ' + cls : '');
      b.setAttribute('aria-label', label);
      b.title = label;
      b.appendChild(makeIcon(iconName, 15, 1.6));
      b.addEventListener('click', onClick);
      return b;
    }

    var maxBtn = btn('maximize', 'Maximize', 'qf-window-maximize', function () {
      if (window.electronAPI && window.electronAPI.window) {
        window.electronAPI.window.toggleMaximize();
      }
    });

    wrap.appendChild(btn('minimize', 'Minimize', null, function () {
      if (window.electronAPI && window.electronAPI.window) {
        window.electronAPI.window.minimize();
      }
    }));
    wrap.appendChild(maxBtn);
    wrap.appendChild(btn('close', 'Close', 'qf-window-close', function () {
      if (window.electronAPI && window.electronAPI.window) {
        window.electronAPI.window.close();
      }
    }));

    // Swap the glyph when the window is maximised/restored.
    function applyMaximized(maximized) {
      maxBtn.textContent = '';
      maxBtn.appendChild(makeIcon(maximized ? 'restore' : 'maximize', 15, 1.6));
      maxBtn.setAttribute('aria-label', maximized ? 'Restore' : 'Maximize');
      maxBtn.title = maximized ? 'Restore' : 'Maximize';
    }

    if (window.electronAPI && window.electronAPI.window) {
      window.electronAPI.window.isMaximized().then(applyMaximized).catch(function () {});
      // Returns a disposer; the shell lives for the window's lifetime so it is
      // never called, but the contract is kept consistent.
      window.electronAPI.window.onMaximizeChanged(function (state) {
        applyMaximized(state && state.maximized);
      });
    }

    return wrap;
  }

  /* ---------------------------------------------------------------- rail */

  function buildRail(onSelect) {
    var rail = document.createElement('nav');
    rail.className = 'qf-rail';
    rail.setAttribute('aria-label', 'Tools');

    RAIL.forEach(function (entry) {
      if (entry.divider) {
        var d = document.createElement('div');
        d.className = 'qf-rail-divider';
        rail.appendChild(d);
        return;
      }
      if (entry.spacer) {
        var s = document.createElement('div');
        s.className = 'qf-rail-spacer';
        rail.appendChild(s);
        return;
      }

      var item = document.createElement('div');
      item.className = 'qf-rail-item';

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'qf-rail-btn';
      btn.setAttribute('aria-label', entry.title);
      btn.appendChild(makeIcon(entry.icon, 21, entry.icon === 'settings' ? 1.6 : 1.8));
      btn.addEventListener('click', function () {
        onSelect(entry);
      });
      item.appendChild(btn);

      var fly = document.createElement('div');
      fly.className = 'qf-rail-flyout';
      var inner = document.createElement('div');
      inner.className = 'qf-rail-flyout-inner';
      var t = document.createElement('span');
      t.className = 'qf-rail-flyout-title';
      t.textContent = entry.title;
      inner.appendChild(t);
      var sub = document.createElement('span');
      sub.className = 'qf-rail-flyout-sub';
      sub.textContent = entry.sub || '';
      sub.setAttribute('data-rail-sub', entry.id);
      inner.appendChild(sub);
      fly.appendChild(inner);
      item.appendChild(fly);

      railItems[entry.id] = item;
      rail.appendChild(item);
    });

    return rail;
  }

  /** Update a rail flyout's subtitle (fed by live data in a later phase). */
  function setRailSubtitle(id, text) {
    var el = document.querySelector('[data-rail-sub="' + id + '"]');
    if (el) el.textContent = text;
  }

  /* --------------------------------------------------------------- boot */

  function getParams() {
    var out = {};
    var qs = window.location.search.replace(/^\?/, '');
    if (!qs) return out;
    qs.split('&').forEach(function (pair) {
      if (!pair) return;
      var kv = pair.split('=');
      out[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || '');
    });
    return out;
  }

  /**
   * Build the shell into document.body.
   * @param {Object} [options]
   * @param {Function} [options.onRailSelect] Overrides default rail behaviour.
   * @param {string} [options.title] Initial breadcrumb text.
   */
  function initShell(options) {
    options = options || {};
    var params = getParams();
    role = params.role || options.role || 'main';

    // Module-scoped, so a re-init would otherwise inherit the previous shell's
    // markers and mark tools popped that are not. Same for the button: it is
    // only rebuilt in the main role, so a standalone init would keep pointing
    // at a detached element from a previous shell.
    poppedViews = {};
    popOutBtn = null;

    shellEl = document.createElement('div');
    shellEl.className = 'app-shell';
    shellEl.id = 'app-shell';
    shellEl.setAttribute('data-role', role);
    shellEl.setAttribute('data-platform', (window.qfPlatform || navigator.platform || '').toLowerCase().indexOf('mac') !== -1 ? 'darwin' : 'other');

    shellEl.appendChild(buildTitleBar({ title: options.title || '' }));

    var body = document.createElement('div');
    body.className = 'qf-shell-body';

    if (role === 'main') {
      body.appendChild(buildRail(options.onRailSelect || function (entry) {
        ShellRouter.show(entry.id);
      }));
    }

    hostEl = document.createElement('div');
    hostEl.className = 'qf-view-host';
    hostEl.id = 'view-host';
    body.appendChild(hostEl);

    shellEl.appendChild(body);
    document.body.appendChild(shellEl);

    // The footer is part of the shell chrome and must sit inside .app-shell
    // (the flex column) rather than as a sibling on <body>.
    //
    // shared/footer.js targets `.page-layout || document.body`, so tagging the
    // shell with .page-layout makes it the injection target. But footer.js waits
    // for DOMContentLoaded while the shell is typically built during parsing, so
    // the footer usually arrives AFTER init() returns - hence the adopt-later
    // handler below rather than a one-shot check here.
    shellEl.classList.add('page-layout');
    adoptFooter();

    // Ask main which platform we are on, so macOS hides the custom buttons and
    // leaves room for the native traffic lights.
    if (window.electronAPI && window.electronAPI.window && window.electronAPI.window.getPlatformChrome) {
      window.electronAPI.window.getPlatformChrome().then(function (info) {
        shellEl.setAttribute('data-platform', info && info.isMac ? 'darwin' : 'other');
      }).catch(function () {});
    }

    // Track which views are open in their own windows. Only the main window has
    // a rail to mark, but the subscription is harmless elsewhere and keeps the
    // state consistent if a popped window ever grows one.
    var winApi = window.electronAPI && window.electronAPI.window;
    if (winApi && winApi.onViewWindowsChanged) {
      winApi.onViewWindowsChanged(function (payload) {
        ShellRouter.setViewWindows((payload && payload.open) || []);
      });
      // Seed the current state: a window opened before this one would otherwise
      // go unmarked until the next open or close.
      if (winApi.listViewWindows) {
        winApi.listViewWindows()
          .then(function (list) { ShellRouter.setViewWindows(list || []); })
          .catch(function () {});
      }
    }

    return { shell: shellEl, host: hostEl, role: role, params: params };
  }

  /**
   * Ensure #status-footer ends up as the last child of the shell, whenever
   * shared/footer.js gets around to injecting it.
   */
  function adoptFooter() {
    var move = function () {
      var footer = document.getElementById('status-footer');
      if (footer && shellEl && footer.parentNode !== shellEl) {
        shellEl.appendChild(footer);
      }
      return !!footer;
    };

    if (move()) return;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        // footer.js listens for the same event; run after it.
        setTimeout(move, 0);
      });
    } else {
      setTimeout(move, 0);
    }
  }

  window.QFShell = {
    init: initShell,
    router: ShellRouter,
    ViewContext: ViewContext,
    setRailSubtitle: setRailSubtitle,
    makeIcon: makeIcon,
    RAIL: RAIL,
    getRole: function () { return role; },
    getHost: function () { return hostEl; },
  };
})();
