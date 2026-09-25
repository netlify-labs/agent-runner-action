const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createAgentRunnerSdk, AGENT_RUNNER_SDK_HANDLE_VERSION } = require('nax-agent-runner-sdk');
const { deriveKey, checkpointAad, sealHandle } = require('./checkpoint-crypto');
const { parseStopRequest } = require('./comment-markers');
const stopRun = require('./stop-run');

const TOKEN = 'nfp_stop_token';
const real = createAgentRunnerSdk({ transport: /** @type {any} */ ({}), token: 'unused' });

function checkpoint(overrides = {}) {
  const handle = real.parseHandle({
    v: AGENT_RUNNER_SDK_HANDLE_VERSION, kind: 'run', runnerId: 'runner1', siteId: 'site1', agent: 'codex',
    input: { siteId: 'site1', prompt: 'p', agent: 'codex', land: 'pr', deadlineMs: 60000, retryBudget: { capacity: 0 }, requestId: randomUUID() },
    policy: { landing: 'pr', deadlineAt: 5_000_000_000_000, retryBudget: { capacity: 0 } },
    retries: { capacity: 0 },
    currentSessionId: 'session1',
  });
  const { sealed } = sealHandle({ handle, sdk: real, key: deriveKey({ token: TOKEN, repo: 'o/r' }), aad: checkpointAad({ repo: 'o/r', thread: '5', runnerId: 'runner1' }) });
  return JSON.stringify({
    v: 1, state: 'running', runnerId: 'runner1', sessionId: 'session1', kind: 'run', agent: 'codex', mode: 'normal', landing: 'pr',
    deadlineAt: 5_000_000_000_000, startedAt: 1, ghRunId: 111, ghRunAttempt: 1, requester: 'a', kv: 1, handle: sealed, ...overrides,
  });
}

/** @param {{ runStatus?: string, dispatchError?: Error }} [options] */
function fakeGithub(options = {}) {
  const calls = /** @type {Array<[string, any]>} */ ([]);
  return {
    calls,
    rest: {
      actions: {
        getWorkflowRun: async () => ({ data: { status: options.runStatus || 'in_progress', conclusion: null } }),
        createWorkflowDispatch: async (/** @type {any} */ params) => { if (options.dispatchError) throw options.dispatchError; calls.push(['dispatch', params]); },
      },
      repos: { get: async () => ({ data: { default_branch: 'main' } }) },
      issues: { createComment: async (/** @type {any} */ params) => { calls.push(['comment', params]); return { data: {} }; } },
    },
  };
}

function fakeSdk(stopError = /** @type {Error | null} */ (null)) {
  const calls = /** @type {string[]} */ ([]);
  return { calls, parseHandle: real.parseHandle, serializeHandle: real.serializeHandle, stop: async () => { calls.push('stop'); if (stopError) throw stopError; } };
}

function core() {
  const outputs = /** @type {Record<string, string>} */ ({});
  return { outputs, info: () => {}, warning: () => {}, setOutput: (/** @type {string} */ k, /** @type {string} */ v) => { outputs[k] = v; } };
}

