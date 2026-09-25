const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createAgentRunnerSdk, AGENT_RUNNER_SDK_HANDLE_VERSION } = require('nax-agent-runner-sdk');
const { deriveKey, checkpointAad, sealHandle } = require('./checkpoint-crypto');
const { parseCheckpoint, renderResultCommentMarker } = require('./comment-markers');
const { recoverRun, waitWithinBudget } = require('./recover-run');

const TOKEN = 'nfp_recover_token';
const real = createAgentRunnerSdk({ transport: /** @type {any} */ ({}), token: 'unused' });
const context = /** @type {any} */ ({ repo: { owner: 'o', repo: 'r' }, eventName: 'issue_comment', payload: {}, actor: 'x' });

let temp;
beforeEach(() => { temp = fs.mkdtempSync(path.join(os.tmpdir(), 'recover-')); });
afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));

function makeHandle({ deadlineAt = 5_000_000_000_000, siteId = 'site1' } = {}) {
  return real.parseHandle({
    v: AGENT_RUNNER_SDK_HANDLE_VERSION, kind: 'run', runnerId: 'runner1', siteId, agent: 'codex',
    input: { siteId, prompt: 'p', agent: 'codex', land: 'pr', deadlineMs: 60000, retryBudget: { capacity: 0 }, requestId: randomUUID() },
    policy: { landing: 'pr', deadlineAt, retryBudget: { capacity: 0 } },
    retries: { capacity: 0 },
    currentSessionId: 'session1',
  });
}

/** @param {{ token?: string, handle?: any, overrides?: Record<string, unknown> }} [options] */
function makeCheckpoint({ token = TOKEN, handle = makeHandle(), overrides = {} } = {}) {
  const { sealed } = sealHandle({ handle, sdk: real, key: deriveKey({ token, repo: 'o/r' }), aad: checkpointAad({ repo: 'o/r', thread: '5', runnerId: 'runner1' }) });
  return /** @type {any} */ ({
    v: 1, state: 'running', runnerId: 'runner1', sessionId: 'session1', kind: 'run', agent: 'codex', mode: 'normal', landing: 'pr',
    deadlineAt: handle.policy.deadlineAt, startedAt: 1, ghRunId: 111, ghRunAttempt: 1, requester: 'DavidWells', kv: 1, handle: sealed, ...overrides,
  });
}

/**
 * @param {{ snapshot?: any, waitResult?: any, waitHangs?: boolean, landing?: any, stopError?: Error }} options
 */
function fakeSdk(options = {}) {
  const calls = /** @type {string[]} */ ([]);
  const session = { sessionId: 'session1', runnerId: 'runner1', state: 'done', prompt: 'p', resultText: 'Did the thing.', agent: 'codex' };
  const sdk = {
    calls,
    parseHandle: real.parseHandle,
    serializeHandle: real.serializeHandle,
    transport: {
      getRunner: async () => { calls.push('getRunner'); return { runnerId: 'runner1', siteId: 'site1', state: 'done' }; },
      listSessions: async () => { calls.push('listSessions'); return [session]; },
    },
    getSnapshot: async () => { calls.push('getSnapshot'); return options.snapshot || { kind: 'terminal', result: { status: 'succeeded', changes: 'changed', resultText: 'Did the thing.', runnerId: 'runner1', sessionId: 'session1', usage: null, links: {} } }; },
    waitFor: async (/** @type {any} */ handle, /** @type {any} */ opts) => {
      calls.push('waitFor');
      if (options.waitHangs) {
        await new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted'))));
      }
      return options.waitResult;
    },
    land: async (/** @type {any} */ handle) => { calls.push('land'); return { handle, landing: options.landing || { kind: 'prOpen', prUrl: 'https://github.com/o/r/pull/77', merged: false } }; },
    stop: async (/** @type {any} */ handle) => { calls.push('stop'); if (options.stopError) throw options.stopError; return handle; },
  };
  return sdk;
}

/**
 * @param {{ runStatus?: string, conclusion?: string, issueState?: string, isPr?: boolean, merged?: boolean, prHeadSha?: string, comments?: any[] }} options
 */
