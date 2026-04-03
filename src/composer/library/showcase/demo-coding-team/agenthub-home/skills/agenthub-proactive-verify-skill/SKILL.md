---
name: agenthub-proactive-verify
description: Use after implementing a feature, fixing a bug, or reaching a wave checkpoint when you need to actively test the behavior by running the app, exercising the flow, and confirming the change actually works.
---

# Agenthub Proactive Verify

## Overview

Verify that a code change actually works by running the application and exercising the changed behavior. This is a **testing workflow**, not a completion gate.

**How this differs from verification-before-completion:**
- `verification-before-completion` = behavioral gate before making success claims
- `agenthub-proactive-verify` = active testing workflow that runs the app, exercises the behavior, and checks what actually happens

Use this skill when you want to really test something, not just prove that you ran a command.

**Announce at start:** "I'm using the agenthub-proactive-verify skill to validate this change."

## When To Use

- After implementing a feature and wanting to confirm the user-visible behavior
- After fixing a bug and wanting to verify the original symptom is gone
- At a wave verification checkpoint when the plan calls for functional validation
- Before committing or preparing a PR when hands-on testing matters

## The Process

### Step 1: Identify What to Verify

Before running anything, answer these questions:

1. What changed?
2. What should be observably different now?
3. How can a human tell it is working?

If you cannot answer all three, ask the user before proceeding.

### Step 2: Choose a Verification Strategy

| Change Type | Verification Strategy |
|---|---|
| CLI behavior | Run the CLI command with realistic inputs and inspect output |
| API endpoint | Start the server, hit the endpoint, inspect response |
| UI flow | Start the app, navigate to the page or flow, inspect visible behavior |
| Library function | Run a focused script or targeted test using the actual function |
| Build/config change | Run the build or config-dependent command and inspect artifacts |

Prefer the most user-realistic path available.

### Step 3: Execute Verification

For each verification command:

1. Run the actual command
2. Read the real output, not just the exit code
3. Compare it to the expected behavior from Step 1
4. Record the evidence for the final report

If the verification requires a running server or dev process:

1. Start it
2. Wait for a concrete ready signal
3. Run the verification
4. Clean up the process after the check

### Step 4: Report Results

Use this format:

```text
## Verification Results

**What was verified:** [description]
**Strategy used:** [CLI/API/UI/library/build]

### Commands and Output
[command]
→ [summary of output]
→ ✅ Expected / ❌ Unexpected

### Verdict
PASS / FAIL / INCONCLUSIVE
```

## Examples

### CLI feature

```bash
# Added --verbose flag
bun run build --verbose
```

Expected: file-by-file or step-by-step output appears, not just summary output.

### API endpoint

```bash
bun run dev &
curl -s localhost:3000/api/health
kill $!
```

Expected: endpoint returns the documented healthy response.

### Bug fix

```bash
bun test tests/pagination.test.ts -v
```

Expected: the regression case passes and the original symptom no longer appears.

## Integration

**Called by:**
- user directly
- `superpowers:executing-plans` at wave verification checkpoints

**Pairs with:**
- `superpowers:verification-before-completion` — use that for evidence-before-claims discipline
- `agenthub-prepare-pr` — use that after testing when you are ready to finish a normal feature branch

## Common Mistakes

- Running only the unit test and never exercising the real behavior
- Claiming success without comparing actual output to expected behavior
- Using a synthetic verification path when a more realistic path is available
- Forgetting to clean up long-running verification processes
