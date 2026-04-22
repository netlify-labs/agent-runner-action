#!/usr/bin/env node
// CLI helper called from the bash agent step to build comment bodies.
// Eliminates bash/JS duplication of prompt cleaning and comment formatting.
//
// Usage:
//   node src/format-comment.js in-progress  → prints in-progress comment body
//
// Reads from environment variables:
//   TRIGGER_TEXT, NETLIFY_AGENT, AGENT_MODEL, AGENT_LINK, ACTION_LINK, AGENT_ID, IS_DRY_RUN

/** @typedef {import('./types').InProgressCommentOptions} InProgressCommentOptions */

const utils = require('./utils');

const command = process.argv[2];

if (command === 'in-progress') {
  const triggerText = process.env.TRIGGER_TEXT || '';
  const model = process.env.NETLIFY_AGENT || process.env.AGENT_MODEL || 'codex';
  const agentLink = process.env.AGENT_LINK || '';
  const actionLink = process.env.ACTION_LINK || '';
  const agentId = process.env.AGENT_ID || '';
  const isDryRun = process.env.IS_DRY_RUN === 'true';

  let body = utils.buildInProgressComment({
    agentRunUrl: agentLink,
    prompt: triggerText,
    model,
    runnerId: agentId,
    ghActionUrl: actionLink,
  });

  if (isDryRun) {
    body += '\n\n> **Preview mode** — no changes will be committed.\n';
  }

  process.stdout.write(body);

} else if (command === 'clean-prompt') {
  const text = process.env.TRIGGER_TEXT || '';
  process.stdout.write(utils.cleanPrompt(text));

} else {
  console.error(`Unknown command: ${command}`);
  console.error('Usage: node format-comment.js <in-progress|clean-prompt>');
  process.exit(1);
}
