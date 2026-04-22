const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const markers = require('./comment-markers');

describe('comment marker constants', () => {
  it('exports the canonical status and history markers', () => {
    assert.equal(markers.STATUS_COMMENT_MARKER, '<!-- netlify-agent-run-status -->');
    assert.equal(markers.HISTORY_COMMENT_MARKER, '<!-- netlify-agent-run-history -->');
    assert.equal(markers.RUNNER_ID_MARKER_PREFIX, '<!-- netlify-agent-runner-id:');
    assert.equal(markers.SESSION_DATA_MARKER_PREFIX, '<!-- netlify-agent-session-data:');
  });
});

describe('render helpers', () => {
  it('renders runner id markers with legacy shape', () => {
    assert.equal(
      markers.renderRunnerIdMarker('runner-123'),
      '<!-- netlify-agent-runner-id:runner-123 -->'
    );
    assert.equal(markers.renderRunnerIdMarker(), '<!-- netlify-agent-runner-id: -->');
  });

  it('renders session data marker with stable json', () => {
    const marker = markers.renderSessionDataMarker({
      session_1: { gh_action_url: 'https://github.com/org/repo/actions/runs/1' },
    });
    assert.equal(
      marker,
      '<!-- netlify-agent-session-data:{"session_1":{"gh_action_url":"https://github.com/org/repo/actions/runs/1"}} -->'
    );
  });
});

describe('parseRunnerId', () => {
  it('extracts runner ids from markdown with surrounding text', () => {
    const body = [
      '### Netlify Agent Runners run completed',
      '',
      '<!-- netlify-agent-runner-id:abc_123-def -->',
      '<!-- netlify-agent-run-status -->',
    ].join('\n');
    assert.equal(markers.parseRunnerId(body), 'abc_123-def');
  });

  it('handles missing suffix in older comment snapshots', () => {
    const body = '<!-- netlify-agent-runner-id:legacy-runner-id\nmore text';
    assert.equal(markers.parseRunnerId(body), 'legacy-runner-id');
  });

  it('returns empty for empty or missing markers', () => {
    assert.equal(markers.parseRunnerId(''), '');
    assert.equal(markers.parseRunnerId(null), '');
    assert.equal(markers.parseRunnerId('no marker here'), '');
  });

  it('returns empty for unknown legacy marker formats', () => {
    const body = '<!-- netlify-agent-runner:legacy-123 -->';
    assert.equal(markers.parseRunnerId(body), '');
  });
});

describe('parseSessionData', () => {
  it('parses session-data markers into objects', () => {
    const body = '<!-- netlify-agent-session-data:{"s1":{"commit_sha":"abc123"}} -->';
    assert.deepEqual(markers.parseSessionData(body), {
      s1: { commit_sha: 'abc123' },
    });
  });

  it('returns empty object for malformed/missing payloads', () => {
    assert.deepEqual(markers.parseSessionData(''), {});
    assert.deepEqual(markers.parseSessionData('<!-- netlify-agent-session-data:not-json -->'), {});
    assert.deepEqual(markers.parseSessionData('<!-- netlify-agent-session-data:[1,2,3] -->'), {});
  });
});

describe('parseLinkedPrReference', () => {
  it('extracts PR numbers from plain reference lines', () => {
    assert.equal(markers.parseLinkedPrReference('Changes in Pull Request #42'), '42');
    assert.equal(markers.parseLinkedPrReference('📎 Pull Request #301'), '301');
  });

  it('extracts PR numbers from linked pull request markdown', () => {
    const body = 'Changes in [Pull Request](https://github.com/netlify-labs/agent-runner-action-example/pull/77)';
    assert.equal(markers.parseLinkedPrReference(body), '77');
  });

  it('returns empty when there is no linked PR reference', () => {
    assert.equal(markers.parseLinkedPrReference('No PR reference in this comment.'), '');
    assert.equal(markers.parseLinkedPrReference(null), '');
  });
});
