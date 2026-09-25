// Rebuild an SDK handle from identifiers. The SDK README discourages
// hand-built handles ("Do not persist only runner/session IDs or construct
// handles by hand"), so this is only the fallback when the sealed handle in a
// checkpoint can't be opened (token rotated, missing), and the long-standing
// path for follow-ups on runs that predate checkpoints (createLegacyHandle).
//
// Verified against nax-agent-runner-sdk 0.3.0: rebuilt "run" and "session"
// handles, including landing progress, pass sdk.parseHandle when request IDs
// are UUIDs.

const { randomUUID } = require('node:crypto');
const { AGENT_RUNNER_SDK_HANDLE_VERSION } = require('nax-agent-runner-sdk');

const PLACEHOLDER_PROMPT = 'Resume a pre-SDK agent-runner-action run.';

class ResumeHandleError extends Error {
  /**
   * @param {'site-mismatch' | 'missing-session'} kind
   * @param {string} message
   */
  constructor(kind, message) {
    super(message);
    this.name = 'ResumeHandleError';
    this.kind = kind;
  }
}

/**
 * @param {{
 *   sdk: { parseHandle: (value: any) => any },
 *   runner: { runnerId: string, siteId?: string, codeOrigin?: string, branch?: string, prUrl?: string },
 *   sessions: Array<{ sessionId: string, agent?: string }>,
 *   siteId: string,
 *   sessionId: string,
 *   kind: 'run' | 'session',
 *   agent: string,
 *   model?: string,
 *   effort?: string,
 *   mode?: 'normal' | 'ask',
 *   landing: 'pr' | 'none',
 *   deadlineAt: number,
 *   deadlineMs?: number,
 *   branch?: string,
 *   prUrl?: string,
 *   committedSessionIds?: string[],
 * }} input
 * @returns {any} a validated SDK handle
 */
function buildResumeHandle(input) {
  const { sdk, runner, sessions, siteId, sessionId, kind } = input;
  if (runner.siteId && runner.siteId !== siteId) {
    throw new ResumeHandleError('site-mismatch', `Agent Runner ${runner.runnerId} belongs to a different site.`);
  }
  if (!sessions.some((session) => session.sessionId === sessionId)) {
    throw new ResumeHandleError('missing-session', `No session ${sessionId} exists for Agent Runner ${runner.runnerId}.`);
  }
  const selection = {
    agent: input.agent,
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.mode && input.mode !== 'normal' ? { mode: input.mode } : {}),
  };
  const deadlineMs = input.deadlineMs ?? Math.max(1, input.deadlineAt - Date.now());
  const prUrl = input.prUrl;
  /** @type {any} */
  const handle = {
    v: AGENT_RUNNER_SDK_HANDLE_VERSION,
    kind,
    runnerId: runner.runnerId,
    siteId,
    agent: input.agent,
    ...(runner.codeOrigin === undefined
      ? {}
      : { origin: { codeOrigin: runner.codeOrigin, ...(runner.branch === undefined ? {} : { branch: runner.branch }) } }),
    input: {
      siteId,
      prompt: PLACEHOLDER_PROMPT,
      ...selection,
      ...(input.branch ? { branch: input.branch } : {}),
      land: input.landing,
      deadlineMs,
      retryBudget: { capacity: 0 },
      requestId: randomUUID(),
    },
    policy: { landing: input.landing, deadlineAt: input.deadlineAt, retryBudget: { capacity: 0 } },
    retries: { capacity: 0 },
    currentSessionId: sessionId,
    ...(prUrl || (input.committedSessionIds && input.committedSessionIds.length > 0)
      ? {
          landing: {
            ...(prUrl ? { prUrl } : {}),
            ...(input.committedSessionIds && input.committedSessionIds.length > 0 ? { committedSessionIds: input.committedSessionIds } : {}),
          },
        }
      : {}),
  };
  if (kind === 'session') {
    handle.sessionId = sessionId;
    handle.sessionInput = { prompt: PLACEHOLDER_PROMPT, ...selection, requestId: randomUUID() };
  }
  return sdk.parseHandle(handle);
}

module.exports = { PLACEHOLDER_PROMPT, ResumeHandleError, buildResumeHandle };
