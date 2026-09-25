const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'probe-ask-mode.mjs');
const SITE = '11111111-2222-3333-4444-555555555555';
const load = () => import(SCRIPT);

describe('probe-ask-mode', () => {
  it('parses arguments and rejects bad ones', async () => {
    const { parseArgs } = await load();
    assert.deepEqual({ ...parseArgs(['--site', SITE, '--dry', '--marker', 'm1']) }, { site: SITE, out: '', dry: true, marker: 'm1' });
    for (const bad of [[], ['--site', 'nope'], ['--site', SITE, '--bogus'], ['--site', SITE, '--marker', 'a b']]) {
      assert.throws(() => parseArgs(bad), undefined, JSON.stringify(bad));
    }
  });

  it('only runs live against the explicitly named canary site', async () => {
    const { assertAllowed } = await load();
    const args = { site: SITE, dry: false };
    const ok = { ALLOW_AGENT_RUNNER_ASK_PROBE: '1', CANARY_SITE_ID: SITE, NETLIFY_AUTH_TOKEN: 't' };
    assert.doesNotThrow(() => assertAllowed(args, ok));
    for (const [name, env] of /** @type {Array<[string, Record<string, string>]>} */ ([
      ['no gate', { ...ok, ALLOW_AGENT_RUNNER_ASK_PROBE: '' }],
      ['no canary id', { ...ok, CANARY_SITE_ID: '' }],
      ['other site', { ...ok, CANARY_SITE_ID: '99999999-2222-3333-4444-555555555555' }],
      ['no token', { ...ok, NETLIFY_AUTH_TOKEN: '' }],
    ])) {
      assert.throws(() => assertAllowed(args, env), undefined, name);
    }
    assert.doesNotThrow(() => assertAllowed({ site: SITE, dry: true }, {}));
  });

  it('--dry prints the plan without network access or the gate', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--site', SITE, '--dry', '--marker', 'm1'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(result.status, 0, result.stderr);
    const steps = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual([...new Set(steps.map((step) => step.step))], ['Q1', 'Q4', 'Q2', 'Q3', 'Q5']);
    assert.equal(steps[0].input.mode, 'ask');
  });

  it('refuses a live run without the gate', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--site', SITE], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ALLOW_AGENT_RUNNER_ASK_PROBE=1/);
  });

  it('redacts prompts and truncates long results', async () => {
    const { sanitizeSession } = await load();
    const out = sanitizeSession({ sessionId: 's', prompt: 'secret', resultText: 'x'.repeat(700) });
    assert.equal(out.prompt, '[redacted]');
    assert.match(out.resultText, /… \(700 chars\)$/);
  });
});
