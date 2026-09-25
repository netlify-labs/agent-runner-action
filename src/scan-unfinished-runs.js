// Recovery scan (operation: recover-scan). Runs on a schedule from the
// optional recovery workflow. Finds threads whose checkpoint says an agent run
// never finished and whose owning job is gone, and dispatches the main
// workflow with recover_thread for each, so recovery runs inside that
// thread's concurrency group (the single writer). It never decrypts or
// recovers anything itself.

const { parseCheckpoint, STATUS_COMMENT_MARKER } = require('./comment-markers');
const { LIVE_RUN_STATES } = require('./recover-run');

const UNFINISHED = new Set(['running', 'stop-pending', 'recovering']);

/**
 * @param {any} github
 * @returns {Promise<string>}
 */
async function botLogin(github) {
  try {
    const { data } = await github.rest.users.getAuthenticated();
    return String(data.login);
  } catch (_) {
    return 'github-actions[bot]';
  }
}

/**
 * @param {{
 *   github: any,
 *   context: { repo: { owner: string, repo: string } },
 *   core: { info: (m: string) => void, warning: (m: string) => void, setOutput: (k: string, v: string) => void, summary?: { addRaw: (t: string) => any, write: () => Promise<unknown> } },
 *   env?: Record<string, string | undefined>,
 *   now?: () => number,
 * }} params
 * @returns {Promise<Array<{ number: number, runnerId: string, state: string, action: 'dispatched' | 'skipped', reason: string }>>}
 */
async function scanUnfinishedRuns({ github, context, core, env = process.env, now = Date.now }) {
  const repo = { owner: context.repo.owner, repo: context.repo.repo };
  const lookbackHours = Math.max(1, Number(env.RECOVER_LOOKBACK_HOURS || 48));
  const maxItems = Math.max(1, Math.min(500, Number(env.RECOVER_MAX_ITEMS || 50)));
  const workflow = String(env.RECOVER_WORKFLOW || 'netlify-agents.yml');
  const since = new Date(now() - lookbackHours * 3600 * 1000).toISOString();
  const login = await botLogin(github);

  const items = (await github.paginate(github.rest.issues.listForRepo, {
    ...repo, state: 'all', sort: 'updated', direction: 'desc', since, per_page: 100,
  })).slice(0, maxItems);

  /** @type {Array<{ number: number, runnerId: string, state: string, action: 'dispatched' | 'skipped', reason: string }>} */
  const report = [];
  let defaultBranch = '';
  for (const item of items) {
    const comments = await github.paginate(github.rest.issues.listComments, { ...repo, issue_number: item.number, per_page: 100 });
    const status = [...comments].reverse().find((/** @type {any} */ comment) =>
      comment.user && comment.user.login === login && String(comment.body || '').includes(STATUS_COMMENT_MARKER));
    if (!status) continue;
    const checkpoint = parseCheckpoint(status.body);
    if (!checkpoint || !UNFINISHED.has(checkpoint.state)) continue;

    let ownerAlive = false;
    try {
      const { data } = await github.rest.actions.getWorkflowRun({ ...repo, run_id: checkpoint.ghRunId });
      ownerAlive = LIVE_RUN_STATES.has(String(data.status));
    } catch (error) {
      if (/** @type {any} */ (error).status !== 404) {
        report.push({ number: item.number, runnerId: checkpoint.runnerId, state: checkpoint.state, action: 'skipped', reason: `owner lookup failed: ${/** @type {Error} */ (error).message}` });
        continue;
      }
    }
    if (ownerAlive) {
      report.push({ number: item.number, runnerId: checkpoint.runnerId, state: checkpoint.state, action: 'skipped', reason: 'owning job still running' });
      continue;
    }

    try {
      if (!defaultBranch) {
        const { data } = await github.rest.repos.get(repo);
        defaultBranch = String(data.default_branch);
      }
      await github.rest.actions.createWorkflowDispatch({
        ...repo,
        workflow_id: workflow,
        ref: defaultBranch,
        inputs: { recover_thread: String(item.number), actor: 'netlify-agent-recovery' },
      });
      report.push({ number: item.number, runnerId: checkpoint.runnerId, state: checkpoint.state, action: 'dispatched', reason: `dispatched ${workflow}` });
    } catch (error) {
      report.push({ number: item.number, runnerId: checkpoint.runnerId, state: checkpoint.state, action: 'skipped', reason: `dispatch failed: ${/** @type {Error} */ (error).message}` });
    }
  }

  const dispatched = report.filter((entry) => entry.action === 'dispatched').length;
  core.info(`Recovery scan: ${items.length} recent thread(s) checked, ${report.length} unfinished, ${dispatched} dispatched.`);
  core.setOutput('dispatched', String(dispatched));
  if (core.summary) {
    const rows = report.map((entry) => `| #${entry.number} | \`${entry.runnerId}\` | ${entry.state} | ${entry.action} | ${entry.reason.replace(/\|/g, '\\|')} |`);
    await core.summary.addRaw([
      '## Netlify Agent Runners recovery scan',
      '',
      `Checked ${items.length} thread(s) updated in the last ${lookbackHours}h.`,
      '',
      ...(rows.length ? ['| Thread | Runner | State | Action | Reason |', '| --- | --- | --- | --- | --- |', ...rows] : ['No unfinished runs.']),
      '',
    ].join('\n')).write();
  }
  return report;
}

module.exports = { UNFINISHED, scanUnfinishedRuns, botLogin };