const context = { repo: { owner: 'o', repo: 'r' }, actor: 'fallback', payload: { comment: { user: { login: 'octocat' } } } };
const baseEnv = { ISSUE_NUMBER: '5', NETLIFY_AUTH_TOKEN: TOKEN, NETLIFY_SITE_ID: 'site1', GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/netlify-agents.yml@refs/heads/main' };
const comments = (/** @type {any} */ github) => github.calls.filter(([name]) => name === 'comment').map(([, p]) => p.body);

describe('stopRun', () => {
  it('stops the run and replies with a stop-request marker; no dispatch while the owner lives', async () => {
    const github = fakeGithub();
    const sdk = fakeSdk();
    const result = await stopRun({ github, context, core: core(), env: { ...baseEnv, COMMAND: 'stop', CHECKPOINT: checkpoint() }, sdk });
    assert.deepEqual(result, { outcome: 'stopped', dispatched: false });
    assert.deepEqual(sdk.calls, ['stop']);
    const [body] = comments(github);
    assert.match(body, /⏹ Stopping the agent run, requested by @octocat\./);
    assert.deepEqual(parseStopRequest(body), { runnerId: 'runner1', sessionId: 'session1', by: 'octocat' });
    assert.ok(!github.calls.some(([name]) => name === 'dispatch'));
  });

  it('dispatches recovery on the default branch when the owner job is gone', async () => {
    const github = fakeGithub({ runStatus: 'completed' });
    const result = await stopRun({ github, context, core: core(), env: { ...baseEnv, COMMAND: 'stop', CHECKPOINT: checkpoint() }, sdk: fakeSdk() });
    assert.equal(result.dispatched, true);
    const dispatch = github.calls.find(([name]) => name === 'dispatch');
    assert.deepEqual(dispatch && dispatch[1], { owner: 'o', repo: 'r', workflow_id: 'netlify-agents.yml', ref: 'main', inputs: { recover_thread: '5', actor: 'octocat' } });
  });

  it('keeps going when the dispatch is not permitted', async () => {
    const github = fakeGithub({ runStatus: 'completed', dispatchError: Object.assign(new Error('Resource not accessible'), { status: 403 }) });
    const result = await stopRun({ github, context, core: core(), env: { ...baseEnv, COMMAND: 'stop', CHECKPOINT: checkpoint() }, sdk: fakeSdk() });
    assert.deepEqual(result, { outcome: 'stopped', dispatched: false });
  });

  it('still records the request when the stop call fails', async () => {
    const github = fakeGithub();
    const result = await stopRun({ github, context, core: core(), env: { ...baseEnv, COMMAND: 'stop', CHECKPOINT: checkpoint() }, sdk: fakeSdk(new Error('503')) });
    assert.equal(result.outcome, 'stop-failed');
    const [body] = comments(github);
    assert.match(body, /didn't go through yet/);
    assert.ok(parseStopRequest(body));
  });

  for (const [name, env] of /** @type {Array<[string, Record<string, string>]>} */ ([
    ['no checkpoint', { CHECKPOINT: '' }],
    ['finalized', { CHECKPOINT: checkpoint({ state: 'finalized' }) }],
    ['stopped', { CHECKPOINT: checkpoint({ state: 'stopped' }) }],
  ])) {
    it(`replies "Nothing to stop" when ${name}`, async () => {
      const github = fakeGithub();
      const sdk = fakeSdk();
      const result = await stopRun({ github, context, core: core(), env: { ...baseEnv, COMMAND: 'stop', ...env }, sdk });
      assert.equal(result.outcome, 'nothing-to-stop', name);
      assert.deepEqual(sdk.calls, []);
      assert.deepEqual(comments(github), ['Nothing to stop: the last run already finished.']);
    });
  }

  it('explains that stop must be its own comment', async () => {
    const github = fakeGithub();
    const result = await stopRun({ github, context, core: core(), env: { ...baseEnv, COMMAND: 'stop-misplaced' }, sdk: fakeSdk() });
    assert.equal(result.outcome, 'misplaced');
    assert.match(comments(github)[0], /Stop only works as its own comment/);
  });

  it('reads the workflow file from GITHUB_WORKFLOW_REF', () => {
    assert.equal(stopRun.workflowFileFromRef('o/r/.github/workflows/agents.yaml@refs/pull/3/merge'), 'agents.yaml');
    assert.equal(stopRun.workflowFileFromRef(''), '');
  });
});

describe('stop-request marker', () => {
  const { renderStopRequestMarker, findStopRequest, stripUntrustedHtmlComments } = require('./comment-markers');
  it('round-trips and survives the untrusted-comment filter', () => {
    const marker = renderStopRequestMarker({ runnerId: 'r1', sessionId: 's1', by: 'octo-cat' });
    assert.deepEqual(parseStopRequest(marker), { runnerId: 'r1', sessionId: 's1', by: 'octo-cat' });
    assert.equal(stripUntrustedHtmlComments(marker), marker);
  });
  it('rejects invalid fields', () => {
    for (const bad of [{ runnerId: 'r"1', sessionId: 's', by: 'a' }, { runnerId: 'r', sessionId: 's', by: 'a b' }, { runnerId: 'r', sessionId: '', by: 'a' }]) {
      assert.equal(renderStopRequestMarker(/** @type {any} */ (bad)), '', JSON.stringify(bad));
    }
    assert.equal(parseStopRequest('<!-- netlify-agent-stop-request:{"runnerId":"r","sessionId":"s","by":"<script>"} -->'), null);
  });
  it('trusts only the bot and matches the runner, newest first', () => {
    const m = (/** @type {string} */ runnerId, /** @type {string} */ by) => renderStopRequestMarker({ runnerId, sessionId: 's', by });
    const list = [
      { user: { login: 'bot' }, body: m('r1', 'first') },
      { user: { login: 'bot' }, body: m('r1', 'second') },
      { user: { login: 'bot' }, body: m('r2', 'other') },
      { user: { login: 'mallory' }, body: m('r1', 'mallory') },
    ];
    assert.equal(findStopRequest(list, { botLogin: 'bot', runnerId: 'r1' })?.by, 'second');
    assert.equal(findStopRequest(list, { botLogin: 'bot', runnerId: 'r3' }), null);
  });
});

describe('checkStopRequest', () => {
  const { renderStopRequestMarker } = require('./comment-markers');
  const github = (/** @type {any[]} */ list) => ({ paginate: async () => list, rest: { issues: { listComments: () => {} } } });
  const marker = renderStopRequestMarker({ runnerId: 'runner1', sessionId: 's', by: 'octocat' });
  it('outputs the requester for a bot-authored request matching the runner', async () => {
    const c = core();
    const by = await stopRun.checkStopRequest({ github: github([{ user: { login: 'bot' }, body: marker }]), context, core: c, env: { ISSUE_NUMBER: '5', AGENT_ID: 'runner1', BOT_LOGIN: 'bot' } });
    assert.equal(by, 'octocat');
    assert.equal(c.outputs.by, 'octocat');
  });
  it('outputs empty for other runners, other authors, or a missing bot login', async () => {
    for (const [list, env] of /** @type {Array<[any[], any]>} */ ([
      [[{ user: { login: 'bot' }, body: marker }], { ISSUE_NUMBER: '5', AGENT_ID: 'runner2', BOT_LOGIN: 'bot' }],
      [[{ user: { login: 'mallory' }, body: marker }], { ISSUE_NUMBER: '5', AGENT_ID: 'runner1', BOT_LOGIN: 'bot' }],
      [[{ user: { login: 'bot' }, body: marker }], { ISSUE_NUMBER: '5', AGENT_ID: 'runner1' }],
    ])) {
      assert.equal(await stopRun.checkStopRequest({ github: github(list), context, core: core(), env }), '', JSON.stringify(env));
    }
  });
});
