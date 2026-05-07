// Cross-post result/status/history comments to a PR created from an issue trigger.
// Also updates the issue status comment with a redirect note.

/** @typedef {import('./types').ActionParams} ActionParams */

const { renderStatusComment } = require('./generate-status-comment');
const {
  listAllComments,
  renderHistoryTocFromComments,
} = require('./generate-history-toc');

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

  // Post a PR-local result comment first so the PR-local status can link to it.
  let prResultUrl = '';
  if (resultBody) {
    const { data: resultComment } = await github.rest.issues.createComment({
      owner, repo, issue_number: prNumber, body: resultBody
    });
    prResultUrl = resultComment.html_url ||
      `https://github.com/${owner}/${repo}/issues/${prNumber}#issuecomment-${resultComment.id}`;
    console.log(`Posted result comment on PR #${prNumber}`);
  }

  // Post status comment on PR. Re-render it so "Read full result" points to
  // the PR-local result comment, not the issue-local result comment.
  if (statusBody) {
    const env = Object.assign({}, process.env, {
      IS_PR: 'true',
      RESULT_COMMENT_URL: prResultUrl,
      RESULT_COMMENT_ID: '',
      REDIRECT_NOTE: '',
    });
    const prStatusBody = renderStatusComment({ env, context }).statusBody;
    await github.rest.issues.createComment({
      owner, repo, issue_number: prNumber, body: prStatusBody
    });
    console.log(`Posted status comment on PR #${prNumber}`);
  }

  // Build/update the PR-local TOC by listing comments on the PR number.
  if (resultBody) {
    const comments = await listAllComments(github, context, prNumber);
    const historyBody = renderHistoryTocFromComments({
      comments: comments.map(comment => Object.assign({ issue_number: prNumber }, comment)),
      botLogin: process.env.BOT_LOGIN || '',
      repoUrl: `https://github.com/${owner}/${repo}`,
    });
    if (historyBody) {
      await github.rest.issues.createComment({
        owner, repo, issue_number: prNumber, body: historyBody
      });
      console.log(`Posted history TOC comment on PR #${prNumber}`);
    }
  } else if (process.env.HISTORY_BODY) {
    await github.rest.issues.createComment({
      owner, repo, issue_number: prNumber, body: process.env.HISTORY_BODY
    });
    console.log(`Posted history comment on PR #${prNumber}`);
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
