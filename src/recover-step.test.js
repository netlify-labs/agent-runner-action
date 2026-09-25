const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const recoverStep = require('./recover-step');
const { recoveryBudgetMs } = recoverStep;

describe('recoveryBudgetMs', () => {
  it('uses 40% of the agent limit for a new request and all of it for a recover dispatch', () => {
    assert.equal(recoveryBudgetMs({ command: 'run', effectiveMinutes: 25 }), 10 * 60 * 1000);
    assert.equal(recoveryBudgetMs({ command: 'recover', effectiveMinutes: 25 }), 25 * 60 * 1000);
    assert.equal(recoveryBudgetMs({ command: 'run', effectiveMinutes: NaN }), 4 * 60 * 1000);
  });
});

describe('recoverStep', () => {
  function fakeCore() {
    const outputs = /** @type {Record<string, string>} */ ({});
    return { outputs, setOutput: (/** @type {string} */ k, /** @type {string} */ v) => { outputs[k] = v; }, info: () => {} };
  }

  it('does nothing without a checkpoint', async () => {
    const core = fakeCore();
    await recoverStep({ github: {}, context: {}, core, env: { CHECKPOINT: '' } });
    assert.deepEqual(core.outputs, { recovered: 'false', blocked: 'false', 'session-data-map': '' });
  });

  it('blocks a new request and says so when the previous run is still working', async () => {
    const created = /** @type {any[]} */ ([]);
    const github = { rest: { issues: { createComment: async (/** @type {any} */ p) => { created.push(p); return {}; } } } };
    const core = fakeCore();
    const recover = /** @type {any} */ (async () => ({ outcome: 'still-running', reason: 'budget-exhausted' }));
    await recoverStep({ github, context: { repo: { owner: 'o', repo: 'r' } }, core, sdk: {}, recover, env: { CHECKPOINT: '{"runnerId":"r1"}', COMMAND: 'run', ISSUE_NUMBER: '5' } });
    assert.equal(core.outputs.blocked, 'true');
    assert.match(created[0].body, /still working, so this request wasn't started/);
  });

  it('does not post the blocked note for a recover dispatch', async () => {
    const created = /** @type {any[]} */ ([]);
    const github = { rest: { issues: { createComment: async (/** @type {any} */ p) => { created.push(p); return {}; } } } };
    const core = fakeCore();
    const recover = /** @type {any} */ (async () => ({ outcome: 'still-running', reason: 'budget-exhausted' }));
    await recoverStep({ github, context: { repo: { owner: 'o', repo: 'r' } }, core, sdk: {}, recover, env: { CHECKPOINT: '{"runnerId":"r1"}', COMMAND: 'recover', ISSUE_NUMBER: '5' } });
    assert.equal(core.outputs.blocked, 'false');
    assert.equal(created.length, 0);
  });

  it('marks recovered and passes the session data map on, with the right budget', async () => {
    const core = fakeCore();
    let budget = 0;
    const recover = /** @type {any} */ (async (/** @type {any} */ params) => { budget = params.budgetMs; return { outcome: 'finalized', reason: 'success', sessionDataMap: { s1: { pr_url: 'x' } } }; });
    await recoverStep({ github: {}, context: { repo: { owner: 'o', repo: 'r' } }, core, sdk: {}, recover, env: { CHECKPOINT: '{"runnerId":"r1"}', COMMAND: 'run', EFFECTIVE_TIMEOUT_MINUTES: '25' } });
    assert.equal(core.outputs.recovered, 'true');
    assert.equal(budget, 10 * 60 * 1000);
    assert.deepEqual(JSON.parse(core.outputs['session-data-map']), { s1: { pr_url: 'x' } });
  });
});
