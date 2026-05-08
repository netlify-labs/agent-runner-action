// Cross-post result/status/history comments to a PR created from an issue trigger.
// Also updates the issue status comment with a redirect note.

/** @typedef {import('./types').ActionParams} ActionParams */

const { renderStatusComment } = require('./generate-status-comment');
const {
  listAllComments,
  renderHistoryPlaceholder,
  renderHistoryTocFromComments,
} = require('./generate-history-toc');
const { HISTORY_COMMENT_MARKER, STATUS_COMMENT_MARKER } = require('./comment-markers');

/**
 * @param {string} statusBody
 * @param {number} prNumber
 * @param {string} agentRunUrl
 * @returns {string}
 */
function insertRedirectNote(statusBody, prNumber, agentRunUrl) {
  const note = `> [!NOTE]\n> A Pull Request was opened for this here #${prNumber}.\n>\n> Leave follow-up \`@netlify\` prompts on PR #${prNumber}, or use the [Netlify Agent Runners dashboard](${agentRunUrl}) to continue iterating.`;
  if (statusBody.includes('Leave follow-up `@netlify` prompts on PR #')) {
    return statusBody;
  }
  const firstNewline = statusBody.indexOf('\n');
  return firstNewline !== -1
    ? statusBody.slice(0, firstNewline) + '\n\n' + note + statusBody.slice(firstNewline)
    : statusBody + '\n\n' + note;
}

/**
 * @param {any[]} comments
 * @param {string} marker
 * @param {string} botLogin
 * @returns {any | null}
 */
function findLatestBotCommentWithMarker(comments, marker, botLogin) {
  const allowedLogins = new Set(
    [botLogin, 'github-actions[bot]', 'netlify-coding[bot]'].filter(Boolean)
  );

  return (comments || [])
    .filter(comment => {
      const login = comment && comment.user && comment.user.login;
      return allowedLogins.has(login) && String(comment.body || '').includes(marker);
    })
    .sort((a, b) => {
      const aTime = new Date(a.created_at || 0).getTime();
      const bTime = new Date(b.created_at || 0).getTime();
      if (aTime !== bTime) return bTime - aTime;
      return Number(b.id || 0) - Number(a.id || 0);
    })[0] || null;
}

/**
 * @param {{
 *   github: import('./types').GitHubClient,
 *   owner: string,
 *   repo: string,
 *   issueNumber: number,
 *   existingComment: any | null,
 *   body: string,
 *   label: string,
 * }} params
 * @returns {Promise<void>}
 */
async function upsertPrComment({ github, owner, repo, issueNumber, existingComment, body, label }) {
  if (existingComment && existingComment.id) {
    await github.rest.issues.updateComment({
      owner,
      repo,
      comment_id: Number(existingComment.id),
      body,
    });
    console.log(`Updated ${label} comment on PR #${issueNumber}`);
    return;
  }

  await github.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });
  console.log(`Posted ${label} comment on PR #${issueNumber}`);
}

/**
 * @param {ActionParams} params
 * @returns {Promise<void>}
 */
