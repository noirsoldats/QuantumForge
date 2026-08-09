/**
 * Per-calculation market read cache
 *
 * Measured on a Cerberus invention run: `findBestDecryptor` evaluates 9
 * options, each calling `calculateManufacturingCost` twice, each pricing ~11
 * materials - ~198 calls to `calculateRealisticPrice` for ~11 distinct items.
 * Every redundant call re-read the same order book from SQLite.
 *
 * The cache sits at the DATABASE READ layer, not on the computed price,
 * because everything that varies per call - quantity, percentile, minVolume,
 * priceModifier - is applied AFTER the fetch. Putting those in a key would
 * shrink the hit rate to nothing; leaving them out would serve wrong prices.
 * Keying only the fetch gives a tiny key AND keeps every price genuinely
 * recomputed.
 *
 * The invariant that matters most: a session lasts exactly one calculation.
 * If one ever outlived its operation, a market refresh could be ignored and
 * the app would price against stale orders with nothing pointing back here.
 */

const path = require('path');

const CACHE = path.join(__dirname, '../../src/main/market-read-cache.js');

let cache;
let reads;

/** A database read that counts how often it actually runs. */
function makeRead(rows = [{ price: 5, volume_remain: 100 }]) {
  return () => {
    reads += 1;
    return rows.map((r) => ({ ...r }));
  };
}

beforeEach(() => {
  jest.resetModules();
  cache = require(CACHE);
  cache.reset();
  reads = 0;
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  cache.reset();
  console.log.mockRestore();
});

describe('session lifetime', () => {
  test('no caching happens outside a session', async () => {
    // Callers that are not part of a calculation must be entirely unaffected.
    const read = makeRead();
    for (let i = 0; i < 5; i += 1) cache.cachedOrders(10000002, 34, null, read);

    expect(reads).toBe(5);
    expect(cache.isActive()).toBe(false);
  });

  test('a session does not survive its calculation', async () => {
    // THE critical invariant: a cached read must never be served to a later
    // calculation, or a market refresh in between is invisible.
    const read = makeRead();

    await cache.withPriceCache(async () => cache.cachedOrders(10000002, 34, null, read));
    await cache.withPriceCache(async () => cache.cachedOrders(10000002, 34, null, read));

    expect(reads).toBe(2);
  });

  test('the session is closed when the calculation returns', async () => {
    await cache.withPriceCache(async () => {
      expect(cache.isActive()).toBe(true);
    });
    expect(cache.isActive()).toBe(false);
  });

  test('the session is closed even when the calculation throws', async () => {
    await expect(
      cache.withPriceCache(async () => { throw new Error('boom'); })
    ).rejects.toThrow('boom');

    expect(cache.isActive()).toBe(false);
  });

  test('the calculation result is passed through', async () => {
    const result = await cache.withPriceCache(async () => 'the answer');
    expect(result).toBe('the answer');
  });
});

describe('nesting', () => {
  test('an inner session joins the outer one', async () => {
    const read = makeRead();

    await cache.withPriceCache(async () => {
      cache.cachedOrders(10000002, 34, null, read);
      await cache.withPriceCache(async () => {
        cache.cachedOrders(10000002, 34, null, read);
      });
      cache.cachedOrders(10000002, 34, null, read);
    });

    expect(reads).toBe(1);
  });

  test('an inner session does not tear down the outer one', async () => {
    // The inner call joins the outer session and returns without closing it,
    // so the outer caller keeps its cache for the rest of its own work.
    await cache.withPriceCache(async () => {
      await cache.withPriceCache(async () => {});
      expect(cache.isActive()).toBe(true);
    });
    expect(cache.isActive()).toBe(false);
  });

  test('a throwing inner session still leaves the outer one open', async () => {
    await cache.withPriceCache(async () => {
      await expect(
        cache.withPriceCache(async () => { throw new Error('inner'); })
      ).rejects.toThrow('inner');
      expect(cache.isActive()).toBe(true);
    });
  });
});

