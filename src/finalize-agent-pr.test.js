const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const finalizeAgentPr = require('./finalize-agent-pr');

describe('Agent Runner pull request metadata finalization', () => {
  it('cleans trigger prefixes without changing an already clean title', () => {
    assert.equal(
      finalizeAgentPr.cleanPullRequestTitle(
        '@netlify codex Improve the checkout',
      ),
      'Improve the checkout',
    );
    assert.equal(
      finalizeAgentPr.cleanPullRequestTitle('Improve the checkout'),
      'Improve the checkout',
    );
  });

  it('adds issue and runner state once', () => {
    const first = finalizeAgentPr.buildPullRequestBody(
      'Agent summary',
      '17',
      'runner-sdk-1',
    );
    assert.match(first, /Agent summary\n\n---\n\nResolves #17/);
    assert.match(first, /<!-- netlify-agent-runner-id:runner-sdk-1 -->/);
    assert.equal(
      finalizeAgentPr.buildPullRequestBody(first, '17', 'runner-sdk-1'),
      first,
    );
  });

  it('updates only a PR in the current repository', async () => {
    const updates = [];
    const previousPrUrl = process.env.AGENT_PR_URL;
    const previousAgentId = process.env.AGENT_ID;
    const previousIssueNumber = process.env.ISSUE_NUMBER;
    process.env.AGENT_PR_URL =
      'https://github.com/netlify-labs/example/pull/42';
    process.env.AGENT_ID = 'runner-sdk-1';
    process.env.ISSUE_NUMBER = '17';
    try {
      await finalizeAgentPr({
        github: {
          rest: {
            pulls: {
              get: async () => ({
                data: {
                  head: { ref: 'agent/runner', sha: 'abc' },
                  base: { ref: 'main' },
                  title: '@netlify codex Improve the checkout',
                  body: 'Agent summary',
                },
              }),
              update: async (input) => {
                updates.push(input);
                return { data: { number: 42 } };
              },
            },
          },
        },
        context: {
          eventName: 'issues',
          payload: {},
          repo: { owner: 'netlify-labs', repo: 'example' },
          actor: 'david',
        },
        core: {
          setOutput() {},
          setFailed(message) {
            throw new Error(message);
          },
        },
      });
    } finally {
      if (previousPrUrl === undefined) delete process.env.AGENT_PR_URL;
      else process.env.AGENT_PR_URL = previousPrUrl;
      if (previousAgentId === undefined) delete process.env.AGENT_ID;
      else process.env.AGENT_ID = previousAgentId;
      if (previousIssueNumber === undefined) delete process.env.ISSUE_NUMBER;
      else process.env.ISSUE_NUMBER = previousIssueNumber;
    }

    assert.equal(updates.length, 1);
    assert.equal(updates[0].pull_number, 42);
    assert.equal(updates[0].title, 'Improve the checkout');
    assert.match(updates[0].body, /Resolves #17/);
  });
});
