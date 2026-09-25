#!/usr/bin/env node
// Probe the Agent Runners backend's ask-mode contract (bead 3jh.1, "D0").
//
// Starts real agent runs, so it is gated: ALLOW_AGENT_RUNNER_ASK_PROBE=1 and
// --site must equal CANARY_SITE_ID (the canary site, passed explicitly).
// --dry prints the planned calls without touching the network.
//
//   ALLOW_AGENT_RUNNER_ASK_PROBE=1 CANARY_SITE_ID=<id> NETLIFY_AUTH_TOKEN=... \
//     node scripts/probe-ask-mode.mjs --site <id> [--out evidence.json] [--dry]
//
// Questions (answers go into the plan's "Ask mode backend contract"):
//   Q1 start({ mode: 'ask' }): mode echoed? diff/commit empty? result shape?
//   Q2 a normal follow-up on an ask-created runner lands a PR normally?
//   Q3 followUp({ mode: 'ask' }) on a runner with a PR: no commit, sees branch?
//   Q4 cost/duration vs the same question in normal mode
//   Q5 an ask session asked to change files: diff kept, discarded, landable?

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

export const QUESTION = 'Answer in three short Markdown bullet points: what does this repository contain, and which file is its main page? Do not modify any files.';

/**
 * @param {string[]} argv
 * @returns {{ site: string, out: string, dry: boolean, marker: string }}
 */
export function parseArgs(argv) {
  const args = { site: '', out: '', dry: false, marker: `ask-probe-${Date.now().toString(36)}` };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry') args.dry = true;
    else if (arg === '--site') args.site = String(argv[++index] || '');
    else if (arg === '--out') args.out = String(argv[++index] || '');
    else if (arg === '--marker') args.marker = String(argv[++index] || '');
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!/^[0-9a-f-]{36}$/i.test(args.site)) throw new Error('--site <site id> is required (a Netlify site UUID).');
  if (!/^[A-Za-z0-9-]{1,64}$/.test(args.marker)) throw new Error('--marker must be alphanumeric.');
  return args;
}

/**
 * Refuse to run against anything but the explicitly named canary site.
 * @param {{ site: string, dry: boolean }} args
 * @param {Record<string, string | undefined>} env
 */
export function assertAllowed(args, env) {
  if (args.dry) return;
  if (env.ALLOW_AGENT_RUNNER_ASK_PROBE !== '1') throw new Error('Set ALLOW_AGENT_RUNNER_ASK_PROBE=1 to start real agent runs.');
  if (!env.CANARY_SITE_ID) throw new Error('Set CANARY_SITE_ID to the canary site ID.');
  if (env.CANARY_SITE_ID !== args.site) throw new Error(`Refusing to probe site ${args.site}: it is not CANARY_SITE_ID.`);
  if (!env.NETLIFY_AUTH_TOKEN) throw new Error('Set NETLIFY_AUTH_TOKEN.');
}

/**
 * The calls the probe makes, in order.
 * @param {{ site: string, marker: string }} args
 */
export function plan(args) {
  return [
    { step: 'Q1', call: 'start', input: { siteId: args.site, mode: 'ask', land: 'pr', prompt: QUESTION } },
    { step: 'Q1', call: 'waitFor + land (ask result; expect no PR)' },
    { step: 'Q4', call: 'start', input: { siteId: args.site, mode: 'normal', land: 'none', prompt: QUESTION } },
    { step: 'Q2', call: 'followUp (Q1 runner)', input: { mode: 'normal', prompt: `In README.md, add one line at the very end exactly: ${args.marker}. Do not edit other files.` } },
    { step: 'Q2', call: 'waitFor + land (expect prOpen)' },
    { step: 'Q3', call: 'followUp (Q1 runner)', input: { mode: 'ask', prompt: 'What is the last line of README.md on this branch? Answer with the line only. Do not modify any files.' } },
    { step: 'Q5', call: 'followUp (Q1 runner)', input: { mode: 'ask', prompt: `Create the file ask-probe-${args.marker}.txt containing the word probe.` } },
    { step: 'Q5', call: 'waitFor + land (does an ask diff land?)' },
  ];
}

