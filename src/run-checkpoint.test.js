const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createAgentRunnerSdk, AGENT_RUNNER_SDK_HANDLE_VERSION } = require('nax-agent-runner-sdk');
const { parseCheckpoint, parseSessionData, parseRunnerId, STATUS_COMMENT_MARKER } = require('./comment-markers');
const { deriveKey, checkpointAad, openHandle } = require('./checkpoint-crypto');
const { buildCheckpoint, renderCheckpointStatusBody, writeCheckpoint } = require('./run-checkpoint');

const sdk = createAgentRunnerSdk({ transport: /** @type {any} */ ({}), token: 'unused' });
const TOKEN = 'nfp_test_token';

function handle() {
  return sdk.parseHandle({
    v: AGENT_RUNNER_SDK_HANDLE_VERSION,
    kind: 'run',
    runnerId: 'runner123',
    siteId: 'SITE_CANARY_1',
    agent: 'claude',
    input: { siteId: 'SITE_CANARY_1', prompt: 'PROMPT_CANARY fix it', agent: 'claude', model: 'claude-fable-5', effort: 'high', land: 'pr', deadlineMs: 60000, retryBudget: { capacity: 0 }, requestId: randomUUID() },
    policy: { landing: 'pr', deadlineAt: 1790000000000, retryBudget: { capacity: 0 } },
    retries: { capacity: 0 },
    currentSessionId: 'session123',
    landing: { prUrl: 'https://github.com/o/r/pull/7', committedSessionIds: ['session100'] },
  });
}

const env = {
  GITHUB_REPOSITORY: 'o/r',
  ISSUE_NUMBER: '53',
  GITHUB_RUN_ID: '999',
  GITHUB_RUN_ATTEMPT: '2',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_TOKEN: 'gh_token',
  REQUESTER: 'DavidWells',
  SITE_NAME: 'gtm-services',
  TRIGGER_TEXT: '@netlify fable high fix it',
  MODEL_LABEL: 'Fable 5',
  EFFORT_LABEL: 'high',
  STATUS_COMMENT_ID: '123',
  SESSION_DATA_MAP: JSON.stringify({ session100: { pr_url: 'https://github.com/o/r/pull/7' } }),
};

describe('buildCheckpoint', () => {
  it('builds public fields and a sealed handle that opens back to the same handle', () => {
    const original = handle();
    const { checkpoint } = buildCheckpoint({ handle: original, sdk, token: TOKEN, env, state: 'running', startedAt: 1789998500000, model: 'claude-fable-5', effort: 'high' });
    assert.deepEqual(
      Object.fromEntries(Object.entries(checkpoint).filter(([key]) => key !== 'handle')),
      {
        v: 1, state: 'running', runnerId: 'runner123', sessionId: 'session123', kind: 'run', agent: 'claude',
        mode: 'normal', landing: 'pr', deadlineAt: 1790000000000, startedAt: 1789998500000, ghRunId: 999, ghRunAttempt: 2,
        requester: 'DavidWells', kv: 1, model: 'claude-fable-5', effort: 'high', prUrl: 'https://github.com/o/r/pull/7', committedSessionIds: ['session100'],
      },
    );
    const key = deriveKey({ token: TOKEN, repo: 'o/r' });
    const reopened = openHandle({ sealed: /** @type {string} */ (checkpoint.handle), kv: 1, sdk, key, aad: checkpointAad({ repo: 'o/r', thread: '53', runnerId: 'runner123' }) });
    assert.deepEqual(reopened, original);
  });
});

describe('renderCheckpointStatusBody', () => {
  it('shows the live run link and carries runner, session-data, and checkpoint markers without plaintext secrets', () => {
    const { checkpoint } = buildCheckpoint({ handle: handle(), sdk, token: TOKEN, env, state: 'running', startedAt: 1, model: 'claude-fable-5', effort: 'high' });
    const body = renderCheckpointStatusBody({ checkpoint, env });
    assert.match(body, /\[View the in progress agent run in Netlify\]\(https:\/\/app\.netlify\.com\/projects\/gtm-services\/agent-runs\/runner123\?session=session123\)/);
    assert.match(body, /\*\*Agent:\*\* `claude` · \*\*Model:\*\* Fable 5 · \*\*Effort:\*\* `high`/);
    assert.equal(parseRunnerId(body), 'runner123');
    assert.equal(parseCheckpoint(body)?.state, 'running');
    const sessions = parseSessionData(body);
    assert.equal(sessions.session100.pr_url, 'https://github.com/o/r/pull/7', 'earlier session data is preserved');
    assert.deepEqual(sessions.session123, { agent: 'claude', model: 'claude-fable-5', effort: 'high', mode: 'normal', gh_action_url: 'https://github.com/o/r/actions/runs/999' });
    assert.ok(body.trim().endsWith(STATUS_COMMENT_MARKER));
    assert.doesNotMatch(body, /PROMPT_CANARY|SITE_CANARY/);
  });
});

describe('writeCheckpoint', () => {
  it('PATCHes the status comment with the checkpoint body', async () => {
    /** @type {any[]} */
    const calls = [];
    const fetchImpl = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => { calls.push({ url, init }); return { ok: true, status: 200 }; });
    const result = await writeCheckpoint({ handle: handle(), sdk, token: TOKEN, env, state: 'running', startedAt: 1, fetchImpl, log: () => {} });
    assert.deepEqual(result, { written: true, promptStripped: false });
    assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/issues/comments/123');
    assert.equal(calls[0].init.method, 'PATCH');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer gh_token');
    assert.equal(parseCheckpoint(JSON.parse(calls[0].init.body).body)?.runnerId, 'runner123');
  });

  it('is best-effort: HTTP errors and exceptions return written=false', async () => {
    const logs = /** @type {string[]} */ ([]);
    const http = await writeCheckpoint({ handle: handle(), sdk, token: TOKEN, env, state: 'running', startedAt: 1, fetchImpl: /** @type {any} */ (async () => ({ ok: false, status: 403 })), log: (m) => logs.push(m) });
    assert.deepEqual(http, { written: false, reason: 'status comment update failed' });
    const thrown = await writeCheckpoint({ handle: handle(), sdk, token: TOKEN, env, state: 'running', startedAt: 1, fetchImpl: /** @type {any} */ (async () => { throw new Error('network down'); }), log: (m) => logs.push(m) });
    assert.equal(thrown.written, false);
    assert.match(logs.join('\n'), /HTTP 403[\s\S]*network down/);
  });

  it('skips runs without a status comment or thread', async () => {
    const result = await writeCheckpoint({ handle: handle(), sdk, token: TOKEN, env: { ...env, STATUS_COMMENT_ID: '' }, state: 'running', startedAt: 1, fetchImpl: /** @type {any} */ (async () => { throw new Error('should not be called'); }) });
    assert.equal(result.written, false);
    assert.match(result.reason || '', /not recoverable/);
  });
});
