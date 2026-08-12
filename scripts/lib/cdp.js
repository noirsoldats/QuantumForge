'use strict';

/**
 * Minimal Chrome DevTools Protocol client.
 *
 * Dependency-free on purpose: Node's built-in `http` finds the target, and the
 * global `WebSocket` (Node 22+, which Electron 43 ships) speaks the protocol.
 * Adding a CDP library here would mean a devDependency for ~80 lines of code.
 *
 * Two endpoint flavours matter, and they are NOT interchangeable:
 *
 *   /json/version  -> the BROWSER-level endpoint. Required for the Tracing
 *                     domain, which spans every process (browser, renderers,
 *                     GPU, network) on one correlated timeline.
 *   /json/list     -> per-target endpoints. The main process appears here when
 *                     launched with --inspect; renderer pages appear when
 *                     launched with --remote-debugging-port.
 */

const http = require('http');

/**
 * GET a JSON path from a CDP HTTP endpoint, retrying while the port comes up.
 *
 * @param {number} port
 * @param {string} pathname   e.g. '/json/list'
 * @param {{timeoutMs?: number, intervalMs?: number}} [opts]
 * @returns {Promise<any>}
 */
async function getJSON(port, pathname, opts = {}) {
  const timeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs : 15000;
  const intervalMs = opts.intervalMs !== undefined ? opts.intervalMs : 200;
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;

  while (Date.now() < deadline) {
    try {
      return await new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => {
            try {
              resolve(JSON.parse(body));
            } catch (err) {
              reject(new Error(`bad JSON from ${pathname}: ${err.message}`));
            }
          });
        });
        req.on('error', reject);
        req.setTimeout(2000, () => req.destroy(new Error('request timeout')));
      });
    } catch (err) {
      lastErr = err;
      await sleep(intervalMs);
    }
  }
  throw new Error(`[cdp] ${pathname} on port ${port} never responded: ${lastErr && lastErr.message}`);
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Connected CDP session over a websocket URL.
 *
 * `send()` resolves with the command result. Events are delivered to listeners
 * registered with `on()`; a domain that streams (Tracing.dataCollected) can
 * push tens of thousands of events, so listeners are plain callbacks rather
 * than accumulating promises.
 */
class CDPSession {
  /** @param {string} wsUrl */
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.sock = null;
    this._nextId = 0;
    this._pending = new Map();
    this._listeners = new Map();
  }

  /** Open the socket and wait for it to be ready. */
  async connect() {
    this.sock = new WebSocket(this.wsUrl);

    this.sock.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (_) {
        return;
      }

      if (msg.id !== undefined && this._pending.has(msg.id)) {
        const { resolve, reject } = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
        return;
      }

      if (msg.method) {
        const handlers = this._listeners.get(msg.method);
        if (handlers) for (const h of handlers) h(msg.params);
      }
    });

    await new Promise((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve(); };
      const onErr = () => { cleanup(); reject(new Error(`[cdp] failed to connect: ${this.wsUrl}`)); };
      const cleanup = () => {
        this.sock.removeEventListener('open', onOpen);
        this.sock.removeEventListener('error', onErr);
      };
      this.sock.addEventListener('open', onOpen);
      this.sock.addEventListener('error', onErr);
    });

    return this;
  }

  /**
   * Issue a CDP command.
   * @param {string} method
   * @param {object} [params]
   * @returns {Promise<any>}
   */
  send(method, params = {}) {
    const id = ++this._nextId;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this.sock.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Subscribe to a CDP event.
   * @param {string} method
   * @param {(params: any) => void} handler
   */
  on(method, handler) {
    if (!this._listeners.has(method)) this._listeners.set(method, []);
    this._listeners.get(method).push(handler);
  }

  /** Wait for a single occurrence of an event. */
  once(method, { timeoutMs = 60000 } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`[cdp] timed out waiting for ${method}`)),
        timeoutMs
      );
      this.on(method, (params) => {
        clearTimeout(timer);
        resolve(params);
      });
    });
  }

  close() {
    try {
      if (this.sock) this.sock.close();
    } catch (_) {
      /* already gone */
    }
  }
}

/**
 * Connect to the browser-level endpoint (required for Tracing).
 * @param {number} port
 */
async function connectBrowser(port) {
  const version = await getJSON(port, '/json/version');
  if (!version.webSocketDebuggerUrl) {
    throw new Error(
      `[cdp] no browser-level websocket on port ${port}. ` +
      `Tracing needs --remote-debugging-port, not --inspect.`
    );
  }
  return new CDPSession(version.webSocketDebuggerUrl).connect();
}

/**
 * Connect to a single target from /json/list.
 *
 * @param {number} port
 * @param {(t: any) => boolean} [predicate] defaults to the first target
 */
async function connectTarget(port, predicate) {
  const targets = await getJSON(port, '/json/list');
  const list = Array.isArray(targets) ? targets : [];
  const target = predicate ? list.find(predicate) : list[0];
  if (!target || !target.webSocketDebuggerUrl) {
    throw new Error(
      `[cdp] no matching debug target on port ${port}. ` +
      `Found ${list.length}: ${list.map((t) => `${t.type}:${t.title}`).join(', ') || '(none)'}`
    );
  }
  const session = await new CDPSession(target.webSocketDebuggerUrl).connect();
  return { session, target };
}

module.exports = {
  CDPSession,
  connectBrowser,
  connectTarget,
  getJSON,
  sleep,
};
