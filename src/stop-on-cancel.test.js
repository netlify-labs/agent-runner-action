const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const stopOnCancel = require('./stop-on-cancel');
const { newestHandleFile } = stopOnCancel;
const { parseCheckpoint, parseRunnerId, parseSessionData, renderCheckpointMarker, renderSessionDataMarker, STATUS_COMMENT_MARKER } = require('./comment-markers');

let temp;
beforeEach(() => { temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-cancel-')); });
afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));

const checkpoint = /** @type {any} */ ({
  v: 1, state: 'running', runnerId: 'runner1', sessionId: 'session1', kind: 'run', agent: 'codex', mode: 'normal', landing: 'pr',
  deadlineAt: 1, startedAt: 1, ghRunId: 1, ghRunAttempt: 1, requester: 'DavidWells', kv: 1, handle: 'abc',
});
const previousBody = `in progress\n${renderSessionDataMarker({ session0: { pr_url: 'https://github.com/o/r/pull/3' } })}\n${renderCheckpointMarker(checkpoint)}\n${STATUS_COMMENT_MARKER}`;

function fakes({ stopError } = /** @type {{ stopError?: Error }} */ ({})) {
  const calls = /** @type {any[]} */ ([]);
  const sdk = {
    parseHandle: (/** @type {string} */ text) => JSON.parse(text),
    stop: async (/** @type {any} */ handle) => { calls.push(['stop', handle.runnerId]); if (stopError) throw stopError; return handle; },
  };
  const github = {
    rest: {
      issues: {
        getComment: async () => ({ data: { body: previousBody } }),
        updateComment: async (/** @type {any} */ params) => { calls.push(['update', params]); return { data: {} }; },
      },
    },
  };
  const core = { info: () => {}, warning: (/** @type {string} */ m) => calls.push(['warning', m]) };
  return { calls, sdk, github, core };
}
const context = { repo: { owner: 'o', repo: 'r' } };

