/**
 * Design token integrity
 *
 * `var(--qf-nope)` is SILENT: the declaration is dropped and the element keeps
 * its inherited value, so the page still renders - just not at the intended
 * colour. Nothing errors, and jsdom applies no stylesheets, so no renderer
 * test can catch it either.
 *
 * This shipped: `--qf-text-secondary` was never defined (the ramp is
 * heading -> primary -> muted -> faint) but was referenced 7 times across two
 * freshly-ported screens, all of which silently fell back to inherited text.
 *
 * A token may legitimately be undefined in variables.css if it is a per-element
 * custom property set from JS - those MUST declare a fallback, which is what
 * makes them safe and is what this test checks instead.
 */

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '../../public');
const VARIABLES = path.join(PUBLIC_DIR, 'shared/variables.css');

/** Tokens set per-element from JS rather than declared globally. */
const RUNTIME_TOKENS = new Set([
  '--qf-call-accent',   // ESI Status: per-row status stripe colour
  '--qf-stack-order',   // Dashboard: per-card z-index
]);

function collectFiles(dir, out = []) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, out);
    else if (/\.(css|html)$/.test(entry.name)) out.push(full);
  });
  return out;
}

let definedTokens;
let files;

beforeAll(() => {
  const vars = fs.readFileSync(VARIABLES, 'utf8');
  definedTokens = new Set(
    [...vars.matchAll(/^\s*(--qf-[a-z0-9-]+)\s*:/gm)].map((m) => m[1])
  );
  files = collectFiles(PUBLIC_DIR);
});

describe('design tokens', () => {
  test('variables.css defines the token set', () => {
    expect(definedTokens.size).toBeGreaterThan(50);
    // The text ramp, named explicitly - this is the one that went wrong.
    expect(definedTokens.has('--qf-text-heading')).toBe(true);
    expect(definedTokens.has('--qf-text-primary')).toBe(true);
    expect(definedTokens.has('--qf-text-muted')).toBe(true);
    expect(definedTokens.has('--qf-text-faint')).toBe(true);
    // There is deliberately NO --qf-text-secondary. If one is ever added,
    // update this test - but do not add it just to satisfy a typo.
    expect(definedTokens.has('--qf-text-secondary')).toBe(false);
  });

  test('every referenced --qf-* token is defined', () => {
    const offenders = [];

    files.forEach((file) => {
      const text = fs.readFileSync(file, 'utf8');
      [...text.matchAll(/var\(\s*(--qf-[a-z0-9-]+)\s*([,)])/g)].forEach((match) => {
        const [, token, next] = match;
        if (definedTokens.has(token)) return;
        // A runtime token is fine, but only with a fallback: `next === ','`
        // means one was supplied.
        if (RUNTIME_TOKENS.has(token) && next === ',') return;
        offenders.push(`${path.relative(PUBLIC_DIR, file)}: ${token}`);
      });
    });

    expect(offenders).toEqual([]);
  });

  test('runtime tokens always declare a fallback', () => {
    // Without one, a row whose JS has not yet run renders with the property
    // dropped entirely rather than with a sane default.
    const offenders = [];

    files.forEach((file) => {
      const text = fs.readFileSync(file, 'utf8');
      RUNTIME_TOKENS.forEach((token) => {
        const pattern = new RegExp(`var\\(\\s*${token}\\s*\\)`, 'g');
        if (pattern.test(text)) {
          offenders.push(`${path.relative(PUBLIC_DIR, file)}: ${token} has no fallback`);
        }
      });
    });

    expect(offenders).toEqual([]);
  });
});
