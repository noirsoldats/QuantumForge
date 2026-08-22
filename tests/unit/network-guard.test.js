/**
 * The test-suite network guard (tests/setup.js).
 *
 * This is the test that keeps the guard honest. The guard's whole value is that
 * it CANNOT be bypassed by the things tests normally do - so an assertion that
 * it is merely "installed" would prove nothing. Each case here actually
 * attempts a connection and asserts it is refused.
 *
 * Why it matters: ESI's error limit is app-wide and a 4xx costs ~2.5x a
 * success, so a test looping over ESI would burn the real application's budget
 * on every CI run.
 */

const net = require('net');
const http = require('http');
const https = require('https');
const tls = require('tls');

/** A host/port that would be a real connection if it were ever allowed. */
const REMOTE = { host: 'esi.evetech.net', port: 443 };

describe('network guard', () => {
  test('a raw socket connect is refused', () => {
    const socket = new net.Socket();
    expect(() => socket.connect(REMOTE)).toThrow(/Network access is blocked/);
  });

  test('the error names the target, so the culprit is obvious', () => {
    const socket = new net.Socket();
    expect(() => socket.connect(REMOTE)).toThrow(/esi\.evetech\.net:443/);
  });

  test('the positional connect(port, host) form is also refused', () => {
    const socket = new net.Socket();
    expect(() => socket.connect(443, 'esi.evetech.net')).toThrow(/esi\.evetech\.net:443/);
  });

  test('http.request is refused', () => {
    expect(() => http.request('http://esi.evetech.net/latest/status/').end())
      .toThrow(/Network access is blocked/);
  });

  test('https.request is refused', () => {
    expect(() => https.request('https://esi.evetech.net/latest/status/').end())
      .toThrow(/Network access is blocked/);
  });

  test('tls.connect is refused', () => {
    expect(() => tls.connect(REMOTE)).toThrow(/Network access is blocked/);
  });

  test('global fetch to a real host is refused', async () => {
    // fetch wraps the underlying failure in a TypeError, so the guard's message
    // arrives on `cause`. This is the case that matters most: it is the API the
    // ESI modules actually use.
    expect.assertions(1);
    try {
      await fetch('https://esi.evetech.net/latest/status/');
    } catch (error) {
      const message = String((error && error.cause && error.cause.message) || error.message);
      expect(message).toMatch(/Network access is blocked/);
    }
  });

  test('the guard survives a suite replacing global.fetch', async () => {
    // Every renderer suite assigns its own global.fetch in beforeEach. A guard
    // that lived on global.fetch would be silently wiped by exactly this, which
    // is why it lives on the socket instead. Here the replacement delegates to
    // the real fetch, so the socket layer is what must refuse it.
    const original = global.fetch;
    global.fetch = (...args) => original(...args);
    try {
      expect.assertions(1);
      await global.fetch('https://esi.evetech.net/latest/status/');
    } catch (error) {
      const message = String((error && error.cause && error.cause.message) || error.message);
      expect(message).toMatch(/Network access is blocked/);
    } finally {
      global.fetch = original;
    }
  });

  describe('the allowNetwork() escape hatch', () => {
    afterEach(() => { global.blockNetwork(); });

    test('allowNetwork() stops the guard refusing the connection', () => {
      // Deliberately NOT proven by opening a real listening server: doing that
      // inside a jest worker leaves a handle that stops the worker exiting
      // cleanly, which showed up as a hang in the full run. What matters here
      // is that the guard delegates instead of throwing, so this asserts the
      // guard's own behaviour and lets the connection fail on its own terms.
      global.allowNetwork();
      const socket = new net.Socket();
      // The connection is never established - it is aborted on the next line -
      // so nothing leaves the machine. The point is only that the guard let the
      // call through to Node instead of refusing it outright.
      socket.on('error', () => {});
      expect(() => socket.connect(9, '127.0.0.1')).not.toThrow();
      socket.destroy();
    });

    test('blockNetwork() restores the block', () => {
      global.allowNetwork();
      global.blockNetwork();
      const socket = new net.Socket();
      expect(() => socket.connect(REMOTE)).toThrow(/Network access is blocked/);
    });

    test('a test always starts guarded, whatever the previous one did', () => {
      const socket = new net.Socket();
      expect(() => socket.connect(REMOTE)).toThrow(/Network access is blocked/);
    });
  });
});

describe('the guard installs exactly once per worker', () => {
  // Test files in one worker share the `net` module, so re-running setup.js
  // per file would stack wrappers - each closing over its own flag, so the
  // outer one says "allowed" while an inner one still throws. Blocking would
  // still work, which is what made this easy to miss; only allowNetwork()
  // broke, and only when more than one test file ran in the same worker.
  test('the install is marked on the shared net module', () => {
    // The marker is what makes the install idempotent: setup.js skips patching
    // when it is already present, so a second run in the same worker cannot
    // wrap connect again.
    expect(net[Symbol.for('quantumforge.test.networkGuard')]).toBeDefined();
  });

  test('allowNetwork() drives the SAME flag the guard reads', () => {
    // The stacking bug was exactly this link breaking: the globals pointed at a
    // newer flag than the wrapper that was actually throwing.
    const guard = net[Symbol.for('quantumforge.test.networkGuard')];
    global.allowNetwork();
    expect(guard.allowed).toBe(true);

    const socket = new net.Socket();
    socket.on('error', () => {});
    expect(() => socket.connect(9, '127.0.0.1')).not.toThrow();
    socket.destroy();

    global.blockNetwork();
    expect(guard.allowed).toBe(false);
  });
});

describe('leaking allowNetwork across tests', () => {
  test('allowNetwork() here', () => {
    global.allowNetwork();
    expect(typeof global.allowNetwork).toBe('function');
  });

  test('is cleared before the next test runs', () => {
    const socket = new net.Socket();
    expect(() => socket.connect(REMOTE)).toThrow(/Network access is blocked/);
  });
});
