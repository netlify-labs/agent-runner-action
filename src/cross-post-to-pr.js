// Cross-post status and history comments to a PR created from an issue trigger.
// Also updates the issue status comment with a redirect note.

/** @typedef {import('./types').ActionParams} ActionParams */

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

  // Post status comment on PR
  const statusBody = process.env.STATUS_BODY || '';
  if (statusBody) {
    await github.rest.issues.createComment({
      owner, repo, issue_number: prNumber, body: statusBody
    });
    console.log(`Posted status comment on PR #${prNumber}`);
  }

  // Post history comment on PR
  const historyBody = process.env.HISTORY_BODY || '';
  if (historyBody) {
    await github.rest.issues.createComment({
      owner, repo, issue_number: prNumber, body: historyBody
    });
    console.log(`Posted history comment on PR #${prNumber}`);
  }

  // Update issue status comment with redirect note
  const issueCommentId = process.env.STATUS_COMMENT_ID || '';
  if (issueCommentId && statusBody) {
    const note = `> [!NOTE]\n> A Pull Request was opened for this here #${prNumber}.\n>\n> Leave follow-up \`@netlify\` prompts on PR #${prNumber}, or use the [Netlify Agent Runners dashboard](${agentRunUrl}) to continue iterating.`;
    const firstNewline = statusBody.indexOf('\n');
    const noteBody = firstNewline !== -1
      ? statusBody.slice(0, firstNewline) + '\n\n' + note + statusBody.slice(firstNewline)
      : statusBody + '\n\n' + note;
    await github.rest.issues.updateComment({
      owner, repo, comment_id: parseInt(issueCommentId), body: noteBody
    });
    console.log(`Updated issue comment with redirect to PR #${prNumber}`);
  }
};
