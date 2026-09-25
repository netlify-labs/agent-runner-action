const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  AGENT_RUNNER_SDK_VERSION,
  createAgentRunnerSdk,
} = require('nax-agent-runner-sdk');
const {
  CHECKPOINT_FILE_PREFIX,
  ReportedActionError,
  runAgentAction,
  selectLegacyCurrentSession,
} = require('./run-agent');

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'netlify', 'sdk-pr-run.json'),
  'utf8',
));

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runner-action-sdk-'));
}

function actionEnv(runnerTemp, overrides = {}) {
  return {
    NETLIFY_AUTH_TOKEN: 'netlify-secret-token',
    NETLIFY_SITE_ID: 'site-123',
    GITHUB_TOKEN: 'github-secret-token',
    TRIGGER_TEXT: 'Implement the requested change without leaking this prompt.',
    NETLIFY_AGENT: 'codex',
    HEAD_BRANCH: '',
    REPOSITORY_DEFAULT_BRANCH: 'main',
    MAX_WAIT_MINUTES: '10',
    IS_DRY_RUN: 'false',
    EXISTING_RUNNER_ID: '',
    SESSION_DATA_MAP: '{}',
    RUNNER_TEMP: runnerTemp,
    ...overrides,
  };
}

function outputCollector() {
  const outputs = {};
  return {
    outputs,
    setOutput(name, value) {
      outputs[name] = String(value ?? '');
    },
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function publishedPackageRoot() {
  const entry = require.resolve('nax-agent-runner-sdk');
  return path.dirname(path.dirname(entry));
}

describe('published SDK package integration', () => {
  it('loads the exact registry package rather than a workspace link', () => {
    const root = publishedPackageRoot();
    const packageJson = JSON.parse(fs.readFileSync(
      path.join(root, 'package.json'),
      'utf8',
    ));
    assert.equal(AGENT_RUNNER_SDK_VERSION, '0.3.0');
    assert.equal(packageJson.version, '0.3.0');
    assert.match(fs.realpathSync(root), /node_modules\/nax-agent-runner-sdk$/);
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
  });

  it('creates, polls, checkpoints, and lands a changed run as PR-only', async () => {
    const runnerTemp = tempDirectory();
    try {
      let runner = clone(fixture.runner);
      const session = clone(fixture.session);
      const memberActions = [];
      const logs = [];
      const collected = outputCollector();
      const transport = {
        async createRunner(input) {
          session.prompt = input.prompt;
          return runner;
        },
        async createSession() {
          throw new Error('Unexpected follow-up');
        },
        async getRunner() {
          return runner;
        },
        async listRunners() {
          return { items: [runner] };
        },
        async listAccountRunners() {
          return { items: [runner] };
        },
        async getSession() {
          return session;
        },
        async listSessions() {
          return [session];
        },
        async cancelRunner() {},
        async cancelSession() {},
        async member(_runnerId, action) {
          memberActions.push(action);
          if (action === 'diff') {
            return {
              diff: {
                kind: 'inline',
                text: 'diff --git a/fixture.txt b/fixture.txt',
              },
            };
          }
          if (action !== 'pull_request') {
            throw new Error(`Unexpected member action: ${action}`);
          }
          session.commitSha = fixture.pullRequest.commitSha;
          runner = {
            ...runner,
            prUrl: fixture.pullRequest.prUrl,
            prNumber: fixture.pullRequest.prNumber,
            prBranch: fixture.pullRequest.prBranch,
            prIsBeingCreated: false,
          };
          return runner;
        },
      };
      const sdk = createAgentRunnerSdk({
        transport,
        sleep: async () => {},
      });

      const outcome = await runAgentAction({
        env: actionEnv(runnerTemp),
        sdk,
        setOutput: collected.setOutput,
        log: (message) => logs.push(message),
        getScreenshot: async () => 'https://example.netlify.app/screenshot.png',
      });

      assert.equal(outcome.result.status, 'succeeded');
      assert.deepEqual(outcome.landing, {
        kind: 'prOpen',
        prUrl: fixture.pullRequest.prUrl,
        merged: false,
      });
      assert.deepEqual(memberActions, ['diff', 'pull_request']);
      assert.equal(collected.outputs.outcome, 'success');
      assert.equal(collected.outputs['agent-id'], fixture.runner.runnerId);
      assert.equal(
        collected.outputs['agent-pr-url'],
        fixture.pullRequest.prUrl,
      );
      assert.equal(
        collected.outputs['agent-commit-sha'],
        fixture.pullRequest.commitSha,
      );
      assert.equal(collected.outputs['agent-has-diff'], 'true');
      assert.equal(collected.outputs['agent-landing-kind'], 'pr-created');
      assert.equal(
        fs.existsSync(path.join(
          runnerTemp,
          `${CHECKPOINT_FILE_PREFIX}${fixture.runner.runnerId}.json`,
        )),
        true,
      );
      assert.equal(logs.some(message => message.includes('netlify-secret-token')), false);
      assert.equal(logs.some(message => message.includes('without leaking')), false);
    } finally {
      fs.rmSync(runnerTemp, { recursive: true, force: true });
    }
  });
});

describe('follow-up compatibility and session-aware landing', () => {
  it('prefers a comment-recorded session over an unrelated latest API session', () => {
    const known = {
      ...clone(fixture.session),
      sessionId: 'known-session',
    };
    const unrelated = {
      ...clone(fixture.session),
      sessionId: 'unrelated-session',
    };
    assert.equal(
      selectLegacyCurrentSession(
        [known, unrelated],
        { 'known-session': { pr_url: fixture.pullRequest.prUrl } },
      ),
      known,
    );
  });

  it('commits the current follow-up session and never uses runner-level stale merge state', async () => {
    const runnerTemp = tempDirectory();
    try {
      let runner = {
        ...clone(fixture.runner),
        prUrl: fixture.pullRequest.prUrl,
        prNumber: fixture.pullRequest.prNumber,
        prBranch: fixture.pullRequest.prBranch,
        mergeCommitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      };
      const known = {
        ...clone(fixture.session),
        sessionId: 'known-session',
        commitSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      };
      const unrelated = {
        ...clone(fixture.session),
        sessionId: 'unrelated-session',
      };
      let current = unrelated;
      const sessions = [known, unrelated];
      const memberActions = [];
      const collected = outputCollector();
      const transport = {
        async createRunner() {
          throw new Error('Unexpected new run');
        },
        async createSession(runnerId, input) {
          current = {
            ...clone(fixture.session),
            sessionId: 'current-follow-up',
            runnerId,
            prompt: input.prompt,
            commitSha: undefined,
          };
          sessions.push(current);
          return current;
        },
        async getRunner() {
          return runner;
        },
        async listRunners() {
          return { items: [runner] };
        },
        async listAccountRunners() {
          return { items: [runner] };
        },
        async getSession(_runnerId, sessionId) {
          return sessions.find(session => session.sessionId === sessionId);
        },
        async listSessions() {
          return sessions;
        },
        async cancelRunner() {},
        async cancelSession() {},
        async member(_runnerId, action) {
          memberActions.push(action);
          if (action === 'diff') {
            return {
              diff: {
                kind: 'inline',
                text: 'diff --git a/fixture.txt b/fixture.txt',
              },
            };
          }
          if (action !== 'commit') {
            throw new Error(`Unexpected member action: ${action}`);
          }
          current.commitSha = fixture.pullRequest.commitSha;
          runner = { ...runner, mergeCommitIsBeingCreated: false };
          return runner;
        },
      };
      const sdk = createAgentRunnerSdk({
        transport,
        sleep: async () => {},
      });

      const outcome = await runAgentAction({
        env: actionEnv(runnerTemp, {
          EXISTING_RUNNER_ID: fixture.runner.runnerId,
          SESSION_DATA_MAP: JSON.stringify({
            'known-session': { pr_url: fixture.pullRequest.prUrl },
          }),
        }),
        sdk,
        setOutput: collected.setOutput,
        log: () => {},
        getScreenshot: async () => '',
      });

      assert.equal(outcome.handle.currentSessionId, 'current-follow-up');
      assert.deepEqual(memberActions, ['diff', 'commit']);
      assert.equal(
        collected.outputs['agent-commit-sha'],
        fixture.pullRequest.commitSha,
      );
      assert.notEqual(
        collected.outputs['agent-commit-sha'],
        runner.mergeCommitSha,
      );
      assert.equal(collected.outputs['agent-pr-url'], fixture.pullRequest.prUrl);
    } finally {
      fs.rmSync(runnerTemp, { recursive: true, force: true });
    }
  });
});

describe('effort forwarding', () => {
  function dryRunTransport(calls) {
    const runner = clone(fixture.runner);
    const known = { ...clone(fixture.session), sessionId: 'known-session' };
    let current = clone(fixture.session);
    const sessions = [known];
    return {
      async createRunner(input) {
        calls.createRunner.push(input);
        current.prompt = input.prompt;
        if (input.effort !== undefined) current.effort = input.effort;
        if (input.model !== undefined) current.model = input.model;
        sessions.push(current);
        return runner;
      },
      async createSession(runnerId, input) {
        calls.createSession.push(input);
        current = {
          ...clone(fixture.session),
          sessionId: 'current-follow-up',
          runnerId,
          prompt: input.prompt,
          ...(input.effort === undefined ? {} : { effort: input.effort }),
          ...(input.model === undefined ? {} : { model: input.model }),
        };
        sessions.push(current);
        return current;
      },
      async getRunner() {
        return runner;
      },
      async listRunners() {
        return { items: [runner] };
      },
      async listAccountRunners() {
        return { items: [runner] };
      },
      async getSession(_runnerId, sessionId) {
        return sessions.find(session => session.sessionId === sessionId) || current;
      },
      async listSessions() {
        return sessions;
      },
      async cancelRunner() {},
      async cancelSession() {},
      async member(_runnerId, action) {
        if (action === 'diff') {
          return {
            diff: { kind: 'inline', text: 'diff --git a/fixture.txt b/fixture.txt' },
          };
        }
        throw new Error(`Unexpected member action: ${action}`);
      },
    };
  }

  async function runWith(overrides, calls = { createRunner: [], createSession: [] }, extra = {}) {
    const runnerTemp = tempDirectory();
    try {
      const sdk = createAgentRunnerSdk({
        transport: dryRunTransport(calls),
        sleep: async () => {},
      });
      const collected = outputCollector();
      await runAgentAction({
        env: actionEnv(runnerTemp, { IS_DRY_RUN: 'true', ...overrides }),
        sdk,
        setOutput: collected.setOutput,
        log: () => {},
        getScreenshot: async () => '',
        ...extra,
      });
      calls.outputs = collected.outputs;
      return calls;
    } finally {
      fs.rmSync(runnerTemp, { recursive: true, force: true });
    }
  }

  it('ask mode sends mode ask with land none and never lands, even with changes', async () => {
    const calls = await runWith({ RUNNER_MODE: 'ask', IS_DRY_RUN: 'false' });
    assert.equal(calls.createRunner.length, 1);
    assert.equal(calls.createRunner[0].mode, 'ask');
    // The dry-run transport throws on any landing member action, so reaching
    // here means sdk.land was never called.
    assert.equal(calls.outputs['agent-ask-discarded-changes'], 'true');
    assert.equal(calls.outputs['agent-pr-url'], '');
    assert.equal(calls.outputs['agent-landing-kind'], 'none');
    assert.equal(calls.outputs.outcome, 'success');
  });

  it('ask mode follow-ups send mode ask; normal runs send no mode', async () => {
    const followUp = { EXISTING_RUNNER_ID: fixture.runner.runnerId, SESSION_DATA_MAP: JSON.stringify({ 'known-session': {} }) };
    const ask = await runWith({ ...followUp, RUNNER_MODE: 'ask', IS_DRY_RUN: 'false' });
    assert.equal(ask.createSession[0].mode, 'ask');
    const normal = await runWith({ RUNNER_MODE: 'normal' });
    assert.equal('mode' in normal.createRunner[0], false);
    assert.equal(normal.outputs['agent-ask-discarded-changes'], 'false');
  });

  it('forwards an explicit effort when creating a runner', async () => {
    const calls = await runWith({ NETLIFY_EFFORT: 'high' });
    assert.equal(calls.createRunner.length, 1);
    assert.equal(calls.createRunner[0].effort, 'high');
    assert.equal(calls.createRunner[0].agent, 'codex');
  });

  it('omits effort for backend Auto when none is selected', async () => {
    const calls = await runWith({ NETLIFY_EFFORT: '' });
    assert.equal(calls.createRunner.length, 1);
    assert.equal('effort' in calls.createRunner[0], false);
  });

  it('forwards effort on follow-ups only when one is given', async () => {
    const followUp = {
      EXISTING_RUNNER_ID: fixture.runner.runnerId,
      SESSION_DATA_MAP: JSON.stringify({ 'known-session': {} }),
    };
    const withEffort = await runWith({ ...followUp, NETLIFY_EFFORT: 'xhigh' });
    assert.equal(withEffort.createSession.length, 1);
    assert.equal(withEffort.createSession[0].effort, 'xhigh');

    const withoutEffort = await runWith(followUp);
    assert.equal(withoutEffort.createSession.length, 1);
    assert.equal('effort' in withoutEffort.createSession[0], false);
  });

  it('forwards an explicit model with effort when creating a runner', async () => {
    const calls = await runWith({ NETLIFY_AGENT: 'claude', NETLIFY_MODEL: 'claude-fable-5', NETLIFY_EFFORT: 'high' });
    assert.equal(calls.createRunner.length, 1);
    assert.equal(calls.createRunner[0].agent, 'claude');
    assert.equal(calls.createRunner[0].model, 'claude-fable-5');
    assert.equal(calls.createRunner[0].effort, 'high');
  });

  it('omits model for backend Auto when none is selected', async () => {
    const calls = await runWith({ NETLIFY_MODEL: '' });
    assert.equal('model' in calls.createRunner[0], false);
  });

  it('forwards model on follow-ups only when one is given', async () => {
    const followUp = {
      EXISTING_RUNNER_ID: fixture.runner.runnerId,
      SESSION_DATA_MAP: JSON.stringify({ 'known-session': {} }),
    };
    const withModel = await runWith({ ...followUp, NETLIFY_AGENT: 'claude', NETLIFY_MODEL: 'claude-sonnet-5' });
    assert.equal(withModel.createSession[0].model, 'claude-sonnet-5');
    const withoutModel = await runWith(followUp);
    assert.equal('model' in withoutModel.createSession[0], false);
  });

  it('forwards a tilde model ID and a translated wire effort unchanged', async () => {
    const calls = await runWith({
      NETLIFY_AGENT: 'opencode',
      NETLIFY_MODEL: '~deepseek/deepseek-v4-flash-latest',
      NETLIFY_EFFORT: 'xhigh',
    });
    assert.equal(calls.createRunner[0].agent, 'opencode');
    assert.equal(calls.createRunner[0].model, '~deepseek/deepseek-v4-flash-latest');
    assert.equal(calls.createRunner[0].effort, 'xhigh');
  });

  it('rejects an over-long model ID before any SDK call', async () => {
    const calls = { createRunner: [], createSession: [] };
    await assert.rejects(
      runWith({ NETLIFY_MODEL: `m${'x'.repeat(128)}` }, calls),
      ReportedActionError,
    );
    assert.equal(calls.createRunner.length, 0);
  });

  it('rejects malformed model values before any SDK call', async () => {
    const calls = { createRunner: [], createSession: [] };
    await assert.rejects(
      runWith({ NETLIFY_MODEL: 'fable; echo' }, calls),
      ReportedActionError,
    );
    assert.equal(calls.createRunner.length, 0);
  });

  it('appends the scope block to the prompt sent to the agent', async () => {
    const calls = await runWith({ TRIGGER_TEXT: 'Fix the header', SCOPE_BLOCK: '\n\n---\nScope guidance from this repository\'s workflow:\nOnly modify needed files.' });
    assert.match(calls.createRunner[0].prompt, /^Fix the header\n\n---\nScope guidance from this repository's workflow:\nOnly modify needed files\./);
    const without = await runWith({ TRIGGER_TEXT: 'Fix the header', SCOPE_BLOCK: '' });
    assert.doesNotMatch(without.createRunner[0].prompt, /Scope guidance/);
  });

  it('writes the checkpoint to the status comment right after start', async () => {
    const patches = [];
    const fetchImpl = async (url, init) => { patches.push({ url, body: JSON.parse(init.body).body }); return { ok: true, status: 200 }; };
    const calls = await runWith(
      { STATUS_COMMENT_ID: '555', ISSUE_NUMBER: '53', GITHUB_REPOSITORY: 'o/r', SITE_NAME: 'site', REQUESTER: 'DavidWells', GITHUB_RUN_ID: '1' },
      undefined,
      { fetchImpl },
    );
    assert.ok(patches.length >= 1);
    assert.equal(patches[0].url, 'https://api.github.com/repos/o/r/issues/comments/555');
    assert.match(patches[0].body, /<!-- netlify-agent-run-checkpoint:\{"v":1,"state":"running"/);
    assert.match(patches[0].body, /View the in progress agent run in Netlify/);
    assert.equal(calls.outputs['checkpoint-written'], 'true');
    assert.equal(calls.outputs.outcome, 'success');
  });

  it('keeps running when the checkpoint write fails', async () => {
    const fetchImpl = async () => ({ ok: false, status: 500 });
    const calls = await runWith({ STATUS_COMMENT_ID: '555', ISSUE_NUMBER: '53', GITHUB_REPOSITORY: 'o/r' }, undefined, { fetchImpl });
    assert.equal(calls.outputs['checkpoint-written'], 'false');
    assert.equal(calls.outputs.outcome, 'success');
  });

  it('simulate-orphan exits right after the checkpoint without waiting or reporting an outcome', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200 });
    const calls = await runWith({ STATUS_COMMENT_ID: '555', ISSUE_NUMBER: '53', GITHUB_REPOSITORY: 'o/r', SIMULATE_ORPHAN: 'true' }, undefined, { fetchImpl });
    assert.equal(calls.outputs['simulated-orphan'], 'true');
    assert.equal(calls.outputs.outcome, '');
    assert.equal(calls.outputs['agent-id'] !== '', true);
  });

  it('rejects malformed effort values before any SDK call', async () => {
    const calls = { createRunner: [], createSession: [] };
    await assert.rejects(
      runWith({ NETLIFY_EFFORT: 'high; rm -rf' }, calls),
      ReportedActionError,
    );
    assert.equal(calls.createRunner.length, 0);
    assert.equal(calls.createSession.length, 0);
  });
});

describe('action policy and failures', () => {
  it('does not land or expose a PR URL in dry-run mode', async () => {
    const runnerTemp = tempDirectory();
    try {
      const runner = clone(fixture.runner);
      const session = clone(fixture.session);
      const memberActions = [];
      const collected = outputCollector();
      const transport = {
        async createRunner(input) {
          session.prompt = input.prompt;
          return runner;
        },
        async createSession() {
          throw new Error('Unexpected follow-up');
        },
        async getRunner() {
          return runner;
        },
        async listRunners() {
          return { items: [runner] };
        },
        async listAccountRunners() {
          return { items: [runner] };
        },
        async getSession() {
          return session;
        },
        async listSessions() {
          return [session];
        },
        async cancelRunner() {},
        async cancelSession() {},
        async member(_runnerId, action) {
          memberActions.push(action);
          if (action === 'diff') {
            return {
              diff: {
                kind: 'inline',
                text: 'diff --git a/fixture.txt b/fixture.txt',
              },
            };
          }
          throw new Error(`Unexpected member action: ${action}`);
        },
      };
      const sdk = createAgentRunnerSdk({
        transport,
        sleep: async () => {},
      });

      const outcome = await runAgentAction({
        env: actionEnv(runnerTemp, { IS_DRY_RUN: 'true' }),
        sdk,
        setOutput: collected.setOutput,
        log: () => {},
        getScreenshot: async () => '',
      });

      assert.equal(outcome.landing, undefined);
      assert.deepEqual(memberActions, ['diff']);
      assert.equal(collected.outputs['agent-pr-url'], '');
      assert.equal(outcome.handle.policy.landing, 'none');
    } finally {
      fs.rmSync(runnerTemp, { recursive: true, force: true });
    }
  });

  it('redacts the explicit token and prompt from typed SDK failure output', async () => {
    const runnerTemp = tempDirectory();
    try {
      const env = actionEnv(runnerTemp);
      const collected = outputCollector();
      const sdk = createAgentRunnerSdk({
        transport: {
          async createRunner() {
            throw new Error(
              `Request failed with ${env.NETLIFY_AUTH_TOKEN}: ${env.TRIGGER_TEXT}`,
            );
          },
          async createSession() {
            throw new Error('Unexpected follow-up');
          },
          async getRunner() {
            throw new Error('Unexpected get');
          },
          async listRunners() {
            return { items: [] };
          },
          async listAccountRunners() {
            return { items: [] };
          },
          async getSession() {
            throw new Error('Unexpected get');
          },
          async listSessions() {
            return [];
          },
          async cancelRunner() {},
          async cancelSession() {},
          async member() {
            throw new Error('Unexpected member');
          },
        },
        sleep: async () => {},
      });

      await assert.rejects(
        runAgentAction({
          env,
          sdk,
          setOutput: collected.setOutput,
          log: () => {},
        }),
        ReportedActionError,
      );
      assert.equal(collected.outputs.outcome, 'failure');
      assert.equal(collected.outputs['failure-category'], 'agent-create-failed');
      assert.equal(
        collected.outputs['agent-error'].includes(env.NETLIFY_AUTH_TOKEN),
        false,
      );
      assert.equal(
        collected.outputs['agent-error'].includes(env.TRIGGER_TEXT),
        false,
      );
      assert.match(collected.outputs['agent-error'], /^\[[a-z0-9-]+\]/);
    } finally {
      fs.rmSync(runnerTemp, { recursive: true, force: true });
    }
  });

  it('uses the SDK deadline path and cancels a timed-out runner', async () => {
    const runnerTemp = tempDirectory();
    try {
      let clock = 0;
      let cancellations = 0;
      const runner = {
        ...clone(fixture.runner),
        state: 'running',
        hasResultDiff: undefined,
      };
      const session = {
        ...clone(fixture.session),
        state: 'running',
        hasResultDiff: undefined,
        resultText: undefined,
      };
      const collected = outputCollector();
      const transport = {
        async createRunner(input) {
          session.prompt = input.prompt;
          return runner;
        },
        async createSession() {
          throw new Error('Unexpected follow-up');
        },
        async getRunner() {
          return runner;
        },
        async listRunners() {
          return { items: [runner] };
        },
        async listAccountRunners() {
          return { items: [runner] };
        },
        async getSession() {
          return session;
        },
        async listSessions() {
          return [session];
        },
        async cancelRunner() {
          cancellations += 1;
        },
        async cancelSession() {
          throw new Error('Unexpected session cancellation');
        },
        async member() {
          throw new Error('Unexpected landing');
        },
      };
      const sdk = createAgentRunnerSdk({
        transport,
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
      });

      await assert.rejects(
        runAgentAction({
          env: actionEnv(runnerTemp, { MAX_WAIT_MINUTES: '0.01' }),
          sdk,
          setOutput: collected.setOutput,
          log: () => {},
          getScreenshot: async () => '',
        }),
        ReportedActionError,
      );
      assert.equal(cancellations, 1);
      assert.equal(collected.outputs.outcome, 'timeout');
      assert.equal(collected.outputs['failure-category'], 'agent-timeout');
      assert.equal(collected.outputs['failure-stage'], 'poll-agent');
    } finally {
      fs.rmSync(runnerTemp, { recursive: true, force: true });
    }
  });
});

describe('waitWithBackoff', () => {
  const { waitWithBackoff } = require('./run-agent');
  /** @param {string} category */
  const sdkFailing = (category, failures, result = { status: 'succeeded' }) => {
    let calls = 0;
    return {
      calls: () => calls,
      sdk: /** @type {any} */ ({
        waitFor: async () => { calls += 1; if (calls <= failures) throw new Error(category); return result; },
        classifyFailure: (error) => ({ category: error.message }),
      }),
    };
  };
  const handle = /** @type {any} */ ({ policy: { deadlineAt: 10_000_000 } });

  it('retries transient rate-limit failures with backoff, then returns the result', async () => {
    const sleeps = [];
    const logs = [];
    const { sdk, calls } = sdkFailing('rate-limit', 2);
    const result = await waitWithBackoff({ sdk, handle, waitOptions: {}, sleep: async (ms) => { sleeps.push(ms); }, log: (m) => logs.push(m), now: () => 0 });
    assert.deepEqual(result, { status: 'succeeded' });
    assert.equal(calls(), 3);
    assert.deepEqual(sleeps, [15000, 30000]);
    assert.match(logs[0], /transient rate-limit error; retrying in 15s/);
  });

  it('rethrows non-transient failures immediately', async () => {
    const { sdk, calls } = sdkFailing('authentication', 1);
    await assert.rejects(waitWithBackoff({ sdk, handle, waitOptions: {}, sleep: async () => {}, log: () => {}, now: () => 0 }), /authentication/);
    assert.equal(calls(), 1);
  });

  it('stops retrying past the deadline or after the retry limit', async () => {
    const pastDeadline = sdkFailing('transport', 5);
    await assert.rejects(waitWithBackoff({ sdk: pastDeadline.sdk, handle: { policy: { deadlineAt: 100 } }, waitOptions: {}, sleep: async () => {}, log: () => {}, now: () => 200 }), /transport/);
    assert.equal(pastDeadline.calls(), 1);
    const forever = sdkFailing('capacity', 100);
    await assert.rejects(waitWithBackoff({ sdk: forever.sdk, handle, waitOptions: {}, sleep: async () => {}, log: () => {}, now: () => 0 }), /capacity/);
    assert.equal(forever.calls(), 9);
  });

  it('never sleeps past the deadline', async () => {
    const sleeps = [];
    const { sdk } = sdkFailing('rate-limit', 1);
    await waitWithBackoff({ sdk, handle: { policy: { deadlineAt: 5000 } }, waitOptions: {}, sleep: async (ms) => { sleeps.push(ms); }, log: () => {}, now: () => 0 });
    assert.deepEqual(sleeps, [5000]);
  });
});