/** Strip prompts and truncate long text before recording evidence. */
export function sanitizeSession(session) {
  const { prompt, ...rest } = session || {};
  const text = typeof rest.resultText === 'string' ? rest.resultText : '';
  return { ...rest, prompt: prompt ? '[redacted]' : undefined, resultText: text.length > 600 ? `${text.slice(0, 600)}… (${text.length} chars)` : text };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assertAllowed(args, process.env);
  const log = (/** @type {string} */ message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
  if (args.dry) {
    for (const entry of plan(args)) console.log(JSON.stringify(entry));
    return;
  }
  const { createAgentRunnerSdk } = await import('nax-agent-runner-sdk');
  const token = String(process.env.NETLIFY_AUTH_TOKEN);
  const sdk = createAgentRunnerSdk({ token });
  const deadlineMs = 20 * 60 * 1000;
  /** @type {Record<string, unknown>} */
  const evidence = { site: args.site, marker: args.marker, startedAt: new Date().toISOString() };
  const sessionsOf = async (/** @type {string} */ runnerId) => (await sdk.transport.listSessions(runnerId, { token })).map(sanitizeSession);
  const timed = async (/** @type {string} */ label, /** @type {() => Promise<any>} */ fn) => {
    const start = Date.now();
    const value = await fn();
    log(`${label}: ${Math.round((Date.now() - start) / 1000)}s`);
    return { value, seconds: Math.round((Date.now() - start) / 1000) };
  };

  // Q1: ask on a fresh runner (with a PR landing policy, as the action would use).
  let handle = await sdk.start({ siteId: args.site, prompt: QUESTION, mode: 'ask', land: 'pr', deadlineMs, requestId: randomUUID() });
  log(`Q1 runner ${handle.runnerId}`);
  const q1 = await timed('Q1 waitFor', () => sdk.waitFor(handle, { token }));
  const q1Land = await sdk.land(handle, { token }).catch((error) => ({ error: String(error.message || error) }));
  if (q1Land.handle) handle = q1Land.handle;
  evidence.q1 = { runnerId: handle.runnerId, result: { status: q1.value.status, changes: q1.value.changes }, seconds: q1.seconds, landing: q1Land.landing || q1Land, sessions: await sessionsOf(handle.runnerId) };

  // Q4: the same question in normal mode.
  const normal = await sdk.start({ siteId: args.site, prompt: QUESTION, mode: 'normal', land: 'none', deadlineMs, requestId: randomUUID() });
  const q4 = await timed('Q4 waitFor', () => sdk.waitFor(normal, { token }));
  evidence.q4 = { runnerId: normal.runnerId, result: { status: q4.value.status, changes: q4.value.changes }, seconds: q4.seconds, sessions: await sessionsOf(normal.runnerId) };

  // Q2: normal follow-up on the ask-created runner, then land.
  let session = await sdk.followUp(handle, { prompt: plan(args)[3].input.prompt, mode: 'normal', requestId: randomUUID() }, { token });
  const q2 = await timed('Q2 waitFor', () => sdk.waitFor(session, { token }));
  const q2Land = await sdk.land(session, { token }).catch((error) => ({ error: String(error.message || error) }));
  if (q2Land.handle) session = q2Land.handle;
  evidence.q2 = { result: { status: q2.value.status, changes: q2.value.changes }, seconds: q2.seconds, landing: q2Land.landing || q2Land };

  // Q3: ask follow-up on a runner that has a PR.
  let ask = await sdk.followUp(session, { prompt: plan(args)[5].input.prompt, mode: 'ask', requestId: randomUUID() }, { token });
  const q3 = await timed('Q3 waitFor', () => sdk.waitFor(ask, { token }));
  evidence.q3 = { result: { status: q3.value.status, changes: q3.value.changes, resultText: q3.value.resultText }, seconds: q3.seconds, sawMarker: String(q3.value.resultText || '').includes(args.marker) };

  // Q5: an ask session asked to change files.
  const change = await sdk.followUp(ask, { prompt: plan(args)[6].input.prompt, mode: 'ask', requestId: randomUUID() }, { token });
  const q5 = await timed('Q5 waitFor', () => sdk.waitFor(change, { token }));
  const q5Land = await sdk.land(change, { token }).catch((error) => ({ error: String(error.message || error) }));
  evidence.q5 = { result: { status: q5.value.status, changes: q5.value.changes }, seconds: q5.seconds, landing: q5Land.landing || q5Land, sessions: await sessionsOf(handle.runnerId), runner: await sdk.transport.getRunner(handle.runnerId, { token }) };

  evidence.finishedAt = new Date().toISOString();
  const json = JSON.stringify(evidence, null, 2);
  if (args.out) fs.writeFileSync(args.out, `${json}\n`);
  console.log(json);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`probe-ask-mode: ${error.message || error}`);
    process.exit(1);
  });
}