module.exports = async function crossPostToPR({ github, context }) {
  const prUrl = process.env.AGENT_PR_URL || '';
  const prNumMatch = prUrl.match(/\/pull\/(\d+)/);
  if (!prNumMatch) return;

  const prNumber = parseInt(prNumMatch[1]);
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const agentId = process.env.AGENT_ID || '';
  const siteName = process.env.SITE_NAME || repo;
  const agentRunUrl = `https://app.netlify.com/projects/${siteName}/agent-runs/${agentId}`;
  const resultBody = process.env.RESULT_BODY || '';
  const statusBody = process.env.STATUS_BODY || '';
  const botLogin = process.env.BOT_LOGIN || '';

  const prComments = await listAllComments(github, context, prNumber);
  const existingStatusComment = findLatestBotCommentWithMarker(prComments, STATUS_COMMENT_MARKER, botLogin);
  const existingHistoryComment = findLatestBotCommentWithMarker(prComments, HISTORY_COMMENT_MARKER, botLogin);

  // On a new PR, create the sticky comments before appending the immutable
  // result comment. Later updates keep those sticky comments above run results
  // in the GitHub timeline.
  let prStatusComment = existingStatusComment;
  let prHistoryComment = existingHistoryComment;
  if (statusBody && !prStatusComment) {
    const env = Object.assign({}, process.env, {
      IS_PR: 'true',
      RESULT_COMMENT_URL: '',
      RESULT_COMMENT_ID: '',
      REDIRECT_NOTE: '',
    });
    const prStatusBody = renderStatusComment({ env, context }).statusBody;
    const { data: comment } = await github.rest.issues.createComment({
      owner, repo, issue_number: prNumber, body: prStatusBody
    });
    prStatusComment = Object.assign({
      issue_number: prNumber,
      user: { login: botLogin || 'github-actions[bot]' },
      body: prStatusBody,
      created_at: new Date().toISOString(),
    }, comment);
    prComments.push(prStatusComment);
    console.log(`Posted status placeholder on PR #${prNumber}`);
  }

  if (resultBody && !prHistoryComment) {
    const body = renderHistoryPlaceholder();
    const { data: comment } = await github.rest.issues.createComment({
      owner, repo, issue_number: prNumber, body
    });
    prHistoryComment = Object.assign({
      issue_number: prNumber,
      user: { login: botLogin || 'github-actions[bot]' },
      body,
      created_at: new Date().toISOString(),
    }, comment);
    prComments.push(prHistoryComment);
    console.log(`Posted history placeholder on PR #${prNumber}`);
  }

  // Post a PR-local result comment after sticky placeholders so the timeline
  // reads status, history, then immutable run result.
  let prResultUrl = '';
  let prResultComment = null;
  if (resultBody) {
    const { data: resultComment } = await github.rest.issues.createComment({
      owner, repo, issue_number: prNumber, body: resultBody
    });
    prResultComment = resultComment;
    prResultUrl = resultComment.html_url ||
      `https://github.com/${owner}/${repo}/issues/${prNumber}#issuecomment-${resultComment.id}`;
    console.log(`Posted result comment on PR #${prNumber}`);
  }

  if (prResultComment && !prComments.some(comment => Number(comment.id) === Number(prResultComment.id))) {
    prComments.push(Object.assign({
      issue_number: prNumber,
      user: { login: botLogin || 'github-actions[bot]' },
      body: resultBody,
      created_at: new Date().toISOString(),
    }, prResultComment));
  }

  // Upsert status comment on PR. Re-render it so "Read full result" points to
  // the PR-local result comment, not the issue-local result comment.
  if (statusBody) {
    const env = Object.assign({}, process.env, {
      IS_PR: 'true',
      RESULT_COMMENT_URL: prResultUrl,
      RESULT_COMMENT_ID: '',
      REDIRECT_NOTE: '',
    });
    const prStatusBody = renderStatusComment({ env, context }).statusBody;
    await upsertPrComment({
      github,
      owner,
      repo,
      issueNumber: prNumber,
      existingComment: prStatusComment,
      body: prStatusBody,
      label: 'status',
    });
  }

  // Build/update the PR-local TOC by listing comments on the PR number.
  if (resultBody) {
    const historyBody = renderHistoryTocFromComments({
      comments: prComments.map(comment => Object.assign({ issue_number: prNumber }, comment)),
      botLogin,
      repoUrl: `https://github.com/${owner}/${repo}`,
    });
    if (historyBody) {
      await upsertPrComment({
        github,
        owner,
        repo,
        issueNumber: prNumber,
        existingComment: prHistoryComment,
        body: historyBody,
        label: 'history TOC',
      });
    }
  } else if (process.env.HISTORY_BODY) {
    await upsertPrComment({
      github,
      owner,
      repo,
      issueNumber: prNumber,
      existingComment: prHistoryComment,
      body: process.env.HISTORY_BODY,
      label: 'history',
    });
  }

  // Update issue status comment with redirect note
  const issueCommentId = process.env.STATUS_COMMENT_ID || '';
  if (issueCommentId && statusBody) {
    const noteBody = insertRedirectNote(statusBody, prNumber, agentRunUrl);
    await github.rest.issues.updateComment({
      owner, repo, comment_id: parseInt(issueCommentId), body: noteBody
    });
    console.log(`Updated issue comment with redirect to PR #${prNumber}`);
  }
};

module.exports.insertRedirectNote = insertRedirectNote;
module.exports.findLatestBotCommentWithMarker = findLatestBotCommentWithMarker;
