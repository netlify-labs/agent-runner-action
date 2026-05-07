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
    assert.ok(rendered.statusBody.includes('### [Netlify Agent Run Status](https://app.netlify.com/projects/site/agent-runs/runner_1) ✅'));
    assert.ok(rendered.statusBody.includes('Netlify Agent Run completed.'));
    assert.ok(rendered.statusBody.includes('**Prompt summary:** Updated homepage'));
    assert.ok(rendered.statusBody.includes('[Read full result](#issuecomment-123)'));
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
    assert.ok(rendered.statusBody.includes('### [Netlify Agent Run Status](https://app.netlify.com/projects/site/agent-runs/runner_3) ❌'));
    assert.ok(rendered.statusBody.includes('Netlify Agent Run failed.'));
    assert.ok(rendered.statusBody.includes('**Failure summary:**'));
    assert.ok(rendered.statusBody.includes('[Read full result](#issuecomment-777)'));
    assert.equal(parseRunnerId(rendered.statusBody), 'runner_3');
  });
});
