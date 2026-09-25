const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createAgentRunnerSdk, AGENT_RUNNER_SDK_HANDLE_VERSION } = require('nax-agent-runner-sdk');
const {
  KV,
  PROMPT_PLACEHOLDER,
  CheckpointCryptoError,
  deriveKey,
  checkpointAad,
  seal,
  open,
  sealHandle,
  openHandle,
} = require('./checkpoint-crypto');

const sdk = createAgentRunnerSdk({ transport: /** @type {any} */ ({}), token: 'unused' });
const repo = 'netlify-labs/gtm-services';
const key = deriveKey({ token: 'nfp_token_A', repo });
const aad = checkpointAad({ repo, thread: 53, runnerId: 'runner123' });

/** @param {string} prompt */
function handle(prompt) {
  return sdk.parseHandle({
    v: AGENT_RUNNER_SDK_HANDLE_VERSION,
    kind: 'run',
    runnerId: 'runner123',
    siteId: 'SITE_CANARY_b3b7360c',
    agent: 'claude',
    input: { siteId: 'SITE_CANARY_b3b7360c', prompt, agent: 'claude', land: 'pr', deadlineMs: 60000, retryBudget: { capacity: 0 }, requestId: randomUUID() },
    policy: { landing: 'pr', deadlineAt: Date.now() + 60000, retryBudget: { capacity: 0 } },
    retries: { capacity: 0 },
    currentSessionId: 'session1',
    landing: { prUrl: 'https://github.com/o/r/pull/1', committedSessionIds: ['s0'] },
  });
}

describe('seal / open', () => {
  it('round-trips and uses a fresh nonce per seal', () => {
    const a = seal({ plaintext: 'hello', key, aad });
    const b = seal({ plaintext: 'hello', key, aad });
    assert.notEqual(a, b);
    assert.equal(open({ sealed: a, key, aad }), 'hello');
    assert.match(a, /^[A-Za-z0-9_-]+$/);
  });

  it('fails on tampered ciphertext, nonce, or tag', () => {
    const sealed = seal({ plaintext: 'hello world', key, aad });
    const bytes = Buffer.from(sealed, 'base64url');
    for (const index of [0, 14, bytes.length - 1]) {
      const tampered = Buffer.from(bytes);
      tampered[index] ^= 0x01;
      assert.throws(() => open({ sealed: tampered.toString('base64url'), key, aad }), (error) => error instanceof CheckpointCryptoError && error.kind === 'auth-failed', `byte ${index}`);
    }
  });

  it('is bound to repo, thread, and runner through the AAD', () => {
    const sealed = seal({ plaintext: 'hello', key, aad });
    for (const other of [
      checkpointAad({ repo, thread: 54, runnerId: 'runner123' }),
      checkpointAad({ repo, thread: 53, runnerId: 'runner999' }),
      checkpointAad({ repo: 'netlify-labs/other', thread: 53, runnerId: 'runner123' }),
    ]) {
      assert.throws(() => open({ sealed, key, aad: other }), /failed authentication/, other);
    }
  });

  it('fails with a different token or repo salt', () => {
    const sealed = seal({ plaintext: 'hello', key, aad });
    assert.throws(() => open({ sealed, key: deriveKey({ token: 'nfp_token_B', repo }), aad }), /failed authentication/);
    assert.throws(() => open({ sealed, key: deriveKey({ token: 'nfp_token_A', repo: 'o/other' }), aad }), /failed authentication/);
  });

  it('rejects malformed input and a missing token', () => {
    assert.throws(() => open({ sealed: 'not base64!', key, aad }), (error) => error instanceof CheckpointCryptoError && error.kind === 'malformed');
    assert.throws(() => open({ sealed: 'abc', key, aad }), /too short/);
    assert.throws(() => deriveKey({ token: '', repo }), (error) => error instanceof CheckpointCryptoError && error.kind === 'missing-key');
  });
});

describe('sealHandle / openHandle', () => {
  it('round-trips a full SDK handle including landing progress', () => {
    const original = handle('PROMPT_CANARY_fix the header');
    const { sealed, promptStripped, kv } = sealHandle({ handle: original, sdk, key, aad });
    assert.equal(promptStripped, false);
    assert.equal(kv, KV);
    const reopened = openHandle({ sealed, kv, sdk, key, aad });
    assert.deepEqual(reopened, original);
  });

  it('never exposes the prompt or site ID in the sealed output', () => {
    const { sealed } = sealHandle({ handle: handle('PROMPT_CANARY_secret context'), sdk, key, aad });
    assert.doesNotMatch(sealed, /PROMPT_CANARY|SITE_CANARY/);
    assert.doesNotMatch(Buffer.from(sealed, 'base64url').toString('latin1'), /PROMPT_CANARY|SITE_CANARY/);
  });

  it('strips prompts when the sealed handle would be too large, and still parses', () => {
    const big = handle(`PROMPT_CANARY_${'x'.repeat(50000)}`);
    const { sealed, promptStripped } = sealHandle({ handle: big, sdk, key, aad });
    assert.equal(promptStripped, true);
    assert.ok(sealed.length <= 40000);
    const reopened = openHandle({ sealed, kv: KV, sdk, key, aad });
    assert.equal(reopened.input.prompt, PROMPT_PLACEHOLDER);
    assert.equal(reopened.landing.prUrl, 'https://github.com/o/r/pull/1');
  });

  it('throws too-large when even the stripped handle does not fit', () => {
    assert.throws(() => sealHandle({ handle: handle('short'), sdk, key, aad, maxChars: 10 }), (error) => error instanceof CheckpointCryptoError && error.kind === 'too-large');
  });

  it('rejects an unknown key version', () => {
    const { sealed } = sealHandle({ handle: handle('p'), sdk, key, aad });
    assert.throws(() => openHandle({ sealed, kv: 2, sdk, key, aad }), (error) => error instanceof CheckpointCryptoError && error.kind === 'unknown-version');
  });

  it('seals a 40 KB handle quickly', () => {
    const payload = handle(`p${'y'.repeat(28000)}`);
    const started = process.hrtime.bigint();
    sealHandle({ handle: payload, sdk, key, aad });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 50, `${elapsedMs.toFixed(1)} ms`);
  });
});
