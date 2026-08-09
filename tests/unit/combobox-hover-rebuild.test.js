/**
 * Structural guard for CLAUDE.md binding rule 2a.
 *
 * A `mouseenter` handler that re-renders its list makes that list unclickable
 * by mouse: a click needs mousedown AND mouseup on the same element, and
 * mouseenter fires first, so rebuilding destroys the element the mousedown
 * landed on. Keyboard selection keeps working, which is why it hides.
 *
 * This is a source-level check because the failure is invisible to a normal
 * DOM test that re-queries after the hover - it only shows up if you hold
 * element references ACROSS the hover. Catching it structurally means a new
 * combobox cannot reintroduce it without the suite failing.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');

/** Files that build keyboard-navigable result lists. */
const COMBOBOX_SOURCES = [
  'src/renderer/market-view-renderer.js',
  'public/shared/qf-search-select.js',
];

/**
 * Functions that rebuild a result list wholesale. Calling one of these from a
 * mouseenter handler, or from an arrow-key branch, is the bug.
 */
const REBUILD_FUNCTIONS = [
  'renderAddResults',
  'renderOverrideResults',
  'renderResults',
  '_renderList',
];

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

/** Extract the body of every mouseenter handler in a source file. */
function mouseEnterHandlers(source) {
  const handlers = [];
  const pattern = /addEventListener\(\s*['"]mouseenter['"]\s*,\s*(?:function\s*\([^)]*\)|\([^)]*\)\s*=>)\s*\{/g;
  let match;

  while ((match = pattern.exec(source)) !== null) {
    // Walk braces from the handler's opening brace to find its end.
    let depth = 1;
    let i = pattern.lastIndex;
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') depth -= 1;
      i += 1;
    }
    handlers.push(source.slice(pattern.lastIndex, i));
  }
  return handlers;
}

describe('combobox hover does not rebuild its rows', () => {
  test.each(COMBOBOX_SOURCES)('%s', (file) => {
    const source = read(file);
    const handlers = mouseEnterHandlers(source);

    handlers.forEach((body) => {
      REBUILD_FUNCTIONS.forEach((fn) => {
        expect(body).not.toContain(`${fn}(`);
      });
    });
  });

  test('the shared component still has mouseenter handlers to check', () => {
    // Guard the guard: if the parser stops finding handlers this suite would
    // pass vacuously.
    const handlers = mouseEnterHandlers(read('public/shared/qf-search-select.js'));
    expect(handlers.length).toBeGreaterThanOrEqual(1);
  });

  test('the market view does not hand-roll a combobox at all', () => {
    // Binding rule 5: searchable dropdowns are the shared QFSearchSelect.
    // Both item searches were migrated to it, so this file should own no
    // result-list rendering, keyboard contract or highlight of its own.
    const source = read('src/renderer/market-view-renderer.js');
    expect(source).not.toMatch(/function (render|run)(Add|Override)(Results|Search)/);
    expect(source).not.toMatch(/function on(Add|Override)KeyDown/);
    expect(source).not.toMatch(/hiIndex/);
    // It should mount the shared component instead.
    expect(source).toMatch(/new window\.QFSearchSelect\(/);
  });

  test('the shared QFSearchSelect uses its in-place sync', () => {
    const handlers = mouseEnterHandlers(read('public/shared/qf-search-select.js'));
    handlers.forEach((body) => {
      expect(body).toMatch(/_syncHighlight\(/);
    });
  });
});

describe('arrow-key navigation does not rebuild its rows either', () => {
  // A rebuild on up/down is not a correctness bug the way hover is, but it
  // discards scroll position and every row listener for no benefit.
  test('the shared component moves the highlight in place on arrow keys', () => {
    const source = read('public/shared/qf-search-select.js');
    const start = source.indexOf('_onSearchKey = function');
    expect(start).toBeGreaterThan(-1);

    let depth = 0;
    let i = source.indexOf('{', start);
    const open = i;
    do {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') depth -= 1;
      i += 1;
    } while (i < source.length && depth > 0);

    const body = source.slice(open, i);
    REBUILD_FUNCTIONS.forEach((fn) => {
      expect(body).not.toContain(`${fn}(`);
    });
    expect(body).toMatch(/_syncHighlight\(/);
  });
});
