/**
 * Facility import parsers.
 *
 * The Ravworks fixture is the REAL export committed at the repo root, not a
 * hand-written approximation: the trailing spaces in its structure names and
 * its "No Rig" sentinel are exactly the details a made-up fixture smooths
 * over, and both change what the importer must do.
 */

const fs = require('fs');
const path = require('path');

const {
  parseRavworksExport,
  parseShipScannerPaste,
} = require('../../src/renderer/facility-import-parsers');

const RAV_EXPORT = fs.readFileSync(
  path.join(__dirname, '../../RavWork_C-FD0D.json'),
  'utf8'
);

/** The paste format the in-game Ship Scanner produces. */
const SCANNER_PASTE = [
  'High Power Slots',
  'Standup Heavy Energy Neutralizer I',
  'Standup Multirole Missile Launcher I',
  'Medium Power Slots',
  'Standup Focused Warp Disruptor I',
  'Standup Target Painter I',
  'Low Power Slots',
  'Standup Layered Armor Plating I',
  'Rig Slots',
  'Standup M-Set Ammunition Manufacturing Material Efficiency II',
  'Standup M-Set Ammunition Manufacturing Time Efficiency II',
  'Service Slots',
  'Standup Manufacturing Plant I',
  'Charges',
  'Standup Focused Warp Scrambling Script',
].join('\n');

describe('parseRavworksExport', () => {
  it('parses every structure in the real export', () => {
    const result = parseRavworksExport(RAV_EXPORT);

    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(10);
  });

  it('returns the three top-level system names', () => {
    const { systems } = parseRavworksExport(RAV_EXPORT);

    // Ravworks records no per-structure system - only these three, which the
    // importer defaults from per row.
    expect(systems).toEqual({ manu: 'C-FD0D', react: 'C-FD0D', inv: 'C-FD0D' });
  });

  it('trims the trailing whitespace Ravworks writes into names', () => {
    const { rows } = parseRavworksExport(RAV_EXPORT);
    const names = rows.map((r) => r.name);

    // The raw file has "Capital Ships " and "A Brave New(bie) Refinery -RAMI ".
    expect(names).toContain('Capital Ships');
    expect(names).toContain('A Brave New(bie) Refinery -RAMI');
    names.forEach((name) => expect(name).toBe(name.trim()));
  });

  it('drops the "No Rig" sentinel rather than treating it as a rig', () => {
    const { rows } = parseRavworksExport(RAV_EXPORT);
    const allRigs = rows.flatMap((r) => r.rigNames);

    expect(allRigs).not.toContain('No Rig');
    // Structure 1 (the Tatara) lists one real rig and two "No Rig" slots.
    const tatara = rows.find((r) => r.structureName === 'Tatara');
    expect(tatara.rigNames).toEqual(['Standup L-Set Reactor Efficiency II']);
  });

  it('keeps rig names verbatim so they can match SDE typeNames', () => {
    const { rows } = parseRavworksExport(RAV_EXPORT);
    const structure3 = rows.find((r) => r.sourceId === 'Structure 3');

    expect(structure3.rigNames).toEqual([
      'Standup M-Set Advanced Large Ship Manufacturing Material Efficiency II',
      'Standup M-Set Basic Large Ship Manufacturing Material Efficiency II',
      'Standup M-Set Advanced Large Ship Manufacturing Time Efficiency I',
    ]);
  });

  it('carries the hull name and Ravworks id through', () => {
    const { rows } = parseRavworksExport(RAV_EXPORT);

    expect(rows[0]).toMatchObject({
      sourceId: 'Structure 1',
      structureName: 'Tatara',
      securityBand: 'Null / Wormhole',
    });
    expect(new Set(rows.map((r) => r.structureName)))
      .toEqual(new Set(['Tatara', 'Azbel', 'Raitaru']));
  });

  describe('rejections', () => {
    it('reports invalid JSON without throwing', () => {
      const result = parseRavworksExport('this is not json');

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not valid JSON/i);
      expect(result.rows).toEqual([]);
    });

    it('reports valid JSON that is not a Ravworks export', () => {
      const result = parseRavworksExport(JSON.stringify({ some: 'object' }));

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not a Ravworks export/i);
    });

    it('rejects a structure list that is not an array', () => {
      const result = parseRavworksExport(
        JSON.stringify({ hidden_my_structures: { a: 1 } })
      );

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not a Ravworks export/i);
    });

    it('distinguishes an empty structure list from a wrong file', () => {
      const result = parseRavworksExport(JSON.stringify({ hidden_my_structures: [] }));

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/no structures/i);
    });

    it('rejects a bare JSON array', () => {
      const result = parseRavworksExport('[]');

      expect(result.ok).toBe(false);
      expect(result.rows).toEqual([]);
    });
  });
});

