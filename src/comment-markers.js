// Shared helpers for hidden markers embedded in issue and PR comments.

const STATUS_COMMENT_MARKER = '<!-- netlify-agent-run-status -->';
const HISTORY_COMMENT_MARKER = '<!-- netlify-agent-run-history -->';
const RUNNER_ID_MARKER_PREFIX = '<!-- netlify-agent-runner-id:';
const SESSION_DATA_MARKER_PREFIX = '<!-- netlify-agent-session-data:';
const MARKER_SUFFIX = '-->';

/**
 * @param {unknown} body
 * @returns {string}
 */
function normalizeBody(body) {
  return typeof body === 'string' ? body : '';
}

/**
 * @param {unknown} sessionDataMap
 * @returns {Record<string, unknown>}
 */
function normalizeSessionDataMap(sessionDataMap) {
  if (!sessionDataMap) return {};
  if (typeof sessionDataMap === 'string') {
    try {
      return normalizeSessionDataMap(JSON.parse(sessionDataMap));
    } catch (_) {
      return {};
    }
  }
  if (Array.isArray(sessionDataMap) || typeof sessionDataMap !== 'object') {
    return {};
  }
  return /** @type {Record<string, unknown>} */ (sessionDataMap);
}

/**
 * @param {string} markerWithValue
 * @returns {string}
 */
function renderMarker(markerWithValue) {
  return `${markerWithValue} ${MARKER_SUFFIX}`;
}

/**
 * @param {unknown} body
 * @param {string} markerPrefix
 * @returns {string}
 */
function readMarkerValue(body, markerPrefix) {
  const text = normalizeBody(body);
  if (!text) return '';

  const markerStart = text.indexOf(markerPrefix);
  if (markerStart === -1) return '';

  const valueStart = markerStart + markerPrefix.length;
  const markerEnd = text.indexOf(MARKER_SUFFIX, valueStart);
  if (markerEnd !== -1) {
    return text.slice(valueStart, markerEnd).trim();
  }

  // Legacy comments may miss the marker suffix; read to end-of-line.
  const lineEnd = text.indexOf('\n', valueStart);
  return (lineEnd === -1 ? text.slice(valueStart) : text.slice(valueStart, lineEnd)).trim();
}

/**
 * @param {string} [runnerId]
 * @returns {string}
 */
function renderRunnerIdMarker(runnerId = '') {
  return renderMarker(`${RUNNER_ID_MARKER_PREFIX}${runnerId}`);
}

/**
 * @param {unknown} body
 * @returns {string}
 */
function parseRunnerId(body) {
  return readMarkerValue(body, RUNNER_ID_MARKER_PREFIX);
}

/**
 * @param {unknown} sessionDataMap
 * @returns {string}
 */
function renderSessionDataMarker(sessionDataMap) {
  return renderMarker(
    `${SESSION_DATA_MARKER_PREFIX}${JSON.stringify(normalizeSessionDataMap(sessionDataMap))}`
  );
}

/**
 * @param {unknown} body
 * @returns {Record<string, unknown>}
 */
function parseSessionData(body) {
  const rawValue = readMarkerValue(body, SESSION_DATA_MARKER_PREFIX);
  if (!rawValue) return {};

  try {
    return normalizeSessionDataMap(JSON.parse(rawValue));
  } catch (_) {
    return {};
  }
}

/**
 * @param {unknown} body
 * @returns {string}
 */
function parseLinkedPrReference(body) {
  const text = normalizeBody(body);
  if (!text) return '';

  const changesLineMatch = text.match(/(?:Changes in|📎)\s+Pull Request #(\d+)\b/i);
  if (changesLineMatch) return changesLineMatch[1];

  const linkedPrMatch = text.match(/\[(?:Pull Request|PR)\]\(https:\/\/github\.com\/[^)\s]+\/pull\/(\d+)\)/i);
  if (linkedPrMatch) return linkedPrMatch[1];

  return '';
}

module.exports = {
  STATUS_COMMENT_MARKER,
  HISTORY_COMMENT_MARKER,
  RUNNER_ID_MARKER_PREFIX,
  SESSION_DATA_MARKER_PREFIX,
  renderRunnerIdMarker,
  parseRunnerId,
  renderSessionDataMarker,
  parseSessionData,
  parseLinkedPrReference,
};
