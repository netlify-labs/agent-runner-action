const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadFixtureJson } = require('./scenario-harness');
const {
  formatReport,
  inferEventName,
  main,
  parseArgs,
  runSimulation,
} = require('./simulate');

const REPO_ROOT = path.join(__dirname, '..');

describe('simulate CLI', () => {
  it('parses required and optional flags', () => {
    const parsed = parseArgs([
      '--fixture',
      'fixtures/events/issue-comment-on-pr.json',
      '--state-fixture=fixtures/github/existing-status-comment-with-runner.json',
      '--format',
      'markdown',
    ]);

    assert.equal(parsed.fixturePath, 'fixtures/events/issue-comment-on-pr.json');
    assert.equal(parsed.stateFixturePath, 'fixtures/github/existing-status-comment-with-runner.json');
    assert.equal(parsed.format, 'markdown');
    assert.equal(parsed.help, false);
  });

  it('requires --fixture', () => {
    assert.throws(
      () => parseArgs(['--format', 'json']),
      /Missing required --fixture/
    );
  });

  it('infers event names from fixture payload shape', () => {
    const issueCommentPayload = loadFixtureJson('fixtures/events/issue-comment-on-pr.json', REPO_ROOT);
    const workflowDispatchPayload = loadFixtureJson('fixtures/events/workflow-dispatch.json', REPO_ROOT);
    const reviewPayload = loadFixtureJson('fixtures/events/pull-request-review.json', REPO_ROOT);

    assert.equal(inferEventName(issueCommentPayload), 'issue_comment');
    assert.equal(inferEventName(workflowDispatchPayload), 'workflow_dispatch');
    assert.equal(inferEventName(reviewPayload), 'pull_request_review');
  });

  it('applies state fixture overrides and exposes recovered state', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simulate-state-'));
    const stateFixturePath = path.join(tempDir, 'state.json');
    const stateFixture = {
      statusCommentBody: [
        '<!-- netlify-agent-runner-id:runner-state-123 -->',
        '<!-- netlify-agent-session-data:{"session-1":{"screenshot":"https://example.test/shot.png"}} -->',
      ].join('\n'),
      prBody: '<!-- netlify-agent-runner-id:runner-pr-987 -->',
      linkedPrNumber: 58,
      existingRunnerIdOutput: 'stale-runner-id',
    };

    try {
      fs.writeFileSync(stateFixturePath, JSON.stringify(stateFixture, null, 2), 'utf8');

      const result = await runSimulation({
        fixturePath: 'fixtures/events/issue-comment-on-pr.json',
        stateFixturePath,
        repoRoot: REPO_ROOT,
      });

      assert.equal(result.report.shouldRun, true);
      assert.equal(result.report.context.isPr, true);
      assert.equal(result.report.context.prNumber, '58');
      assert.equal(result.report.recoveredState.runnerId, 'runner-state-123');
      assert.equal(result.report.recoveredState.recoveryAction, 'resume-runner');
      assert.ok(result.report.summary.includes('# Netlify Agent Runners'));
      assert.ok(result.report.comments.length > 0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('runs main() with a valid fixture and exits 0', async () => {
    /** @type {string[]} */
    const stdout = [];
    /** @type {string[]} */
    const stderr = [];
    const code = await main(
      ['--fixture', 'fixtures/events/issue-opened-body-trigger.json'],
      {
        stdout: { write: chunk => stdout.push(String(chunk)) },
        stderr: { write: chunk => stderr.push(String(chunk)) },
      }
    );

    assert.equal(code, 0);
    assert.equal(stderr.length, 0);
    const output = stdout.join('');
    assert.ok(output.includes('Local Simulator'));
    assert.ok(output.includes('Scenario: simulate:issue-opened-body-trigger.json'));
    assert.ok(output.includes('Decision: run'));
  });

  it('renders parseable JSON report output', async () => {
    const { report } = await runSimulation({
      fixturePath: 'fixtures/events/issue-opened-body-trigger.json',
      repoRoot: REPO_ROOT,
    });

    const jsonOutput = formatReport(report, 'json');
    const parsed = JSON.parse(jsonOutput);

    assert.equal(parsed.scenarioName, 'simulate:issue-opened-body-trigger.json');
    assert.equal(parsed.decision, 'run');
    assert.equal(parsed.eventName, 'issues');
    assert.equal(parsed.shouldRun, true);
    assert.equal(parsed.context.isPr, false);
    assert.equal(typeof parsed.summary, 'string');
  });

  it('runs main() and prints markdown output', async () => {
    /** @type {string[]} */
    const stdout = [];
    /** @type {string[]} */
    const stderr = [];
    const code = await main(
      ['--fixture', 'fixtures/events/bot-comment.json', '--format', 'markdown'],
      {
        stdout: { write: chunk => stdout.push(String(chunk)) },
        stderr: { write: chunk => stderr.push(String(chunk)) },
      }
    );

    assert.equal(code, 0);
    assert.equal(stderr.length, 0);
    const output = stdout.join('');
    assert.ok(output.includes('# Local Simulator'));
    assert.ok(output.includes('| Scenario | `simulate:bot-comment.json` |'));
    assert.ok(output.includes('| Decision | `skip` |'));
    assert.ok(output.includes('| Should run | false |'));
    assert.ok(output.includes('## Step Summary'));
  });

  it('returns non-zero for missing fixture paths', async () => {
    /** @type {string[]} */
    const stdout = [];
    /** @type {string[]} */
    const stderr = [];
    const code = await main(
      ['--fixture', 'fixtures/events/does-not-exist.json'],
      {
        stdout: { write: chunk => stdout.push(String(chunk)) },
        stderr: { write: chunk => stderr.push(String(chunk)) },
      }
    );

    assert.equal(code, 1);
    assert.equal(stdout.length, 0);
    assert.ok(stderr.join('').includes('simulate:'));
  });

  it('runs main() with --format json and emits parseable output', async () => {
    /** @type {string[]} */
    const stdout = [];
    /** @type {string[]} */
    const stderr = [];
    const code = await main(
      ['--fixture', 'fixtures/events/issue-opened-body-trigger.json', '--format', 'json'],
      {
        stdout: { write: chunk => stdout.push(String(chunk)) },
        stderr: { write: chunk => stderr.push(String(chunk)) },
      }
    );

    assert.equal(code, 0);
    assert.equal(stderr.length, 0);
    const parsed = JSON.parse(stdout.join(''));
    assert.equal(parsed.eventName, 'issues');
    assert.equal(parsed.shouldRun, true);
    assert.equal(typeof parsed.summary, 'string');
  });

  it('propagates state reconciliation warnings into simulator report', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simulate-warning-'));
    const stateFixturePath = path.join(tempDir, 'warning-state.json');
    const stateFixture = {
      existingSessionDataOutput: '{broken-json',
    };

    try {
      fs.writeFileSync(stateFixturePath, JSON.stringify(stateFixture, null, 2), 'utf8');

      const result = await runSimulation({
        fixturePath: 'fixtures/events/issue-opened-body-trigger.json',
        stateFixturePath,
        repoRoot: REPO_ROOT,
      });

      assert.ok(
        result.report.warnings.some(warning => warning.includes('existing session data output is malformed JSON')),
        'expected malformed existing output warning'
      );
      assert.equal(result.report.recoveredState.recoveryAction, 'manual-review');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