describe('parseShipScannerPaste', () => {
  it('takes the rigs and nothing else from a full scan', () => {
    const result = parseShipScannerPaste(SCANNER_PASTE);

    expect(result.rigNames).toEqual([
      'Standup M-Set Ammunition Manufacturing Material Efficiency II',
      'Standup M-Set Ammunition Manufacturing Time Efficiency II',
    ]);
    expect(result.serviceNames).toEqual(['Standup Manufacturing Plant I']);
    // 2 high + 2 medium + 1 low + 1 service + 1 charge
    expect(result.ignoredCount).toBe(7);
    expect(result.sawHeader).toBe(true);
  });

  it('groups every slot so nothing is silently lost', () => {
    const { slots } = parseShipScannerPaste(SCANNER_PASTE);

    expect(slots.high).toHaveLength(2);
    expect(slots.medium).toHaveLength(2);
    expect(slots.low).toEqual(['Standup Layered Armor Plating I']);
    expect(slots.rig).toHaveLength(2);
    expect(slots.charges).toEqual(['Standup Focused Warp Scrambling Script']);
  });

  it('handles CRLF line endings', () => {
    const result = parseShipScannerPaste(SCANNER_PASTE.replace(/\n/g, '\r\n'));

    expect(result.rigNames).toHaveLength(2);
    expect(result.rigNames[0]).toBe(
      'Standup M-Set Ammunition Manufacturing Material Efficiency II'
    );
  });

  it('strips the trailing quantity column some clients append', () => {
    const result = parseShipScannerPaste(
      'Rig Slots\nStandup M-Set Ammunition Manufacturing Material Efficiency II\t1\n'
    );

    expect(result.rigNames).toEqual([
      'Standup M-Set Ammunition Manufacturing Material Efficiency II',
    ]);
  });

  it('is case-insensitive about slot headings', () => {
    const result = parseShipScannerPaste('RIG SLOTS\nStandup M-Set Equipment Manufacturing Material Efficiency II');

    expect(result.rigNames).toHaveLength(1);
  });

  it('ignores preamble before the first heading', () => {
    const result = parseShipScannerPaste(
      'Some Structure Name\nCorporation Ltd.\nRig Slots\nStandup M-Set Equipment Manufacturing Material Efficiency II'
    );

    expect(result.rigNames).toHaveLength(1);
    expect(result.ignoredCount).toBe(0);
  });

  it('reports a scan with a rig section but no rigs', () => {
    const result = parseShipScannerPaste('Rig Slots\nService Slots\nStandup Manufacturing Plant I');

    expect(result.rigNames).toEqual([]);
    expect(result.serviceNames).toEqual(['Standup Manufacturing Plant I']);
    // sawHeader separates "unfitted structure" from "this is not a scan".
    expect(result.sawHeader).toBe(true);
  });

  it('flags text with no recognised headings', () => {
    const result = parseShipScannerPaste('just some text\nmore text');

    expect(result.sawHeader).toBe(false);
    expect(result.rigNames).toEqual([]);
    expect(result.ignoredCount).toBe(0);
  });

  it('survives empty and nullish input', () => {
    [null, undefined, ''].forEach((input) => {
      const result = parseShipScannerPaste(input);
      expect(result.rigNames).toEqual([]);
      expect(result.sawHeader).toBe(false);
    });
  });
});
