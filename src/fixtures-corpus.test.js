const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FIXTURES_ROOT = path.join(__dirname, '..', 'fixtures');

const REQUIRED = {
  events: [
    'issue-opened-body-trigger.json',
    'issue-opened-title-trigger.json',
    'issue-comment-on-issue.json',
    'issue-comment-on-pr.json',
    'pull-request-target-body-trigger.json',
    'pull-request-review-comment.json',
    'pull-request-review.json',
    'workflow-dispatch.json',
    'fork-pr-untrusted.json',
    'bot-comment.json',
  ],
  github: [
    'collaborator-admin.json',
    'collaborator-read.json',
    'timeline-no-linked-pr.json',
    'timeline-linked-pr.json',
    'existing-status-comment-with-runner.json',
    'existing-status-comment-malformed-session-data.json',
    'pr-body-with-runner-marker.json',
  ],
  netlify: [
    'get-site-success.json',
    'get-site-failure-auth.json',
    'agent-create-success.json',
    'agent-create-model-unavailable.json',
    'agent-show-running.json',
    'agent-show-completed-with-diff.json',
    'agent-show-failed.json',
    'sessions-list-success.json',
  ],
};

/**
 * @param {'events' | 'github' | 'netlify'} group
 * @param {string} file
 * @returns {unknown}
 */
function readJson(group, file) {
  const filePath = path.join(FIXTURES_ROOT, group, file);
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

describe('fixture corpus inventory', () => {
  it('contains all required fixture files', () => {
    for (const group of Object.keys(REQUIRED)) {
      const groupName = /** @type {'events' | 'github' | 'netlify'} */ (group);
      for (const file of REQUIRED[groupName]) {
        const fixturePath = path.join(FIXTURES_ROOT, groupName, file);
        assert.equal(
          fs.existsSync(fixturePath),
          true,
          `missing required fixture: ${groupName}/${file}`
        );
      }
    }

    assert.equal(fs.existsSync(path.join(FIXTURES_ROOT, 'README.md')), true);
  });

  it('parses every required fixture as valid JSON', () => {
    for (const group of Object.keys(REQUIRED)) {
      const groupName = /** @type {'events' | 'github' | 'netlify'} */ (group);
      for (const file of REQUIRED[groupName]) {
        assert.doesNotThrow(
          () => readJson(groupName, file),
          `${groupName}/${file} should parse as JSON`
        );
      }
    }
  });
});

describe('event fixtures', () => {
  it('cover trigger entry points and guardrail cases', () => {
    const openedBody = /** @type {any} */ (readJson('events', 'issue-opened-body-trigger.json'));
    const openedTitle = /** @type {any} */ (readJson('events', 'issue-opened-title-trigger.json'));
    const issueCommentPr = /** @type {any} */ (readJson('events', 'issue-comment-on-pr.json'));
    const forkUntrusted = /** @type {any} */ (readJson('events', 'fork-pr-untrusted.json'));
    const botComment = /** @type {any} */ (readJson('events', 'bot-comment.json'));

    assert.match(openedBody.issue.body, /@netlify/i);
    assert.match(openedTitle.issue.title, /@netlify/i);
    assert.ok(issueCommentPr.issue.pull_request?.url, 'issue-comment-on-pr should include pull_request url');

    assert.equal(forkUntrusted.pull_request.author_association, 'NONE');
    assert.notEqual(
      forkUntrusted.pull_request.head.repo.full_name,
      forkUntrusted.repository.full_name,
      'fork-pr-untrusted must represent a foreign fork'
    );

    assert.equal(botComment.sender.login, 'github-actions[bot]');
  });
});

describe('github response fixtures', () => {
  it('include collaborator, timeline, and runner marker cases', () => {
    const collaboratorAdmin = /** @type {any} */ (readJson('github', 'collaborator-admin.json'));
    const collaboratorRead = /** @type {any} */ (readJson('github', 'collaborator-read.json'));
    const timelineLinked = /** @type {any[]} */ (readJson('github', 'timeline-linked-pr.json'));
    const statusWithRunner = /** @type {any} */ (readJson('github', 'existing-status-comment-with-runner.json'));
    const malformedSessionData = /** @type {any} */ (readJson('github', 'existing-status-comment-malformed-session-data.json'));

    assert.equal(collaboratorAdmin.data.permission, 'admin');
    assert.equal(collaboratorRead.data.permission, 'read');

    assert.ok(
      timelineLinked.some(event => event.source?.issue?.pull_request?.url),
      'timeline-linked-pr should include at least one linked PR cross-reference'
    );

    assert.match(statusWithRunner.data.body, /<!-- netlify-agent-runner-id:/);
    assert.match(statusWithRunner.data.body, /<!-- netlify-agent-session-data:/);
    assert.match(malformedSessionData.data.body, /\{not-json\}/);
  });
});

describe('netlify response fixtures', () => {
  it('cover site lookup, runner lifecycle, and sessions list', () => {
    const siteSuccess = /** @type {any} */ (readJson('netlify', 'get-site-success.json'));
    const siteFailure = /** @type {any} */ (readJson('netlify', 'get-site-failure-auth.json'));
    const createSuccess = /** @type {any} */ (readJson('netlify', 'agent-create-success.json'));
    const modelUnavailable = /** @type {any} */ (readJson('netlify', 'agent-create-model-unavailable.json'));
    const showRunning = /** @type {any} */ (readJson('netlify', 'agent-show-running.json'));
    const showCompleted = /** @type {any} */ (readJson('netlify', 'agent-show-completed-with-diff.json'));
    const showFailed = /** @type {any} */ (readJson('netlify', 'agent-show-failed.json'));
    const sessionsList = /** @type {any} */ (readJson('netlify', 'sessions-list-success.json'));

    assert.equal(typeof siteSuccess.id, 'string');
    assert.equal(siteFailure.status, 401);
    assert.equal(typeof createSuccess.id, 'string');
    assert.match(modelUnavailable.error, /not available/i);

    assert.equal(showRunning.state, 'running');
    assert.equal(showCompleted.state, 'completed');
    assert.equal(showFailed.state, 'failed');

    assert.ok(Array.isArray(sessionsList.sessions));
    assert.ok(sessionsList.sessions.length > 0);
  });
});
