---
name: cds-work-unit-commits
description: "Trigger: commit splitting, chained PRs, keeping tests and docs with code. Plan commits as reviewable work units."
license: Apache-2.0
metadata:
  author: cds-skills
  version: "1.0"
---

## When to Use

Load this skill when deciding what belongs in each commit or PR.

Use it for:

- Splitting a feature into reviewable work.
- Preparing commits before opening a PR.
- Turning a large change into chained or stacked PRs.
- Keeping reviewer cognitive load healthy.
- Committing feature work in reviewable slices of about 400 authored changed lines.

## Critical Rules

| Rule | Requirement |
|------|-------------|
| Commit by work unit | A commit represents a deliverable behavior, fix, migration, or docs unit. |
| Do not commit by file type | Avoid `models`, then `services`, then `tests` if none works alone. |
| Keep tests with code | Tests belong in the same commit as the behavior they verify. |
| Keep docs with the user-visible change | Docs belong with the feature or workflow they explain. |
| Tell a story | A reviewer should understand why each commit exists from its diff and message. |
| Future PR-ready | Each commit should be a candidate chained PR when the change grows. |
| Workload guard | If the forecast is above about 400 authored changed lines, tell the user and use `/cds-chained-pr` to choose how to deliver it before implementing. |
| Budget is not code-golf | Never shrink a diff by deleting comments, blank lines, docs, or tests, or by compressing code, to fit the review budget. Slice by work unit or report the overage. |
| Risky units stand alone | A unit that touches data migrations, security, public contracts, concurrency or delivery/CI gets its own commit so a reviewer takes it alone. |

## Work Unit Checklist

Before committing, confirm:

- [ ] The commit has one clear purpose.
- [ ] The repo still makes sense after applying only this commit.
- [ ] Tests or docs for this unit are included when relevant.
- [ ] Rollback is reasonable without reverting unrelated work.
- [ ] The commit message explains the outcome, not the file list (Conventional Commit format).

## Split Examples

| Weak split | Better work-unit split |
|------------|------------------------|
| `add models` | `feat(auth): add token validation domain model and tests` |
| `add services` | `feat(auth): wire token validation into login flow` |
| `add tests` | Tests included with each behavior commit |
| `update docs` | Docs included with the user-facing change they explain |

## PR Relationship

Use work-unit commits as the foundation for chained PRs:

1. Build the smallest independent work unit.
2. Include verification for that unit.
3. Commit it with a Conventional Commit message.
4. If the PR approaches 400 changed lines, promote commits or groups of commits into chained PRs.

Splitting is bounded: after one honest slicing pass, if no cohesive split fits the budget, stop and report the smallest honest count and the reason. Follow the destination repository's documented contribution and size policy; do not add labels or exceptions that policy does not define.

## Feature Relationship

A feature tracked in `odd/tasks/<feature>.md` commits in slices of about 400 authored changed lines, not one commit per task:

- A slice holds one or more whole tasks with their tests and docs; the last slice closes the feature.
- Record the commit that holds each task in the feature document.
- Never commit, push or open a PR unless the user asked for it.

## Commands

```bash
# Review the story before committing
git diff --stat
git diff --cached --stat

# Check recent commit style
git log --oneline -5
```
