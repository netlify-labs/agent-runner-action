const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createAgentRunnerSdk } = require('nax-agent-runner-sdk');
const { buildResumeHandle, ResumeHandleError, PLACEHOLDER_PROMPT } = require('./resume-handle');

const sdk = createAgentRunnerSdk({ transport: /** @type {any} */ ({}), token: 'unused' });
const runner = { runnerId: 'runner1', siteId: 'site1', codeOrigin: 'github', branch: 'main', prUrl: 'https://github.com/o/r/pull/9' };
const sessions = [{ sessionId: 'session1' }, { sessionId: 'session2' }];
const base = { sdk, runner, sessions, siteId: 'site1', sessionId: 'session2', agent: 'claude', landing: /** @type {const} */ ('pr'), deadlineAt: Date.now() + 60000 };

describe('buildResumeHandle', () => {
  it('rebuilds a run handle that passes parseHandle', () => {
    const handle = buildResumeHandle({ ...base, kind: 'run' });
    assert.equal(handle.kind, 'run');
    assert.equal(handle.currentSessionId, 'session2');
    assert.equal(handle.input.prompt, PLACEHOLDER_PROMPT);
    assert.equal(handle.policy.deadlineAt, base.deadlineAt, 'deadline is preserved exactly');
    assert.deepEqual(handle.origin, { codeOrigin: 'github', branch: 'main' });
  });

  it('rebuilds a session handle with selection and landing progress', () => {
    const handle = buildResumeHandle({
      ...base,
      kind: 'session',
      model: 'claude-fable-5',
      effort: 'high',
      prUrl: 'https://github.com/o/r/pull/9',
      committedSessionIds: ['session1'],
    });
    assert.equal(handle.kind, 'session');
    assert.equal(handle.sessionId, 'session2');
    assert.deepEqual([handle.sessionInput.model, handle.sessionInput.effort], ['claude-fable-5', 'high']);
    assert.deepEqual(handle.landing, { prUrl: 'https://github.com/o/r/pull/9', committedSessionIds: ['session1'] });
  });

  it('does not invent landing progress the caller did not pass', () => {
    assert.equal(buildResumeHandle({ ...base, kind: 'run' }).landing, undefined);
  });

  it('refuses a runner that belongs to another site', () => {
    assert.throws(() => buildResumeHandle({ ...base, kind: 'run', siteId: 'site2' }), (error) => error instanceof ResumeHandleError && error.kind === 'site-mismatch');
  });

  it('refuses a session the runner does not have', () => {
    assert.throws(() => buildResumeHandle({ ...base, kind: 'run', sessionId: 'nope' }), (error) => error instanceof ResumeHandleError && error.kind === 'missing-session');
  });

  it('uses fresh UUID request IDs every time', () => {
    const a = buildResumeHandle({ ...base, kind: 'session' });
    const b = buildResumeHandle({ ...base, kind: 'session' });
    assert.notEqual(a.input.requestId, b.input.requestId);
    assert.match(a.sessionInput.requestId, /^[0-9a-f-]{36}$/);
  });
});
