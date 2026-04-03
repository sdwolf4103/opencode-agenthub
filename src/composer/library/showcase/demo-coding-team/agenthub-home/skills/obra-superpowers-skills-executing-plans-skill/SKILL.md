---
name: executing-plans
description: Use when you have a written implementation plan to execute in a separate session with review checkpoints
---

# Executing Plans

## Overview

Load plan, review critically, execute all tasks, report when complete.

**Announce at start:** "I'm using the executing-plans skill to implement this plan."

**Note:** Tell your human partner that Superpowers works much better with access to subagents. The quality of its work will be significantly higher if run on a platform with subagent support (such as Claude Code or Codex). If subagents are available, use superpowers:subagent-driven-development instead of this skill.

## The Process

### Step 1: Load and Review Plan
1. Read plan file
2. Review critically - identify any questions or concerns about the plan
3. If concerns: Raise them with your human partner before starting
4. If no concerns: Create TodoWrite and proceed

### Step 2: Execute Tasks

For each task:
1. Mark as in_progress
2. Follow each step exactly (plan has bite-sized steps)
3. Run verifications as specified
4. Mark as completed

**Wave-aware execution:** If the plan uses wave structure (sections headed `## Wave N — ...`), treat wave boundaries as mandatory checkpoints:

1. Execute all tasks within the current wave sequentially
2. At a `Wave N verification checkpoint` section:
   - Run every verification command listed in the checkpoint
   - If any verification fails: STOP and report the failure. Do not proceed to the next wave.
   - If all verification passes: report wave completion before continuing.
   - Prefer active verification over mere status reporting. If `agenthub-proactive-verify` is available and the checkpoint calls for functional validation, announce: "I'm using the agenthub-proactive-verify skill to validate this wave before proceeding." Then run the checkpoint commands.
3. If the plan does not use wave structure, execute tasks as a flat sequence.

**Wave checkpoint is a gate, not a suggestion.** A failing checkpoint blocks all subsequent waves.

### Step 3: Complete Development

After all tasks complete and verified:

**If working in a git worktree:**
- Announce: "I'm using the finishing-a-development-branch skill to complete this work."
- **REQUIRED SUB-SKILL:** Use superpowers:finishing-a-development-branch
- Follow that skill to verify tests, present options, execute choice

**If working on a simple feature branch (no worktree):**
- Announce: "I'm using the agenthub-prepare-pr skill to finish this branch."
- **REQUIRED SUB-SKILL:** Use agenthub-prepare-pr
- Follow that skill to verify, clean up commits, and merge locally or create a PR

## When to Stop and Ask for Help

**STOP executing immediately when:**
- Hit a blocker (missing dependency, test fails, instruction unclear)
- Plan has critical gaps preventing starting
- You don't understand an instruction
- Verification fails repeatedly

**Ask for clarification rather than guessing.**

## When to Revisit Earlier Steps

**Return to Review (Step 1) when:**
- Partner updates the plan based on your feedback
- Fundamental approach needs rethinking

**Don't force through blockers** - stop and ask.

## Remember
- Review plan critically first
- Follow plan steps exactly
- Don't skip verifications
- Reference skills when plan says to
- Stop when blocked, don't guess
- Never start implementation on main/master branch without explicit user consent

## Integration

**Required workflow skills:**
- **superpowers:writing-plans** - Creates the plan this skill executes
- **agenthub-prepare-pr** - Complete development after all tasks when using a normal feature branch

**Optional workflow skills:**
- **superpowers:using-git-worktrees** - Set up isolated workspace before starting when worktree isolation is useful
- **superpowers:finishing-a-development-branch** - Complete development after all tasks in a worktree-based workflow
- **agenthub-proactive-verify** - Active testing workflow for wave checkpoints and final validation
