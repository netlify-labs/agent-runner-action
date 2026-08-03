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
    assert.equal(AGENT_RUNNER_SDK_VERSION, '0.2.0');
    assert.equal(packageJson.version, '0.2.0');
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
