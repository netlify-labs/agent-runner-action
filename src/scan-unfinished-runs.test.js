const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { renderCheckpointMarker, STATUS_COMMENT_MARKER } = require('./comment-markers');
const { scanUnfinishedRuns } = require('./scan-unfinished-runs');

/** @param {string} state @param {number} ghRunId */
function statusBody(state, ghRunId, runnerId = 'runner1') {
  const checkpoint = /** @type {any} */ ({
    v: 1, state, runnerId, sessionId: 'session1', kind: 'run', agent: 'codex', mode: 'normal', landing: 'pr',
    deadlineAt: 1, startedAt: 1, ghRunId, ghRunAttempt: 1, requester: 'DavidWells', kv: 1,
  });
  return `status\n${renderCheckpointMarker(checkpoint)}\n${STATUS_COMMENT_MARKER}`;
}

/**
 * @param {{ items: any[], comments: Record<number, any[]>, runs?: Record<number, string>, dispatchError?: Error }} fixture
 */
function fakeGithub(fixture) {
  const calls = /** @type {Array<[string, any]>} */ ([]);
  return {
    calls,
    paginate: async (/** @type {any} */ fn, /** @type {any} */ params) => (await fn(params)).data,
    rest: {
      users: { getAuthenticated: async () => { throw new Error('integration token'); } },
      issues: {
        listForRepo: async (/** @type {any} */ params) => { calls.push(['listForRepo', params]); return { data: fixture.items }; },
        listComments: async (/** @type {any} */ params) => ({ data: fixture.comments[params.issue_number] || [] }),
      },
      actions: {
        getWorkflowRun: async (/** @type {any} */ params) => {
          const status = (fixture.runs || {})[params.run_id];
          if (!status) { const error = /** @type {any} */ (new Error('Not Found')); error.status = 404; throw error; }
          return { data: { status } };
        },
        createWorkflowDispatch: async (/** @type {any} */ params) => { calls.push(['dispatch', params]); if (fixture.dispatchError) throw fixture.dispatchError; return {}; },
      },
      repos: { get: async () => ({ data: { default_branch: 'master' } }) },
    },
  };
}

function fakeCore() {
  const outputs = /** @type {Record<string, string>} */ ({});
  const summaries = /** @type {string[]} */ ([]);
  return { outputs, summaries, info: () => {}, warning: () => {}, setOutput: (/** @type {string} */ k, /** @type {string} */ v) => { outputs[k] = v; }, summary: { addRaw(/** @type {string} */ t) { summaries.push(t); return this; }, write: async () => {} } };
}

const bot = { login: 'github-actions[bot]' };
const context = { repo: { owner: 'o', repo: 'r' } };

describe('scanUnfinishedRuns', () => {
  it('dispatches recover_thread only for unfinished checkpoints whose owner is gone', async () => {
    const github = fakeGithub({
      items: [{ number: 1 }, { number: 2 }, { number: 3 }, { number: 4 }, { number: 5 }],
      comments: {
        1: [{ user: bot, body: statusBody('running', 11) }],        // owner done -> dispatch
        2: [{ user: bot, body: statusBody('running', 22) }],        // owner still running -> skip
        3: [{ user: bot, body: statusBody('finalized', 33) }],      // finished -> ignore
        4: [{ user: { login: 'mallory' }, body: statusBody('running', 44) }], // not bot-authored -> ignore
        5: [{ user: bot, body: statusBody('stop-pending', 55) }],   // owner missing (404) -> dispatch
      },
      runs: { 11: 'completed', 22: 'in_progress' },
    });
    const core = fakeCore();
    const report = await scanUnfinishedRuns({ github, context, core, env: { RECOVER_WORKFLOW: 'netlify-agents.yml' }, now: () => Date.parse('2026-09-25T12:00:00Z') });
    assert.deepEqual(report.map((entry) => [entry.number, entry.action]), [[1, 'dispatched'], [2, 'skipped'], [5, 'dispatched']]);
    const dispatches = github.calls.filter(([name]) => name === 'dispatch').map(([, params]) => params);
    assert.deepEqual(dispatches[0], { owner: 'o', repo: 'r', workflow_id: 'netlify-agents.yml', ref: 'master', inputs: { recover_thread: '1', actor: 'netlify-agent-recovery' } });
    assert.equal(core.outputs.dispatched, '2');
    assert.match(core.summaries.join('\n'), /\| #2 \| `runner1` \| running \| skipped \| owning job still running \|/);
  });

  it('looks back the configured window over open and closed threads, capped', async () => {
    const github = fakeGithub({ items: Array.from({ length: 80 }, (_, index) => ({ number: index + 1 })), comments: {} });
    await scanUnfinishedRuns({ github, context, core: fakeCore(), env: { RECOVER_LOOKBACK_HOURS: '24', RECOVER_MAX_ITEMS: '10' }, now: () => Date.parse('2026-09-25T12:00:00Z') });
    const list = github.calls.find(([name]) => name === 'listForRepo')?.[1];
    assert.equal(list.state, 'all');
    assert.equal(list.since, '2026-09-24T12:00:00.000Z');
  });

  it('reports dispatch failures without throwing', async () => {
    const github = fakeGithub({ items: [{ number: 1 }], comments: { 1: [{ user: bot, body: statusBody('running', 11) }] }, runs: { 11: 'completed' }, dispatchError: new Error('Resource not accessible') });
    const report = await scanUnfinishedRuns({ github, context, core: fakeCore(), env: {} });
    assert.deepEqual([report[0].action, report[0].reason], ['skipped', 'dispatch failed: Resource not accessible']);
  });

  it('reports no unfinished runs', async () => {
    const core = fakeCore();
    await scanUnfinishedRuns({ github: fakeGithub({ items: [], comments: {} }), context, core, env: {} });
    assert.match(core.summaries.join('\n'), /No unfinished runs\./);
    assert.equal(core.outputs.dispatched, '0');
  });
});
