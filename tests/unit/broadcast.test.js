/**
 * broadcast()
 *
 * Guards the silent-failure mode proven during the shell spike:
 * `webContents.send()` reaches ONLY the main frame, so any renderer hosted in
 * an iframe (every not-yet-ported tool) never receives the message - with no
 * error to debug. broadcast() must iterate `mainFrame.framesInSubtree`.
 *
 * If someone later "simplifies" this back to webContents.send, these fail.
 */

const path = require('path');

const BROADCAST = path.join(__dirname, '../../src/main/broadcast.js');

/** Build a fake window whose frames record what they were sent. */
function makeWindow({ frameCount = 2, destroyed = false, throwOnFrame = -1 } = {}) {
  const frames = [];
  for (let i = 0; i < frameCount; i++) {
    frames.push({
      name: `frame${i}`,
      sent: [],
      send(channel, payload) {
        if (i === throwOnFrame) throw new Error('frame gone');
        this.sent.push([channel, payload]);
      },
    });
  }
  return {
    isDestroyed: () => destroyed,
    webContents: {
      sentViaWebContents: [],
      send(channel, payload) {
        this.sentViaWebContents.push([channel, payload]);
      },
      mainFrame: { framesInSubtree: frames },
    },
    _frames: frames,
  };
}

function loadBroadcast(windows) {
  let mod;
  jest.isolateModules(() => {
    jest.doMock('electron', () => ({
      BrowserWindow: { getAllWindows: () => windows },
    }));
    mod = require(BROADCAST);
  });
  return mod;
}

describe('broadcast', () => {
  test('sends to EVERY frame, not just the main frame', () => {
    const win = makeWindow({ frameCount: 3 });
    const { broadcast } = loadBroadcast([win]);

    broadcast('test:channel', { value: 1 });

    win._frames.forEach((f) => {
      expect(f.sent).toEqual([['test:channel', { value: 1 }]]);
    });
  });

  test('does NOT rely on webContents.send (which misses subframes)', () => {
    const win = makeWindow({ frameCount: 2 });
    const { broadcast } = loadBroadcast([win]);

    broadcast('test:channel', 'x');

    expect(win.webContents.sentViaWebContents).toHaveLength(0);
  });

  test('reaches every window, not just the first', () => {
    const a = makeWindow({ frameCount: 1 });
    const b = makeWindow({ frameCount: 1 });
    const { broadcast } = loadBroadcast([a, b]);

    broadcast('ping');

    expect(a._frames[0].sent).toHaveLength(1);
    expect(b._frames[0].sent).toHaveLength(1);
  });

  test('skips destroyed windows', () => {
    const dead = makeWindow({ frameCount: 1, destroyed: true });
    const live = makeWindow({ frameCount: 1 });
    const { broadcast } = loadBroadcast([dead, live]);

    expect(() => broadcast('ping')).not.toThrow();
    expect(dead._frames[0].sent).toHaveLength(0);
    expect(live._frames[0].sent).toHaveLength(1);
  });

  test('a frame disappearing mid-iterate does not stop the others', () => {
    const win = makeWindow({ frameCount: 3, throwOnFrame: 1 });
    const { broadcast } = loadBroadcast([win]);

    expect(() => broadcast('ping')).not.toThrow();
    expect(win._frames[0].sent).toHaveLength(1);
    expect(win._frames[1].sent).toHaveLength(0); // threw
    expect(win._frames[2].sent).toHaveLength(1); // still delivered
  });

  test('handles no windows', () => {
    const { broadcast } = loadBroadcast([]);
    expect(() => broadcast('ping')).not.toThrow();
  });

  test('sendToWindow covers that window\'s frames only', () => {
    const a = makeWindow({ frameCount: 2 });
    const b = makeWindow({ frameCount: 2 });
    const { sendToWindow } = loadBroadcast([a, b]);

    sendToWindow(a, 'targeted', 42);

    a._frames.forEach((f) => expect(f.sent).toEqual([['targeted', 42]]));
    b._frames.forEach((f) => expect(f.sent).toHaveLength(0));
  });

  test('sendToWindow ignores a destroyed or missing window', () => {
    const dead = makeWindow({ frameCount: 1, destroyed: true });
    const { sendToWindow } = loadBroadcast([dead]);

    expect(() => sendToWindow(dead, 'x')).not.toThrow();
    expect(() => sendToWindow(null, 'x')).not.toThrow();
    expect(dead._frames[0].sent).toHaveLength(0);
  });
});