function fakeGithub(options = {}) {
  const calls = /** @type {Array<[string, any]>} */ ([]);
  return {
    calls,
    paginate: async (/** @type {any} */ fn, /** @type {any} */ params) => (await fn(params)).data,
    rest: {
      actions: { getWorkflowRun: async () => ({ data: { status: options.runStatus || 'completed', conclusion: options.conclusion ?? 'failure' } }) },
      issues: {
        get: async () => ({ data: { state: options.issueState || 'open', ...(options.isPr ? { pull_request: {} } : {}) } }),
        listComments: async () => ({ data: options.comments || [] }),
        createComment: async (/** @type {any} */ params) => { calls.push(['createComment', params]); return { data: {} }; },
        updateComment: async (/** @type {any} */ params) => { calls.push(['updateComment', params]); return { data: {} }; },
      },
      pulls: { get: async () => ({ data: { merged: Boolean(options.merged), head: { sha: options.prHeadSha || 'aaaa1111' } } }) },
    },
  };
}

/** @param {any} sdk @param {any} github @param {any} checkpoint @param {Record<string, any>} [extra] */
function run(sdk, github, checkpoint, extra = {}) {
  return recoverRun({
    sdk, github, context, thread: '5', statusCommentId: '42', checkpoint, input: { token: TOKEN, siteId: 'site1' }, budgetMs: 1000,
    env: { RUNNER_TEMP: temp, SITE_NAME: 'site', GITHUB_RUN_ID: '222', GITHUB_RUN_ATTEMPT: '1' }, log: () => {}, pollIntervalMs: 10, ...extra,
  });
}

const status = (/** @type {any} */ github) => github.calls.filter(([name]) => name === 'updateComment').map(([, params]) => params.body).at(-1) || '';

