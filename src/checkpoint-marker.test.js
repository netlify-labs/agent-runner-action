const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  renderCheckpointMarker,
  parseCheckpoint,
  validateCheckpoint,
  stripUntrustedHtmlComments,
  containsStateMarker,
  STATUS_COMMENT_MARKER,
} = require('./comment-markers');
const extractAgentId = require('./extract-agent-id');

/** @returns {import('./comment-markers').RunCheckpoint} */
function checkpoint(overrides = {}) {
  return /** @type {any} */ ({
    v: 1,
    state: 'running',
    runnerId: '6ab5de0c2660172e9b17b86f',
    sessionId: '6ab5de0c2660172e9b17b871',
    kind: 'run',
    agent: 'opencode',
    model: 'moonshotai/kimi-k3',
    effort: 'max',
    mode: 'normal',
    landing: 'pr',
    deadlineAt: 1790000000000,
    startedAt: 1789998500000,
    ghRunId: 36086874799,
    ghRunAttempt: 1,
    requester: 'DavidWells',
    prUrl: 'https://github.com/netlify-labs/gtm-services/pull/56',
    committedSessionIds: ['6ab5de0c2660172e9b17b870'],
    kv: 1,
    handle: 'AbC_-123',
    ...overrides,
  });
}

describe('checkpoint marker', () => {
  it('round-trips through a status comment body', () => {
    const body = `Status\n\n${renderCheckpointMarker(checkpoint())}\n${STATUS_COMMENT_MARKER}`;
    assert.deepEqual(parseCheckpoint(body), checkpoint());
    assert.ok(containsStateMarker(body));
  });

  it('keeps optional fields optional', () => {
    const minimal = checkpoint({ model: undefined, effort: undefined, prUrl: undefined, committedSessionIds: undefined, handle: undefined, prHeadSha: undefined });
    for (const key of Object.keys(minimal)) if (minimal[/** @type {keyof typeof minimal} */ (key)] === undefined) delete minimal[/** @type {keyof typeof minimal} */ (key)];
    assert.deepEqual(parseCheckpoint(renderCheckpointMarker(minimal)), minimal);
  });

  const invalid = {
    'unknown version': { v: 2 },
    'unknown key version': { kv: 2 },
    'unknown state': { state: 'paused' },
    'bad runner id': { runnerId: 'x"y' },
    'bad session id': { sessionId: '' },
    'bad kind': { kind: 'job' },
    'unknown agent': { agent: 'gpt' },
    'bad model id': { model: 'Kimi K3' },
    'unknown effort': { effort: 'ultra' },
    'bad mode': { mode: 'plan' },
    'bad landing': { landing: 'merge' },
    'negative deadline': { deadlineAt: -1 },
    'string run id': { ghRunId: '36086874799' },
    'bad requester': { requester: 'bad user!' },
    'bad pr head sha': { prHeadSha: 'zzz' },
    'foreign pr url': { prUrl: 'https://evil.example/pull/1' },
    'too many committed sessions': { committedSessionIds: Array.from({ length: 51 }, (_, i) => `s${i}`) },
    'bad committed session': { committedSessionIds: ['ok', 'no spaces'] },
    'non-base64url handle': { handle: 'abc=+/' },
  };
  for (const [name, overrides] of Object.entries(invalid)) {
    it(`drops the whole checkpoint for ${name}`, () => {
      assert.equal(validateCheckpoint(checkpoint(overrides)), null);
      assert.equal(renderCheckpointMarker(checkpoint(overrides)), '');
    });
  }

  it('ignores unparseable marker JSON', () => {
    assert.equal(parseCheckpoint('<!-- netlify-agent-run-checkpoint:{not json} -->'), null);
    assert.equal(parseCheckpoint('no marker'), null);
  });

  it('keeps checkpoint markers through the allowlist but strips other HTML comments', () => {
    const body = `${renderCheckpointMarker(checkpoint())}\n<!-- evil -->`;
    const stripped = stripUntrustedHtmlComments(body);
    assert.ok(stripped.includes('netlify-agent-run-checkpoint:'));
    assert.ok(!stripped.includes('evil'));
  });

  it('never carries prompt text or a site ID in public fields', () => {
    const marker = renderCheckpointMarker(checkpoint({ prompt: 'PROMPT_CANARY', siteId: 'SITE_CANARY' }));
    assert.doesNotMatch(marker, /PROMPT_CANARY|SITE_CANARY/);
  });
});

describe('extractAgentId checkpoint outputs', () => {
  /** @param {string} commentBody @param {string} [prBody] */
  async function extract(commentBody, prBody = '') {
    /** @type {Record<string, string>} */
    const outputs = {};
    const core = { setOutput: (/** @type {string} */ k, /** @type {string} */ v) => { outputs[k] = v; } };
    const github = {
      rest: {
        issues: { getComment: async () => ({ data: { body: commentBody } }) },
        pulls: { get: async () => ({ data: { body: prBody, head: { repo: { full_name: 'o/r' } }, base: { repo: { full_name: 'o/r' } } } }) },
      },
    };
    const originalLog = console.log;
    console.log = () => {};
    try {
      await extractAgentId({ github: /** @type {any} */ (github), context: /** @type {any} */ ({ repo: { owner: 'o', repo: 'r' } }), core: /** @type {any} */ (core), inputs: { isPR: 'true', commentId: '1', prNumber: '5' } });
    } finally {
      console.log = originalLog;
    }
    return outputs;
  }

  it('outputs the checkpoint and state from the status comment', async () => {
    const body = `<!-- netlify-agent-runner-id:6ab5de0c2660172e9b17b86f -->\n${renderCheckpointMarker(checkpoint())}\n${STATUS_COMMENT_MARKER}`;
    const outputs = await extract(body);
    assert.equal(outputs['checkpoint-state'], 'running');
    assert.deepEqual(JSON.parse(outputs.checkpoint), checkpoint());
  });

  it('ignores a checkpoint for a different runner than the reconciled one', async () => {
    const body = `<!-- netlify-agent-runner-id:6ab5de0c2660172e9b17b86f -->\n${renderCheckpointMarker(checkpoint({ runnerId: 'otherrunner0000000000000' }))}`;
    const outputs = await extract(body);
    assert.equal(outputs.checkpoint, '');
    assert.equal(outputs['checkpoint-state'], '');
  });

  it('never reads a checkpoint from the PR body', async () => {
    const outputs = await extract('', `<!-- netlify-agent-runner-id:6ab5de0c2660172e9b17b86f -->\n${renderCheckpointMarker(checkpoint())}`);
    assert.equal(outputs.checkpoint, '');
  });
});

describe('session data run configuration fields', () => {
  const { parseSessionData, renderSessionDataMarker } = require('./comment-markers');
  it('keeps valid agent/model/effort/mode and drops invalid ones', () => {
    const marker = renderSessionDataMarker({
      s1: { agent: 'claude', model: 'claude-fable-5', effort: 'high', mode: 'normal' },
      s2: { agent: 'gpt', model: 'Bad Model!', effort: 'ultra', mode: 'plan' },
    });
    assert.deepEqual(parseSessionData(marker), {
      s1: { agent: 'claude', model: 'claude-fable-5', effort: 'high', mode: 'normal' },
      s2: {},
    });
  });
});
