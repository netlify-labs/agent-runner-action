// "Recover unfinished run" step. Runs in a job that holds the thread's
// concurrency group (a new @netlify comment, or a recover_thread dispatch) when
// the thread's checkpoint says the previous run never finished. Finishes it
// first; for a new request, uses at most 40% of the agent time limit so the
// request still has time to run.

const { createAgentRunnerSdk } = require('nax-agent-runner-sdk');
const { recoverRun } = require('./recover-run');

const TRIGGER_SHARE = 0.4;

/**
 * @param {{ command: string, effectiveMinutes: number }} input
 * @returns {number} milliseconds recovery may wait
 */
function recoveryBudgetMs({ command, effectiveMinutes }) {
  const minutes = Number.isFinite(effectiveMinutes) && effectiveMinutes > 0 ? effectiveMinutes : 10;
  const share = command === 'recover' ? 1 : TRIGGER_SHARE;
  return Math.floor(minutes * share * 60 * 1000);
}

/**
 * @param {{ github: any, context: any, core: any, env?: Record<string, string | undefined>, sdk?: any, recover?: typeof recoverRun }} params
 * @returns {Promise<void>}
 */
module.exports = async function recoverStep({ github, context, core, env = process.env, sdk, recover = recoverRun }) {
  core.setOutput('recovered', 'false');
  core.setOutput('blocked', 'false');
  core.setOutput('session-data-map', '');
  let checkpoint;
  try {
    checkpoint = JSON.parse(String(env.CHECKPOINT || ''));
  } catch (_) {
    core.info('No usable checkpoint; nothing to recover.');
    return;
  }
  const command = env.COMMAND || 'run';
  const budgetMs = recoveryBudgetMs({ command, effectiveMinutes: Number(env.EFFECTIVE_TIMEOUT_MINUTES || env.TIMEOUT_MINUTES || 10) });
  const client = sdk || createAgentRunnerSdk({ token: String(env.NETLIFY_AUTH_TOKEN || '') });
  const result = await recover({
    sdk: client,
    github,
    context,
    thread: String(env.ISSUE_NUMBER || ''),
    statusCommentId: String(env.STATUS_COMMENT_ID || ''),
    checkpoint,
    input: { token: String(env.NETLIFY_AUTH_TOKEN || ''), siteId: String(env.NETLIFY_SITE_ID || '') },
    budgetMs,
    env,
    log: (message) => core.info(message),
  });
  core.info(`Recovery outcome: ${result.outcome} (${result.reason}).`);
  core.setOutput('outcome', result.outcome);
  if (result.sessionDataMap) core.setOutput('session-data-map', JSON.stringify(result.sessionDataMap));
  if (result.outcome === 'finalized' || result.outcome === 'stopped') {
    core.setOutput('recovered', 'true');
    return;
  }
  if (result.outcome === 'still-running' && command !== 'recover') {
    core.setOutput('blocked', 'true');
    await github.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: Number(env.ISSUE_NUMBER),
      body: "The previous agent run on this thread is still working, so this request wasn't started. Comment again once it finishes.",
    });
  }
};

module.exports.recoveryBudgetMs = recoveryBudgetMs;
module.exports.TRIGGER_SHARE = TRIGGER_SHARE;
