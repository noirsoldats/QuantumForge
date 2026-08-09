/**
 * QFSearchSelect - searchable dropdown (vanilla, no framework)
 *
 * Framework-free port of the redesign project's `qf-search-select.jsx`.
 * This is the ONE shared searchable dropdown for the whole app - never fork it
 * or hand-roll another one. Non-searchable dropdowns with ~3 or fewer fixed
 * options should stay a plain `<select class="qf-select">`.
 *
 * Usage:
 *   const sel = new QFSearchSelect(mountEl, {
 *     options: ['A', 'B'],            // string[] | {value,label,disabled?}[]
 *     value: 'A',
 *     onChange: (e) => console.log(e.target.value),
 *     placeholder: 'Select...',
 *     compact: false,
 *     disabled: false,
 *     label: 'Region',                // optional
 *     description: 'Where to price',  // optional
 *   });
 *   sel.setOptions(next);
 *   sel.setValue('B');
 *   sel.getValue();
 *   sel.destroy();
 *
 * `onChange` receives `{ target: { value } }` so existing
 * `(e) => ...e.target.value` handlers keep working unchanged.
 *
 * Two presentations, ONE behaviour:
 *
 *   default ("trigger")  a closed button showing the current value; clicking it
 *                        opens a popover containing the search field + results.
 *
 *   `inline: true`       the search field IS the control (always visible, no
 *                        trigger button, no popover). Results drop directly
 *                        beneath it. Use for a page's primary search - e.g. the
 *                        Blueprint Calculator's blueprint search - where there
 *                        is no "current value" to display and the user should be
 *                        able to type immediately.
 *
 * Inline mode reuses the SAME row rendering, highlight, keyboard handling and
 * async search as trigger mode. It is a difference in where the input and list
 * live, never a difference in behaviour - that is the whole point of keeping one
 * component (see CLAUDE.md rule 5).
 *
 * Rich rows: pass `renderRow(option, els)` to decorate a row (icon, category,
 * tech badge). It is called AFTER the standard row is built, so the highlight,
 * click and hover wiring are already in place and cannot be broken by a caller.
 *
 * Behaviour contract (must stay identical everywhere):
 *   - trigger mode: click / Enter / Space / ArrowDown opens; search auto-focuses
 *   - inline mode: focusing or typing in the field opens the list
 *   - type filters; ArrowUp/ArrowDown move the highlight; Enter selects
 *   - Escape / Tab / click-outside close; mouse hover syncs the highlight
 *   - selected row shows a checkmark
 *
 * Two deliberate implementation rules (see CLAUDE.md "UI Redesign Conventions"):
 *   1. The row highlight is expressed with `box-shadow` ONLY, never a toggled
 *      background - a background set on a row highlighted on its first paint
 *      does not clear reliably.
 *   2. `this.hiIndex` is a plain instance field starting at -1, so no row is
 *      highlighted on first paint (which is what triggers rule 1). It is reset
 *      to -1 on open, close, query change and select.
 */
