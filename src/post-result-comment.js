// Post an immutable per-run result comment.
// Sets outputs: result-comment-id, result-comment-url, result-comment-error

/**
 * @param {{github: import('./types').GitHubClient, context: import('./types').ActionContext, core: import('./types').ActionCore}} params
 * @returns {Promise<void>}
 */
module.exports = async function postResultComment({ github, context, core }) {
  const body = process.env.RESULT_BODY || process.env.RESULT_COMMENT_BODY || '';
  const issueNumber = parseInt(process.env.ISSUE_NUMBER || '', 10);

  core.setOutput('result-comment-id', '');
  core.setOutput('result-comment-url', '');
  core.setOutput('result-comment-error', '');

  if (!body.trim()) {
    console.log('No result comment body to post; skipping result comment.');
    return;
  }

  if (!issueNumber) {
    core.setOutput('result-comment-error', 'Missing issue number for result comment');
    console.warn('Missing issue number for result comment; skipping result comment.');
    return;
  }

  try {
    const { data: comment } = await github.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: issueNumber,
      body,
    });

    const id = String(comment.id || '');
    const url = comment.html_url ||
      `https://github.com/${context.repo.owner}/${context.repo.repo}/issues/${issueNumber}#issuecomment-${id}`;
    core.setOutput('result-comment-id', id);
    core.setOutput('result-comment-url', url);
    console.log(`Posted result comment ${id} on #${issueNumber}`);
  } catch (error) {
    const message = error && typeof error === 'object' && 'message' in error
      ? String(error.message)
      : String(error);
    core.setOutput('result-comment-error', message);
    console.warn(`Unable to post result comment: ${message}`);
  }
};