describe('order-book keys', () => {
  test('the same read is issued once', async () => {
    const read = makeRead();
    await cache.withPriceCache(async () => {
      cache.cachedOrders(10000002, 34, null, read);
      cache.cachedOrders(10000002, 34, null, read);
      cache.cachedOrders(10000002, 34, null, read);
    });
    expect(reads).toBe(1);
  });

  test('quantity is NOT part of the key', async () => {
    // The two calculateManufacturingCost calls per decryptor option price the
    // same materials at different quantities - both genuinely needed, since ME
    // rounding is per run-batch. They share one order-book read.
    const read = makeRead();
    await cache.withPriceCache(async () => {
      cache.cachedOrders(10000002, 34, null, read); // qty 1
      cache.cachedOrders(10000002, 34, null, read); // qty 5000
    });
    expect(reads).toBe(1);
  });

  test('different types read separately', async () => {
    const read = makeRead();
    await cache.withPriceCache(async () => {
      cache.cachedOrders(10000002, 34, null, read);
      cache.cachedOrders(10000002, 35, null, read);
    });
    expect(reads).toBe(2);
  });

  test('different regions read separately', async () => {
    const read = makeRead();
    await cache.withPriceCache(async () => {
      cache.cachedOrders(10000002, 34, null, read);
      cache.cachedOrders(10000043, 34, null, read);
    });
    expect(reads).toBe(2);
  });

  test('location filter IS part of the key', async () => {
    // It becomes a WHERE clause, so two calls differing only by station must
    // not share an entry - that would price a station against region-wide
    // orders.
    const read = makeRead();
    await cache.withPriceCache(async () => {
      cache.cachedOrders(10000002, 34, null, read);
      cache.cachedOrders(10000002, 34, { stationId: 60003760 }, read);
      cache.cachedOrders(10000002, 34, { systemId: 30000142 }, read);
    });
    expect(reads).toBe(3);
  });

  test('the same location filter shares an entry', async () => {
    const read = makeRead();
    await cache.withPriceCache(async () => {
      cache.cachedOrders(10000002, 34, { stationId: 60003760 }, read);
      cache.cachedOrders(10000002, 34, { stationId: 60003760 }, read);
    });
    expect(reads).toBe(1);
  });

  test('a null typeId (whole-region read) is distinct from a typed one', async () => {
    const read = makeRead();
    await cache.withPriceCache(async () => {
      cache.cachedOrders(10000002, null, null, read);
      cache.cachedOrders(10000002, 34, null, read);
    });
    expect(reads).toBe(2);
  });
});

describe('history keys', () => {
  test('the same history read is issued once', async () => {
    const read = makeRead([{ date: '2026-01-01', average: 5 }]);
    await cache.withPriceCache(async () => {
      cache.cachedHistory(10000002, 34, null, read);
      cache.cachedHistory(10000002, 34, null, read);
    });
    expect(reads).toBe(1);
  });

  test('day count is part of the key', async () => {
    // A 7-day slice is a different query from a 30-day one.
    const read = makeRead([{ date: '2026-01-01', average: 5 }]);
    await cache.withPriceCache(async () => {
      cache.cachedHistory(10000002, 34, 7, read);
      cache.cachedHistory(10000002, 34, 30, read);
    });
    expect(reads).toBe(2);
  });

  test('orders and history do not collide', async () => {
    const read = makeRead();
    await cache.withPriceCache(async () => {
      cache.cachedOrders(10000002, 34, null, read);
      cache.cachedHistory(10000002, 34, null, read);
    });
    expect(reads).toBe(2);
  });
});

describe('mutation isolation', () => {
  test('callers receive a copy, not the cached array', async () => {
    // Price helpers sort and filter these. Today always on a `filter()`
    // result, but handing out the cached array would let a future in-place
    // `.sort()` corrupt every later hit - surfacing as wrong prices with
    // nothing pointing back to this cache.
    const read = makeRead([{ price: 1 }, { price: 2 }]);

    await cache.withPriceCache(async () => {
      const first = cache.cachedOrders(10000002, 34, null, read);
      first.reverse();
      first.push({ price: 99 });

      const second = cache.cachedOrders(10000002, 34, null, read);
      expect(second).toHaveLength(2);
      expect(second[0].price).toBe(1);
    });

    expect(reads).toBe(1);
  });

  test('history reads are copied too', async () => {
    const read = makeRead([{ date: 'a' }, { date: 'b' }]);

    await cache.withPriceCache(async () => {
      cache.cachedHistory(10000002, 34, null, read).length = 0;
      expect(cache.cachedHistory(10000002, 34, null, read)).toHaveLength(2);
    });
  });
});

describe('the real invention shape', () => {
  test('a Cerberus decryptor sweep collapses ~198 calls to 11 reads', async () => {
    // 9 options (8 decryptors + none) x 2 cost calls x 11 materials.
    const read = makeRead();
    let priceCalls = 0;

    await cache.withPriceCache(async () => {
      for (let option = 0; option < 9; option += 1) {
        for (let costCall = 0; costCall < 2; costCall += 1) {
          for (let material = 0; material < 11; material += 1) {
            priceCalls += 1;
            cache.cachedOrders(10000002, 34 + material, null, read);
          }
        }
      }
    });

    expect(priceCalls).toBe(198);
    expect(reads).toBe(11);
  });

  test('reports its hit rate', async () => {
    const read = makeRead();
    await cache.withPriceCache(async () => {
      cache.cachedOrders(10000002, 34, null, read);
      cache.cachedOrders(10000002, 34, null, read);
      cache.cachedOrders(10000002, 35, null, read);

      expect(cache.getStats()).toEqual({
        orderHits: 1,
        orderMisses: 2,
        historyHits: 0,
        historyMisses: 0,
      });
    });
  });

  test('stats are null outside a session', () => {
    expect(cache.getStats()).toBeNull();
  });
});

