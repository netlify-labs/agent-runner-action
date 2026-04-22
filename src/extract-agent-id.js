// Extract existing agent run ID and session data from status comment or PR body.
// Sets outputs: agent-runner-id, session-data-map, agent-run-url, has-linked-pr, linked-pr-number

/** @typedef {import('./types').ActionParams} ActionParams */
const { RUNNER_ID_MARKER_PREFIX } = require('./comment-markers');
const { reconcileAgentState } = require('./state-reconciliation');

/**
 * @param {ActionParams & {inputs: {isPR: string, commentId: string, prNumber: string}}} params
 * @returns {Promise<void>}
 */
module.exports = async function extractAgentId({ github, context, core, inputs }) {
  const isPR = inputs.isPR === 'true';
  const commentId = inputs.commentId;
  const prNumber = inputs.prNumber;
  let statusCommentBody = '';
  let prBody = '';

  // First try: status comment on this issue/PR
  if (commentId) {
    const comment = await github.rest.issues.getComment({
      owner: context.repo.owner, repo: context.repo.repo, comment_id: parseInt(commentId)
    });
    statusCommentBody = comment.data.body || '';
  }

  // Fallback for PRs: check PR body
  if (!statusCommentBody.includes(RUNNER_ID_MARKER_PREFIX) && isPR && prNumber) {
    const pr = await github.rest.pulls.get({
      owner: context.repo.owner, repo: context.repo.repo,
      pull_number: parseInt(prNumber)
    });
    prBody = pr.data.body || '';
  }

  const reconciled = reconcileAgentState({
    isPr: isPR,
    statusCommentBody,
    prBody,
  });

  if (reconciled.warnings.length > 0) {
    console.log(
      `State reconciliation warnings (confidence=${reconciled.confidence}, action=${reconciled.recoveryAction})`
    );
    for (const warning of reconciled.warnings) {
      console.log(`- ${warning}`);
    }
  }

  core.setOutput('agent-runner-id', reconciled.runnerId);
  core.setOutput('session-data-map', JSON.stringify(reconciled.sessionDataMap));

  // Preserve current behavior: prefer explicit URL links from comment/PR body.
  const bodyForUrl = statusCommentBody || prBody;
  const urlMatch = bodyForUrl.match(/\[(?:View agent run|Netlify agent run|Agent run)\]\((https:\/\/app\.netlify\.com\/projects\/[^)]+)\)/);
  core.setOutput('agent-run-url', urlMatch ? urlMatch[1] : reconciled.agentRunUrl);

  if (reconciled.linkedPrNumber) {
    core.setOutput('has-linked-pr', 'true');
    core.setOutput('linked-pr-number', reconciled.linkedPrNumber);
  } else {
    core.setOutput('has-linked-pr', 'false');
    core.setOutput('linked-pr-number', '');
  }
};