(function () {
  'use strict';

  var OPEN_INSTANCES = [];

  function normalizeOptions(options) {
    return (options || []).map(function (o) {
      return typeof o === 'string' ? { value: o, label: o } : o;
    });
  }

  function QFSearchSelect(mountEl, opts) {
    if (!mountEl) throw new Error('QFSearchSelect: mount element is required');
    opts = opts || {};

    this.mountEl = mountEl;
    this.options = normalizeOptions(opts.options);
    this.value = opts.value !== undefined ? opts.value : null;
    this.onChange = opts.onChange || null;
    this.placeholder = opts.placeholder || 'Select…';
    this.searchPlaceholder = opts.searchPlaceholder || 'Type to search…';
    this.compact = !!opts.compact;
    this.disabled = !!opts.disabled;
    this.label = opts.label || null;
    this.description = opts.description || null;

    // Inline mode: the search field is the control itself. No trigger button,
    // no popover - results render in a panel directly under the field.
    this.inline = !!opts.inline;
    // Optional per-row decorator, called after the standard row is built so it
    // cannot disturb the highlight/click/hover wiring.
    this.renderRow = typeof opts.renderRow === 'function' ? opts.renderRow : null;
    // Inline mode keeps the typed text after a selection when this is true
    // (default: clear, matching the mockup's blueprint search).
    this.keepQueryOnSelect = !!opts.keepQueryOnSelect;

    // Async ("remote") mode. When onSearch is supplied the component stops
    // filtering a fixed list and asks the caller for options instead:
    //
    //   onSearch(query) -> Promise<Array<string | {value,label,...}>>
    //
    // The caller does the querying; this handles debounce, in-flight
    // ordering, and the loading / no-results / prompt states.
    this.onSearch = typeof opts.onSearch === 'function' ? opts.onSearch : null;
    this.minQueryLength = opts.minQueryLength !== undefined ? opts.minQueryLength : 2;
    this.debounceMs = opts.debounceMs !== undefined ? opts.debounceMs : 200;
    this.searchPrompt = opts.searchPrompt || 'Type to search…';
    this.loadingText = opts.loadingText || 'Searching…';
    this.emptyText = opts.emptyText || 'No matches';

    this.open = false;
    this.query = '';
    // Instance field, NOT state: mutated synchronously between rapid keydowns.
    // Starts at -1 so nothing is highlighted on first paint.
    this.hiIndex = -1;
    this.filtered = [];

    // Async bookkeeping. searchToken discards out-of-order responses: a slow
    // query for "tri" must never overwrite a later, faster query for "pye".
    this.searchToken = 0;
    this.searching = false;
    this._debounceHandle = null;
    // Inline mode: set while the clear button hands focus back to the field, so
    // the focus handler does not immediately reopen the list being cleared.
    this._suppressFocusOpen = false;

    this._boundDocMouseDown = this._onDocMouseDown.bind(this);
    this._boundReposition = this._reposition.bind(this);
    this._rafHandles = [];

    this._build();
    this._renderTrigger();
  }

  /* ---------------------------------------------------------------- build */

  QFSearchSelect.prototype._build = function () {
    var doc = this.mountEl.ownerDocument;
    this.doc = doc;

    var root = doc.createElement('div');
    root.className = 'qf-ss';
    if (this.label || this.description) {
      var head = doc.createElement('div');
      head.className = 'qf-ss-head';
      if (this.label) {
        var lab = doc.createElement('label');
        lab.className = 'qf-ss-label';
        lab.textContent = this.label;
        head.appendChild(lab);
      }
      if (this.description) {
        var desc = doc.createElement('span');
        desc.className = 'qf-ss-desc';
        desc.textContent = this.description;
        head.appendChild(desc);
      }
      root.appendChild(head);
    }

    var anchor = doc.createElement('div');
    anchor.className = 'qf-ss-anchor';

    if (this.inline) {
      root.appendChild(anchor);
      this.mountEl.appendChild(root);
      this.rootEl = root;
      this.anchorEl = anchor;
      this._buildInline(doc, anchor);
      return;
    }

    var trigger = doc.createElement('div');
    // classList (not className) - _renderTrigger toggles classes on this element.
    trigger.classList.add('qf-ss-trigger');
    if (this.compact) trigger.classList.add('qf-ss-compact');
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.tabIndex = this.disabled ? -1 : 0;

    var text = doc.createElement('span');
    text.className = 'qf-ss-value';
    trigger.appendChild(text);

    var chev = doc.createElement('span');
    chev.className = 'qf-ss-chevron';
    chev.setAttribute('aria-hidden', 'true');
    trigger.appendChild(chev);

    anchor.appendChild(trigger);
    root.appendChild(anchor);
    this.mountEl.appendChild(root);

    this.rootEl = root;
    this.anchorEl = anchor;
    this.triggerEl = trigger;
    this.textEl = text;

    var self = this;
    trigger.addEventListener('click', function () {
      if (self.disabled) return;
      self.open ? self.close() : self.openMenu();
    });
    trigger.addEventListener('keydown', function (e) {
      if (self.disabled) return;
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        self.openMenu();
      }
    });
  };

  /**
   * Inline presentation: a persistent search field with a results panel below.
   *
   * The input is created ONCE here and lives for the instance's lifetime -
   * unlike trigger mode, which builds its input on every open. That is why the
   * inline open/close paths only show and hide the list panel and must never
   * remove `inputEl`: doing so would blur the field mid-typing.
   */
  QFSearchSelect.prototype._buildInline = function (doc, anchor) {
    var self = this;

    var field = doc.createElement('div');
    field.className = 'qf-ss-inline-field';
    field.appendChild(this._searchIcon());

    var input = doc.createElement('input');
    input.type = 'text';
    input.className = 'qf-ss-inline-input';
    input.placeholder = this.placeholder;
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-autocomplete', 'list');
    input.disabled = this.disabled;
    field.appendChild(input);

    // Clear button: only meaningful once something has been typed.
    var clear = doc.createElement('span');
    clear.className = 'qf-ss-inline-clear';
    clear.setAttribute('role', 'button');
    clear.setAttribute('aria-label', 'Clear search');
    clear.textContent = '×';
    clear.hidden = true;
    field.appendChild(clear);

    anchor.appendChild(field);

    var list = doc.createElement('div');
    list.className = 'qf-ss-inline-list qf-scroll';
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    anchor.appendChild(list);

    this.inputEl = input;
    this.listEl = list;
    this.clearEl = clear;
    this.fieldEl = field;

    input.addEventListener('input', function () {
      self.query = input.value;
      self.hiIndex = -1;
      self.clearEl.hidden = !input.value;
      if (!self.open) self.openMenu();
      if (self.onSearch) {
        self._scheduleSearch();
      } else {
        self._applyFilter();
        self._renderList();
      }
    });
    input.addEventListener('focus', function () {
      if (self.disabled || self._suppressFocusOpen) return;
      self.openMenu();
    });
    input.addEventListener('keydown', this._onSearchKey.bind(this));

    clear.addEventListener('click', function () {
      // Focus is returned to the field so the user can retype immediately, but
      // the focus handler above would reopen the list we just closed. Suppress
      // that one reopen: clearing means "show me nothing", not "search again".
      self._suppressFocusOpen = true;
      self.clearQuery();
      self.inputEl.focus();
      // Cleared on a timeout rather than the next line: focus events are
      // synchronous in jsdom but not guaranteed to be in every browser, and a
      // flag cleared too early would let the list reopen anyway.
      setTimeout(function () { self._suppressFocusOpen = false; }, 0);
    });
  };

  /** Reset the typed text and results. Inline mode only. */
  QFSearchSelect.prototype.clearQuery = function () {
    if (!this.inline) return;
    this.query = '';
    this.hiIndex = -1;
    if (this.inputEl) this.inputEl.value = '';
    if (this.clearEl) this.clearEl.hidden = true;
    if (this.onSearch) {
      this.searchToken += 1;
      this.searching = false;
      this.options = [];
    }
    this._applyFilter();
    this.close();
  };

  /* --------------------------------------------------------------- render */

  QFSearchSelect.prototype._selectedOption = function () {
    var v = this.value;
    for (var i = 0; i < this.options.length; i++) {
      if (String(this.options[i].value) === String(v)) return this.options[i];
    }
    return null;
  };

  QFSearchSelect.prototype._renderTrigger = function () {
    // Inline mode has no trigger button; the only shared affordance is the
    // expanded state announced on the input.
    if (this.inline) {
      if (this.inputEl) {
        this.inputEl.setAttribute('aria-expanded', this.open ? 'true' : 'false');
        this.inputEl.disabled = this.disabled;
      }
      return;
    }
    var sel = this._selectedOption();
    this.textEl.textContent = sel ? sel.label : this.placeholder;
    this.triggerEl.classList.toggle('qf-ss-placeholder', !sel);
    this.triggerEl.classList.toggle('qf-ss-disabled', this.disabled);
    this.triggerEl.classList.toggle('qf-ss-open', this.open);
    this.triggerEl.setAttribute('aria-expanded', this.open ? 'true' : 'false');
    this.triggerEl.tabIndex = this.disabled ? -1 : 0;
  };

  QFSearchSelect.prototype._applyFilter = function () {
    // In async mode `options` IS the current result set - the caller already
    // filtered server-side, so filtering again would drop legitimate matches
    // (a search for "hydro" returning "Hydrogen Fuel Block" must survive).
    if (this.onSearch) {
      this.filtered = this.options.slice();
      return;
    }
    var q = this.query.trim().toLowerCase();
    this.filtered = q
      ? this.options.filter(function (o) {
          return String(o.label).toLowerCase().indexOf(q) !== -1;
        })
      : this.options.slice();
  };

  /**
   * Debounced remote search. Only used when `onSearch` was supplied.
   *
   * Every keystroke would otherwise hit the backend, and responses can land
   * out of order, so this debounces and stamps each request with a token.
   */
  QFSearchSelect.prototype._scheduleSearch = function () {
    var self = this;
    if (this._debounceHandle) clearTimeout(this._debounceHandle);

    var q = this.query.trim();
    if (q.length < this.minQueryLength) {
      // Too short to search: drop any in-flight response and show the prompt.
      this.searchToken += 1;
      this.searching = false;
      this.options = [];
      this._applyFilter();
      this._renderList();
      return;
    }

    this.searching = true;
    this._renderList();

    this._debounceHandle = setTimeout(function () {
      var token = ++self.searchToken;
      Promise.resolve(self.onSearch(q))
        .then(function (results) {
          if (token !== self.searchToken) return;   // a newer query won
          self.options = normalizeOptions(results);
          self.searching = false;
          self.hiIndex = -1;
          self._applyFilter();
          self._renderList();
        })
        .catch(function (err) {
          if (token !== self.searchToken) return;
          console.error('[QFSearchSelect] search failed:', err);
          self.options = [];
          self.searching = false;
          self._applyFilter();
          self._renderList();
        });
    }, this.debounceMs);
  };

  QFSearchSelect.prototype._renderList = function () {
    if (!this.listEl) return;
    var doc = this.doc;
    var self = this;
    var sel = this._selectedOption();

    this.listEl.textContent = '';
    this.rowEls = [];

    if (this.filtered.length === 0) {
      var empty = doc.createElement('div');
      empty.classList.add('qf-ss-empty');
      if (this.searching) {
        empty.textContent = this.loadingText;
      } else if (this.onSearch && this.query.trim().length < this.minQueryLength) {
        // Distinguish "type more" from "nothing matched" - an empty box that
        // says "No matches" before you have typed anything reads as broken.
        empty.textContent = this.searchPrompt;
      } else {
        empty.textContent = this.emptyText;
      }
      this.listEl.appendChild(empty);
      return;
    }

    // Clamp the highlight to the current list (it may have shrunk).
    if (this.hiIndex >= this.filtered.length) this.hiIndex = this.filtered.length - 1;

    this.filtered.forEach(function (o, i) {
      var row = doc.createElement('div');
      // Use classList throughout so later toggles operate on the same token set.
      row.classList.add('qf-ss-row');
      row.setAttribute('role', 'option');
      // Expose the value so callers and tests can identify a row without
      // depending on its label text.
      row.setAttribute('data-value', String(o.value));
      if (i === self.hiIndex) row.classList.add('qf-ss-hi');
      var isSel = sel && String(o.value) === String(sel.value);
      if (isSel) {
        row.classList.add('qf-ss-selected');
        row.setAttribute('aria-selected', 'true');
      }
      if (o.disabled) row.classList.add('qf-ss-row-disabled');

      var check = doc.createElement('span');
      check.classList.add('qf-ss-check');
      check.textContent = isSel ? '✓' : '';
      row.appendChild(check);

      var lab = doc.createElement('span');
      lab.classList.add('qf-ss-row-label');
      lab.textContent = o.label;
      row.appendChild(lab);

      row.addEventListener('mouseenter', function () {
        self.hiIndex = i;
        self._syncHighlight();
      });
      row.addEventListener('click', function () {
        if (o.disabled) return;
        self._choose(o);
      });

      // Decorate LAST: the row is fully wired by now, so a caller adding an
      // icon or badge cannot disturb the highlight/click/hover contract.
      if (self.renderRow) {
        try {
          self.renderRow(o, { row: row, label: lab, check: check });
        } catch (err) {
          // A broken decorator must not take out the whole list.
          console.error('[QFSearchSelect] renderRow failed:', err);
        }
      }

      self.rowEls.push(row);
      self.listEl.appendChild(row);
    });
  };

  // Only toggles the highlight class - avoids rebuilding rows on every arrow key.
  // Uses the row elements captured in _renderList rather than re-querying, so the
  // highlight stays correct regardless of how rows are nested.
  QFSearchSelect.prototype._syncHighlight = function () {
    if (!this.rowEls) return;
    for (var i = 0; i < this.rowEls.length; i++) {
      this.rowEls[i].classList.toggle('qf-ss-hi', i === this.hiIndex);
    }
    this._scrollHighlightIntoView();
  };

  QFSearchSelect.prototype._scrollHighlightIntoView = function () {
    if (!this.listEl || this.hiIndex < 0) return;
    // Index into the captured row elements, NOT listEl.children: the list may
    // contain non-row children (empty-state text, and group headers in inline
    // mode), which would make a positional lookup scroll to the wrong element.
    var row = this.rowEls && this.rowEls[this.hiIndex];
    if (!row) return;
    var top = row.offsetTop;
    var bottom = top + row.offsetHeight;
    if (top < this.listEl.scrollTop) {
      this.listEl.scrollTop = top;
    } else if (bottom > this.listEl.scrollTop + this.listEl.clientHeight) {
      this.listEl.scrollTop = bottom - this.listEl.clientHeight;
    }
  };

  /* ----------------------------------------------------------- open/close */

  QFSearchSelect.prototype.openMenu = function () {
    if (this.open || this.disabled) return;

    // Only one dropdown open at a time.
    OPEN_INSTANCES.slice().forEach(function (inst) { inst.close(); });

    if (this.inline) {
      this._openInline();
      return;
    }

    var doc = this.doc;
    var self = this;

    this.open = true;
    this.query = '';
    this.hiIndex = -1;

    // Async mode starts empty: the query was just cleared, so the previous
    // search's results no longer correspond to anything the user typed.
    if (this.onSearch) {
      this.options = [];
      this.searching = false;
    }
    this._applyFilter();

    var pop = doc.createElement('div');
    pop.className = 'qf-ss-popover';

    var searchWrap = doc.createElement('div');
    searchWrap.className = 'qf-ss-search';

    searchWrap.appendChild(this._searchIcon());

    var input = doc.createElement('input');
    input.type = 'text';
    input.className = 'qf-ss-input';
    input.placeholder = this.searchPlaceholder;
    input.setAttribute('autocomplete', 'off');
    searchWrap.appendChild(input);
    pop.appendChild(searchWrap);

    var list = doc.createElement('div');
    list.className = 'qf-ss-list qf-scroll';
    list.setAttribute('role', 'listbox');
    pop.appendChild(list);

    // position:fixed on <body> so the popover escapes any overflow:hidden or
    // scrolling ancestor (e.g. Build List rows).
    doc.body.appendChild(pop);

    this.popEl = pop;
    this.inputEl = input;
    this.listEl = list;

    this._renderList();
    this._reposition();
    this._renderTrigger();

    input.addEventListener('input', function () {
      self.query = input.value;
      self.hiIndex = -1;          // nothing hot until the user arrows again
      if (self.onSearch) {
        self._scheduleSearch();
      } else {
        self._applyFilter();
        self._renderList();
      }
    });
    input.addEventListener('keydown', this._onSearchKey.bind(this));

    doc.addEventListener('mousedown', this._boundDocMouseDown, true);
    window.addEventListener('scroll', this._boundReposition, true);
    window.addEventListener('resize', this._boundReposition);

    // The popover mounts a frame later; retry focus across two frames.
    this._focusInput();

    OPEN_INSTANCES.push(this);
  };

  /**
   * Inline open: reveal the results panel. Deliberately does NOT reset `query`
   * or rebuild the input - in inline mode the field is the control and the user
   * may already be mid-word. (Trigger mode clears the query on open because its
   * input is created fresh each time.)
   */
  QFSearchSelect.prototype._openInline = function () {
    this.open = true;
    this.hiIndex = -1;
    this._applyFilter();

    this.listEl.hidden = false;
    this._renderList();
    this._renderTrigger();

    this.doc.addEventListener('mousedown', this._boundDocMouseDown, true);

    OPEN_INSTANCES.push(this);
  };

  QFSearchSelect.prototype._focusInput = function () {
    var self = this;
    var tryFocus = function () { if (self.inputEl) self.inputEl.focus(); };
    tryFocus();
    this._rafHandles.push(requestAnimationFrame(function () {
      tryFocus();
      self._rafHandles.push(requestAnimationFrame(tryFocus));
    }));
  };

  QFSearchSelect.prototype._searchIcon = function () {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = this.doc.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'qf-ss-search-icon');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    var c = this.doc.createElementNS(NS, 'circle');
    c.setAttribute('cx', '11'); c.setAttribute('cy', '11'); c.setAttribute('r', '8');
    var l = this.doc.createElementNS(NS, 'line');
    l.setAttribute('x1', '21'); l.setAttribute('y1', '21');
    l.setAttribute('x2', '16.65'); l.setAttribute('y2', '16.65');
    svg.appendChild(c); svg.appendChild(l);
    return svg;
  };

  QFSearchSelect.prototype.close = function () {
    if (!this.open) return;
    this.open = false;
    this.hiIndex = -1;

    // Abandon any pending or in-flight remote search: the popover it would
    // paint into is about to be removed.
    if (this._debounceHandle) {
      clearTimeout(this._debounceHandle);
      this._debounceHandle = null;
    }
    this.searchToken += 1;
    this.searching = false;

    this.doc.removeEventListener('mousedown', this._boundDocMouseDown, true);

    var i = OPEN_INSTANCES.indexOf(this);
    if (i !== -1) OPEN_INSTANCES.splice(i, 1);

    // Inline mode owns its input and list for the instance's lifetime: only the
    // results panel is hidden. Tearing down `inputEl` here would blur the field
    // the user is typing into.
    if (this.inline) {
      if (this.listEl) {
        this.listEl.hidden = true;
        this.listEl.textContent = '';
      }
      this.rowEls = null;
      this._renderTrigger();
      return;
    }

    window.removeEventListener('scroll', this._boundReposition, true);
    window.removeEventListener('resize', this._boundReposition);

    this._rafHandles.forEach(cancelAnimationFrame);
    this._rafHandles = [];

    if (this.popEl && this.popEl.parentNode) this.popEl.parentNode.removeChild(this.popEl);
    this.popEl = null;
    this.inputEl = null;
    this.listEl = null;
    this.rowEls = null;

    this._renderTrigger();
  };

  QFSearchSelect.prototype._reposition = function () {
    if (!this.popEl || !this.anchorEl) return;
    var r = this.anchorEl.getBoundingClientRect();
    this.popEl.style.left = r.left + 'px';
    this.popEl.style.top = (r.bottom + 5) + 'px';
    this.popEl.style.width = r.width + 'px';
  };

  /* --------------------------------------------------------------- events */

  QFSearchSelect.prototype._onDocMouseDown = function (e) {
    if (this.rootEl.contains(e.target)) return;
    if (this.popEl && this.popEl.contains(e.target)) return;
    this.close();
  };

  QFSearchSelect.prototype._onSearchKey = function (e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (this.inline) {
        // Inline mode: the field persists, so Escape must clear the text too -
        // closing alone would leave the query sitting there with no results.
        // (Trigger mode discards its input on close, so this is implicit.)
        this.clearQuery();
        return;
      }
      this.close();
      if (this.triggerEl) this.triggerEl.focus();
      return;
    }
    if (e.key === 'Tab') { this.close(); return; }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (this.filtered.length === 0) return;
      // From -1 the first press lands on row 0.
      this.hiIndex = Math.min(this.hiIndex + 1, this.filtered.length - 1);
      this._syncHighlight();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (this.filtered.length === 0) return;
      this.hiIndex = Math.max(this.hiIndex - 1, 0);
      this._syncHighlight();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (this.hiIndex >= 0) this._choose(this.filtered[this.hiIndex]);
    }
  };

  QFSearchSelect.prototype._choose = function (o) {
    if (!o) return;
    this.value = o.value;

    // Inline mode: clear the typed text on select unless the caller opted out.
    // Leaving a stale query behind is a real bug - the user picks "Hydrogen
    // Fuel Block", then later clears the selection and finds "hydro" still
    // sitting in the box.
    if (this.inline && !this.keepQueryOnSelect) {
      this.query = '';
      if (this.inputEl) this.inputEl.value = '';
      if (this.clearEl) this.clearEl.hidden = true;
      if (this.onSearch) {
        this.searchToken += 1;
        this.searching = false;
        this.options = [];
      }
      this._applyFilter();
    }

    this.close();
    this._renderTrigger();
    if (this.onChange) this.onChange({ target: { value: o.value }, option: o });
  };

  /* ---------------------------------------------------------- public API */

  QFSearchSelect.prototype.setOptions = function (options) {
    this.options = normalizeOptions(options);
    this.hiIndex = -1;
    if (this.open) {
      this._applyFilter();
      this._renderList();
    }
    this._renderTrigger();
  };

  QFSearchSelect.prototype.setValue = function (value) {
    this.value = value;
    this._renderTrigger();
  };

  QFSearchSelect.prototype.getValue = function () {
    return this.value;
  };

  QFSearchSelect.prototype.setDisabled = function (disabled) {
    this.disabled = !!disabled;
    if (this.disabled) this.close();
    this._renderTrigger();
  };

  QFSearchSelect.prototype.destroy = function () {
    this.close();
    if (this._debounceHandle) {
      clearTimeout(this._debounceHandle);
      this._debounceHandle = null;
    }
    this.searchToken += 1;

    // Belt and braces: close() removes this, but an instance destroyed while
    // already closed must not leave a document listener behind either.
    this.doc.removeEventListener('mousedown', this._boundDocMouseDown, true);

    if (this.rootEl && this.rootEl.parentNode) {
      this.rootEl.parentNode.removeChild(this.rootEl);
    }
    this.rootEl = null;
    this.triggerEl = null;
    this.textEl = null;
    this.anchorEl = null;
    this.inputEl = null;
    this.listEl = null;
    this.clearEl = null;
    this.fieldEl = null;
    this.rowEls = null;
  };

  window.QFSearchSelect = QFSearchSelect;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { QFSearchSelect: QFSearchSelect };
  }
})();
