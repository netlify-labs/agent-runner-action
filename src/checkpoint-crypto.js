// Encrypt the full SDK run handle so it can live in the (public) status
// comment. The SDK's contract is to persist the complete handle returned by
// every mutating call; the handle contains the prompt and site ID, so it is
// sealed with AES-256-GCM under a key only token holders can derive.
//
//   key  = HKDF-SHA256(ikm = NETLIFY_AUTH_TOKEN, salt = "<owner>/<repo>",
//                      info = "netlify-agent-run-checkpoint/v1")
//   aad  = "<owner>/<repo>#<thread number>:<runnerId>"
//   blob = base64url(nonce[12] || ciphertext || tag[16])
//
// The AAD binds a sealed handle to its thread and runner, so a blob copied
// into another thread (or paired with another runner ID) fails to open.

const crypto = require('node:crypto');

const KV = 1;
const HKDF_INFO = 'netlify-agent-run-checkpoint/v1';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const DEFAULT_MAX_CHARS = 40000;
const PROMPT_PLACEHOLDER = '[prompt omitted from checkpoint]';

class CheckpointCryptoError extends Error {
  /**
   * @param {'auth-failed' | 'malformed' | 'unknown-version' | 'too-large' | 'missing-key'} kind
   * @param {string} message
   */
  constructor(kind, message) {
    super(message);
    this.name = 'CheckpointCryptoError';
    this.kind = kind;
  }
}

/**
 * @param {{ token: string, repo: string }} input `repo` is "owner/name"
 * @returns {Buffer}
 */
function deriveKey({ token, repo }) {
  if (!token) throw new CheckpointCryptoError('missing-key', 'A Netlify token is required to derive the checkpoint key.');
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(token, 'utf8'), Buffer.from(repo, 'utf8'), Buffer.from(HKDF_INFO, 'utf8'), 32));
}

/**
 * @param {{ repo: string, thread: string | number, runnerId: string }} input
 * @returns {string}
 */
function checkpointAad({ repo, thread, runnerId }) {
  return `${repo}#${thread}:${runnerId}`;
}

/**
 * @param {{ plaintext: string, key: Buffer, aad: string }} input
 * @returns {string}
 */
function seal({ plaintext, key, aad }) {
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64url');
}

/**
 * @param {{ sealed: string, key: Buffer, aad: string }} input
 * @returns {string}
 */
function open({ sealed, key, aad }) {
  if (typeof sealed !== 'string' || !/^[A-Za-z0-9_-]+$/.test(sealed)) {
    throw new CheckpointCryptoError('malformed', 'Sealed checkpoint is not base64url.');
  }
  const bytes = Buffer.from(sealed, 'base64url');
  if (bytes.length < NONCE_BYTES + TAG_BYTES + 1) {
    throw new CheckpointCryptoError('malformed', 'Sealed checkpoint is too short.');
  }
  const nonce = bytes.subarray(0, NONCE_BYTES);
  const tag = bytes.subarray(bytes.length - TAG_BYTES);
  const ciphertext = bytes.subarray(NONCE_BYTES, bytes.length - TAG_BYTES);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (_) {
    throw new CheckpointCryptoError('auth-failed', 'Sealed checkpoint failed authentication (wrong token, thread, runner, or tampered data).');
  }
}

/**
 * Replace prompt text in a handle with a placeholder (prompts are only needed
 * for ambiguous-create reconciliation, which is over once a run exists).
 * @param {any} handle
 * @returns {any}
 */
function stripHandlePrompts(handle) {
  const copy = JSON.parse(JSON.stringify(handle));
  if (copy.input && typeof copy.input.prompt === 'string') copy.input.prompt = PROMPT_PLACEHOLDER;
  if (copy.sessionInput && typeof copy.sessionInput.prompt === 'string') copy.sessionInput.prompt = PROMPT_PLACEHOLDER;
  return copy;
}

/**
 * Seal a handle for the status comment, stripping prompts if needed to fit.
 * @param {{ handle: any, sdk: { serializeHandle: (h: any) => string, parseHandle: (v: any) => any }, key: Buffer, aad: string, maxChars?: number }} input
 * @returns {{ sealed: string, promptStripped: boolean, kv: number }}
 */
function sealHandle({ handle, sdk, key, aad, maxChars = DEFAULT_MAX_CHARS }) {
  const full = seal({ plaintext: sdk.serializeHandle(handle), key, aad });
  if (full.length <= maxChars) return { sealed: full, promptStripped: false, kv: KV };
  const stripped = sdk.parseHandle(stripHandlePrompts(handle));
  const small = seal({ plaintext: sdk.serializeHandle(stripped), key, aad });
  if (small.length <= maxChars) return { sealed: small, promptStripped: true, kv: KV };
  throw new CheckpointCryptoError('too-large', `Sealed handle is ${small.length} characters after removing prompts (limit ${maxChars}).`);
}

/**
 * Open a sealed handle back into a validated SDK handle.
 * @param {{ sealed: string, kv: number, sdk: { parseHandle: (v: any) => any }, key: Buffer, aad: string }} input
 * @returns {any}
 */
function openHandle({ sealed, kv, sdk, key, aad }) {
  if (kv !== KV) throw new CheckpointCryptoError('unknown-version', `Unknown checkpoint key version ${kv}.`);
  return sdk.parseHandle(open({ sealed, key, aad }));
}

module.exports = {
  KV,
  DEFAULT_MAX_CHARS,
  PROMPT_PLACEHOLDER,
  CheckpointCryptoError,
  deriveKey,
  checkpointAad,
  seal,
  open,
  stripHandlePrompts,
  sealHandle,
  openHandle,
};
