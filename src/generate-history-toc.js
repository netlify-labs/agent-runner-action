// Generate a compact PR history table of contents from immutable result comments.
// Sets output: comment-body

const { HISTORY_COMMENT_MARKER, parseResultCommentIdentifiers } = require('./comment-markers');

/**
 * @param {string} body
 * @returns {{runNumber: string, model: string, status: string}}
 */
function parseResultSummary(body) {
  const firstLine = (body || '').split('\n').find(line => line.trim()) || '';
  const runMatch = firstLine.match(/Run #(\d+)\s*\|\s*([^|]+)\s*\|\s*Agent Run\s+([^\]]+)/i);
  const failed = /Agent Run failed|FAILED|❌/i.test(firstLine);
  return {
    runNumber: runMatch ? runMatch[1] : '?',
    model: runMatch ? runMatch[2].trim() : 'agent',
    status: failed ? 'failed' : 'completed',
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
      const when = formatIso(comment.created_at);
      const anchor = `${repoUrl}/issues/${comment.issue_number || ''}#issuecomment-${comment.id}`;
      const status = summary.status === 'failed' ? '❌' : '✅';
      return `- ${status} [Run #${summary.runNumber} | ${summary.model}](${anchor})${when ? ` | ${when}` : ''}`;
    });

  if (rows.length === 0) return '';
  return [
    '### Agent Run History',
    '',
    'Newest runs first. Full run narratives live in the linked result comments.',
    '',
    ...rows,
    '',
    HISTORY_COMMENT_MARKER,
  ].join('\n');
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
