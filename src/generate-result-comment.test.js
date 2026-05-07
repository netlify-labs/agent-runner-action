const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderResultComment } = require('./generate-result-comment');
const {
  RESULT_COMMENT_MARKER_PREFIX,
  STATUS_COMMENT_MARKER,
  HISTORY_COMMENT_MARKER,
  RUNNER_ID_MARKER_PREFIX,
  SESSION_DATA_MARKER_PREFIX,
  parseResultCommentIdentifiers,
} = require('./comment-markers');

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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-result-test-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('renderResultComment', () => {
  it('renders a success result comment with only the result marker', () => {
    writeSessions('runner_1', [{
      id: 'session_1',
      prompt: '@netlify codex build this\n◌ https://github.com/o/r/issues/1#issuecomment-1',
      title: 'Updated homepage',
      result: 'Made the requested changes.',
      deploy_url: 'https://site.netlify.app',
      agent_config: { agent: 'codex' },
    }]);

    const rendered = renderResultComment({
      context: context(),
      env: {
        RUNNER_TEMP: tempDir,
        AGENT_ID: 'runner_1',
        SITE_NAME: 'site',
        AGENT_SCREENSHOT_URL: 'https://site.netlify.app/screenshot.png',
        AGENT_DEPLOY_URL: 'https://site.netlify.app',
        AGENT_COMMIT_SHA: 'abc123',
        AGENT_PR_URL: 'https://github.com/netlify-labs/agent-runner-action-example/pull/5',
        GH_ACTION_URL: 'https://github.com/netlify-labs/agent-runner-action-example/actions/runs/9',
        SESSION_DATA_MAP: '{}',
      },
    });

    assert.ok(rendered.resultBody.includes('### [Run #1 | codex | Agent Run completed]'));
    assert.ok(rendered.resultBody.includes('**Prompt:**'));
    assert.ok(rendered.resultBody.includes('### Result: Updated homepage'));
    assert.ok(rendered.resultBody.includes('[Code Changes]'));
    assert.ok(rendered.resultBody.includes(RESULT_COMMENT_MARKER_PREFIX));
    assert.deepEqual(parseResultCommentIdentifiers(rendered.resultBody), {
      runnerId: 'runner_1',
      sessionId: 'session_1',
    });
    assert.ok(!rendered.resultBody.includes(STATUS_COMMENT_MARKER));
    assert.ok(!rendered.resultBody.includes(HISTORY_COMMENT_MARKER));
    assert.ok(!rendered.resultBody.includes(RUNNER_ID_MARKER_PREFIX));
    assert.ok(!rendered.resultBody.includes(SESSION_DATA_MARKER_PREFIX));
  });

  it('scrubs marker-shaped text from user and agent-authored prose', () => {
    writeSessions('runner_2', [{
      id: 'session_2',
      prompt: '@netlify fix <!-- netlify-agent-run-status -->',
      title: 'Title <!-- netlify-agent-runner-id:evil -->',
      result: 'Result <!-- netlify-agent-session-data:{} -->',
      agent_config: { agent: 'codex' },
    }]);

    const rendered = renderResultComment({
      context: context(),
      env: {
        RUNNER_TEMP: tempDir,
        AGENT_ID: 'runner_2',
        SITE_NAME: 'site',
        SESSION_DATA_MAP: '{}',
      },
    });

    assert.ok(!rendered.resultBody.includes(STATUS_COMMENT_MARKER));
    assert.ok(!rendered.resultBody.includes(RUNNER_ID_MARKER_PREFIX));
    assert.ok(!rendered.resultBody.includes(SESSION_DATA_MARKER_PREFIX));
    assert.ok(rendered.resultBody.includes(RESULT_COMMENT_MARKER_PREFIX));
  });

  it('renders failure result comments when a latest session exists', () => {
    writeSessions('runner_3', [{
      id: 'session_3',
      prompt: '@netlify fix it',
      title: 'Failed run',
      agent_config: { agent: 'codex' },
    }]);

    const rendered = renderResultComment({
      context: context(),
      outcome: 'failure',
      env: {
        RUNNER_TEMP: tempDir,
        AGENT_ID: 'runner_3',
        SITE_NAME: 'site',
        AGENT_ERROR: 'Agent Runner codex is not available',
        FAILURE_CATEGORY: 'model-unavailable',
        FAILURE_STAGE: 'create-agent',
        SESSION_DATA_MAP: '{}',
      },
    });

    assert.ok(rendered.resultBody.includes('Agent Run failed'));
    assert.ok(rendered.resultBody.includes('Suggested next steps'));
    assert.ok(rendered.resultBody.includes(RESULT_COMMENT_MARKER_PREFIX));
  });

  it('emits no result body when there is no latest session id', () => {
    const rendered = renderResultComment({
      context: context(),
      env: {
        RUNNER_TEMP: tempDir,
        AGENT_ID: 'runner_4',
        SITE_NAME: 'site',
        SESSION_DATA_MAP: '{}',
      },
    });

    assert.equal(rendered.resultBody, '');
    assert.equal(rendered.resultMarker, '');
  });
});