/* ------------------------------------------------- concurrent calculations */

/*
 * Several windows can run the same tool at once - two Manufacturing Summaries,
 * or a popped-out What Can I Build? alongside one in the main window.
 *
 * The session used to be a single module-level variable, so the second caller
 * saw it set, treated itself as NESTED, and inherited the first one's cached
 * reads. Since a market refresh can land between two windows' runs, that let
 * one window serve another stale order books - defeating the per-calculation
 * lifetime the cache is built around. The depth counting also went wrong when
 * they finished out of order.
 *
 * Sessions now live in async context, so each calculation is isolated.
 */
describe('isolation between concurrent windows', () => {
  test('two windows calculating at once do NOT share a session', async () => {
    const read = makeRead();

    await Promise.all([
      cache.withPriceCache(async () => {
        cache.cachedOrders(10000002, 34, null, read);
        await new Promise((r) => setTimeout(r, 10));
      }, 'window A'),
      cache.withPriceCache(async () => {
        await new Promise((r) => setTimeout(r, 5));
        cache.cachedOrders(10000002, 34, null, read);
      }, 'window B'),
    ]);

    // Same type, same region - but two independent sessions, so two reads.
    expect(reads).toBe(2);
  });

  test('each window still caches within itself', async () => {
    const read = makeRead();

    await Promise.all([
      cache.withPriceCache(async () => {
        cache.cachedOrders(10000002, 34, null, read);
        await new Promise((r) => setTimeout(r, 5));
        cache.cachedOrders(10000002, 34, null, read); // hit
      }, 'A'),
      cache.withPriceCache(async () => {
        cache.cachedOrders(10000002, 34, null, read);
        await new Promise((r) => setTimeout(r, 5));
        cache.cachedOrders(10000002, 34, null, read); // hit
      }, 'B'),
    ]);

    // One read each, not four.
    expect(reads).toBe(2);
  });

  test('stats belong to the calling window', async () => {
    const read = makeRead();
    const seen = await Promise.all([
      cache.withPriceCache(async () => {
        cache.cachedOrders(10000002, 34, null, read);
        cache.cachedOrders(10000002, 34, null, read);
        await new Promise((r) => setTimeout(r, 5));
        return cache.getStats();
      }, 'A'),
      cache.withPriceCache(async () => {
        cache.cachedOrders(10000002, 99, null, read);
        await new Promise((r) => setTimeout(r, 5));
        return cache.getStats();
      }, 'B'),
    ]);

    expect(seen[0]).toMatchObject({ orderHits: 1, orderMisses: 1 });
    expect(seen[1]).toMatchObject({ orderHits: 0, orderMisses: 1 });
  });

  test('one window throwing does not disturb another', async () => {
    const read = makeRead();
    let survivorHadSession = false;

    await Promise.all([
      cache.withPriceCache(async () => { throw new Error('boom'); }, 'fails')
        .catch(() => {}),
      cache.withPriceCache(async () => {
        await new Promise((r) => setTimeout(r, 5));
        survivorHadSession = cache.isActive();
        cache.cachedOrders(10000002, 34, null, read);
      }, 'survives'),
    ]);

    expect(survivorHadSession).toBe(true);
    expect(reads).toBe(1);
  });

  test('genuine nesting inside ONE operation still shares', async () => {
    // The behaviour the reference counting was for: an operation calling
    // another that also opens a session.
    const read = makeRead();

    await cache.withPriceCache(async () => {
      cache.cachedOrders(10000002, 34, null, read);
      await cache.withPriceCache(async () => {
        cache.cachedOrders(10000002, 34, null, read);
      }, 'inner');
      cache.cachedOrders(10000002, 34, null, read);
    }, 'outer');

    expect(reads).toBe(1);
  });

  test('a session never leaks outside its calculation', async () => {
    await cache.withPriceCache(async () => {
      expect(cache.isActive()).toBe(true);
    }, 'scoped');

    expect(cache.isActive()).toBe(false);
    expect(cache.getStats()).toBeNull();
  });
});
