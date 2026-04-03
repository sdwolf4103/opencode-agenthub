---
name: agenthub-prepare-pr
description: Use when implementation is complete on a normal feature branch and you need to verify, clean up commits, rebase, and either merge locally or create a PR without using a worktree-heavy workflow.
---

# Agenthub Prepare PR

## Overview

Finish a feature branch for a mostly solo branch-and-merge workflow. Verify tests pass, clean up commit history, rebase on the target branch, and either merge locally or push and create a PR.

**This skill is for normal feature branches.** If you are working inside an isolated git worktree, prefer `superpowers:finishing-a-development-branch`.

**Core principle:** Verify → Clean up → Rebase → Finish.

**Announce at start:** "I'm using the agenthub-prepare-pr skill to finish this branch."

## When To Use

- You are on a feature branch, not `main` or `master`
- Implementation is complete
- You want a simple finish flow without worktree-oriented cleanup

## The Process

### Step 1: Verify Tests

Before anything else, run the project's relevant verification commands.

If tests fail, stop and fix them before proceeding.

### Step 2: Identify Branch Context

Check:

```bash
git branch --show-current
git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'
git log --oneline <base>..HEAD
```

If you are on `main` or `master`, stop. This skill is for feature branches.

### Step 3: Clean Up Commits

If the branch history is messy, use interactive rebase to squash or reword commits into clean conventional-commit style history.

Preferred commit styles:
- `feat:`
- `fix:`
- `refactor:`
- `test:`
- `docs:`
- `chore:`

### Step 4: Rebase on Target

```bash
git fetch origin
git rebase origin/<base>
```

If rebase conflicts occur, resolve them, continue the rebase, and re-run tests.

### Step 5: Present Options

Present exactly these three options:

1. Merge to `<base>` locally
2. Push and create a Pull Request
3. Keep the branch as-is

### Step 6: Execute Choice

#### Option 1: Merge locally

```bash
git checkout <base>
git pull origin <base>
git merge --no-ff <branch>
```

Re-run tests on the merged result, then delete the feature branch if clean.

#### Option 2: Push and create PR

```bash
git push -u origin <branch>
gh pr create --base <base> --title "<title>" --body "<summary and verification notes>"
```

If `gh` is unavailable, provide the manual compare URL or instruct the user to create the PR manually.

#### Option 3: Keep branch as-is

Report that the branch is cleaned up and rebased, and can be finished later.

## Integration

**Called by:**
- `superpowers:executing-plans` after work completes on a normal feature branch
- user directly when finishing a feature branch

**Alternative for worktree workflows:**
- `superpowers:finishing-a-development-branch`

**Pairs with:**
- `agenthub-proactive-verify`
- `superpowers:verification-before-completion`

## Red Flags

- Never merge with failing tests
- Never force-push `main` or `master`
- Never skip the rebase step when the target branch has moved
- Never create a PR without local verification
