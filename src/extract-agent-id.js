// Extract existing agent runner ID and session data from status comment or PR body.
// Sets outputs: agent-runner-id, session-data-map, agent-run-url, has-linked-pr, linked-pr-number

/** @typedef {import('./types').ActionParams} ActionParams */

/**
 * @param {ActionParams & {inputs: {isPR: string, commentId: string, prNumber: string}}} params
 * @returns {Promise<void>}
 */
module.exports = async function extractAgentId({ github, context, core, inputs }) {
  const isPR = inputs.isPR === 'true';
  const commentId = inputs.commentId;
  const prNumber = inputs.prNumber;
  let body = '';

  // First try: status comment on this issue/PR
  if (commentId) {
    const comment = await github.rest.issues.getComment({
      owner: context.repo.owner, repo: context.repo.repo, comment_id: parseInt(commentId)
    });
    body = comment.data.body;
  }

  // Fallback for PRs: check PR body
  if (!body.includes('netlify-agent-runner-id') && isPR && prNumber) {
    const pr = await github.rest.pulls.get({
      owner: context.repo.owner, repo: context.repo.repo,
      pull_number: parseInt(prNumber)
    });
    body = pr.data.body || '';
  }

  const runnerMatch = body.match(/<!-- netlify-agent-runner-id:(\w+) -->/);
  core.setOutput('agent-runner-id', runnerMatch ? runnerMatch[1] : '');

  const sessionMatch = body.match(/<!-- netlify-agent-session-data:(.*?) -->/);
  core.setOutput('session-data-map', sessionMatch ? sessionMatch[1] : '{}');

  const urlMatch = body.match(/\[(?:View agent run|Netlify agent run)\]\((https:\/\/app\.netlify\.com\/projects\/[^)]+)\)/);
  core.setOutput('agent-run-url', urlMatch ? urlMatch[1] : '');

  const prMatch = body.match(/(?:Changes in |📎 )(?:Pull Request #(\d+)|\[Pull Request\]\(https:\/\/github\.com\/[^)]+\/pull\/(\d+)\))/);
  if (prMatch) {
    core.setOutput('has-linked-pr', 'true');
    core.setOutput('linked-pr-number', prMatch[1] || prMatch[2]);
  } else {
    core.setOutput('has-linked-pr', 'false');
    core.setOutput('linked-pr-number', '');
  }
};