describe('recoverRun', () => {
  it('lands a finished run, posts a recovered result that mentions the requester, and finalizes', async () => {
    const sdk = fakeSdk();
    const github = fakeGithub();
    const result = await run(sdk, github, makeCheckpoint());
    assert.equal(result.outcome, 'finalized');
    assert.ok(sdk.calls.includes('land'));
    assert.ok(!sdk.calls.includes('getRunner'), 'uses the sealed handle, not a rebuild');
    const comment = github.calls.find(([name]) => name === 'createComment')?.[1].body || '';
    assert.match(comment.split('\n')[0], /Agent Run completed\]\(.*\) ✅ · recovered$/);
    assert.match(comment, /@DavidWells, your earlier request finished\./);
    assert.equal(parseCheckpoint(status(github))?.state, 'finalized');
  });

  it('skips while the owning job is still running', async () => {
    const sdk = fakeSdk();
    const result = await run(sdk, fakeGithub({ runStatus: 'in_progress' }), makeCheckpoint());
    assert.deepEqual([result.outcome, result.reason], ['skipped', 'owner-alive']);
    assert.deepEqual(sdk.calls, []);
  });

  it('treats an earlier attempt of this same workflow run as dead', async () => {
    const result = await run(fakeSdk(), fakeGithub({ runStatus: 'in_progress' }), makeCheckpoint({ overrides: { ghRunId: 222, ghRunAttempt: 1 } }), {
      env: { RUNNER_TEMP: temp, GITHUB_RUN_ID: '222', GITHUB_RUN_ATTEMPT: '2' },
    });
    assert.equal(result.outcome, 'finalized');
  });

  it('stops instead of landing when the owner run was cancelled', async () => {
    const sdk = fakeSdk();
    const github = fakeGithub({ conclusion: 'cancelled' });
    const result = await run(sdk, github, makeCheckpoint());
    assert.deepEqual([result.outcome, result.reason], ['stopped', 'owner-cancelled']);
    assert.ok(sdk.calls.includes('stop') && !sdk.calls.includes('land'));
    assert.match(status(github), /Stopped: the workflow was cancelled while the agent was running\./);
    assert.equal(parseCheckpoint(status(github))?.state, 'stopped');
  });

  it('stops and never lands when the thread was closed or merged', async () => {
    const closed = await run(fakeSdk(), fakeGithub({ issueState: 'closed' }), makeCheckpoint());
    assert.deepEqual([closed.outcome, closed.reason], ['stopped', 'thread-closed']);
    const github = fakeGithub({ issueState: 'closed', isPr: true, merged: true });
    await run(fakeSdk(), github, makeCheckpoint());
    assert.match(status(github), /this pull request was merged before the run finished/);
  });

  it('retries a pending stop', async () => {
    const result = await run(fakeSdk(), fakeGithub(), makeCheckpoint({ overrides: { state: 'stop-pending' } }));
    assert.deepEqual([result.outcome, result.reason], ['stopped', 'stop-pending']);
  });

  it('records stop-pending when stopping fails', async () => {
    const github = fakeGithub({ conclusion: 'cancelled' });
    const result = await run(fakeSdk({ stopError: new Error('503'), snapshot: { kind: 'running' } }), github, makeCheckpoint());
    assert.deepEqual([result.outcome, result.reason], ['still-running', 'stop-failed']);
    assert.equal(parseCheckpoint(status(github))?.state, 'stop-pending');
  });

  it('treats a failed stop of an already-finished run as stopped', async () => {
    const github = fakeGithub({ conclusion: 'cancelled' });
    const result = await run(fakeSdk({ stopError: new Error('409 already stopped') }), github, makeCheckpoint());
    assert.deepEqual([result.outcome, result.reason], ['stopped', 'owner-cancelled']);
    assert.equal(parseCheckpoint(status(github))?.state, 'stopped');
  });

  it('honors a bot-authored @netlify stop request instead of landing', async () => {
    const { renderStopRequestMarker } = require('./comment-markers');
    const marker = renderStopRequestMarker({ runnerId: 'runner1', sessionId: 'session1', by: 'octocat' });
    const github = fakeGithub({ comments: [{ user: { login: 'github-actions[bot]' }, body: `⏹ Stopping\n\n${marker}` }] });
    const sdk = fakeSdk();
    const result = await run(sdk, github, makeCheckpoint(), { env: { RUNNER_TEMP: temp, SITE_NAME: 'site', GITHUB_RUN_ID: '222', BOT_LOGIN: 'github-actions[bot]' } });
    assert.deepEqual([result.outcome, result.reason], ['stopped', 'stop-requested']);
    assert.ok(!sdk.calls.includes('land'), 'never lands a stopped run');
    assert.match(status(github), /Stopped by @octocat\./);
  });

  it('ignores a stop-request marker typed by someone other than the bot', async () => {
    const { renderStopRequestMarker } = require('./comment-markers');
    const marker = renderStopRequestMarker({ runnerId: 'runner1', sessionId: 'session1', by: 'octocat' });
    const github = fakeGithub({ comments: [{ user: { login: 'mallory' }, body: marker }] });
    const result = await run(fakeSdk(), github, makeCheckpoint(), { env: { RUNNER_TEMP: temp, SITE_NAME: 'site', GITHUB_RUN_ID: '222', BOT_LOGIN: 'github-actions[bot]' } });
    assert.equal(result.outcome, 'finalized');
  });

  it('stops a run that is past its deadline, keeping the original deadline', async () => {
    const handle = makeHandle({ deadlineAt: 1000 });
    const sdk = fakeSdk({ snapshot: { kind: 'running', runnerId: 'runner1', state: 'running', usage: null } });
    const result = await run(sdk, fakeGithub(), makeCheckpoint({ handle }), { now: () => 2000 });
    assert.deepEqual([result.outcome, result.reason], ['stopped', 'past-deadline']);
  });

  it('waits within its budget, then finalizes', async () => {
    const sdk = fakeSdk({
      snapshot: { kind: 'running', runnerId: 'runner1', state: 'running', usage: null },
      waitResult: { status: 'succeeded', changes: 'unchanged', resultText: 'Done', runnerId: 'runner1', sessionId: 'session1', usage: null, links: {} },
    });
    const result = await run(sdk, fakeGithub(), makeCheckpoint());
    assert.equal(result.outcome, 'finalized');
    assert.ok(sdk.calls.includes('waitFor') && !sdk.calls.includes('land'), 'no changes, nothing to land');
  });

  it('reports still-running when the budget runs out, without touching the deadline', async () => {
    const handle = makeHandle();
    const sdk = fakeSdk({ snapshot: { kind: 'running', runnerId: 'runner1', state: 'running', usage: null }, waitHangs: true });
    const result = await run(sdk, fakeGithub(), makeCheckpoint({ handle }), { budgetMs: 20 });
    assert.deepEqual([result.outcome, result.reason], ['still-running', 'budget-exhausted']);
    assert.equal(result.handle.policy.deadlineAt, handle.policy.deadlineAt);
  });

  it('reports but does not land when the PR head moved', async () => {
    const sdk = fakeSdk();
    const github = fakeGithub({ prHeadSha: 'bbbb2222' });
    const result = await run(sdk, github, makeCheckpoint({ overrides: { prHeadSha: 'aaaa1111', prUrl: 'https://github.com/o/r/pull/9', kind: 'run' } }));
    assert.deepEqual([result.outcome, result.reason], ['finalized', 'pr-head-moved']);
    assert.ok(!sdk.calls.includes('land'));
    assert.match(github.calls.find(([name]) => name === 'createComment')?.[1].body || '', /Not applied: the branch changed after this run started/);
  });

  it('does not post a second result comment for the same session', async () => {
    const marker = renderResultCommentMarker({ runnerId: 'runner1', sessionId: 'session1' });
    const github = fakeGithub({ comments: [{ body: `### [Run #1 | codex | Agent Run completed](x) ✅\n${marker}` }] });
    await run(fakeSdk(), github, makeCheckpoint());
    assert.equal(github.calls.filter(([name]) => name === 'createComment').length, 0);
  });

  it('rebuilds the handle when the sealed one cannot be opened (token rotated)', async () => {
    const sdk = fakeSdk();
    const result = await run(sdk, fakeGithub(), makeCheckpoint({ token: 'old_token' }));
    assert.equal(result.outcome, 'finalized');
    assert.ok(sdk.calls.includes('getRunner'), 'rebuilt from the runner');
  });

  it('skips when the sealed handle belongs to another site', async () => {
    const result = await run(fakeSdk(), fakeGithub(), makeCheckpoint({ handle: makeHandle({ siteId: 'other-site' }) }));
    assert.deepEqual([result.outcome, result.reason], ['skipped', 'mismatch']);
  });

  it('reports a failed run as a failure result', async () => {
    const sdk = fakeSdk({ snapshot: { kind: 'terminal', result: { status: 'failed', runnerId: 'runner1', usage: null, failure: { message: 'agent crashed' } } } });
    const github = fakeGithub();
    const result = await run(sdk, github, makeCheckpoint());
    assert.equal(result.outcome, 'finalized');
    assert.match(github.calls.find(([name]) => name === 'createComment')?.[1].body || '', /with a problem/);
  });
});

