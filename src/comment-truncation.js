const STATUS_COMMENT_VISIBLE_BYTES = 1000;
const MAX_RESULT_BODY_LENGTH = 60000;

/**
 * @param {string} value
 * @returns {number}
 */
function byteLength(value) {
  return Buffer.byteLength(value || '', 'utf8');
}

/**
 * @param {string} value
 * @param {number} maxBytes
 * @returns {string}
 */
function sliceToBytes(value, maxBytes) {
  if (maxBytes <= 0) return '';
  let used = 0;
  let out = '';
  for (const char of value) {
    const size = byteLength(char);
    if (used + size > maxBytes) break;
    out += char;
    used += size;
  }
  return out;
}

/**
 * @param {string} text
 * @param {number} index
 * @returns {boolean}
 */
function isInsideMarkdownLink(text, index) {
  const linkPattern = /\[[^\]]*\]\([^)]+\)/g;
  let match;
  while ((match = linkPattern.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (index > start && index < end) return true;
  }
  return false;
}

/**
 * @param {string} text
 * @param {number} maxBytes
 * @returns {number}
 */
function findBoundary(text, maxBytes) {
  const capped = sliceToBytes(text, maxBytes);
  const candidates = [
    capped.lastIndexOf('\n\n'),
    capped.lastIndexOf('. '),
    capped.lastIndexOf('! '),
    capped.lastIndexOf('? '),
    capped.lastIndexOf(' '),
  ].filter(index => index > 0);

  for (const index of candidates) {
    const boundary = text[index] === '\n' ? index : index + 1;
    if (!isInsideMarkdownLink(text, boundary)) return boundary;
  }

  for (let index = capped.length; index > 0; index -= 1) {
    if (!isInsideMarkdownLink(text, index)) return index;
  }
  return capped.length;
}

/**
 * @param {string | null | undefined} text
 * @param {number} maxBytes
 * @returns {string}
 */
function truncateAtBoundary(text, maxBytes) {
  const value = String(text || '');
  if (byteLength(value) <= maxBytes) return value;

  const ellipsis = '...';
  const contentBudget = maxBytes - byteLength(ellipsis);
  if (contentBudget <= 0) return sliceToBytes(ellipsis, maxBytes);

  const boundary = findBoundary(value, contentBudget);
  const truncated = value.slice(0, boundary).trimEnd();
  return `${truncated}${ellipsis}`;
}

/**
 * @param {Array<string | undefined>} parts
 * @returns {string}
 */
function joinVisible(parts) {
  return parts.filter(Boolean).join('\n\n').trim();
}

/**
 * @param {string[]} fields
 * @param {number} budget
 * @returns {string[]}
 */
function fitRequiredFields(fields, budget) {
  const required = fields.filter(Boolean);
  if (byteLength(joinVisible(required)) <= budget) return required;

  let longestIndex = -1;
  let longestBytes = -1;
  required.forEach((field, index) => {
    if (/^\[[^\]]+\]\([^)]+\)$/.test(field)) return;
    const size = byteLength(field);
    if (size > longestBytes) {
      longestBytes = size;
      longestIndex = index;
    }
  });

  if (longestIndex === -1) return required;

  const others = required.filter((_, index) => index !== longestIndex);
  const separatorBytes = Math.max(0, required.length - 1) * byteLength('\n\n');
  const remaining = Math.max(0, budget - byteLength(joinVisible(others)) - separatorBytes);
  required[longestIndex] = truncateAtBoundary(required[longestIndex], remaining);
  return required;
}

/**
 * @param {{
 *   header?: string,
 *   subtitle?: string,
 *   screenshot?: string,
 *   title?: string,
 *   links?: string | string[],
 *   redirectNote?: string,
 *   resultCommentLink?: string,
 *   markers?: string | string[],
 *   budget?: number,
 * }} params
 * @returns {string}
 */
function assembleStatusBody({
  header = '',
  subtitle = '',
  screenshot = '',
  title = '',
  links = '',
  redirectNote = '',
  resultCommentLink = '',
  markers = '',
  budget = STATUS_COMMENT_VISIBLE_BYTES,
} = {}) {
  const linkRow = Array.isArray(links) ? links.filter(Boolean).join(' | ') : links;
  const markerBlock = Array.isArray(markers) ? markers.filter(Boolean).join('\n') : markers;

  const required = fitRequiredFields(
    [header, subtitle, title, resultCommentLink, redirectNote].filter(Boolean),
    budget
  );
  const optional = [screenshot, linkRow].filter(Boolean);

  let visible = joinVisible([...required, ...optional]);
  while (byteLength(visible) > budget && optional.length > 0) {
    optional.shift();
    visible = joinVisible([...required, ...optional]);
  }

  if (byteLength(visible) > budget) {
    visible = joinVisible(fitRequiredFields(required, budget));
  }

  return markerBlock
    ? `${visible}\n\n${markerBlock}`.trim()
    : visible;
}

/**
 * @param {string} body
 * @param {string} dashboardUrl
 * @returns {string}
 */
function truncateResultBody(body, dashboardUrl = '') {
  if (byteLength(body) <= MAX_RESULT_BODY_LENGTH) return body;
  const tail = dashboardUrl
    ? `\n\n_Result truncated for GitHub. See the full result in the [Netlify dashboard](${dashboardUrl})._`
    : '\n\n_Result truncated for GitHub. See the full result in the Netlify dashboard._';
  const head = truncateAtBoundary(body, MAX_RESULT_BODY_LENGTH - byteLength(tail));
  return `${head}${tail}`;
}

module.exports = {
  STATUS_COMMENT_VISIBLE_BYTES,
  MAX_RESULT_BODY_LENGTH,
  byteLength,
  truncateAtBoundary,
  assembleStatusBody,
  truncateResultBody,
};
