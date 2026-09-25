const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { fetchWithRetry, retryAfterMs } = require('./fetch-retry');

/** @param {number} status @param {Record<string, string>} [headers] */
const response = (status, headers = {}) => /** @type {any} */ ({ status, ok: status >= 200 && status < 300, headers: { get: (name) => headers[name.toLowerCase()] ?? null } });

describe('fetchWithRetry', () => {
  it('retries 429 with Retry-After, then returns the success', async () => {
    const statuses = [429, 200];
    const sleeps = /** @type {number[]} */ ([]);
    const result = await fetchWithRetry('u', {}, {
      fetchImpl: /** @type {any} */ (async () => response(statuses.shift() || 200, { 'retry-after': '2' })),
      sleep: async (ms) => { sleeps.push(ms); },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(sleeps, [2000]);
  });

  it('backs off exponentially on gateway errors and caps the delay', async () => {
    const sleeps = /** @type {number[]} */ ([]);
    const result = await fetchWithRetry('u', {}, {
      attempts: 4, baseDelayMs: 1000, maxDelayMs: 3000,
      fetchImpl: /** @type {any} */ (async () => response(503)),
      sleep: async (ms) => { sleeps.push(ms); },
    });
    assert.equal(result.status, 503, 'last response is returned after the final attempt');
    assert.deepEqual(sleeps, [1000, 2000, 3000]);
  });

  it('does not retry client errors like 404', async () => {
    let calls = 0;
    const result = await fetchWithRetry('u', {}, { fetchImpl: /** @type {any} */ (async () => { calls += 1; return response(404); }), sleep: async () => {} });
    assert.equal(result.status, 404);
    assert.equal(calls, 1);
  });

  it('retries network errors and rethrows the last one', async () => {
    let calls = 0;
    await assert.rejects(
      fetchWithRetry('u', {}, { attempts: 3, fetchImpl: /** @type {any} */ (async () => { calls += 1; throw new Error('ECONNRESET'); }), sleep: async () => {} }),
      /ECONNRESET/,
    );
    assert.equal(calls, 3);
  });

  it('parses Retry-After seconds and HTTP dates', () => {
    assert.equal(retryAfterMs('5'), 5000);
    assert.equal(retryAfterMs(new Date(10_000).toUTCString(), 4_000), 6000);
    assert.equal(retryAfterMs('soon'), null);
    assert.equal(retryAfterMs(null), null);
  });
});
