// "Handle stop request" step: a comment that is exactly "@netlify stop".
// The stop workflow run is routed outside the thread's concurrency group (so
// it doesn't queue behind the run it stops), which means it is NOT the
// thread's writer: it never edits the status comment. It stops the agent run,
// then replies with a bot-authored stop-request marker. The owning job (or
// recovery, if the owner is gone) reads that marker when it renders the final
// status, and shows "Stopped by @user".

const { createAgentRunnerSdk } = require('nax-agent-runner-sdk');
const { findStopRequest, renderStopRequestMarker } = require('./comment-markers');
const { ownerState, resolveHandle } = require('./recover-run');

const FINISHED_STATES = new Set(['finalized', 'stopped']);

/**
 * Workflow file name of the running workflow, from GITHUB_WORKFLOW_REF
 * ("owner/repo/.github/workflows/file.yml@refs/heads/main").
 * @param {string | undefined} workflowRef
 * @returns {string}
 */
function workflowFileFromRef(workflowRef) {
  const match = /\.github\/workflows\/([^/@]+\.ya?ml)@/.exec(String(workflowRef || ''));
  return match ? match[1] : '';
}

/**
 * @param {{
 *   github: any,
 *   context: { repo: { owner: string, repo: string }, actor?: string, payload?: any },
 *   core: { info: (m: string) => void, warning: (m: string) => void, setOutput: (k: string, v: string) => void },
 *   env?: Record<string, string | undefined>,
 *   sdk?: any,
 * }} params
 * @returns {Promise<{ outcome: 'misplaced' | 'nothing-to-stop' | 'stopped' | 'stop-failed', dispatched?: boolean }>}
 */
async function stopRun({ github, context, core, env = process.env, sdk }) {
  const repo = { owner: context.repo.owner, repo: context.repo.repo };
  const thread = String(env.ISSUE_NUMBER || '');
  const reply = async (/** @type {string} */ body) => {
    if (!/^\d+$/.test(thread)) return;
    await github.rest.issues.createComment({ ...repo, issue_number: Number(thread), body });
  };
  /** @param {Awaited<ReturnType<typeof stopRun>>} result */
  const finish = (result) => {
    core.setOutput('outcome', result.outcome);
    core.info(`Stop request: ${result.outcome}${result.dispatched ? ' (recovery dispatched)' : ''}.`);
    return result;
  };

  if (env.COMMAND === 'stop-misplaced') {
    await reply('Stop only works as its own comment. To stop the agent run, add a new comment containing only `@netlify stop`.');
    return finish({ outcome: 'misplaced' });
  }

  let checkpoint = null;
  try {
    checkpoint = JSON.parse(String(env.CHECKPOINT || ''));
  } catch (_) {
    checkpoint = null;
  }
  if (!checkpoint || FINISHED_STATES.has(checkpoint.state)) {
    await reply('Nothing to stop: the last run already finished.');
    return finish({ outcome: 'nothing-to-stop' });
  }

  const by = String((context.payload && context.payload.comment && context.payload.comment.user && context.payload.comment.user.login) || context.actor || 'unknown');
  const token = String(env.NETLIFY_AUTH_TOKEN || '');
  const client = sdk || createAgentRunnerSdk({ token });
  let stopError = '';
  try {
    const { handle } = await resolveHandle({
      sdk: client,
      checkpoint,
      token,
      siteId: String(env.NETLIFY_SITE_ID || ''),
      repoFullName: `${repo.owner}/${repo.repo}`,
      thread,
      log: (message) => core.info(message),
    });
    await client.stop(handle, { token });
  } catch (error) {
    stopError = /** @type {Error} */ (error).message;
    core.warning(`Stopping Agent Runner ${checkpoint.runnerId} failed: ${stopError}`);
  }

  const marker = renderStopRequestMarker({ runnerId: checkpoint.runnerId, sessionId: checkpoint.sessionId, by });
  const headline = stopError
    ? `⏹ Stop requested by @${by}, but stopping the agent run didn't go through yet. Comment \`@netlify stop\` again to retry.`
    : `⏹ Stopping the agent run, requested by @${by}.`;
  await reply(`${headline}\n\n${marker}`);

  // If the owning job is gone, nobody will render the final status. Dispatch
  // recovery so it happens under the thread's concurrency group.
  let dispatched = false;
  const owner = await ownerState({ github, repo, checkpoint, env: { ...env, GITHUB_RUN_ID: '0' } }).catch(() => ({ alive: true, conclusion: '' }));
  const workflow = workflowFileFromRef(env.GITHUB_WORKFLOW_REF);
  if (!owner.alive && workflow) {
    try {
      const { data } = await github.rest.repos.get(repo);
      await github.rest.actions.createWorkflowDispatch({
        ...repo,
        workflow_id: workflow,
        ref: String(data.default_branch),
        inputs: { recover_thread: thread, actor: by },
      });
      dispatched = true;
    } catch (error) {
      core.info(`Couldn't dispatch recovery (${/** @type {Error} */ (error).message}); the status updates on the next @netlify comment or the recovery scan.`);
    }
  }
  return finish({ outcome: stopError ? 'stop-failed' : 'stopped', dispatched });
}

/**
 * "Check stop request" step (owner job, after the agent step): was this run
 * stopped with @netlify stop? Outputs `by` (the requester) or ''.
 * @param {{ github: any, context: { repo: { owner: string, repo: string } }, core: { setOutput: (k: string, v: string) => void, info: (m: string) => void }, env?: Record<string, string | undefined> }} params
 * @returns {Promise<string>}
 */
async function checkStopRequest({ github, context, core, env = process.env }) {
  const thread = String(env.ISSUE_NUMBER || '');
  const runnerId = String(env.AGENT_ID || '');
  let by = '';
  if (/^\d+$/.test(thread) && runnerId && env.BOT_LOGIN) {
    try {
      const comments = await github.paginate(github.rest.issues.listComments, { owner: context.repo.owner, repo: context.repo.repo, issue_number: Number(thread), per_page: 100 });
      const request = findStopRequest(comments, { botLogin: env.BOT_LOGIN, runnerId });
      by = request ? request.by : '';
    } catch (error) {
      core.info(`Couldn't check for a stop request: ${/** @type {Error} */ (error).message}`);
    }
  }
  if (by) core.info(`Agent Runner ${runnerId} was stopped by @${by}.`);
  core.setOutput('by', by);
  return by;
}

module.exports = stopRun;
module.exports.checkStopRequest = checkStopRequest;
module.exports.workflowFileFromRef = workflowFileFromRef;
