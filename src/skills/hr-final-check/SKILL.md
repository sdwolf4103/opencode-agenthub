---
name: hr-final-check
description: "Final package QA checklist for clarity, safety, and import readiness"
audience: "HR verifier subagent"
license: MIT
compatibility: "opencode >= 0.1"
metadata:
  domain: agent-qa
  version: "1.0"
---

# HR Final Check Protocol

## Purpose

Verify that a staged package is understandable and safe before the human operator approves it.

## Required Checklist Sections

1. package completeness
2. provenance completeness
3. bundle/profile coherence
4. soul clarity
5. skill clarity
6. MCP completeness and host-runtime clarity
7. deployment role correctness
8. unresolved risks / open decisions
9. import-root and assemble-only validation
10. runtime configuration confirmation
11. protocol-compliance checkpoints

## Clarity Definitions

### Subagent description clear

All of the following must be true:

- the description states what the subagent does
- the description states its scope or boundary
- the description does not overlap ambiguously with another staged subagent

### Skill description clear

All of the following must be true:

- the description states when to use the skill
- the description states what procedure it performs
- the description states what output or result the user/operator should expect

## Final Output

Write `final-checklist.md` and end with a human-facing status:

- `READY FOR HUMAN CONFIRMATION`
- `READY WITH CAVEATS`
- `NOT READY`

## Compact Checklist Shape

Keep `final-checklist.md` compact and explicit. Use this shape:

```text
## Final Checklist - <package-id>
| Check | Result |
|---|---|
| import root is agenthub-home/ | pass/fail |
| no unsupported concepts | pass/fail |
| soul skill/tool sets declared | pass/fail |
| descriptions are operator-readable | pass/fail |
| MCP registrations resolve to staged servers or blocker | pass/fail |
| handoff clearly separates test/use/promote | pass/fail |
| model preferences were confirmed before assembly | pass/fail |
| final names were user-confirmed | pass/fail |
| specialized work was delegated | pass/fail |
| staged model ids confirmed via opencode environment | pass/fail |
| profile defaultAgent matches bundle agent.name | pass/fail |
| team includes at least one primary, non-hidden agent | pass/fail |
| default opencode agent policy confirmed | pass/fail |
| default-profile preference recorded if present | pass/fail |
| no host project mutations | pass/fail |
overall: READY FOR HUMAN CONFIRMATION | READY WITH CAVEATS | NOT READY
blocker: <description or none>
```

## Hard Validation Rule

The package cannot be marked ready unless the verifier confirms:

1. the handoff shows: (a) staging path, (b) test command `agenthub hr <profile>`, (c) promote command `agenthub promote <package-id>`
2. the manual import fallback points to `<package-root>/agenthub-home` and is described as advanced/manual only
3. all referenced skills either exist inside the staged `skills/` directory or are explicitly rejected as missing blockers
4. `python3 $HR_HOME/bin/validate_staged_package.py $HR_HOME/staging/<package-id>` passes
5. the package explicitly records whether default opencode agents are kept or hidden, and if `promotion_preferences.set_default_profile` is present, it is consistent
6. staged model ids are either confirmed available in the opencode environment or are called out as blockers/caveats for human review
7. if any bundle references MCP tools, the staged package includes the referenced `mcp/*.json` files, the required `mcp-servers/` implementation files, and `mcp-servers/package.json` when runtime dependencies are needed
8. the handoff clearly shows how to test/use the staged profile in a workspace before promote, and promote is not described as mandatory for workspace use
9. if a profile sets `defaultAgent`, that value exactly matches one of the staged bundles' `agent.name` values (not just the bundle filename)
10. the staged team includes at least one non-hidden primary agent, and any `team-only` profile keeps at least one such primary agent available to the operator

If bundle metadata contains fake runtime keys such as `optional_skills` or `runtime_conditional_skills`, mark the package `NOT READY` until they are removed or rewritten as plain documentation outside runtime bundle semantics.
