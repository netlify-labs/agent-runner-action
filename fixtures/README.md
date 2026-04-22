# Deterministic Fixture Corpus

This directory contains compact JSON fixtures for scenario tests and simulator flows.

## Layout

- `events/`: GitHub event payloads used to exercise trigger and context logic.
- `github/`: Mocked GitHub API responses used by context extraction and runner recovery paths.
- `netlify/`: Mocked Netlify API/CLI response payloads for runner lifecycle behavior.

## Required Event Fixtures

- `issue-opened-body-trigger.json`
- `issue-opened-title-trigger.json`
- `issue-comment-on-issue.json`
- `issue-comment-on-pr.json`
- `pull-request-target-body-trigger.json`
- `pull-request-review-comment.json`
- `pull-request-review.json`
- `workflow-dispatch.json`
- `fork-pr-untrusted.json`
- `bot-comment.json`

## Required GitHub Response Fixtures

- `collaborator-admin.json`
- `collaborator-read.json`
- `timeline-no-linked-pr.json`
- `timeline-linked-pr.json`
- `existing-status-comment-with-runner.json`
- `existing-status-comment-malformed-session-data.json`
- `pr-body-with-runner-marker.json`

## Required Netlify Response Fixtures

- `get-site-success.json`
- `get-site-failure-auth.json`
- `agent-create-success.json`
- `agent-create-model-unavailable.json`
- `agent-show-running.json`
- `agent-show-completed-with-diff.json`
- `agent-show-failed.json`
- `sessions-list-success.json`

## Authoring Rules

- Keep fixtures deterministic and small: include only fields used by modules/tests.
- Prefer realistic IDs/URLs so debug traces are readable.
- Add new fixtures as additive files; avoid mutating existing fixtures unless behavior changes.
- When adding fixtures, update `src/fixtures-corpus.test.js` so inventory drift fails fast.
