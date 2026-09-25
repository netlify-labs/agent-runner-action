// fetch with bounded retries for transient API responses (rate limits and
// gateway errors). Used by preflight's Netlify site check, which otherwise
// failed a whole run on a single HTTP 429.

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/**
 * @param {string | null} header Retry-After value (seconds or HTTP date)
 * @param {number} now
 * @returns {number | null} delay in ms
 */
function retryAfterMs(header, now = Date.now()) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/**
 * @param {string} url
 * @param {RequestInit} init
 * @param {{ attempts?: number, baseDelayMs?: number, maxDelayMs?: number, fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>, log?: (message: string) => void }} [options]
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, init, options = {}) {
  const {
    attempts = 4,
    baseDelayMs = 1000,
    maxDelayMs = 15000,
    fetchImpl = fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log = () => {},
  } = options;
  /** @type {unknown} */
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, init);
      if (!RETRYABLE_STATUS.has(response.status) || attempt === attempts) return response;
      const delay = Math.min(maxDelayMs, retryAfterMs(response.headers.get('retry-after')) ?? baseDelayMs * 2 ** (attempt - 1));
      log(`HTTP ${response.status}; retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1} of ${attempts}).`);
      await sleep(delay);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) throw error;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      log(`Request failed (${/** @type {Error} */ (error).message}); retrying in ${Math.round(delay / 1000)}s.`);
      await sleep(delay);
    }
  }
  throw lastError;
}

module.exports = { RETRYABLE_STATUS, retryAfterMs, fetchWithRetry };
