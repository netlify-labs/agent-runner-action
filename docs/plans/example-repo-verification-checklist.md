# Example Repo Branch Verification Checklist

This checklist verifies `netlify-labs/agent-runner-action` in
`netlify-labs/agent-runner-action-example` using
`netlify-labs/agent-runner-action@dw/actions-updates` (or an immutable commit SHA
from that branch) before any `@main` or release-tag movement.

## Guardrails

- Do not overwrite or repoint `@main` or any release tags during validation.
- Keep verification work on a temporary branch in
  `netlify-labs/agent-runner-action-example`.
- Record both the tested action ref and the resolved action SHA for each run.
- Keep one run URL per scenario in the validation log.

## Setup

1. In `netlify-labs/agent-runner-action-example`, create a verification branch:
   - `verify/dw-actions-updates-<date>`
2. Copy [example-repo-verification-workflow.yml](./example-repo-verification-workflow.yml)
   into `.github/workflows/netlify-agents-branch-verification.yml`.
3. Keep the action reference on the branch ref:
   - `netlify-labs/agent-runner-action@dw/actions-updates`
4. Optional, for release-candidate validation, pin to an immutable SHA from
   `dw/actions-updates`:
   - `gh api repos/netlify-labs/agent-runner-action/commits/dw/actions-updates --jq '.sha'`
   - Update both `ACTION_UNDER_TEST_REF` and the `uses:` ref in the workflow.
5. Confirm `NETLIFY_AUTH_TOKEN` and `NETLIFY_SITE_ID` secrets are present.

## Scenario Checklist

| ID | Scenario | How to Trigger | Expected Summary/Comment/Links |
|---|---|---|---|
| S1 | Preflight-only success | `workflow_dispatch` with `preflight-only=true` after the input is implemented. | Step summary shows validation success and no agent start. Because this is `workflow_dispatch`, no status comment is expected. |
| S2 | Invalid site ID failure | `workflow_dispatch` with `site_id_override=invalid-site-id`. | Fails fast with clear error text. Step summary includes readable failure details and logs link. Because this is `workflow_dispatch`, no issue/PR comment is expected. |
| S3 | Dry-run prompt | `workflow_dispatch` with `dry_run=true` and a normal prompt. | Agent run starts, but no commit/PR is created. Summary states dry-run path. Status comment still shows run context and outcome. |
| S4 | Normal issue trigger | Open an issue with `@netlify` prompt text. | Eyes reaction appears. Status comment updates from in-progress to final outcome with agent/result and links (deploy/PR when available). |
| S5 | PR follow-up trigger | Comment `@netlify ...` on the active PR created by the action. | Existing PR receives follow-up status/history updates. Run keeps continuity on the same PR thread. |
| S6 | Failure path with readable summary/comment output | Trigger one deterministic failure mode (for example, invalid site ID or expired token). | Summary and comment clearly state what failed, where it failed, and what to do next; include run logs link and Netlify dashboard link when available. |

## Evidence To Capture Per Scenario

- Example repo run URL.
- `Action under test` and `Resolved action commit SHA` from `$GITHUB_STEP_SUMMARY`.
- Trigger source (dispatch, issue, PR comment).
- Whether eyes reaction and status/history comments were posted as expected.
- Outcome details: success/failure/timeout, deploy link, PR link, and remediation text.

## Rollback Behavior

1. Revert the example repo workflow back to the stable action ref
   (`netlify-labs/agent-runner-action@v1`) after validation is complete.
2. Keep verification evidence (run URLs + tested SHA) in the PR description or
   validation notes.
3. Close or clean up temporary verification issues/PR comments that are no longer
   needed.
4. Do not move, overwrite, or repoint `@main` or release tags as part of rollback.

## Sign-Off Template

- Tested action ref:
- Resolved action SHA:
- Example repo branch:
- Scenario results: `S1` `S2` `S3` `S4` `S5` `S6`
- Follow-up fixes required:
