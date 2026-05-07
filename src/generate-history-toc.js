// Generate a bounded rich PR history comment from immutable result comments.
// Sets output: comment-body

const { HISTORY_COMMENT_MARKER, parseResultCommentIdentifiers } = require('./comment-markers');
const { byteLength, truncateAtBoundary } = require('./comment-truncation');
const utils = require('./utils');

const MAX_HISTORY_BODY_LENGTH = 60000;

/**
 * @param {string} body
 * @returns {{
 *   runNumber: string,
 *   model: string,
 *   status: string,
 *   agentRunUrl: string,
 *   title: string,
 *   promptBlock: string,
 *   screenshotHtml: string,
 *   links: string,
 * }}
 */
function parseResultSummary(body) {
  const value = body || '';
  const firstLine = value.split('\n').find(line => line.trim()) || '';
  const runMatch = firstLine.match(/Run #(\d+)\s*\|\s*([^|]+)\s*\|\s*Agent Run\s+([^\]]+)\]\(([^)]+)\)/i);
  const failed = /Agent Run failed|FAILED|❌/i.test(firstLine);
  return {
    runNumber: runMatch ? runMatch[1] : '?',
    model: runMatch ? runMatch[2].trim() : 'agent',
    status: failed ? 'failed' : 'completed',
    agentRunUrl: runMatch ? runMatch[4] : '',
    title: extractResultTitle(value),
    promptBlock: extractPromptBlock(value),
    screenshotHtml: extractScreenshotHtml(value),
    links: normalizeLinks(extractLinks(value)),
  };
}

/**
 * @param {string} value
 * @returns {string}
 */
function formatIso(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

/**
 * @param {string} body
 * @returns {string}
 */
function extractResultTitle(body) {
  const match = body.match(/^### Result(?::\s*(.+))?$/m);
  return match && match[1] ? match[1].trim() : '';
}

/**
 * @param {string} body
 * @returns {string}
 */
function extractPromptBlock(body) {
  const start = body.indexOf('**Prompt:**');
  if (start === -1) return '';
  const afterStart = body.slice(start);
  const end = afterStart.search(/\n### Result\b/);
  return (end === -1 ? afterStart : afterStart.slice(0, end)).trim();
}

/**
 * @param {string} body
 * @returns {string}
 */
function extractScreenshotHtml(body) {
  const match = body.match(/<a href="[^"]+"><img src="[^"]+" alt="Preview" width="[^"]+" align="right"><\/a>/);
  if (!match) return '';
  return match[0].replace(/width="[^"]+"/, 'width="180"');
}

/**
 * @param {string} body
 * @returns {string}
 */
function extractLinks(body) {
  const lines = body.split('\n').map(line => line.trim()).filter(Boolean);
  return lines.find(line => (
    line.includes('[Open Preview](') ||
    line.includes('[Agent run](') ||
    line.includes('[Code Changes](') ||
    line.includes('[Action logs](')
  )) || '';
}

/**
 * @param {string} links
 * @returns {string}
 */
function normalizeLinks(links) {
  return links
    .replace(/\[Open Preview\]/g, '[Open Preview URL]')
    .replace(/\[Agent run\]/g, '[Netlify Agents run]')
    .replace(/ \| /g, ' • ');
}

/**
 * @param {string} value
 * @returns {string}
 */
function formatRunDate(value) {
  return value ? utils.formatRunDate(value) : '';
}

/**
 * @param {import('./types').GitHubClient} github
 * @param {import('./types').ActionContext} context
 * @param {number} issueNumber
 * @returns {Promise<any[]>}
 */
async function listAllComments(github, context, issueNumber) {
  const comments = [];
  for (let page = 1; page < 100; page += 1) {
    const response = await github.rest.issues.listComments({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: issueNumber,
      per_page: 100,
      page,
    });
    const batch = Array.isArray(response.data) ? response.data : [];
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  return comments;
}

/**
 * @param {{comments: any[], botLogin: string, repoUrl: string}} params
 * @returns {string}
 */
function renderHistoryTocFromComments({ comments, botLogin, repoUrl }) {
  const rows = comments
    .filter(comment => {
      const login = comment && comment.user && comment.user.login;
      if (botLogin && login !== botLogin) return false;
      return Boolean(parseResultCommentIdentifiers(comment.body || ''));
    })
    .sort((a, b) => {
      const aTime = new Date(a.created_at || 0).getTime();
      const bTime = new Date(b.created_at || 0).getTime();
      if (aTime !== bTime) return bTime - aTime;
      return Number(b.id || 0) - Number(a.id || 0);
    })
    .map(comment => {
      const summary = parseResultSummary(comment.body || '');
      const when = formatRunDate(comment.created_at);
      const status = summary.status === 'failed' ? '❌' : '✅';
      const datePart = when ? ` at ${when}` : '';
      const runHeader = `${status} \`Run ${summary.runNumber}${datePart} using ${summary.model}\``;
      const parts = [];
      if (summary.screenshotHtml) parts.push(summary.screenshotHtml);
      parts.push(runHeader);
      if (summary.title) parts.push(summary.title);
      if (summary.promptBlock) parts.push(summary.promptBlock);
      if (summary.links) parts.push(summary.links);
      return `${parts.join('\n\n')}\n\n---`;
    });

  if (rows.length === 0) return '';
  const firstSummary = parseResultSummary(rows.length > 0
    ? (comments.find(comment => parseResultCommentIdentifiers(comment.body || '')) || {}).body || ''
    : '');
  const dashboardUrl = firstSummary.agentRunUrl || '';
  const header = [
    '### Netlify Agent Run History',
    '',
    dashboardUrl
      ? `View the full history in [Netlify Agent Run dashboard](${dashboardUrl})`
      : 'Newest runs first. Full run narratives live in the linked result comments.',
    '',
    '---',
    HISTORY_COMMENT_MARKER,
  ];

  const markerBlock = `\n${HISTORY_COMMENT_MARKER}`;
  const prefix = header.slice(0, -1).join('\n');
  const renderedRows = [];
  for (const row of rows) {
    const candidate = [prefix, '', ...renderedRows, row, '', HISTORY_COMMENT_MARKER].join('\n');
    if (byteLength(candidate) > MAX_HISTORY_BODY_LENGTH) break;
    renderedRows.push(row);
  }

  let body = [prefix, '', ...renderedRows, '', HISTORY_COMMENT_MARKER].join('\n');
  if (renderedRows.length === 0) {
    body = `${truncateAtBoundary(prefix, MAX_HISTORY_BODY_LENGTH - byteLength(markerBlock))}${markerBlock}`;
  }
  return body;
}

/**
 * @param {{github: import('./types').GitHubClient, context: import('./types').ActionContext, core: import('./types').ActionCore}} params
 * @returns {Promise<void>}
 */
module.exports = async function generateHistoryToc({ github, context, core }) {
  const issueNumber = parseInt(process.env.ISSUE_NUMBER || '', 10);
  const botLogin = process.env.BOT_LOGIN || '';
  if (!issueNumber) {
    core.setOutput('comment-body', '');
    return;
  }

  const comments = await listAllComments(github, context, issueNumber);
  const repoUrl = `https://github.com/${context.repo.owner}/${context.repo.repo}`;
  const body = renderHistoryTocFromComments({
    comments: comments.map(comment => Object.assign({ issue_number: issueNumber }, comment)),
    botLogin,
    repoUrl,
  });
  core.setOutput('comment-body', body);
};

module.exports.parseResultSummary = parseResultSummary;
module.exports.renderHistoryTocFromComments = renderHistoryTocFromComments;
module.exports.listAllComments = listAllComments;
module.exports.MAX_HISTORY_BODY_LENGTH = MAX_HISTORY_BODY_LENGTH;
