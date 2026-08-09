/**
 * Reactions Calculator — native shell view.
 *
 * Ported from the framed public/reactions-calculator.html. Presentation
 * follows "Reactions Calculator (1a).dc.html"; every IPC call and result
 * shape is carried over from the legacy renderer unchanged.
 *
 * Shapes worth stating, because reading the wrong field is how these ports
 * break silently:
 *   - searchReactions returns { typeID, typeName, productName,
 *     productQuantity } - capital-ID, and the product is already included.
 *   - calculateMaterials returns { materials, tree, product, time, pricing }.
 *   - tree nodes carry { typeName, quantity, isIntermediate, reactionName,
 *     children }.
 *   - structure bonuses are materialEfficiency / timeEfficiency /
 *     costReduction, NOT materialBonus / timeBonus / costBonus.
 */
(function () {
  'use strict';

  const TEMPLATE_URL = 'reactions.view.html';
  const TOOL_KEY = 'reactionsMarketSetId';

  const state = {
    /** The chosen reaction: { typeID, typeName, productName, productQuantity } */
    reaction: null,
    facilities: [],
    facilityId: '',
    marketSet: null,
    characterId: null,
    /** Last calculation result, kept so a re-render needs no refetch. */
    result: null,
  };

  let templateCache = null;
  let searchSelects = [];

  /* --------------------------------------------------------------- helpers */

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /** A cell that may be ellipsised, carrying its full value as a title. */
  function truncatedCell(cls, text) {
    const node = el('span', cls, text);
    if (text !== undefined && text !== null && String(text) !== '') {
      node.title = String(text);
    }
    return node;
  }

  function toast(message, type) {
    if (window.QFToast) window.QFToast.show(message, type);
    else console.log(`[reactions] ${type}: ${message}`);
  }

  function svgEl(size, children) {
    const ns = 'http://www.w3.org/2000/svg';
    const node = document.createElementNS(ns, 'svg');
    node.setAttribute('width', String(size));
    node.setAttribute('height', String(size));
    node.setAttribute('viewBox', '0 0 24 24');
    node.setAttribute('fill', 'none');
    node.setAttribute('stroke', 'currentColor');
    node.setAttribute('stroke-width', '2');
    node.setAttribute('stroke-linecap', 'round');
    node.setAttribute('stroke-linejoin', 'round');
    node.setAttribute('aria-hidden', 'true');
    children.forEach(([tag, attrs]) => {
      const child = document.createElementNS(ns, tag);
      Object.entries(attrs).forEach(([k, v]) => child.setAttribute(k, String(v)));
      node.appendChild(child);
    });
    return node;
  }

  /**
   * The glyph marking a tree row's role, per the mockup:
   *   product      - an open circle
   *   intermediate - a crosshair circle (it is itself a reaction)
   *   raw          - a small filled square
   */
  function roleGlyph(role) {
    if (role === 'product') {
      return svgEl(15, [['circle', { cx: 12, cy: 12, r: 9 }]]);
    }
    if (role === 'intermediate') {
      return svgEl(13, [
        ['circle', { cx: 12, cy: 12, r: 9 }],
        ['line', { x1: 12, y1: 3, x2: 12, y2: 21 }],
        ['line', { x1: 3, y1: 12, x2: 21, y2: 12 }],
      ]);
    }
    return el('span', 'rx-tree-dot');
  }

  /** The Upwell-structure mark used beside a facility name. */
  function facilityGlyph() {
    return svgEl(14, [['path', { d: 'M3 21V9l7-4v4l7-4v16z' }]]);
  }

  /** EVE type icon. Reaction FORMULAS use the blueprint variant. */
  function typeIcon(typeId, cls, variant) {
    const img = document.createElement('img');
    img.className = cls || 'rx-tree-icon';
    img.src = `https://images.evetech.net/types/${typeId}/${variant || 'icon'}?size=64`;
    img.alt = '';
    img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
    return img;
  }

  function formatNumber(value, decimals = 0) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
    return Number(value).toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }

  function formatISK(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
    return `${formatNumber(value, 2)} ISK`;
  }

  /** Reaction jobs run for hours to days, so days are worth spelling out. */
  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '—';
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

  async function loadSafely(label, fn) {
    try {
      return await fn();
    } catch (error) {
      console.error(`[reactions] load failed: ${label}`, error);
      return null;
    }
  }

  function renderSafely(label, fn) {
    try {
      fn();
    } catch (error) {
      console.error(`[reactions] render failed: ${label}`, error);
    }
  }

  /**
   * Mount a QFSearchSelect, replacing any previous instance in that host.
   *
   * These hosts are rebuilt when their options change, and a bare
   * `new QFSearchSelect(host, ...)` APPENDS - leaving two dropdowns stacked
   * and the old one still holding a document listener and a body popover.
   */
  function mountSelect(host, opts) {
    if (!host || !window.QFSearchSelect) return null;

    searchSelects = searchSelects.filter((entry) => {
      if (entry.host !== host) return true;
      try {
        entry.sel.destroy();
      } catch (error) {
        console.error('[reactions] select destroy failed:', error);
      }
      return false;
    });
    host.textContent = '';

    const sel = new window.QFSearchSelect(host, opts);
    searchSelects.push({ host, sel });
    return sel;
  }

  function destroySelects() {
    searchSelects.forEach(({ sel }) => {
      try {
        sel.destroy();
      } catch (error) {
        console.error('[reactions] select destroy failed:', error);
      }
    });
    searchSelects = [];
  }

  /* ------------------------------------------------------------ data load */

  async function initCharacter() {
    const character = await loadSafely('default character', () =>
      window.electronAPI.esi.getDefaultCharacter()
    );
    state.characterId = character ? character.characterId : null;
  }

  async function initMarketSet() {
    const [sets, result] = await Promise.all([
      loadSafely('market sets', () => window.electronAPI.market.getMarketSets()),
      loadSafely('tool market set', () =>
        window.electronAPI.market.getMarketSetForTool(TOOL_KEY)
      ),
    ]);

    state.marketSet = result ? result.marketSet : null;

    // A plain select: a short list of the user's own market sets.
    const host = $('rx-market-host');
    if (host) host.textContent = '';
    mountPlainSelect(host, {
      // Market set ids are opaque STRINGS - never coerce to Number.
      options: (sets || []).map((s) => ({
        value: String(s.id),
        label: s.name + (s.isDefault ? ' (Default)' : ''),
      })),
      value: state.marketSet ? String(state.marketSet.id) : '',
      placeholder: 'Market set…',
      onChange: async (e) => {
        await loadSafely('set tool market set', async () => {
          await window.electronAPI.market.setMarketSetForTool(TOOL_KEY, e.target.value);
          const next = await window.electronAPI.market.getMarketSetForTool(TOOL_KEY);
          state.marketSet = next.marketSet;
        });
        // Prices changed, so the last result is stale.
        if (state.reaction) await calculate();
      },
    });
  }

  /** A plain native select, for short fixed lists (binding rule 5). */
  function mountPlainSelect(host, opts) {
    if (!host) return null;
    const select = el('select', 'qf-select');

    if (opts.placeholder) {
      const ph = el('option', null, opts.placeholder);
      ph.value = '';
      select.appendChild(ph);
    }
    (opts.options || []).forEach((opt) => {
      const option = el('option', null, opt.label);
      option.value = opt.value;
      select.appendChild(option);
    });

    select.value = opts.value === null || opts.value === undefined ? '' : String(opts.value);
    select.addEventListener('change', () => opts.onChange({ target: { value: select.value } }));

    host.appendChild(select);
    return select;
  }

  async function loadFacilities() {
    const facilities = await loadSafely('facilities', () =>
      window.electronAPI.facilities.getFacilities()
    );
    state.facilities = facilities || [];

    // Reactions run in refineries, but the legacy page offered every
    // facility and let the backend decide - keep that, so a user is never
    // blocked by a mis-tagged structure.
    mountPlainSelect($('rx-facility-host'), {
      options: state.facilities.map((f) => ({
        value: String(f.id),
        label: f.name,
      })),
      value: state.facilityId,
      placeholder: 'No facility (no bonuses)',
      onChange: async (e) => {
        state.facilityId = e.target.value;
        await renderFacilityBonuses();
        // The facility changes ME/TE and job cost, so the result is stale.
        if (state.reaction && state.result) await calculate();
      },
    });
  }

  /* -------------------------------------------------------------- search */

  function initSearch() {
    mountSelect($('rx-search-host'), {
      inline: true,
      onSearch: async (query) => {
        const results = await loadSafely('search reactions', () =>
          window.electronAPI.reactions.searchReactions(query)
        );
        // searchReactions returns typeID (capital ID), typeName, productName
        // and productQuantity - the product is already there, so the row can
        // show what the reaction makes without a second lookup.
        return (results || []).map((r) => ({
          value: String(r.typeID),
          label: r.typeName,
          meta: r,
        }));
      },
      minQueryLength: 2,
      debounceMs: 300,
      placeholder: 'Search for a reaction…',
      searchPrompt: 'Type at least 2 characters to search reactions',
      emptyText: 'No reactions found',
      loadingText: 'Searching reactions…',
      renderRow: (option, els) => {
        // Runs AFTER the row is wired, so it cannot disturb click/hover.
        // A reaction formula is a blueprint-like item, hence the `bp` icon.
        const r = option.meta;
        if (!r || !els.label) return;
        els.row.insertBefore(typeIcon(r.typeID, 'rx-search-icon', 'bp'), els.label);
        els.label.appendChild(el(
          'span',
          'rx-search-produces',
          `Produces ${formatNumber(r.productQuantity)}x ${r.productName}`
        ));
      },
      onChange: (e) => {
        const picked = (e.option && e.option.meta) || null;
        if (picked) selectReaction(picked);
      },
    });
  }

  async function selectReaction(reaction) {
    state.reaction = reaction;
    state.result = null;

    $('rx-empty').hidden = true;
    $('rx-results').hidden = false;
    $('rx-output').hidden = true;

    $('rx-reaction-name').textContent = reaction.typeName;

    const icon = $('rx-reaction-icon');
    icon.src = `https://images.evetech.net/types/${reaction.typeID}/bp?size=64`;
    icon.style.visibility = '';

    // "Produces Fullerene × 200 / run", per the mockup.
    const produces = $('rx-reaction-product');
    produces.textContent = 'Produces ';
    produces.appendChild(el('span', 'rx-meta-strong', reaction.productName));
    produces.appendChild(document.createTextNode(' × '));
    produces.appendChild(el('span', 'rx-meta-mono', formatNumber(reaction.productQuantity)));
    produces.appendChild(document.createTextNode(' / run'));

    // Cycle time is only known once the calculation returns.
    $('rx-reaction-cycle').textContent = '';

    await calculate();
  }

  /* ----------------------------------------------------------- calculate */

  async function calculate() {
    if (!state.reaction) return;

    const runs = parseInt($('rx-runs').value, 10);
    if (!Number.isFinite(runs) || runs < 1) {
      toast('Runs must be at least 1.', 'warning');
      return;
    }

    $('rx-loading').hidden = false;
    $('rx-output').hidden = true;

    const result = await loadSafely('calculate reaction', () =>
      window.electronAPI.reactions.calculateMaterials(
        state.reaction.typeID,
        runs,
        state.characterId,
        state.facilityId || null,
        state.marketSet ? state.marketSet.id : undefined
      )
    );

    $('rx-loading').hidden = true;

    if (!result) {
      toast('Failed to calculate reaction.', 'error');
      return;
    }
    if (result.error) {
      // The calculator reports domain failures in-band rather than throwing.
      toast(result.error, 'error');
      return;
    }

    state.result = result;
    renderResult(result);
  }

  /**
   * Paint a calculation result.
   *
   * Extracted from calculate() so a popped-out window can adopt a result it was
   * handed and render it without recalculating.
   */
  function renderResult(result) {
    if (!result) return;
    $('rx-output').hidden = false;

    renderSafely('time', () => renderTime(result.time));
    renderSafely('tree', () => renderTree(result.tree, result.product));
    renderSafely('materials', () => renderMaterials(result.materials, result.pricing));
    renderSafely('pricing', () => renderPricing(result.pricing));
  }

  /* -------------------------------------------------------------- render */

  function renderTime(time) {
    const host = $('rx-time');
    host.textContent = '';
    if (!time) return;

    const row = (label, value, cls) => {
      const line = el('div', `rx-time-row${cls ? ` ${cls}` : ''}`);
      line.appendChild(el('span', 'rx-time-label', label));
      line.appendChild(el('span', 'rx-time-value mono', value));
      host.appendChild(line);
    };

    row('Base Time', formatTime(time.baseTime));
    row('Total Time (with bonuses)', formatTime(time.totalTime), 'is-total');

    // The cycle time belongs on the reaction header, where the mockup has it.
    $('rx-reaction-cycle').textContent = '';
    const cycle = $('rx-reaction-cycle');
    cycle.appendChild(document.createTextNode('Cycle Time '));
    cycle.appendChild(el('span', 'rx-meta-mono', formatTime(time.baseTime)));
  }

  function renderTree(tree, product) {
    const host = $('rx-tree');
    host.textContent = '';

    if (!Array.isArray(tree) || tree.length === 0) {
      host.appendChild(el('div', 'rx-pending', 'This reaction has no expanded inputs.'));
      return;
    }

    // The product sits at the root so the chain reads top-down.
    if (product) {
      const root = el('div', 'rx-tree-row rx-tree-root');
      const rootGlyph = el('span', 'rx-tree-glyph is-product');
      rootGlyph.appendChild(roleGlyph('product'));
      root.appendChild(rootGlyph);
      root.appendChild(typeIcon(product.typeID, 'rx-tree-icon'));

      const text = el('div', 'rx-tree-text');
      const nameRow = el('div', 'rx-tree-name-row');
      nameRow.appendChild(truncatedCell('rx-tree-name', product.typeName));
      nameRow.appendChild(el('span', 'rx-tree-badge is-product', 'PRODUCT'));
      text.appendChild(nameRow);
      // Captioned with the formula that makes it, as the mockup does.
      if (state.reaction) {
        text.appendChild(truncatedCell('rx-tree-formula', state.reaction.typeName));
      }
      root.appendChild(text);

      root.appendChild(el('span', 'rx-tree-qty', `× ${formatNumber(product.quantity)}`));
      host.appendChild(root);
    }

    const walk = (nodes, depth) => {
      nodes.forEach((node) => {
        const row = el('div', 'rx-tree-row');
        row.setAttribute('data-rx-node', String(node.typeID));
        row.style.setProperty('--rx-depth', String(depth));

        // An intermediate is itself produced by a reaction, so it reads as
        // INTERMEDIATE (green), not "Reaction" - the chain continues below.
        const role = node.isIntermediate ? 'intermediate' : 'raw';

        const glyph = el('span', `rx-tree-glyph is-${role}`);
        glyph.appendChild(roleGlyph(role));
        row.appendChild(glyph);
        row.appendChild(typeIcon(node.typeID, 'rx-tree-icon'));

        const text = el('div', 'rx-tree-text');
        const nameRow = el('div', 'rx-tree-name-row');
        nameRow.appendChild(truncatedCell('rx-tree-name', node.typeName));
        nameRow.appendChild(el(
          'span',
          `rx-tree-badge is-${role}`,
          role === 'intermediate' ? 'INTERMEDIATE' : 'RAW'
        ));
        text.appendChild(nameRow);

        // An intermediate is made by another reaction; naming it explains
        // why the chain continues below this row.
        if (node.isIntermediate && node.reactionName) {
          text.appendChild(truncatedCell('rx-tree-formula', node.reactionName));
        }
        row.appendChild(text);

        row.appendChild(el('span', 'rx-tree-qty', `× ${formatNumber(node.quantity)}`));
        host.appendChild(row);

        if (node.children && node.children.length > 0) walk(node.children, depth + 1);
      });
    };

    walk(tree, 1);
  }

  async function renderMaterials(materials, pricing) {
    const host = $('rx-materials');
    host.textContent = '';

    // `materials` is an OBJECT keyed by typeID, not an array.
    const entries = Object.entries(materials || {});
    $('rx-materials-count').textContent = entries.length;

    if (entries.length === 0) {
      host.appendChild(el('div', 'rx-pending', 'No raw materials.'));
      return;
    }

    // Names are not in the materials map, so resolve them alongside.
    const names = await Promise.all(entries.map(([typeId]) =>
      loadSafely('type name', () => window.electronAPI.reactions.getTypeName(Number(typeId)))
    ));

    // Nested TWO levels deep, and each entry is an object - not a bare price.
    const materialPrices = (pricing && pricing.inputCosts && pricing.inputCosts.materialPrices)
      || {};

    let total = 0;
    let anyPriced = false;

    entries.forEach(([typeId, quantity], i) => {
      const row = el('div', 'rx-material-row');
      row.setAttribute('data-rx-material', String(typeId));

      row.appendChild(typeIcon(typeId, 'rx-material-icon'));

      const text = el('div', 'rx-material-text');
      text.appendChild(truncatedCell('rx-material-name', names[i] || `Type ${typeId}`));

      // hasPrice distinguishes "free" from "could not be priced" - showing
      // 0.00 ISK for an unpriced material would understate the total.
      const priced = materialPrices[typeId];
      const hasPrice = !!(priced && priced.hasPrice);

      text.appendChild(el(
        'div',
        'rx-material-detail',
        hasPrice
          ? `${formatNumber(quantity)} × ${formatISK(priced.unitPrice)}`
          : formatNumber(quantity)
      ));
      row.appendChild(text);

      const cell = el(
        'span',
        'rx-material-total',
        hasPrice ? formatISK(priced.totalPrice) : '—'
      );
      cell.title = hasPrice
        ? `${formatISK(priced.unitPrice)} each`
        : 'No market price available';
      row.appendChild(cell);

      if (hasPrice) {
        total += priced.totalPrice;
        anyPriced = true;
      }

      host.appendChild(row);
    });

    // Only claim a total when something was actually priced.
    const totalRow = $('rx-materials-total');
    totalRow.hidden = !anyPriced;
    if (anyPriced) $('rx-materials-total-value').textContent = formatISK(total);
  }

  function renderPricing(pricing) {
    const card = $('rx-pricing-card');
    if (!pricing) {
      // No market set, or nothing priceable - hiding the card is honest;
      // showing zeroes would read as "this reaction is worthless".
      card.hidden = true;
      return;
    }
    card.hidden = false;

    const cards = $('rx-pricing-cards');
    cards.textContent = '';

    const profit = Number(pricing.profit);
    const margin = Number(pricing.profitMargin);

    const priceCard = (label, value, sub, tone) => {
      const box = el('div', 'rx-price-card');
      // Stable hook: the cards are otherwise only identifiable by position.
      box.setAttribute('data-rx-price', label.toLowerCase().replace(/[^a-z]+/g, '-'));
      box.appendChild(el('span', 'rx-price-label', label));
      box.appendChild(el('span', `rx-price-value${tone ? ` ${tone}` : ''}`, value));
      if (sub) box.appendChild(el('span', `rx-price-sub${tone ? ` ${tone}` : ''}`, sub));
      cards.appendChild(box);
    };

    // outputValue is an OBJECT, not a number - reading it directly rendered
    // a dash. Main computes it as price-each x product quantity x runs,
    // priced through the selected market set.
    const output = pricing.outputValue || {};

    // Show the working: "12,000 × 250.00 ISK sell". hasPrice distinguishes a
    // genuinely free product from one the market could not price, so an
    // unpriced product says so rather than claiming 0.00 each.
    const outputSub = output.hasPrice
      ? `${formatNumber(output.quantity)} × ${formatISK(output.unitPrice)}`
        + `${output.priceType ? ` ${output.priceType}` : ''}`
      : (output.quantity ? `${formatNumber(output.quantity)} — no market price` : null);

    priceCard('Total Reaction Cost', formatISK(pricing.totalCost));
    priceCard('Output Value', formatISK(output.totalValue), outputSub);
    priceCard(
      'Profit',
      formatISK(pricing.profit),
      Number.isFinite(margin) ? `${margin.toFixed(2)}% margin` : null,
      Number.isFinite(profit) ? (profit >= 0 ? 'is-positive' : 'is-negative') : null
    );

    renderJobCost(pricing);
  }

  function renderJobCost(pricing) {
    const host = $('rx-jobcost-rows');
    host.textContent = '';

    const jcb = pricing.jobCostBreakdown;
    if (!jcb) {
      $('rx-jobcost').hidden = true;
      return;
    }
    $('rx-jobcost').hidden = false;

    // Percentages come from the breakdown itself rather than being assumed:
    // the system index varies per system and the tax per structure owner.
    const pct = (v) => (Number.isFinite(Number(v)) ? `${Number(v).toFixed(2)}%` : '—');

    const rows = [
      ['Estimated Item Value (EIV)', formatISK(jcb.estimatedItemValue), 'row'],
      [`System Cost Index (${pct(jcb.systemCostIndex)})`, formatISK(jcb.jobGrossCost), 'row'],
      ['Job Base Cost', formatISK(jcb.jobBaseCost), 'sub'],
      [`Facility Tax (${pct(jcb.facilityTaxRate)})`, formatISK(jcb.facilityTax), 'row'],
      ['SCC Surcharge', formatISK(jcb.sccSurcharge), 'row'],
      ['Total Job Cost', formatISK(jcb.totalJobCost), 'sub'],
      ['Total Reaction Cost', formatISK(pricing.totalCost), 'total'],
    ];

    rows.forEach(([label, value, kind]) => {
      const row = el('div', `rx-jobcost-row is-${kind}`);
      row.appendChild(el('span', 'rx-jobcost-label', label));
      row.appendChild(el('span', 'rx-jobcost-value mono', value));
      host.appendChild(row);
    });
  }

  async function renderFacilityBonuses() {
    const panel = $('rx-bonuses');
    const host = $('rx-bonus-list');
    host.textContent = '';

    if (!state.facilityId) {
      panel.hidden = true;
      return;
    }

    const facility = state.facilities.find(
      (f) => String(f.id) === String(state.facilityId)
    );
    if (!facility || !facility.structureTypeId) {
      // An NPC station has no structure bonuses at all.
      panel.hidden = true;
      return;
    }

    const bonuses = await loadSafely('structure bonuses', () =>
      window.electronAPI.facilities.getStructureBonuses(facility.structureTypeId)
    );
    if (!bonuses) {
      panel.hidden = true;
      return;
    }

    const facilityLabel = $('rx-bonuses-facility');
    facilityLabel.textContent = '';
    facilityLabel.appendChild(facilityGlyph());
    facilityLabel.appendChild(
      document.createTextNode(bonuses.structureName || facility.name)
    );

    // materialEfficiency / timeEfficiency / costReduction - NOT
    // materialBonus / timeBonus / costBonus.
    [
      ['Material', bonuses.materialEfficiency],
      ['Time', bonuses.timeEfficiency],
      ['Cost', bonuses.costReduction],
    ].forEach(([label, raw]) => {
      const value = Number(raw) || 0;
      const box = el('span', `rx-bonus${value ? '' : ' is-zero'}`);
      box.appendChild(el('span', 'rx-bonus-dot'));
      box.appendChild(document.createTextNode(`${label} `));
      box.appendChild(el('span', 'rx-bonus-value', value ? `-${value.toFixed(1)}%` : '0%'));
      host.appendChild(box);
    });

    panel.hidden = false;
  }

  /* ------------------------------------------------------------------ mount */

  async function loadTemplate() {
    const inline = $('reactions-view-template');
    if (inline) return inline.content.cloneNode(true);

    if (!templateCache) {
      try {
        const html = await fetch(TEMPLATE_URL).then((r) => r.text());
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        const tpl = parsed.getElementById('reactions-view-template');
        if (!tpl) {
          console.error('[reactions] template not found');
          return null;
        }
        templateCache = tpl;
      } catch (error) {
        console.error('[reactions] template load failed:', error);
        return null;
      }
    }
    return templateCache.content.cloneNode(true);
  }

  async function mount(container, params, ctx) {
    const fragment = await loadTemplate();
    if (!fragment) {
      container.appendChild(el('div', 'empty-state', 'Failed to load Reactions.'));
      return {};
    }
    container.appendChild(fragment);

    ctx.on($('rx-calculate'), 'click', () => calculate());
    ctx.on($('rx-runs'), 'keydown', (e) => {
      // Enter in the runs field should calculate, not submit anything.
      if (e.key === 'Enter') {
        e.preventDefault();
        calculate();
      }
    });

    await initCharacter();
    await initMarketSet();
    await loadFacilities();
    initSearch();

    // Opened with a reaction already chosen (e.g. from a plan).
    if (params && params.reactionTypeId) {
      const results = await loadSafely('search reactions', () =>
        window.electronAPI.reactions.searchReactions('')
      );
      const match = (results || []).find(
        (r) => String(r.typeID) === String(params.reactionTypeId)
      );
      if (match) await selectReaction(match);
    }

    return {
      destroy: destroySelects,

      /**
       * State to carry into a popped-out window.
       *
       * `state.result` is already kept so a re-render needs no refetch - the
       * same property makes it portable. A reaction chain prices every material
       * in the tree, so re-running it just to move a window is wasted work.
       */
      getHandoff() {
        if (!state.reaction) return null;
        return {
          reaction: state.reaction,
          // Runs lives only in the DOM input, not in state - a popped window
          // would otherwise open at the template default while showing results
          // calculated for a different number of runs.
          runs: parseInt($('rx-runs').value, 10) || 1,
          facilityId: state.facilityId,
          characterId: state.characterId,
          result: state.result,
        };
      },

      /** Adopt a popped-out window's reaction and its calculated result. */
      async applyHandoff(payload) {
        if (!payload || !payload.reaction) return;

        // Facility and character first: selectReaction reads them, and they
        // are what produced the result being adopted.
        //
        // The CONTROL is set too. `mountPlainSelect` appends a real <select>
        // into the host, so it is reachable - and setting state alone would
        // leave the picker showing whatever it was seeded with while the
        // results belong to a different facility.
        if (payload.facilityId) {
          state.facilityId = payload.facilityId;
          const facilitySelect = $('rx-facility-host').querySelector('select');
          if (facilitySelect) facilitySelect.value = String(payload.facilityId);
        }
        if (payload.characterId) state.characterId = payload.characterId;

        await selectReaction(payload.reaction);

        // Restore runs so the input agrees with the results being adopted, and
        // so a later recalculation starts from the right number.
        if (typeof payload.runs === 'number') {
          const runsInput = $('rx-runs');
          if (runsInput) runsInput.value = payload.runs;
        }

        // selectReaction clears the result and shows the empty state; adopt the
        // handed-over one instead of recalculating.
        if (payload.result) {
          state.result = payload.result;
          renderResult(payload.result);
        }
      },
    };
  }

  if (window.QFShell && window.QFShell.router) {
    window.QFShell.router.register('reactions', {
      title: 'Reactions',
      mount,
    });
  }
})();
