/**
 * CSS scoping contract for shell views.
 *
 * The application shell loads every view's stylesheet into ONE document, so an
 * unscoped rule in one view's CSS restyles every other screen. This already
 * happened: settings.css defined a bare `.primary-button`, loaded last, and
 * silently changed the dashboard's SDE modal buttons.
 *
 * Rule: a view stylesheet may only contain selectors scoped to that view's own
 * root (an id), plus a small allowlist. Shared component classes belong in
 * public/shared/components.css.
 */

const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '../../public');

/**
 * View stylesheets loaded into the main window alongside each other.
 *
 * A rule is considered scoped if it is either:
 *   - descended from one of the view's `roots` (an id), or
 *   - named with one of the view's `prefixes`.
 *
 * Both are valid; what matters is that the selector cannot match markup owned
 * by another view. A bare, generic class name (`.primary-button`, `.empty-state`)
 * satisfies neither and is what this test is here to catch.
 */
const VIEW_STYLESHEETS = [
  {
    file: 'dashboard.css',
    roots: ['#dashboard-view', '#titlebar-trailing', '#settings-btn'],
    prefixes: ['.dash-', '.qf-tool-'],
  },
  {
    file: 'market-view.css',
    roots: ['#market-view'],
    prefixes: [],
  },
  {
    file: 'character-hub.css',
    roots: ['#character-hub'],
    prefixes: [],
  },
  {
    file: 'settings.css',
    roots: ['#settings-app', '#validation-modal', '#character-divisions-container',
            '#default-manufacturing-characters-container', '#accounts-tab'],
    prefixes: [],
  },
];

/**
 * Selectors a view stylesheet may legitimately define unscoped, because they
 * target the shell's own containers or are view-agnostic utilities.
 */
const ALLOWED_UNSCOPED = [
  /^\.qf-view-native/,   // the shell's view container
  /^:root$/,
];

/** Strip comments and at-rule wrappers, then list every selector. */
function selectorsOf(css) {
  let s = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // Drop @keyframes blocks entirely - their "0%"/"from" keys are not selectors.
  s = s.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  // Unwrap @media/@supports so their inner rules are still checked.
  s = s.replace(/@(?:media|supports)[^{]*\{/g, '');

  const out = [];
  for (const m of s.matchAll(/([^{}]+)\{/g)) {
    for (const raw of m[1].split(',')) {
      const sel = raw.trim().replace(/\s+/g, ' ');
      if (sel) out.push(sel);
    }
  }
  return out;
}

describe('view stylesheets are scoped', () => {
  VIEW_STYLESHEETS.forEach(({ file, roots, prefixes }) => {
    test(`${file} defines no unscoped selectors`, () => {
      const css = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
      const offenders = selectorsOf(css).filter((sel) => {
        if (roots.some((r) => sel.startsWith(r))) return false;
        if (prefixes.some((pfx) => sel.startsWith(pfx))) return false;
        if (ALLOWED_UNSCOPED.some((re) => re.test(sel))) return false;
        return true;
      });

      expect(offenders).toEqual([]);
    });
  });
});

describe('view stylesheets contain no global rules', () => {
  VIEW_STYLESHEETS.forEach(({ file }) => {
    test(`${file} has no bare element, *, html or body rules`, () => {
      const css = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
      const globals = selectorsOf(css).filter((sel) =>
        /^\*/.test(sel) || /^(html|body)\b/.test(sel));

      // A `*` reset or a body rule in a view stylesheet leaks into every screen.
      expect(globals).toEqual([]);
    });
  });
});

describe('no selector is defined by two stylesheets that load together', () => {
  test('view stylesheets do not collide with each other or the shell', () => {
    const files = ['shared/shell.css', 'dashboard.css', 'settings.css', 'character-hub.css', 'market-view.css'];
    const seen = new Map(); // selector -> file

    const collisions = [];
    files.forEach((f) => {
      const css = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
      new Set(selectorsOf(css)).forEach((sel) => {
        if (seen.has(sel) && seen.get(sel) !== f) {
          collisions.push(`${sel}  (${seen.get(sel)} vs ${f})`);
        } else {
          seen.set(sel, f);
        }
      });
    });

    expect(collisions).toEqual([]);
  });
});

describe('shared component classes are defined once', () => {
  test('styles.css does not redefine components.css classes', () => {
    // styles.css used to carry a duplicate copy of the .modal* rules and, since
    // it loads AFTER components.css on 9 pages, it silently overrode
    // .modal-header's flex layout - left-aligning every modal close button.
    // components.css is the single source of truth for shared components.
    const components = fs.readFileSync(path.join(PUBLIC, 'shared/components.css'), 'utf8');
    const styles = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');

    const componentSelectors = new Set(selectorsOf(components));
    const collisions = [...new Set(selectorsOf(styles))]
      .filter((sel) => componentSelectors.has(sel));

    expect(collisions).toEqual([]);
  });
});
