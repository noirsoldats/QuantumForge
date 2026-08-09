/**
 * Blueprint Calculator - shell view.
 *
 * Ported from "Blueprint Calculator (1a).dc.html". Replaces the former
 * public/blueprint-calculator.html page + blueprint-calculator-renderer.js.
 *
 * ALL calculation and pricing stays in main - this module only gathers inputs,
 * calls the same IPC as before, and renders the result. Any change in the
 * numbers here would be a bug, not a port.
 *
 * Lifecycle: registered with the shell router, so it can be mounted, unmounted
 * and mounted again in a persistent document. Everything that outlives a single
 * render - document listeners, IPC subscriptions, QFSearchSelect instances -
 * goes through `ctx` so the router disposes it. The legacy page discarded its
 * subscription disposers, which was safe only because navigation destroyed the
 * document; here it would mean duplicate handlers on every remount.
 *
 * Binding rules (CLAUDE.md "UI Redesign Conventions") that bite in this file:
 *   - rule 1/3: row + tab highlights toggle a class whose CSS is box-shadow
 *     only, and every conditional style sets the same properties in both
 *     branches
 *   - rule 5: searchable dropdowns are the shared QFSearchSelect; the two
 *     fixed-option invention selects stay plain <select class="qf-select">
 */
(function () {
  'use strict';

  const TOOL_KEY_CALC = 'blueprintCalculatorMarketSetId';

  /* ------------------------------------------------------------------ state */

  const state = {
    blueprint: null,
    // Which owned blueprint supplied the ME, or null when none is owned.
    // Carries characterId / isCopy / isCorporation so the UI can later show
    // where the number came from.
    ownedBlueprint: null,
    defaultCharacter: null,
    marketSet: null,
    facilities: [],
    facilityId: null,
    tab: 'results',
    inventionLoaded: false,
    // Invention view state, preserved across decryptor/strategy changes so a
    // re-render does not refetch prices for every material again.
    invention: null,
    inventionStrategy: 'total-per-item',
    inventionDecryptorIndex: -1,
  };

  // QFSearchSelect instances. Tracked so every mount disposes exactly the ones
  // it created - they own document-level listeners and body-mounted popovers,
  // so dropping the container is NOT enough.
  let searchSelects = [];

  /** The facility picker, so a handoff can set it rather than only its state. */
  let facilitySelect = null;

  let templateCache = null;

  /* --------------------------------------------------------------- helpers */

  function $(id) {
    return document.getElementById(id);
  }

  function toast(message, type, options) {
    if (window.QFToast) {
      window.QFToast.show(message, type, options);
    } else {
      console[type === 'error' ? 'error' : 'log']('[blueprint-calculator]', message);
    }
  }

  function formatNumber(value) {
    if (!value) return '0';
    return value.toLocaleString('en-US');
  }

  function formatISK(value) {
    if (!value || value === 0) return '0.00 ISK';
    return (
      value.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }) + ' ISK'
    );
  }

  function formatTime(seconds) {
    if (!seconds || seconds === 0) return '0s';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
    return parts.join(' ');
  }

  /**
   * Type icon.
   *
   * EVE serves blueprints from a different variant than ordinary items: `/icon`
   * 404s for a blueprint typeID, which is what rendered every search row and the
   * blueprint card as a broken image. Blueprints must use `/bp`.
   *
   * `onerror` clears the element rather than leaving the browser's broken-image
   * glyph, so an unexpected 404 degrades to blank space instead of visible
   * breakage.
   */
  function typeIcon(typeId, cls, variant) {
    const img = document.createElement('img');
    img.className = cls || 'bpc-mat-icon';
    img.src = `https://images.evetech.net/types/${typeId}/${variant || 'icon'}?size=64`;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => {
      img.style.visibility = 'hidden';
    });
    return img;
  }

  /** Icon for a blueprint typeID (uses the `bp` variant). */
  function blueprintIcon(typeId, cls) {
    return typeIcon(typeId, cls, 'bp');
  }

  /**
   * Tech tier for a blueprint, derived from its name.
   *
   * `searchBlueprints` returns only typeID/typeName/product columns - there is
   * no meta-group field to read - so this is inferred rather than fetched. EVE
   * names T2/T3 blueprints consistently enough for this to be reliable, and a
   * miss only costs a badge, never a number.
   */
  function techOf(name) {
    if (!name) return null;
    if (/\bII\b/.test(name)) return 'T2';
    if (/\bIII\b/.test(name)) return 'T3';
    return null;
  }

  /** Build an element with optional class/text. Keeps render code readable. */
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /**
   * Run a render step in isolation.
   *
   * The renderer logs failures rather than throwing, so a single bad panel used
   * to abort every panel after it in the same function (this is exactly how the
   * Market override counters silently read 0). Each section renders behind its
   * own guard so one failure cannot blank its siblings.
   */
  function renderSafely(label, fn) {
    try {
      fn();
    } catch (error) {
      console.error(`[blueprint-calculator] render failed: ${label}`, error);
    }
  }

  async function loadSafely(label, fn) {
    try {
      return await fn();
    } catch (error) {
      console.error(`[blueprint-calculator] load failed: ${label}`, error);
      return null;
    }
  }

  /* -------------------------------------------------------------- template */

  async function loadTemplate() {
    const inline = $('blueprint-calculator-view-template');
    if (inline) return inline.content.cloneNode(true);

    if (!templateCache) {
      try {
        const html = await fetch('blueprint-calculator.view.html').then((r) => r.text());
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        const tpl = parsed.getElementById('blueprint-calculator-view-template');
        if (!tpl) {
          console.error('[blueprint-calculator] template not found');
          return null;
        }
        templateCache = tpl.content;
      } catch (error) {
        console.error('[blueprint-calculator] failed to load template:', error);
        return null;
      }
    }
    return document.importNode(templateCache, true);
  }

  /* ------------------------------------------------------------ market set */

  async function initMarketSet(ctx) {
    const sets = (await loadSafely('market sets', () =>
      window.electronAPI.market.getMarketSets()
    )) || [];

    const result = await loadSafely('tool market set', () =>
      window.electronAPI.market.getMarketSetForTool(TOOL_KEY_CALC)
    );
    state.marketSet = result ? result.marketSet : null;

    const host = $('bpc-market-host');
    if (!host || !window.QFSearchSelect) return;

    const options = sets.map((s) => ({
      // Market set ids are opaque STRINGS - never coerce them to Number.
      value: String(s.id),
      label: s.name + (s.isDefault ? ' (Default)' : ''),
    }));

    const sel = new window.QFSearchSelect(host, {
      options,
      value: state.marketSet ? String(state.marketSet.id) : null,
      placeholder: 'Select market set…',
      onChange: async (e) => {
        await loadSafely('set tool market set', async () => {
          await window.electronAPI.market.setMarketSetForTool(TOOL_KEY_CALC, e.target.value);
          const next = await window.electronAPI.market.getMarketSetForTool(TOOL_KEY_CALC);
          state.marketSet = next.marketSet;
        });
        // Pricing depends on the market set, so a loaded blueprint is stale.
        if (state.blueprint) await calculate();
      },
    });
    searchSelects.push(sel);
    ctx.track(() => sel.destroy());
  }

  /* -------------------------------------------------------------- facility */

  async function initFacilities(ctx) {
    const facilities =
      (await loadSafely('facilities', () => window.electronAPI.facilities.getFacilities())) || [];
    state.facilities = facilities;

    const defaultFacility = facilities.find((f) => f.usage === 'default');
    state.facilityId = defaultFacility ? defaultFacility.id : null;

    const host = $('bpc-facility-host');
    if (!host || !window.QFSearchSelect) return;

    const options = [{ value: '', label: 'No Facility (No Bonuses)' }].concat(
      facilities.map((f) => ({ value: String(f.id), label: f.name }))
    );

    const sel = new window.QFSearchSelect(host, {
      options,
      value: state.facilityId ? String(state.facilityId) : '',
      placeholder: 'No Facility (No Bonuses)',
      onChange: async (e) => {
        state.facilityId = e.target.value || null;
        if (state.blueprint) await calculate();
      },
    });
    searchSelects.push(sel);
    // Held so a popped-out window can drive the control, not just the state
    // behind it. Setting state.facilityId alone leaves the picker showing the
    // DEFAULT facility it was seeded with, contradicting the results.
    facilitySelect = sel;
    ctx.track(() => {
      sel.destroy();
      facilitySelect = null;
    });
  }

  /* ---------------------------------------------------------------- search */

  function initSearch(ctx) {
    const host = $('bpc-search-host');
    if (!host || !window.QFSearchSelect) return;

    // Inline mode: the search field IS the control. Same component as every
    // other searchable dropdown - keyboard nav, hover sync and async loading
    // come from the shared implementation rather than a local copy.
    const sel = new window.QFSearchSelect(host, {
      inline: true,
      placeholder: 'Search for a blueprint…',
      minQueryLength: 2,
      debounceMs: 300,
      searchPrompt: 'Type at least 2 characters to search blueprints',
      emptyText: 'No blueprints found',
      loadingText: 'Searching blueprints…',
      onSearch: async (query) => {
        const results = await window.electronAPI.calculator.searchBlueprints(query, 100);
        return (results || []).map((bp) => ({
          value: String(bp.typeID),
          label: bp.typeName,
          typeID: bp.typeID,
          productName: bp.productName,
          productQuantity: bp.productQuantity,
          tech: techOf(bp.typeName),
        }));
      },
      renderRow: (opt, els) => {
        // Rich row: icon, name + what it produces, tech badge. Runs after the
        // row is wired, so it cannot disturb click/hover/highlight.
        // Search results are BLUEPRINTS, so this needs the `bp` variant. The
        // card and material rows below show products/materials and stay `icon`.
        els.row.insertBefore(blueprintIcon(opt.typeID, 'bpc-sr-icon'), els.label);

        const text = el('div', 'bpc-sr-text');
        text.appendChild(el('div', 'bpc-sr-name', opt.label));
        if (opt.productName) {
          text.appendChild(
            el(
              'div',
              'bpc-sr-cat',
              `Produces: ${opt.productName} × ${formatNumber(opt.productQuantity)}`
            )
          );
        }
        els.row.replaceChild(text, els.label);

        if (opt.tech) {
          const badge = el('span', 'bpc-tech', opt.tech);
          badge.setAttribute('data-tech', opt.tech);
          els.row.appendChild(badge);
        }
      },
      onChange: (e) => {
        const typeId = parseInt(e.target.value, 10);
        if (!Number.isNaN(typeId)) selectBlueprint(typeId);
      },
    });
    searchSelects.push(sel);
    ctx.track(() => sel.destroy());
  }

  /* ------------------------------------------------------- blueprint select */

  async function selectBlueprint(blueprintTypeId, meOverride) {
    try {
      const product = await window.electronAPI.calculator.getBlueprintProduct(blueprintTypeId);
      if (!product) {
        toast('Blueprint not found.', 'error');
        return;
      }

      const [blueprintName, productName] = await Promise.all([
        window.electronAPI.calculator.getTypeName(blueprintTypeId),
        window.electronAPI.calculator.getTypeName(product.typeID),
      ]);

      state.blueprint = {
        typeID: blueprintTypeId,
        typeName: blueprintName,
        product: {
          typeID: product.typeID,
          typeName: productName,
          quantity: product.quantity,
        },
      };

      // ME defaults to the best owned blueprint across the ENABLED blueprint
      // sources (Settings > Industry), unless the caller supplied one (opening
      // from the Blueprints window). No longer tied to the default character:
      // which characters supply blueprints is now configuration.
      let me = 0;
      state.ownedBlueprint = null;

      if (meOverride !== undefined && meOverride !== null) {
        me = meOverride;
      } else {
        const owned = await loadSafely('owned blueprint', () =>
          window.electronAPI.calculator.resolveOwnedBlueprint(blueprintTypeId)
        );
        if (owned) {
          state.ownedBlueprint = owned;
          // Number.isFinite, not `|| 0`: a legitimately owned ME 0 blueprint is
          // not a failure and must not be silently replaced.
          me = Number.isFinite(owned.me) ? owned.me : 0;
        }
      }

      $('bpc-me').value = me;
      $('bpc-runs').value = 1;

      renderBlueprintCard();

      state.tab = 'results';
      state.inventionLoaded = false;
      state.invention = null;
      state.inventionDecryptorIndex = -1;

      await window.electronAPI.calculator.clearCaches();

      $('bpc-empty').hidden = true;
      $('bpc-bp-card').hidden = false;

      await calculate();
    } catch (error) {
      console.error('[blueprint-calculator] selectBlueprint failed:', error);
      toast(`Failed to load blueprint: ${error.message}`, 'error');
    }
  }

  function renderBlueprintCard() {
    const bp = state.blueprint;
    if (!bp) return;

    $('bpc-bp-name').textContent = bp.typeName;
    $('bpc-bp-product').textContent = bp.product.typeName;
    $('bpc-bp-per-run').textContent = formatNumber(bp.product.quantity);

    const tech = techOf(bp.typeName);
    const techEl = $('bpc-bp-tech');
    techEl.hidden = !tech;
    if (tech) {
      techEl.textContent = tech;
      techEl.setAttribute('data-tech', tech);
    }

    const iconHost = $('bpc-bp-icon');
    iconHost.textContent = '';
    iconHost.appendChild(typeIcon(bp.product.typeID, ''));

    updateProductTotal();
  }

  function updateProductTotal() {
    const bp = state.blueprint;
    if (!bp) return;
    const runs = parseInt($('bpc-runs').value, 10) || 1;
    $('bpc-bp-total').textContent = formatNumber(bp.product.quantity * runs);
  }

  /* ------------------------------------------------------------- calculate */

  async function calculate() {
    if (!state.blueprint) return;

    const me = parseInt($('bpc-me').value, 10) || 0;
    const runs = parseInt($('bpc-runs').value, 10) || 1;

    if (runs < 1) {
      toast('Runs must be at least 1.', 'warning');
      return;
    }
    if (me < 0 || me > 10) {
      toast('ME level must be between 0 and 10.', 'warning');
      return;
    }

    showLoading(true);

    try {
      const characterId =
        state.defaultCharacter && state.defaultCharacter.characterId
          ? state.defaultCharacter.characterId
          : null;

      const result = await window.electronAPI.calculator.calculateMaterials(
        state.blueprint.typeID,
        runs,
        me,
        characterId,
        state.facilityId,
        state.marketSet ? state.marketSet.id : undefined
      );

      if (result && result.error) throw new Error(result.error);

      await displayCalculation(result, runs);
    } catch (error) {
      console.error('[blueprint-calculator] calculate failed:', error);
      toast(`Failed to calculate materials: ${error.message}`, 'error');
    } finally {
      showLoading(false);
    }
  }

  function showLoading(on) {
    $('bpc-loading').hidden = !on;
    if (on) {
      $('bpc-panel-results').hidden = true;
      $('bpc-panel-invention').hidden = true;
    }
  }

  async function displayCalculation(result, runs) {
    $('bpc-tabs').hidden = false;

    updateProductTotal();

    await renderFacilityBonuses();
    await renderTotalMaterials(result.materials);
    await renderBreakdown(result.breakdown, runs);
    renderSafely('pricing', () => renderPricing(result.pricing));

    // Invention tab is only offered when the blueprint can actually be
    // invented from; loading is deferred until the tab is opened.
    await configureInventionTab();

    state.inventionLoaded = false;
    state.invention = null;

    showTab(state.tab);
  }

  /* ------------------------------------------------------ facility bonuses */

  async function renderFacilityBonuses() {
    const wrap = $('bpc-bonuses');
    if (!state.facilityId) {
      wrap.hidden = true;
      return;
    }

    const facility = await loadSafely('facility', () =>
      window.electronAPI.facilities.getFacility(state.facilityId)
    );
    if (!facility) {
      wrap.hidden = true;
      return;
    }

    $('bpc-bonuses-facility').textContent = facility.name;

    const list = $('bpc-bonuses-list');
    list.textContent = '';

    const addBonus = (label, value) => {
      const item = el('span', 'bpc-bonus');
      item.appendChild(el('span', 'bpc-bonus-dot'));
      item.appendChild(document.createTextNode(label + ' '));
      item.appendChild(el('span', 'bpc-bonus-value', value));
      list.appendChild(item);
    };

    if (facility.structureTypeId) addBonus('Structure', '-1.00%');

    if (facility.rigs && facility.rigs.length > 0) {
      let securityStatus = 0.5;
      if (facility.systemId) {
        const sec = await loadSafely('system security', () =>
          window.electronAPI.sde.getSystemSecurityStatus(facility.systemId)
        );
        if (typeof sec === 'number') securityStatus = sec;
      }
      const secMultiplier = securityStatus >= 0.5 ? 1.0 : securityStatus > 0 ? 1.9 : 2.1;
      const secLabel =
        securityStatus >= 0.5
          ? 'High-Sec (1.0x)'
          : securityStatus > 0
            ? 'Low-Sec (1.9x)'
            : 'Null-Sec/WH (2.1x)';

      let totalRigBonus = 0;
      for (const rig of facility.rigs) {
        const rigTypeId = typeof rig === 'string' ? parseInt(rig, 10) : rig.typeId;
        const bonuses = await loadSafely(`rig bonuses ${rigTypeId}`, () =>
          window.electronAPI.calculator.getRigBonuses(rigTypeId)
        );
        if (bonuses && bonuses.materialBonus) {
          totalRigBonus += bonuses.materialBonus * secMultiplier;
        }
      }

      addBonus(`Rigs (${facility.rigs.length})`, `${totalRigBonus.toFixed(2)}%`);
      addBonus('Security', secLabel);
    }

    wrap.hidden = false;
  }

  /* ------------------------------------------------------- total materials */

  async function renderTotalMaterials(materials) {
    const host = $('bpc-total-materials');
    host.textContent = '';

    const entries = Object.entries(materials || {});
    $('bpc-total-mat-count').textContent = String(entries.length);

    if (entries.length === 0) {
      host.appendChild(el('div', 'bpc-mat-row', 'No materials required'));
      return;
    }

    const list = await Promise.all(
      entries.map(async ([typeId, quantity]) => ({
        typeId: parseInt(typeId, 10),
        typeName: await window.electronAPI.calculator.getTypeName(parseInt(typeId, 10)),
        quantity,
      }))
    );
    list.sort((a, b) => b.quantity - a.quantity);

    list.forEach((mat) => {
      const row = el('div', 'bpc-mat-row');
      row.appendChild(typeIcon(mat.typeId));
      row.appendChild(el('span', 'bpc-mat-name', mat.typeName));
      row.appendChild(el('span', 'bpc-mat-qty', formatNumber(mat.quantity)));
      host.appendChild(row);
    });
  }

  /* ------------------------------------------------------------- breakdown */

  async function renderBreakdown(breakdown, totalRuns) {
    const rawHost = $('bpc-raw-materials');
    const intHost = $('bpc-intermediates');
    rawHost.textContent = '';
    intHost.textContent = '';

    const first = breakdown && breakdown.length > 0 ? breakdown[0] : null;
    if (!first) {
      $('bpc-intermediates-wrap').hidden = true;
      return;
    }

    $('bpc-breakdown-name').textContent = first.blueprintName;
    $('bpc-breakdown-me').textContent = `ME ${first.meLevel}`;
    $('bpc-breakdown-runs').textContent = `${formatNumber(first.runs)} run${first.runs > 1 ? 's' : ''}`;

    (first.rawMaterials || []).forEach((mat) => {
      const row = el('div', 'bpc-mat-row');
      row.appendChild(typeIcon(mat.typeID || mat.typeId));
      row.appendChild(el('span', 'bpc-mat-name', mat.typeName));
      row.appendChild(el('span', 'bpc-mat-qty', formatNumber(mat.quantity)));
      rawHost.appendChild(row);
    });

    const intermediates = first.intermediateComponents || [];
    $('bpc-intermediates-wrap').hidden = intermediates.length === 0;

    intermediates.forEach((comp) => {
      const row = el('div', 'bpc-mat-row');
      row.appendChild(typeIcon(comp.typeID || comp.typeId));

      const name = el('span', 'bpc-mat-name', comp.typeName);
      const badge = el('span', 'bpc-badge bpc-badge-warning', `ME ${comp.meLevel}`);
      name.appendChild(badge);
      row.appendChild(name);

      row.appendChild(el('span', 'bpc-mat-qty', formatNumber(comp.quantity)));
      intHost.appendChild(row);
    });
  }

  /* --------------------------------------------------------------- pricing */

  function renderPricing(pricing) {
    const costRows = $('bpc-cost-rows');
    const feeRows = $('bpc-fee-rows');
    const priceHost = $('bpc-material-prices');
    costRows.textContent = '';
    feeRows.textContent = '';
    priceHost.textContent = '';

    if (!pricing) {
      $('bpc-total-cost').textContent = '—';
      $('bpc-sell-value').textContent = '—';
      $('bpc-profit-value').textContent = '—';
      $('bpc-profit-margin').textContent = '—';
      $('bpc-materials-cost-total').textContent = '—';
      $('bpc-output-value').textContent = '—';
      return;
    }

    const kv = (host, label, value, opts) => {
      const o = opts || {};
      const row = el('div', o.rowClass || 'bpc-kv');
      row.appendChild(el('span', o.labelClass || 'bpc-kv-label', label));
      row.appendChild(el('span', `bpc-mono ${o.valueClass || ''}`.trim(), value));
      host.appendChild(row);
    };

    /* ---- cost summary ---- */
    kv(costRows, 'Materials', formatISK(pricing.inputCosts.totalCost));
    if (pricing.jobCostBreakdown) {
      kv(costRows, 'Job Cost', formatISK(pricing.jobCostBreakdown.totalJobCost));
    } else if (pricing.jobCost) {
      kv(costRows, 'Job Cost', formatISK(pricing.jobCost));
    }
    if (pricing.taxesBreakdown) {
      kv(costRows, 'Material Broker Fees', formatISK(pricing.taxesBreakdown.materialBrokerFee));
      kv(costRows, 'Product Selling Fees', formatISK(pricing.taxesBreakdown.totalProductFees));
    } else if (pricing.salesTax) {
      kv(costRows, 'Sales Tax', formatISK(pricing.salesTax));
    }

    $('bpc-total-cost').textContent = formatISK(pricing.totalCosts);

    const outQty = pricing.outputValue.quantity;
    $('bpc-sell-label').textContent = `Sell Value (${formatNumber(outQty)} units)`;
    $('bpc-sell-value').textContent = formatISK(pricing.outputValue.totalValue);

    if (!pricing.outputValue.hasPrice) {
      toast('Product price data not available for this item.', 'warning');
    }

    /* ---- profit ---- */
    const isProfit = pricing.profit >= 0;
    const profitBox = $('bpc-profit');
    profitBox.classList.toggle('is-loss', !isProfit);
    $('bpc-profit-label').textContent = isProfit ? 'Profit' : 'Loss';
    $('bpc-profit-value').textContent = formatISK(Math.abs(pricing.profit));
    $('bpc-profit-margin').textContent = `${pricing.profitMargin.toFixed(2)}%`;

    /* ---- input costs ---- */
    const matPrices = pricing.inputCosts.materialPrices || {};
    const matEntries = Object.entries(matPrices);
    $('bpc-matprice-count').textContent = `${matEntries.length} items`;

    // The pricing payload carries typeName, resolved in blueprint-pricing.js
    // from the calculator's already-warm name cache - so this render stays
    // synchronous. (It did NOT carry one until 2026-08-08, which is why every
    // row here read "Type 34"; the fallback below is now genuinely a fallback.)
    matEntries
      .map(([typeId, data]) => ({ typeId: parseInt(typeId, 10), ...data }))
      .sort((a, b) => b.quantity - a.quantity)
      .forEach((mat) => {
        const row = el('div', 'bpc-price-row');
        row.appendChild(typeIcon(mat.typeId));

        const text = el('div', 'bpc-price-text');
        text.appendChild(el('div', 'bpc-price-name', mat.typeName || `Type ${mat.typeId}`));
        text.appendChild(
          el('div', 'bpc-price-detail', `${formatNumber(mat.quantity)} × ${formatISK(mat.unitPrice)}`)
        );
        row.appendChild(text);
        row.appendChild(el('span', 'bpc-price-total', formatISK(mat.totalPrice)));
        priceHost.appendChild(row);
      });

    $('bpc-materials-cost-total').textContent = formatISK(pricing.inputCosts.totalCost);

    if (pricing.inputCosts.itemsWithoutPrices > 0) {
      toast(
        `${pricing.inputCosts.itemsWithoutPrices} material(s) are missing price data.`,
        'warning'
      );
    }

    /* ---- fees column ---- */
    const header = (label) => feeRows.appendChild(el('div', 'bpc-section-label bpc-section-label-accent', label));
    const sub = (label) => feeRows.appendChild(el('div', 'bpc-fee-sub', label));
    const feeRow = (label, value, opts) => {
      const o = opts || {};
      const row = el('div', `bpc-fee-row ${o.indent ? 'bpc-fee-row-indent' : ''}`.trim());
      row.appendChild(el('span', o.strong ? 'bpc-kv-strong' : 'bpc-kv-label', label));
      row.appendChild(el('span', `bpc-mono ${o.strong ? 'bpc-kv-strong' : ''}`.trim(), value));
      feeRows.appendChild(row);
    };

    if (pricing.jobCostBreakdown) {
      const jcb = pricing.jobCostBreakdown;
      header('Job Costs');
      feeRow('Estimated Item Value', formatISK(jcb.estimatedItemValue), { indent: true });
      feeRow('System Cost Index', `${(jcb.systemCostIndex * 100).toFixed(2)}%`, { indent: true });
      feeRow('Job Gross Cost', formatISK(jcb.jobGrossCost), { indent: true });
      if (jcb.structureRollBonus > 0) {
        feeRow('Structure Cost Bonus', `-${jcb.structureRollBonus.toFixed(2)}%`, { indent: true });
      }
      feeRow('Job Base Cost', formatISK(jcb.jobBaseCost), { indent: true });

      sub('Installation Taxes');
      feeRow(`Facility Tax (${jcb.facilityTaxRate.toFixed(2)}%)`, formatISK(jcb.facilityTax), {
        indent: true,
      });
      feeRow('SCC Surcharge (4%)', formatISK(jcb.sccSurcharge), { indent: true });
      feeRow('Total Job Cost', formatISK(jcb.totalJobCost), { strong: true });
    }

    if (pricing.taxesBreakdown) {
      const tb = pricing.taxesBreakdown;
      header('Trading Fees');

      sub('Material Purchase Fees');
      feeRow('Materials Cost', formatISK(tb.materialsCost), { indent: true });
      const brokerSkill =
        tb.brokerRelationsSkillLevel > 0 ? ` (Broker Relations ${tb.brokerRelationsSkillLevel})` : '';
      feeRow(`Broker Fee Rate${brokerSkill}`, `${tb.materialBrokerFeeRate.toFixed(2)}%`, {
        indent: true,
      });
      feeRow('Material Purchase Fees Total', formatISK(tb.materialBrokerFee), { strong: true });

      sub('Product Selling Fees');
      feeRow('Product Value', formatISK(tb.outputValue), { indent: true });
      const acctSkill =
        tb.accountingSkillLevel > 0 ? ` (Accounting ${tb.accountingSkillLevel})` : '';
      feeRow(`Sales Tax Rate${acctSkill}`, `${tb.effectiveSalesTaxRate.toFixed(2)}%`, {
        indent: true,
      });
      feeRow('Sales Tax', formatISK(tb.productSalesTax), { indent: true });
      feeRow(`Broker Fee Rate${brokerSkill}`, `${tb.productBrokerFeeRate.toFixed(2)}%`, {
        indent: true,
      });
      feeRow('Broker Fee', formatISK(tb.productBrokerFee), { indent: true });
      feeRow('Product Selling Fees Total', formatISK(tb.totalProductFees), { strong: true });
    }

    $('bpc-output-label').textContent = `Output Value (${formatNumber(outQty)} × ${
      state.blueprint ? state.blueprint.product.typeName : ''
    })`;
    $('bpc-output-value').textContent = formatISK(pricing.outputValue.totalValue);
  }

  /* --------------------------------------------------------------- tabs */

  function showTab(tab) {
    state.tab = tab;

    ['results', 'invention'].forEach((name) => {
      const btn = $(`bpc-tab-${name}`);
      const panel = $(`bpc-panel-${name}`);
      const active = name === tab;
      if (btn) {
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
      }
      if (panel) panel.hidden = !active;
    });

    if (tab === 'invention' && !state.inventionLoaded && state.blueprint) {
      // Invention needs a price per material AND per decryptor, fetched
      // sequentially - seconds, not milliseconds. Showing the empty skeleton
      // for that whole time reads as a broken screen, so hide the panel behind
      // the spinner until there is something real to paint.
      $('bpc-panel-invention').hidden = true;
      $('bpc-loading').hidden = false;
      loadInvention();
    }
  }

  async function configureInventionTab() {
    const btn = $('bpc-tab-invention');
    if (!btn) return;

    const data = await loadSafely('invention data', () =>
      window.electronAPI.calculator.getInventionData(state.blueprint.typeID)
    );

    const canInvent = !!(data && data.products && data.products.length > 0);
    btn.hidden = !canInvent;

    // Falling back to Results when invention disappears prevents landing on an
    // empty panel after switching to a T1-only blueprint.
    if (!canInvent && state.tab === 'invention') state.tab = 'results';
  }

  /* ------------------------------------------------------------- invention */

  async function loadInvention() {
    if (state.inventionLoaded || !state.blueprint) return;

    const runs = parseInt($('bpc-runs').value, 10) || 1;
    try {
      await displayInvention(state.blueprint.typeID, runs);
      state.inventionLoaded = true;
    } catch (error) {
      console.error('[blueprint-calculator] invention load failed:', error);
      toast('Failed to load invention data.', 'error');
    } finally {
      // `finally`, not the try body: a failure must still clear the spinner,
      // otherwise the tab spins forever with nothing behind it.
      $('bpc-loading').hidden = true;
      if (state.tab === 'invention') $('bpc-panel-invention').hidden = false;
    }
  }

  /**
   * Gather invention inputs and render the tab.
   *
   * The data-gathering below is carried over from the legacy renderer
   * unchanged - same IPC, same arguments, same fallbacks. Only the rendering
   * that follows it is new.
   */
  async function displayInvention(blueprintTypeId, runs) {
    const inventionData = await window.electronAPI.calculator.getInventionData(blueprintTypeId);
    if (!inventionData || !inventionData.products || inventionData.products.length === 0) return;
    if (!inventionData.materials || inventionData.materials.length === 0) return;

    const selectedProduct = inventionData.products[0];

    const regionId =
      (state.marketSet &&
        state.marketSet.inputMaterials &&
        state.marketSet.inputMaterials.regionId) ||
      10000002;
    const locationId =
      (state.marketSet &&
        state.marketSet.inputMaterials &&
        state.marketSet.inputMaterials.locationId) ||
      null;
    const inputPriceType =
      (state.marketSet &&
        state.marketSet.inputMaterials &&
        state.marketSet.inputMaterials.priceType) ||
      'sell';
    const marketSetId = state.marketSet ? state.marketSet.id : undefined;

    const priceOf = async (typeId, priceType, scope) => {
      const data = await window.electronAPI.market.calculatePrice(
        typeId,
        regionId,
        locationId,
        priceType,
        1,
        marketSetId,
        scope
      );
      return data.price || data.unitPrice || 0;
    };

    /* ---- material + decryptor prices ---- */
    const materialPrices = {};
    // Priced in parallel: these are independent lookups and each writes its own
    // key, so awaiting them one at a time only added latency. The legacy page
    // did them serially, which is most of why this tab took seconds to fill in.
    await Promise.all(
      inventionData.materials.map(async (material) => {
        const typeId = material.typeID || material.typeId;
        if (!typeId) return;
        materialPrices[typeId] =
          (await loadSafely(`price ${typeId}`, () => priceOf(typeId, inputPriceType, 'input'))) || 0;
      })
    );

    const allDecryptors =
      (await loadSafely('decryptors', () =>
        window.electronAPI.calculator.getAllDecryptors()
      )) || [];
    await Promise.all(
      allDecryptors.map(async (decryptor) => {
        materialPrices[decryptor.typeID] =
          (await loadSafely(`price decryptor ${decryptor.typeID}`, () =>
            priceOf(decryptor.typeID, inputPriceType, 'input')
          )) || 0;
      })
    );

    /* ---- prices for the invented blueprint's own manufacturing inputs ---- */
    const inventedBlueprintTypeId = selectedProduct.typeID || selectedProduct.typeId;
    if (inventedBlueprintTypeId) {
      const materialCalc = await loadSafely('invented material list', () =>
        window.electronAPI.calculator.calculateMaterials(
          inventedBlueprintTypeId,
          1,
          2, // baseline ME for the expansion
          state.defaultCharacter ? state.defaultCharacter.characterId : null,
          state.facilityId,
          marketSetId
        )
      );
      if (materialCalc && materialCalc.materials) {
        // Filter BEFORE fetching, then fetch in parallel. The skip-check reads
        // prices resolved by the two awaited blocks above, so this is
        // equivalent to the serial version - and this is the largest loop, a
        // full expansion of the invented blueprint's materials.
        const missing = Object.keys(materialCalc.materials)
          .map((key) => parseInt(key, 10))
          .filter((typeId) => !materialPrices[typeId]);

        await Promise.all(
          missing.map(async (typeId) => {
            materialPrices[typeId] =
              (await loadSafely(`price ${typeId}`, () =>
                priceOf(typeId, inputPriceType, 'input')
              )) || 0;
          })
        );
      }
    }

    /* ---- product price ---- */
    let productPrice = 0;
    const manufacturedTypeId =
      (selectedProduct.manufacturedProduct &&
        (selectedProduct.manufacturedProduct.typeID ||
          selectedProduct.manufacturedProduct.typeId)) ||
      null;
    if (manufacturedTypeId) {
      const outputPriceType =
        (state.marketSet &&
          state.marketSet.outputProducts &&
          state.marketSet.outputProducts.priceType) ||
        'sell';
      productPrice =
        (await loadSafely('product price', () =>
          priceOf(manufacturedTypeId, outputPriceType, 'output')
        )) || 0;
    }

    /* ---- skills ---- */
    const skills = { encryption: 0, datacore1: 0, datacore2: 0 };
    if (state.defaultCharacter && state.defaultCharacter.characterId) {
      const cid = state.defaultCharacter.characterId;
      skills.encryption =
        (await loadSafely('encryption skill', () =>
          window.electronAPI.skills.getEffectiveLevel(cid, 21790)
        )) || 0;

      if (inventionData.skills && inventionData.skills.length >= 2) {
        const s1 = inventionData.skills[0];
        const s2 = inventionData.skills[1];
        skills.datacore1 =
          (await loadSafely('datacore skill 1', () =>
            window.electronAPI.skills.getEffectiveLevel(cid, s1.skillID || s1.skillId)
          )) || 0;
        skills.datacore2 =
          (await loadSafely('datacore skill 2', () =>
            window.electronAPI.skills.getEffectiveLevel(cid, s2.skillID || s2.skillId)
          )) || 0;
        skills.datacore1Name = s1.skillName;
        skills.datacore2Name = s2.skillName;
      }
    }

    const selectedInventionData = {
      materials: inventionData.materials,
      product: selectedProduct,
      baseProbability: selectedProduct.baseProbability,
      skills: inventionData.skills,
      time: inventionData.time,
    };

    const result = await window.electronAPI.calculator.findBestDecryptor(
      selectedInventionData,
      materialPrices,
      productPrice,
      skills,
      null,
      state.inventionStrategy,
      marketSetId
    );

    if (!result || !result.best) {
      console.error('[blueprint-calculator] invalid decryptor result:', result);
      return;
    }

    state.invention = {
      data: inventionData,
      selectedProduct,
      skills,
      materialPrices,
      productPrice,
      result,
    };

    renderInvention();
  }

  function renderInvention() {
    const inv = state.invention;
    if (!inv) return;

    const { selectedProduct, skills, result } = inv;
    const options = result.allOptions || [];
    const best = result.best;

    // -1 means "follow the optimum"; an explicit pick pins a row.
    const display =
      state.inventionDecryptorIndex >= 0 && options[state.inventionDecryptorIndex]
        ? options[state.inventionDecryptorIndex]
        : best;

    renderSafely('invention banner', () => {
      $('bpc-inv-from-name').textContent = state.blueprint.typeName;
      $('bpc-inv-target-name').textContent =
        (selectedProduct.manufacturedProduct &&
          selectedProduct.manufacturedProduct.typeName) ||
        selectedProduct.typeName;
      $('bpc-inv-bp-name').textContent = selectedProduct.typeName;

      const iconHost = $('bpc-inv-icon');
      iconHost.textContent = '';
      // Prefer the manufactured item (an ordinary type). Falling back to the
      // invented BLUEPRINT means the variant has to change with it.
      const manufactured =
        selectedProduct.manufacturedProduct &&
        (selectedProduct.manufacturedProduct.typeID ||
          selectedProduct.manufacturedProduct.typeId);
      iconHost.appendChild(
        manufactured
          ? typeIcon(manufactured, '')
          : blueprintIcon(selectedProduct.typeID, '')
      );
    });

    const rowInto = (host, label, value, valueClass) => {
      const row = el('div', 'bpc-kv');
      row.appendChild(el('span', 'bpc-kv-label', label));
      row.appendChild(el('span', `bpc-mono ${valueClass || ''}`.trim(), value));
      host.appendChild(row);
    };

    renderSafely('invention target', () => {
      const host = $('bpc-inv-target-rows');
      host.textContent = '';
      rowInto(host, 'Invented Blueprint', selectedProduct.typeName);
      rowInto(
        host,
        'Manufactures',
        (selectedProduct.manufacturedProduct &&
          selectedProduct.manufacturedProduct.typeName) ||
          'Unknown'
      );
      rowInto(
        host,
        'Base Probability',
        `${(selectedProduct.baseProbability * 100).toFixed(2)}%`
      );
    });

    renderSafely('invention skills', () => {
      const host = $('bpc-inv-skill-rows');
      host.textContent = '';
      rowInto(host, 'Encryption Methods', `Level ${skills.encryption || 0}`);
      if (skills.datacore1Name) {
        rowInto(host, skills.datacore1Name, `Level ${skills.datacore1 || 0}`);
      }
      if (skills.datacore2Name) {
        rowInto(host, skills.datacore2Name, `Level ${skills.datacore2 || 0}`);
      }
    });

    renderSafely('invention datacores', () => {
      const host = $('bpc-inv-datacores');
      host.textContent = '';
      let total = 0;
      (inv.data.materials || []).forEach((mat) => {
        const typeId = mat.typeID || mat.typeId;
        const unit = inv.materialPrices[typeId] || 0;
        const lineTotal = unit * mat.quantity;
        total += lineTotal;

        const row = el('div', 'bpc-price-row');
        row.appendChild(typeIcon(typeId));
        const text = el('div', 'bpc-price-text');
        text.appendChild(el('div', 'bpc-price-name', mat.typeName));
        text.appendChild(
          el('div', 'bpc-price-detail', `×${formatNumber(mat.quantity)} · ${formatISK(unit)}`)
        );
        row.appendChild(text);
        row.appendChild(el('span', 'bpc-price-total', formatISK(lineTotal)));
        host.appendChild(row);
      });
      $('bpc-inv-datacore-total').textContent = formatISK(total);
    });

    renderSafely('invention decryptor select', () => {
      // Kept in sync with the table: both pin the same index, so selecting in
      // either place moves the other.
      //
      // Field names come from calculateOptionMetrics in blueprint-calculator.js:
      // an option carries `name` and `typeID` directly - there is no nested
      // `decryptor` object. Reading one made every row read "No Decryptor".
      const select = $('bpc-inv-decryptor');
      select.textContent = '';

      const auto = el('option', null, `Optimal Decryptor (${best.name || 'None'})`);
      auto.value = '';
      select.appendChild(auto);

      options.forEach((opt, index) => {
        const node = el('option', null, opt.name || 'No Decryptor');
        node.value = String(index);
        select.appendChild(node);
      });

      select.value =
        state.inventionDecryptorIndex >= 0 ? String(state.inventionDecryptorIndex) : '';
    });

    renderSafely('invention optimal', () => {
      const host = $('bpc-inv-optimal-rows');
      host.textContent = '';
      rowInto(host, 'Decryptor', best.name || 'None', 'bpc-accent');
      rowInto(host, 'Success Chance', `${(best.probability * 100).toFixed(2)}%`);
      rowInto(host, 'Runs per Copy', formatNumber(best.runsPerBPC));
      rowInto(host, 'Output ME', String(best.finalME));
      rowInto(host, 'Output TE', String(best.finalTE));
    });

    renderSafely('invention output', () => {
      const host = $('bpc-inv-output-rows');
      host.textContent = '';
      rowInto(host, 'Runs per Copy', formatNumber(display.runsPerBPC));
      rowInto(host, 'Material Efficiency', String(display.finalME));
      rowInto(host, 'Time Efficiency', String(display.finalTE));
      if (inv.data.time) rowInto(host, 'Invention Time', formatTime(inv.data.time));
    });

    renderSafely('invention costs', () => {
      const host = $('bpc-inv-cost-rows');
      host.textContent = '';
      // Expected attempts per success is 1/p. The backend does not return it -
      // it returns costPerSuccess, which already has it folded in - so derive
      // it here rather than inventing a field that does not exist.
      const attempts = display.probability > 0 ? 1 / display.probability : null;
      rowInto(host, 'Attempts / Success', attempts ? attempts.toFixed(2) : '—');
      rowInto(host, 'Cost per Attempt', formatISK(display.totalCostPerAttempt));
      rowInto(host, 'Cost per Success', formatISK(display.costPerSuccess));
      rowInto(host, 'Materials', formatISK(display.materialCost));
      if (display.decryptorCost) rowInto(host, 'Decryptor', formatISK(display.decryptorCost));
      rowInto(host, 'Job Cost', formatISK(display.jobCost));
      rowInto(host, 'Invention Cost / Run', formatISK(display.costPerRun), 'bpc-accent');
    });

    renderSafely('invention economics', () => {
      const host = $('bpc-inv-econ-rows');
      host.textContent = '';
      if (display.manufacturingCostPerItem !== undefined) {
        rowInto(host, 'Manufacturing / Item', formatISK(display.manufacturingCostPerItem));
      }
      if (display.totalCostPerItem !== undefined) {
        rowInto(host, 'Total Cost / Item', formatISK(display.totalCostPerItem));
      }
      if (inv.productPrice) rowInto(host, 'Product Price', formatISK(inv.productPrice));
      if (display.profitPerItem !== undefined) {
        rowInto(
          host,
          'Profit / Item',
          formatISK(display.profitPerItem),
          display.profitPerItem >= 0 ? 'bpc-accent' : ''
        );
      }
    });

    renderSafely('invention decryptor table', () => {
      const host = $('bpc-decryptor-rows');
      host.textContent = '';

      options.forEach((opt, index) => {
        const row = el('div', 'bpc-dec-row');
        // typeID is null for the no-decryptor option, so compare on the option
        // name too - two nulls must not read as "the same decryptor".
        const isBest =
          best && String(opt.typeID) === String(best.typeID) && opt.name === best.name;
        const isSelected = index === state.inventionDecryptorIndex;
        // Both flags drive classes only; the CSS toggles box-shadow, never a
        // background (binding rule 1).
        row.classList.toggle('is-best', !!isBest);
        row.classList.toggle('is-selected', isSelected);

        const name = el('span', 'bpc-dec-name');
        if (isBest) name.appendChild(el('span', 'bpc-dec-best-badge', 'BEST'));
        name.appendChild(document.createTextNode(opt.name || 'No Decryptor'));
        row.appendChild(name);

        row.appendChild(el('span', 'bpc-dec-cell', `${(opt.probability * 100).toFixed(1)}%`));
        row.appendChild(el('span', 'bpc-dec-cell', formatNumber(opt.runsPerBPC)));
        row.appendChild(el('span', 'bpc-dec-cell', String(opt.finalME)));
        row.appendChild(el('span', 'bpc-dec-cell', String(opt.finalTE)));
        row.appendChild(el('span', 'bpc-dec-cost', formatISK(opt.costPerRun)));

        row.addEventListener('click', () => {
          // Clicking the pinned row unpins it and returns to the optimum.
          state.inventionDecryptorIndex = isSelected ? -1 : index;
          renderInvention();
        });

        host.appendChild(row);
      });
    });

    renderSafely('invention savings', () => {
      const wrap = $('bpc-inv-savings');
      const host = $('bpc-inv-savings-rows');
      host.textContent = '';

      // `noDecryptor` is a REDUCED projection, not a full option: it carries
      // only probability, costPerSuccess, totalCost, totalCostPerItem and
      // manufacturingCostPerItem. Comparing on costPerRun or runs would read
      // undefined on that side and silently show nothing.
      const noDec = result.noDecryptor;
      if (!noDec || !best || !best.typeID) {
        wrap.hidden = true;
        return;
      }

      const rows = [];
      if (noDec.totalCostPerItem !== undefined && best.totalCostPerItem !== undefined) {
        const saving = noDec.totalCostPerItem - best.totalCostPerItem;
        if (saving > 0) rows.push(['Saving / Item', formatISK(saving)]);
      }
      if (noDec.probability !== undefined && best.probability > noDec.probability) {
        const delta = (best.probability - noDec.probability) * 100;
        rows.push(['Extra Success Chance', `+${delta.toFixed(2)}%`]);
      }

      if (rows.length === 0) {
        wrap.hidden = true;
        return;
      }
      rows.forEach(([label, value]) => rowInto(host, label, value));
      wrap.hidden = false;
    });
  }

  /* ---------------------------------------------------------- add to plan */

  async function openPlanModal() {
    if (!state.blueprint) {
      toast('No blueprint selected.', 'warning');
      return;
    }

    const characterId =
      state.defaultCharacter && state.defaultCharacter.characterId
        ? state.defaultCharacter.characterId
        : null;
    if (!characterId) {
      toast('Select a default character first.', 'warning');
      return;
    }

    const plans =
      (await loadSafely('plans', () => window.electronAPI.plans.getAll(characterId, {}))) || [];

    const me = parseInt($('bpc-me').value, 10) || 0;
    const runs = parseInt($('bpc-runs').value, 10) || 1;
    const facility = state.facilities.find((f) => String(f.id) === String(state.facilityId));

    $('bpc-modal-bp-name').textContent = state.blueprint.typeName;
    $('bpc-modal-bp-sub').textContent = `${formatNumber(runs)} run${runs > 1 ? 's' : ''} · ME ${me} · ${
      facility ? facility.name : 'No Facility'
    }`;

    const iconHost = $('bpc-modal-bp-icon');
    iconHost.textContent = '';
    iconHost.appendChild(typeIcon(state.blueprint.product.typeID, ''));

    // Rebuilt per open so newly created plans appear without a reload.
    const host = $('bpc-plan-options');
    host.textContent = '';
    let selected = null;

    const makeOption = (value, label, status) => {
      const btn = el('button', 'bpc-plan-option');
      btn.type = 'button';
      btn.setAttribute('data-plan-id', value);
      btn.appendChild(el('span', 'bpc-plan-dot'));

      if (value === 'new') {
        const wrap = el('span', 'bpc-new-plan-label');
        wrap.appendChild(el('span', null, '+ Create New Plan'));
        btn.appendChild(wrap);
      } else {
        btn.appendChild(el('span', 'bpc-plan-name', label));
        const badge = el('span', 'bpc-plan-status', status);
        badge.setAttribute('data-status', status);
        btn.appendChild(badge);
      }

      btn.addEventListener('click', () => {
        selected = value;
        host.querySelectorAll('.bpc-plan-option').forEach((node) => {
          node.classList.toggle('is-selected', node === btn);
        });
        $('bpc-new-plan-section').hidden = value !== 'new';
      });

      host.appendChild(btn);
    };

    plans.forEach((plan) => makeOption(String(plan.planId), plan.planName, plan.status));
    makeOption('new', 'Create New Plan', null);

    $('bpc-new-plan-section').hidden = true;
    $('bpc-new-plan-name').value = '';

    const modal = $('bpc-plan-modal');
    modal.hidden = false;

    // The confirm handler closes over `selected`, so it must be replaced each
    // time the modal opens - otherwise a stale closure adds to the wrong plan.
    const confirm = $('bpc-plan-confirm');
    const onConfirm = async () => {
      if (!selected) {
        toast('Select a plan or create a new one.', 'warning');
        return;
      }
      try {
        let planId = selected;
        if (selected === 'new') {
          const name = $('bpc-new-plan-name').value.trim() || null;
          const created = await window.electronAPI.plans.create(characterId, name, null);
          planId = created.planId;
        }
        closePlanModal();
        await addBlueprintToPlan(planId);
      } catch (error) {
        console.error('[blueprint-calculator] add to plan failed:', error);
        toast(`Failed to add to plan: ${error.message}`, 'error');
      }
    };

    confirm.replaceWith(confirm.cloneNode(true));
    $('bpc-plan-confirm').addEventListener('click', onConfirm);
  }

  function closePlanModal() {
    const modal = $('bpc-plan-modal');
    if (modal) modal.hidden = true;
  }

  async function addBlueprintToPlan(planId) {
    const me = parseInt($('bpc-me').value, 10) || 0;
    const runs = parseInt($('bpc-runs').value, 10) || 1;

    let facilitySnapshot = null;
    if (state.facilityId) {
      const facility = state.facilities.find((f) => String(f.id) === String(state.facilityId));
      if (facility) {
        facilitySnapshot = {
          name: facility.name,
          systemId: facility.systemId,
          structureTypeId: facility.structureTypeId,
          rigs: facility.rigs || [],
        };
      }
    }

    await window.electronAPI.plans.addBlueprint(planId, {
      blueprintTypeId: state.blueprint.typeID,
      runs,
      // The handler destructures `lines`; `productionLines` was never read,
      // so this relied on the default happening to be 1.
      lines: 1,
      meLevel: me,
      // This screen has no TE input - it never has - so 0 is honest rather
      // than a dropped value.
      teLevel: 0,
      facilityId: state.facilityId,
      facilitySnapshot,
    });

    toast('Blueprint added to plan.', 'success');
  }

  /* ------------------------------------------------------------- mounting */

  async function mount(container, params, ctx) {
    const fragment = await loadTemplate();
    if (!fragment) {
      container.appendChild(el('div', 'empty-state', 'Failed to load the Blueprint Calculator.'));
      return {};
    }
    container.appendChild(fragment);

    searchSelects = [];

    state.defaultCharacter = await loadSafely('default character', () =>
      window.electronAPI.esi.getDefaultCharacter()
    );

    await initMarketSet(ctx);
    await initFacilities(ctx);
    initSearch(ctx);

    /* ---- inputs ---- */
    ctx.on($('bpc-me'), 'change', () => {
      if (state.blueprint) calculate();
    });
    ctx.on($('bpc-runs'), 'change', () => {
      updateProductTotal();
      if (state.blueprint) calculate();
    });

    /* ---- tabs ---- */
    ['results', 'invention'].forEach((name) => {
      ctx.on($(`bpc-tab-${name}`), 'click', () => showTab(name));
    });

    /* ---- invention selects (fixed options - plain selects per rule 5) ---- */
    const strategySelect = $('bpc-inv-strategy');
    [
      ['invention-only', 'Invention Cost Only'],
      ['total-per-item', 'Total Cost per Item'],
      ['total-full-bpc', 'Total Cost for Full BPC'],
      ['time-optimized', 'Fastest Manufacturing Time'],
    ].forEach(([value, label]) => {
      const opt = el('option', null, label);
      opt.value = value;
      strategySelect.appendChild(opt);
    });
    strategySelect.value = state.inventionStrategy;
    ctx.on(strategySelect, 'change', async () => {
      state.inventionStrategy = strategySelect.value;
      state.inventionLoaded = false;
      state.inventionDecryptorIndex = -1;
      await loadInvention();
    });

    ctx.on($('bpc-inv-decryptor'), 'change', () => {
      const value = $('bpc-inv-decryptor').value;
      state.inventionDecryptorIndex = value === '' ? -1 : parseInt(value, 10);
      renderInvention();
    });

    /* ---- add to plan ---- */
    ctx.on($('bpc-add-to-plan'), 'click', openPlanModal);
    ctx.on($('bpc-plan-cancel'), 'click', closePlanModal);
    ctx.on($('bpc-plan-modal-close'), 'click', closePlanModal);
    ctx.on($('bpc-plan-modal'), 'click', (e) => {
      if (e.target === $('bpc-plan-modal')) closePlanModal();
    });
    ctx.on(document, 'keydown', (e) => {
      if (e.key === 'Escape' && !$('bpc-plan-modal').hidden) closePlanModal();
    });

    /* ---- live data ---- */
    // Both of these were previously subscribed without keeping their disposer,
    // which would stack a duplicate handler on every remount.
    ctx.track(
      window.electronAPI.esi.onDefaultCharacterChanged(async () => {
        state.defaultCharacter = await loadSafely('default character', () =>
          window.electronAPI.esi.getDefaultCharacter()
        );
      })
    );

    ctx.track(
      window.electronAPI.blueprints.onOpenInCalculator(async (data) => {
        if (!data) return;
        await selectBlueprint(data.blueprintTypeId, data.meLevel);
      })
    );

    // Opened from the Blueprints window: the router passes the blueprint
    // directly, so there is no navigate-then-guess-a-delay race.
    if (params && params.blueprintTypeId) {
      await selectBlueprint(params.blueprintTypeId, params.meLevel);
    }

    return {
      destroy() {
        searchSelects.forEach((sel) => {
          try {
            sel.destroy();
          } catch (error) {
            console.error('[blueprint-calculator] search select destroy failed:', error);
          }
        });
        searchSelects = [];
      },

      /**
       * State to carry into a popped-out window.
       *
       * ME and RUNS live only in the DOM inputs - there is no state field for
       * them - so they must be read from the controls, not from `state`.
       * Missing them was why a popped window recalculated at the blueprint's
       * default ME and one run.
       */
      getHandoff() {
        if (!state.blueprint) return null;
        return {
          blueprintTypeId: state.blueprint.typeID || state.blueprint.typeId,
          meLevel: parseInt($('bpc-me').value, 10) || 0,
          runs: parseInt($('bpc-runs').value, 10) || 1,
          facilityId: state.facilityId,
          tab: state.tab,
          inventionLoaded: state.inventionLoaded,
          invention: state.invention,
          inventionStrategy: state.inventionStrategy,
          inventionDecryptorIndex: state.inventionDecryptorIndex,
        };
      },

      /**
       * Adopt a popped-out window's blueprint, inputs and invention results.
       *
       * ORDER IS LOAD-BEARING. `selectBlueprint` deliberately resets the screen
       * for a newly chosen blueprint: it overwrites the ME input with the owned
       * or base ME, sets runs to 1, forces the Results tab, and clears
       * `state.invention`. So everything handed over must be restored AFTER it
       * runs, and the calculation re-driven from the restored inputs - not
       * before, where it would simply be wiped.
       */
      async applyHandoff(payload) {
        if (!payload || !payload.blueprintTypeId) return;

        // Facility first: it is not touched by selectBlueprint, and the
        // recalculation below must use it.
        //
        // The CONTROL is set too, not just the state behind it. The picker is a
        // QFSearchSelect seeded with the DEFAULT facility on mount - it is not
        // persisted - so setting state alone left it displaying the default
        // while the results were calculated for another facility.
        if (payload.facilityId) {
          state.facilityId = payload.facilityId;
          if (facilitySelect) facilitySelect.setValue(String(payload.facilityId));
        }

        await selectBlueprint(payload.blueprintTypeId);

        // Restore the inputs selectBlueprint just reset, then recalculate so
        // the figures on screen match them. Without this the popped window
        // shows results for the default ME and a single run.
        if (typeof payload.meLevel === 'number') $('bpc-me').value = payload.meLevel;
        if (typeof payload.runs === 'number') $('bpc-runs').value = payload.runs;

        updateProductTotal();
        await calculate();

        // Invention is the expensive part - a 9-option decryptor sweep - so it
        // is adopted rather than re-run. Restored after selectBlueprint, which
        // clears it.
        if (payload.invention) {
          state.invention = payload.invention;
          state.inventionLoaded = !!payload.inventionLoaded;
          if (payload.inventionStrategy) state.inventionStrategy = payload.inventionStrategy;
          if (typeof payload.inventionDecryptorIndex === 'number') {
            state.inventionDecryptorIndex = payload.inventionDecryptorIndex;
          }
        }

        if (payload.tab) showTab(payload.tab);

        // showTab does NOT paint adopted data: it only kicks off a fetch when
        // `inventionLoaded` is false, and here it is deliberately true. Without
        // this the tab opens loaded and completely empty.
        //
        // After showTab, so the panel is visible and un-hidden before drawing
        // into it.
        if (payload.invention && state.tab === 'invention') {
          renderInvention();
        }
      },
    };
  }

  if (window.QFShell && window.QFShell.router) {
    window.QFShell.router.register('blueprint-calculator', {
      title: 'Blueprint Calculator',
      mount,
    });
  }
})();
