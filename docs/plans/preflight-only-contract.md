# Preflight-Only Public Contract

Status: accepted for implementation work.

This document finalizes the public behavior contract for setup validation so
implementation tasks can proceed without ambiguity.

## Scope

The contract applies to action behavior when a new optional input
`preflight-only` is present.

## Contract Decisions

1. `preflight-only` is a public input.
   - Name: `preflight-only`
   - Type: boolean-like string (`'true'` or `'false'`)
   - Default: `'false'`
2. `dry-run` semantics do not change.
   - `dry-run=true` still starts the agent.
   - `dry-run=true` still skips commit/PR creation.
3. `preflight-only=true` does not start or resume an agent runner.
   - It only validates configuration and exits after reporting.
4. If both `dry-run=true` and `preflight-only=true`, preflight-only wins.
   - No agent is started.
   - Report that preflight-only took precedence.
5. `failure-category` becomes a formal output.
   - Empty string on success or skipped paths with no failure.
   - Set to a taxonomy value on failure.

## Reporting Rules

### Issue/PR triggered events

- On preflight success:
  - Post or update a status comment that clearly says configuration is valid and
    no agent was started because `preflight-only` is enabled.
- On preflight failure:
  - Post or update a status comment with clear failure title, summary, and
    remediation (safe for public visibility).

### `workflow_dispatch`

- Always write details to `$GITHUB_STEP_SUMMARY`.
- Do not create issue or PR comments for `workflow_dispatch` preflight runs.

## Truth Table

| `preflight-only` | `dry-run` | Agent starts | Commit/PR creation | Expected reporting |
|---|---|---|---|---|
| false | false | yes | normal behavior | existing status/history behavior + summary when implemented |
| false | true | yes | skipped | existing dry-run reporting behavior |
| true | false | no | none | issue/PR: status comment; dispatch: summary-only |
| true | true | no | none | same as preflight-only; include precedence note |

## Implementation Notes

- Add `preflight-only` to `action.yml` inputs once implementation starts.
- Emit `failure-category` output from orchestration paths.
- Keep backward compatibility: existing consumers that do not set
  `preflight-only` must observe current behavior.
- Keep docs and example workflows explicit that branch/SHA validation happens
  before any `@main` or release-tag movement.
