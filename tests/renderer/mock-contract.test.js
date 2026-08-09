/**
 * @jest-environment jsdom
 *
 * Mock contract: every electronAPI method a view calls must exist on its
 * suite's mock.
 *
 * WHY THIS EXISTS
 * ---------------
 * Adding one subscription to the Market view's mount() broke **140 tests in a
 * single suite**. The mock had no `onFetchProgress`, mount() threw a
 * `TypeError` before it finished, and since every test in that file mounts the
 * view, every test failed.
 *
 * The blast radius came from three things multiplying:
 *
 *   1. All of a suite's tests share one mount() helper, so a mount-time failure
 *      is total rather than local.
 *   2. A call made DURING MOUNT has no containment. The same suite has calls
 *      behind controls (open an editor, search a system) that are unmocked
 *      today and pass, because no test reaches them.
 *   3. jsdom has no equivalent of `tests/harness/electron-harness.js`, which
 *      auto-answers undeclared channels precisely so a missing stub cannot wedge
 *      a run. Each jsdom suite hand-lists its mock instead.
 *
 * So the mock surface was unverified: the only way to discover a gap was to
 * break every test at once. This test makes the gap a single, named failure
 * BEFORE the suite runs - and it also reports the latent ones that no test
 * currently exercises.
 *
 * HOW
 * ---
 * Static analysis, not a runtime proxy. A proxy only observes what a test
 * happens to exercise, which is exactly the containment problem above; parsing
 * finds every call site including the ones no test reaches. Verified safe:
 * no renderer destructures electronAPI (`const { x } = electronAPI.ns`), so
 * every call is a direct member access this can see.
 */

const fs = require('fs');
const path = require('path');

const RENDERER_DIR = path.join(__dirname, '../../src/renderer');
const TEST_DIR = __dirname;

/**
 * Renderer -> the suite that mounts it.
 *
 * Only views with a jsdom suite appear here. A view added without one is
 * caught by the coverage test at the bottom rather than silently skipped.
 */
const PAIRS = [
  ['assets-view-renderer.js', 'assets-ui.test.js'],
  ['audit-log-view-renderer.js', 'audit-log-ui.test.js'],
  ['blueprint-calculator-view-renderer.js', 'blueprint-calculator-ui.test.js'],
  ['blueprints-view-renderer.js', 'blueprints-ui.test.js'],
  ['character-hub-renderer.js', 'character-hub-ui.test.js'],
  ['esi-status-view-renderer.js', 'esi-status-ui.test.js'],
  ['facilities-view-renderer.js', 'facilities-ui.test.js'],
  ['loot-analyzer-view-renderer.js', 'loot-analyzer-ui.test.js'],
  ['manufacturing-plans-view-renderer.js', 'manufacturing-plans-ui.test.js'],
  ['manufacturing-summary-view-renderer.js', 'manufacturing-summary-ui.test.js'],
  ['market-view-renderer.js', 'market-watchlist-ui.test.js'],
  ['reactions-view-renderer.js', 'reactions-ui.test.js'],
  ['skills-view-renderer.js', 'skills-ui.test.js'],
  ['what-can-i-build-view-renderer.js', 'what-can-i-build-ui.test.js'],
];

/**
 * Calls made while the view is MOUNTING.
 *
 * These are the dangerous ones: a missing mock here takes down every test in
 * the suite, because they all mount. Calls elsewhere fail only the tests that
 * reach them.
 *
 * The mount body is matched from `async function mount(` to the first
 * column-2 closing brace - the file-wide convention in these renderers.
 */
function mountTimeCalls(source) {
  const start = source.search(/async function mount\s*\(/);
  if (start === -1) return new Set();

  const rest = source.slice(start);
  const end = rest.search(/\n {2}\}\n/);
  return extractCalls(end === -1 ? rest : rest.slice(0, end));
}

/** Every `electronAPI.<ns>.<method>` (and one nested level) in a chunk of source. */
function extractCalls(source) {
  const calls = new Set();

  // Nested first (market.watchlists.create), so the two-part pattern does not
  // record `market.watchlists` as if it were the method.
  const nested = new Set();
  for (const m of source.matchAll(/electronAPI\.(\w+)\.(\w+)\.(\w+)\s*\(/g)) {
    calls.add(`${m[1]}.${m[2]}.${m[3]}`);
    nested.add(`${m[1]}.${m[2]}`);
  }

  for (const m of source.matchAll(/electronAPI\.(\w+)\.(\w+)\s*\(/g)) {
    if (nested.has(`${m[1]}.${m[2]}`)) continue;
    calls.add(`${m[1]}.${m[2]}`);
  }

  return calls;
}

/**
 * Does the suite's mock declare this method?
 *
 * Matches `name:` as an object key. Deliberately loose about WHICH namespace -
 * a stricter check would have to parse the mock object, and the failure this
 * guards against is a wholly absent method, not one filed under the wrong key.
 */
function mockDeclares(testSource, call) {
  const method = call.split('.').pop();
  return new RegExp(`\\b${method}\\s*:`).test(testSource);
}

const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8');

describe('mock contract', () => {
  describe.each(PAIRS)('%s', (rendererFile, testFile) => {
    let renderer;
    let suite;

    beforeAll(() => {
      renderer = read(RENDERER_DIR, rendererFile);
      suite = read(TEST_DIR, testFile);
    });

    test('every method called during mount() is mocked', () => {
      // THE regression this file exists for. A gap here fails the whole suite
      // at once, with a stack trace that names the line but not the cause.
      const missing = [...mountTimeCalls(renderer)]
        .filter((call) => !mockDeclares(suite, call))
        .sort();

      expect(missing).toEqual([]);
    });

    test('every method the view calls at all is mocked', () => {
      // Broader: catches calls behind controls, which fail only the tests that
      // reach them - or no test at all, until a user finds it.
      const missing = [...extractCalls(renderer)]
        .filter((call) => !mockDeclares(suite, call))
        .sort();

      expect(missing).toEqual([]);
    });
  });

  test('every ported view has a suite', () => {
    // A view added without a jsdom suite would otherwise be silently exempt
    // from everything above.
    const rendererFiles = fs
      .readdirSync(RENDERER_DIR)
      .filter((f) => f.endsWith('-view-renderer.js'));

    const covered = new Set(PAIRS.map(([r]) => r));
    const uncovered = rendererFiles.filter((f) => !covered.has(f));

    expect(uncovered).toEqual([]);
  });

  test('no renderer destructures electronAPI', () => {
    // The static analysis above reads direct member access. A destructured
    // call (`const { getAll } = electronAPI.plans`) would be invisible to it,
    // so the pattern is banned rather than silently unchecked.
    const offenders = fs
      .readdirSync(RENDERER_DIR)
      .filter((f) => f.endsWith('.js'))
      .filter((f) =>
        /const\s*\{[^}]+\}\s*=\s*(?:window\.)?electronAPI/.test(read(RENDERER_DIR, f))
      );

    expect(offenders).toEqual([]);
  });
});