describe('stopOnCancel', () => {
  it('stops the saved run and marks the checkpoint stopped', async () => {
    fs.writeFileSync(path.join(temp, 'agent-runner-sdk-handle-runner1.json'), JSON.stringify({ runnerId: 'runner1', currentSessionId: 'session1' }));
    const { calls, sdk, github, core } = fakes();
    const result = await stopOnCancel({ github, context, core, sdk, env: { RUNNER_TEMP: temp, STATUS_COMMENT_ID: '9', SITE_NAME: 'site' } });
    assert.deepEqual(result, { outcome: 'stopped' });
    assert.deepEqual(calls[0], ['stop', 'runner1']);
    const body = calls.find(([kind]) => kind === 'update')[1].body;
    assert.match(body, /The workflow was cancelled, so the agent run was stopped\./);
    assert.equal(parseCheckpoint(body)?.state, 'stopped');
    assert.equal(parseRunnerId(body), 'runner1');
    assert.equal(parseSessionData(body).session0.pr_url, 'https://github.com/o/r/pull/3', 'session data is kept');
  });

  it('records stop-pending when the stop call fails', async () => {
    fs.writeFileSync(path.join(temp, 'agent-runner-sdk-handle-runner1.json'), JSON.stringify({ runnerId: 'runner1', currentSessionId: 'session1' }));
    const { calls, sdk, github, core } = fakes({ stopError: new Error('503') });
    const result = await stopOnCancel({ github, context, core, sdk, env: { RUNNER_TEMP: temp, STATUS_COMMENT_ID: '9' } });
    assert.deepEqual(result, { outcome: 'stop-pending' });
    const body = calls.find(([kind]) => kind === 'update')[1].body;
    assert.equal(parseCheckpoint(body)?.state, 'stop-pending');
    assert.match(body, /will retry the stop/);
  });

  it('does nothing when no run was started', async () => {
    const { calls, sdk, github, core } = fakes();
    assert.deepEqual(await stopOnCancel({ github, context, core, sdk, env: { RUNNER_TEMP: temp } }), { outcome: 'no-run' });
    assert.equal(calls.length, 0);
  });

  it('never throws when the comment update fails', async () => {
    fs.writeFileSync(path.join(temp, 'agent-runner-sdk-handle-runner1.json'), JSON.stringify({ runnerId: 'runner1', currentSessionId: 'session1' }));
    const { calls, sdk, core } = fakes();
    const github = { rest: { issues: { getComment: async () => { throw new Error('boom'); }, updateComment: async () => ({}) } } };
    const result = await stopOnCancel({ github, context, core, sdk, env: { RUNNER_TEMP: temp, STATUS_COMMENT_ID: '9' } });
    assert.equal(result.outcome, 'stopped');
    assert.match(calls.find(([kind]) => kind === 'warning')[1], /Couldn't update the status comment/);
  });

  it('picks the newest handle file', () => {
    const older = path.join(temp, 'agent-runner-sdk-handle-a.json');
    const newer = path.join(temp, 'agent-runner-sdk-handle-b.json');
    fs.writeFileSync(older, '{}');
    fs.writeFileSync(newer, '{}');
    fs.utimesSync(older, new Date(1000), new Date(1000));
    assert.equal(newestHandleFile(temp), newer);
    assert.equal(newestHandleFile(path.join(temp, 'missing')), null);
  });
});

describe('stopOnCancel after the run already landed', () => {
  // GitHub can deliver a cancel a minute late; the agent may finish and open
  // its PR in that window. The status must say so instead of "stopped".
  const landedCheckpoint = { ...checkpoint, prUrl: 'https://github.com/o/r/pull/146', committedSessionIds: ['session1'] };
  function landedFakes(body) {
    const f = fakes();
    f.github.rest.issues.getComment = async () => ({ data: { body } });
    return f;
  }

  it('reports the landed PR (from the checkpoint) and does not claim a stop', async () => {
    fs.writeFileSync(path.join(temp, 'agent-runner-sdk-handle-runner1.json'), JSON.stringify({ runnerId: 'runner1', currentSessionId: 'session1' }));
    const { calls, sdk, github, core } = landedFakes(`x\n${renderCheckpointMarker(landedCheckpoint)}\n${STATUS_COMMENT_MARKER}`);
    const result = await stopOnCancel({ github, context, core, sdk, env: { RUNNER_TEMP: temp, STATUS_COMMENT_ID: '9', SITE_NAME: 'site' } });
    assert.deepEqual(result, { outcome: 'landed-before-cancel' });
    assert.ok(!calls.some(([kind]) => kind === 'stop'), 'a finished run is not stopped');
    const body = calls.find(([kind]) => kind === 'update')[1].body;
    assert.match(body, /cancelled after the agent had already finished, so its changes were applied: \[pull request\]\(https:\/\/github\.com\/o\/r\/pull\/146\)/);
    assert.doesNotMatch(body, /so the agent run was stopped/);
    assert.equal(parseCheckpoint(body)?.state, 'finalized');
  });

  it('uses the saved handle landing when the checkpoint missed it', async () => {
    fs.writeFileSync(path.join(temp, 'agent-runner-sdk-handle-runner1.json'), JSON.stringify({ runnerId: 'runner1', currentSessionId: 'session1', landing: { prUrl: 'https://github.com/o/r/pull/7', committedSessionIds: ['session1'] } }));
    const { calls, sdk, github, core } = fakes();
    assert.deepEqual(await stopOnCancel({ github, context, core, sdk, env: { RUNNER_TEMP: temp, STATUS_COMMENT_ID: '9' } }), { outcome: 'landed-before-cancel' });
    assert.match(calls.find(([kind]) => kind === 'update')[1].body, /pull\/7/);
  });

  it('an earlier session\'s PR does not count as this run landing', () => {
    const { landedPrUrl } = stopOnCancel;
    assert.equal(landedPrUrl({ runnerId: 'runner1', currentSessionId: 'session2' }, /** @type {any} */ ({ ...landedCheckpoint })), null);
    assert.equal(landedPrUrl({ runnerId: 'runner2', currentSessionId: 'session1' }, /** @type {any} */ ({ ...landedCheckpoint })), null, 'another runner');
    assert.equal(landedPrUrl({ runnerId: 'runner1', currentSessionId: 'session1', landing: { prUrl: 'javascript:alert(1)', committedSessionIds: ['session1'] } }, null), null, 'unsafe URL');
  });
});