describe('waitWithinBudget', () => {
  it('returns null when the budget aborts the wait', async () => {
    const sdk = { waitFor: (/** @type {any} */ _h, /** @type {any} */ opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted')))) };
    assert.equal(await waitWithinBudget({ sdk, handle: {}, token: 't', budgetMs: 5, pollIntervalMs: 1 }), null);
  });

  it('rethrows real errors', async () => {
    const sdk = { waitFor: async () => { throw new Error('boom'); } };
    await assert.rejects(waitWithinBudget({ sdk, handle: {}, token: 't', budgetMs: 1000, pollIntervalMs: 1 }), /boom/);
  });
});

describe('ownerState', () => {
  const { ownerState } = require('./recover-run');
  const checkpoint = /** @type {any} */ ({ ghRunId: 55, ghRunAttempt: 1 });
  /** @param {number} status */
  const failing = (status) => ({ rest: { actions: { getWorkflowRun: async () => { throw Object.assign(new Error('x'), { status }); } } } });

  it('treats a deleted owner run as gone', async () => {
    assert.deepEqual(await ownerState({ github: failing(404), repo: { owner: 'o', repo: 'r' }, checkpoint, env: {} }), { alive: false, conclusion: 'missing' });
  });

  it('treats an owner it cannot inspect (no actions: read) as gone, with unknown conclusion', async () => {
    assert.deepEqual(await ownerState({ github: failing(403), repo: { owner: 'o', repo: 'r' }, checkpoint, env: {} }), { alive: false, conclusion: 'unknown' });
  });

  it('rethrows other lookup errors', async () => {
    await assert.rejects(ownerState({ github: failing(500), repo: { owner: 'o', repo: 'r' }, checkpoint, env: {} }));
  });
});
