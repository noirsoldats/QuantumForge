/**
 * Facility import parsers.
 *
 * Two text/JSON formats users already have, turned into plain data the
 * Facilities view can resolve against the SDE:
 *
 *   1. Ravworks config export (.json) - many structures, each with a hull
 *      name and up to three rig names.
 *   2. In-game Ship Scanner paste - one structure's fitted modules, grouped
 *      under slot headers.
 *
 * These are PURE: no DOM, no IPC, no SDE. They only turn text into names and
 * counts. Every name -> typeID resolution happens in the renderer against the
 * lists it has already loaded, because a bare `typeName` lookup is ambiguous
 * (there are two "Azbel" rows in invTypes; only one is a published
 * Engineering Complex).
 */
(function () {
  'use strict';

  /** Ravworks writes this in a rig slot that is empty. */
  const RAV_EMPTY_RIG = 'no rig';

  /**
   * Ship Scanner slot headers, lowercased.
   *
   * A header line carries no module, it just switches which slot the lines
   * below it belong to. Anything before the first header is preamble.
   */
  const SCANNER_HEADERS = {
    'high power slots': 'high',
    'medium power slots': 'medium',
    'low power slots': 'low',
    'rig slots': 'rig',
    'service slots': 'service',
    'charges': 'charges',
  };

  /**
   * One line of a scanner paste, minus the noise real pastes carry.
   *
   * Some client versions append a tab-separated quantity column, so only the
   * first field is the module name. \r is stripped by the caller's split.
   */
  function cleanLine(line) {
    return String(line).split('\t')[0].trim();
  }

  /**
   * @param {string} jsonText - contents of a Ravworks .json export
   * @returns {{
   *   ok: boolean,
   *   error?: string,
   *   rows: Array<{
   *     sourceId: string,
   *     name: string,
   *     structureName: string,
   *     rigNames: string[],
   *     securityBand: string
   *   }>,
   *   systems: { manu: string, react: string, inv: string }
   * }}
   */
  function parseRavworksExport(jsonText) {
    const fail = (error) => ({ ok: false, error, rows: [], systems: emptySystems() });

    let data;
    try {
      data = JSON.parse(jsonText);
    } catch (error) {
      return fail('That file is not valid JSON.');
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return fail('That file is not a Ravworks export.');
    }

    // The structure list is what makes a Ravworks export usable here. Its
    // absence - not a JSON error - is how we tell "wrong file" from "broken
    // file", so the two get different messages.
    const raw = data.hidden_my_structures;
    if (!Array.isArray(raw)) {
      return fail('That file is not a Ravworks export (no structure list found).');
    }
    if (raw.length === 0) {
      return fail('That Ravworks export contains no structures.');
    }

    const rows = raw
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry, index) => ({
        // Ravworks' own "Structure N" id, which hidden_allocation_dict points
        // at. Kept for traceability; falls back to the index so rows always
        // have a stable key for the preview table.
        sourceId: text(entry.id) || `row-${index}`,
        // Ravworks names routinely carry trailing spaces ("Capital Ships ").
        // settings-manager trims on save, so trim here too or the preview's
        // duplicate check disagrees with what actually gets written.
        name: text(entry.name),
        structureName: text(entry.structure),
        rigNames: [entry.Rig1, entry.Rig2, entry.Rig3]
          .map(text)
          .filter((rig) => rig && rig.toLowerCase() !== RAV_EMPTY_RIG),
        securityBand: text(entry.security),
      }));

    return {
      ok: true,
      rows,
      systems: {
        manu: text(data.manu_system),
        react: text(data.react_system),
        inv: text(data.inv_system),
      },
    };
  }

  function emptySystems() {
    return { manu: '', react: '', inv: '' };
  }

  function text(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  /**
   * @param {string} rawText - a paste from the in-game Ship Scanner
   * @returns {{
   *   slots: Record<string, string[]>,
   *   rigNames: string[],
   *   serviceNames: string[],
   *   ignoredCount: number,
   *   sawHeader: boolean
   * }}
   */
  function parseShipScannerPaste(rawText) {
    const slots = { high: [], medium: [], low: [], rig: [], service: [], charges: [] };
    let current = null;
    let sawHeader = false;
    let ignoredCount = 0;

    String(rawText == null ? '' : rawText)
      .split(/\r?\n/)
      .forEach((line) => {
        const value = cleanLine(line);
        if (!value) return;

        const header = SCANNER_HEADERS[value.toLowerCase()];
        if (header) {
          current = header;
          sawHeader = true;
          return;
        }

        // Lines before the first header are preamble, not modules.
        if (!current) return;

        slots[current].push(value);
        // Rigs are the only thing we can store; services are reported but not
        // persisted (the facility model has no field for them).
        if (current !== 'rig') ignoredCount += 1;
      });

    return {
      slots,
      rigNames: slots.rig.slice(),
      serviceNames: slots.service.slice(),
      ignoredCount,
      // Lets the caller tell "not a scanner paste" from "a scan of an unfitted
      // structure" - both yield zero rigs, but only one is a user error.
      sawHeader,
    };
  }

  const api = { parseRavworksExport, parseShipScannerPaste };

  if (typeof window !== 'undefined') window.QFFacilityImport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
