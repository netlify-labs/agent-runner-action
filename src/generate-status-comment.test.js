const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderStatusComment } = require('./generate-status-comment');
const { byteLength, STATUS_COMMENT_VISIBLE_BYTES } = require('./comment-truncation');
const { parseRunnerId, parseSessionData, STATUS_COMMENT_MARKER } = require('./comment-markers');

let tempDir;

function context() {
  return { repo: { owner: 'netlify-labs', repo: 'agent-runner-action-example' } };
}

function writeSessions(agentId, sessions) {
  fs.writeFileSync(
    path.join(tempDir, `agent-sessions-${agentId}.json`),
    JSON.stringify(sessions),
    'utf8'
  );
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-status-test-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('renderStatusComment', () => {
  it('renders a short success status with a result link and state markers', () => {
    writeSessions('runner_1', [{
      id: 'session_1',
      title: 'Updated homepage',
      deploy_url: 'https://site.netlify.app',
      agent_config: { agent: 'codex' },
    }]);

    const rendered = renderStatusComment({
      context: context(),
      env: {
        RUNNER_TEMP: tempDir,
        AGENT_ID: 'runner_1',
        SITE_NAME: 'site',
        RESULT_COMMENT_ID: '123',
        AGENT_SCREENSHOT_URL: 'https://site.netlify.app/screenshot.png',
        AGENT_DEPLOY_URL: 'https://site.netlify.app',
        GH_ACTION_URL: 'https://github.com/netlify-labs/agent-runner-action-example/actions/runs/9',
        SESSION_DATA_MAP: '{}',
      },
    });

    const visible = rendered.statusBody.split('<!-- netlify-agent-session-data:')[0].trim();
    assert.ok(byteLength(visible) <= STATUS_COMMENT_VISIBLE_BYTES);
    assert.ok(rendered.statusBody.includes('### [Netlify Agent Run Status](https://app.netlify.com/projects/site/agent-runs/runner_1?session=session_1) ✅'));
    assert.ok(rendered.statusBody.includes('Netlify Agent Run completed.'));
    assert.ok(rendered.statusBody.includes('**Prompt summary:** Updated homepage'));
    assert.ok(rendered.statusBody.includes('[Read full result](#issuecomment-123)'));
    assert.ok(rendered.statusBody.indexOf('<a href="https://site.netlify.app"') < rendered.statusBody.indexOf('Run #1 | codex'));
    assert.equal(parseRunnerId(rendered.statusBody), 'runner_1');
    assert.equal(parseSessionData(rendered.statusBody).session_1.screenshot, 'https://site.netlify.app/screenshot.png');
    assert.ok(rendered.statusBody.includes(STATUS_COMMENT_MARKER));
  });

  it('preserves redirect notes when provided', () => {
    writeSessions('runner_2', [{ id: 'session_2', agent_config: { agent: 'codex' } }]);
    const rendered = renderStatusComment({
      context: context(),
      env: {
        RUNNER_TEMP: tempDir,
        AGENT_ID: 'runner_2',
        SITE_NAME: 'site',
        RESULT_COMMENT_URL: 'https://github.com/o/r/issues/1#issuecomment-555',
        REDIRECT_NOTE: '> Continue on PR #5.',
        SESSION_DATA_MAP: '{}',
      },
    });
    assert.ok(rendered.statusBody.includes('> Continue on PR #5.'));
    assert.ok(rendered.statusBody.includes('https://github.com/o/r/issues/1#issuecomment-555'));
  });

  it('renders failure status comments with state markers', () => {
    writeSessions('runner_3', [{ id: 'session_3', agent_config: { agent: 'codex' } }]);
    const rendered = renderStatusComment({
      context: context(),
      outcome: 'failure',
      env: {
        RUNNER_TEMP: tempDir,
        AGENT_ID: 'runner_3',
        SITE_NAME: 'site',
        RESULT_COMMENT_ID: '777',
        AGENT_ERROR: 'boom',
        FAILURE_CATEGORY: 'unknown',
        FAILURE_STAGE: 'poll-agent',
        SESSION_DATA_MAP: '{}',
      },
    });
    assert.ok(rendered.statusBody.includes('### [Netlify Agent Run Status](https://app.netlify.com/projects/site/agent-runs/runner_3?session=session_3) ❌'));
    assert.ok(rendered.statusBody.includes('Netlify Agent Run failed.'));
    assert.ok(rendered.statusBody.includes('**Failure summary:**'));
    assert.ok(rendered.statusBody.includes('[Read full result](#issuecomment-777)'));
    assert.equal(parseRunnerId(rendered.statusBody), 'runner_3');
  });
});

describe('renderStatusComment failure inference', () => {
  /** @param {Record<string, string>} env */
  function render(env) {
    return renderStatusComment({
      env: { RUNNER_TEMP: tempDir, SITE_NAME: 'site', ...env },
      context: context(),
    }).statusBody;
  }

  it('reports a crashed agent step as failed even without error text', () => {
    const body = render({ AGENT_STEP_OUTCOME: 'failure', AGENT_OUTCOME: '', AGENT_ERROR: '' });
    assert.match(body, /❌/);
    assert.match(body, /Netlify Agent Run failed\./);
    assert.doesNotMatch(body, /completed/);
  });

  it('reports failure and timeout outcomes as failed', () => {
    for (const outcome of ['failure', 'timeout']) {
      assert.match(render({ AGENT_OUTCOME: outcome }), /Netlify Agent Run failed\./, outcome);
    }
  });

  it('reports a failure category (e.g. from preflight) as failed', () => {
    const body = render({ FAILURE_CATEGORY: 'missing-auth-token' });
    assert.match(body, /Netlify Agent Run failed\./);
  });

  it('still reports a real success as completed', () => {
    const body = render({ AGENT_OUTCOME: 'success', AGENT_STEP_OUTCOME: 'success' });
    assert.match(body, /✅/);
    assert.match(body, /Netlify Agent Run completed\./);
  });

  it('does not treat a skipped agent step alone as a failure', () => {
    const body = render({ AGENT_STEP_OUTCOME: 'skipped', AGENT_OUTCOME: '' });
    assert.match(body, /Netlify Agent Run completed\./);
  });
});

describe('renderStatusComment scope line', () => {
  const scope = JSON.stringify({
    flags: [
      { path: 'netlify.toml', display: 'netlify.toml', reason: 'Protected path `**/netlify.toml`', rule: '**/netlify.toml' },
      { path: 'AGENTS.md', display: 'AGENTS.md', reason: 'Protected path `AGENTS.md`', rule: 'AGENTS.md' },
    ],
    requested: [],
  });

  it('adds the one-liner on success', () => {
    const body = renderStatusComment({
      env: { RUNNER_TEMP: tempDir, SITE_NAME: 'site', AGENT_OUTCOME: 'success', SCOPE_RESULT_JSON: scope },
      context: context(),
    }).statusBody;
    assert.match(body, /⚠️ 2 files outside the usual scope\. See the result comment\./);
  });

  it('omits it on failure', () => {
    const body = renderStatusComment({
      env: { RUNNER_TEMP: tempDir, SITE_NAME: 'site', AGENT_OUTCOME: 'failure', SCOPE_RESULT_JSON: scope },
      context: context(),
    }).statusBody;
    assert.doesNotMatch(body, /outside the usual scope/);
  });
});

describe('final status checkpoint merge', () => {
  const { mergeFinalCheckpoint, readLiveCheckpoint } = require('./generate-status-comment');
  const { renderCheckpointMarker, parseCheckpoint } = require('./comment-markers');
  const base = /** @type {any} */ ({
    v: 1, state: 'running', runnerId: 'runner_1', sessionId: 'session_1', kind: 'run', agent: 'codex', mode: 'normal',
    landing: 'pr', deadlineAt: 1, startedAt: 1, ghRunId: 1, ghRunAttempt: 1, requester: 'DavidWells', kv: 1, handle: 'abc',
  });

  it('finalizes a running checkpoint and never regresses stopped or finalized', () => {
    assert.equal(mergeFinalCheckpoint(base, 'runner_1')?.state, 'finalized');
    assert.equal(mergeFinalCheckpoint({ ...base, state: 'stop-pending' }, 'runner_1')?.state, 'finalized');
    assert.equal(mergeFinalCheckpoint({ ...base, state: 'stopped' }, 'runner_1')?.state, 'stopped');
    assert.equal(mergeFinalCheckpoint({ ...base, state: 'finalized' }, 'runner_1')?.state, 'finalized');
  });

  it('leaves a checkpoint for a different runner untouched and handles none', () => {
    assert.equal(mergeFinalCheckpoint(base, 'runner_other')?.state, 'running');
    assert.equal(mergeFinalCheckpoint(null, 'runner_1'), null);
  });

  it('keeps the sealed handle when merging', () => {
    assert.equal(mergeFinalCheckpoint(base, 'runner_1')?.handle, 'abc');
  });

  it('reads the live checkpoint from the status comment, tolerating API errors', async () => {
    const body = `x\n${renderCheckpointMarker(base)}`;
    const ok = { rest: { issues: { getComment: async () => ({ data: { body } }) } } };
    assert.equal((await readLiveCheckpoint(ok, context(), '42'))?.runnerId, 'runner_1');
    const failing = { rest: { issues: { getComment: async () => { throw new Error('boom'); } } } };
    assert.equal(await readLiveCheckpoint(failing, context(), '42'), null);
    assert.equal(await readLiveCheckpoint(ok, context(), ''), null);
  });

  it('renders the merged checkpoint marker in the final status body', () => {
    const body = renderStatusComment({
      env: { RUNNER_TEMP: tempDir, SITE_NAME: 'site', AGENT_OUTCOME: 'success', AGENT_ID: 'runner_1' },
      context: context(),
      checkpoint: mergeFinalCheckpoint(base, 'runner_1'),
    }).statusBody;
    assert.equal(parseCheckpoint(body)?.state, 'finalized');
  });

  it('renders no checkpoint marker for old comments without one', () => {
    const body = renderStatusComment({ env: { RUNNER_TEMP: tempDir, SITE_NAME: 'site' }, context: context() }).statusBody;
    assert.equal(parseCheckpoint(body), null);
  });
});

describe('stopped runs', () => {
  const stoppedCheckpoint = /** @type {any} */ ({
    v: 1, state: 'stopped', runnerId: 'runner_1', sessionId: 'session_1', kind: 'run', agent: 'codex', mode: 'normal',
    landing: 'pr', deadlineAt: 1, startedAt: 1, ghRunId: 1, ghRunAttempt: 1, requester: 'DavidWells', kv: 1,
  });

  it('shows the cancel message instead of a failure when the checkpoint is stopped', () => {
    const body = renderStatusComment({ env: { RUNNER_TEMP: tempDir, SITE_NAME: 'site', AGENT_STEP_OUTCOME: 'failure' }, context: context(), checkpoint: stoppedCheckpoint }).statusBody;
    assert.match(body, /⏹/);
    assert.match(body, /The workflow was cancelled, so the agent run was stopped\./);
    assert.doesNotMatch(body, /Netlify Agent Run failed|Failure summary/);
    assert.match(body, /\| stopped at /);
  });

  it('names who stopped it when a stop request exists', () => {
    const body = renderStatusComment({ env: { RUNNER_TEMP: tempDir, SITE_NAME: 'site', STOP_REQUESTED_BY: 'DavidWells' }, context: context(), checkpoint: stoppedCheckpoint }).statusBody;
    assert.match(body, /Stopped by @DavidWells\./);
  });

  it('notes a stop that arrived after a successful run', () => {
    const finalized = { ...stoppedCheckpoint, state: 'finalized' };
    const body = renderStatusComment({ env: { RUNNER_TEMP: tempDir, SITE_NAME: 'site', AGENT_OUTCOME: 'success', STOP_REQUESTED_BY: 'octocat' }, context: context(), checkpoint: finalized }).statusBody;
    assert.match(body, /Netlify Agent Run completed\. Stop requested by @octocat after the run finished\./);
    assert.match(body, /✅/);
  });

  it('still reports success if the run finished before the stop took effect', () => {
    const body = renderStatusComment({ env: { RUNNER_TEMP: tempDir, SITE_NAME: 'site', AGENT_OUTCOME: 'success' }, context: context(), checkpoint: stoppedCheckpoint }).statusBody;
    assert.match(body, /Netlify Agent Run completed\./);
  });
});

describe('ask-mode status', () => {
  it('shows answered instead of completed', () => {
    const body = renderStatusComment({ env: { RUNNER_TEMP: tempDir, SITE_NAME: 'site', AGENT_OUTCOME: 'success', RUNNER_MODE: 'ask' }, context: context(), outcome: 'success' }).statusBody;
    assert.match(body, /💬/);
    assert.match(body, /Answered\./);
    assert.match(body, /\| answered at /);
    assert.doesNotMatch(body, /completed/);
  });
});


describe('status for a run that failed before finishing', () => {
  it('shows the requested agent, model, and effort when no session file exists', () => {
    const body = renderStatusComment({ env: { RUNNER_TEMP: tempDir, SITE_NAME: 'site', AGENT_ID: 'no_sessions_runner', AGENT_OUTCOME: 'timeout', REQUESTED_AGENT: 'claude', REQUESTED_MODEL_ID: 'claude-fable-5', REQUESTED_EFFORT: 'high' }, context: context(), outcome: 'failure' }).statusBody;
    assert.match(body, /Run #1 \| claude · Fable 5 · high \| failed at /);
  });
});
