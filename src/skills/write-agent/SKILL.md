---
name: write-agent
description: Create or revise the core assets for an Agent Hub agent, including soul, bundle, and optional profile.
when_to_use: Use when authoring a new agent role directly instead of going through the HR staffing lane.
---

# write-agent

## Purpose

Author the asset set for a new Agent Hub agent role: a soul, a bundle, and optionally a profile. This skill handles direct asset authoring; HR handles staffing, sourcing, staging, and team assembly.

## Workflow

1. Gather the role's purpose, scope, runtime mode, tools, and expected collaboration pattern.
2. Decide whether the result is primarily a visible primary agent or a subagent-oriented helper.
3. Draft the soul with purpose, behavior contract, boundaries, and output style.
4. Draft the bundle JSON that binds the soul to runtime settings, permissions, skills, and model policy.
5. Optionally create or update a profile when the new bundle should be launchable as part of a named team.
6. Verify that soul, bundle, and profile references line up exactly.
7. If composition is uncertain, use scaffold helpers or assembly checks such as `agenthub new soul`, `agenthub new bundle`, `agenthub new profile`, and `agenthub start <profile> --assemble-only`.

## Core concepts

| Asset | What it does |
|---|---|
| soul | Defines identity, behavior, boundaries, and response style |
| bundle | Connects a soul to runtime settings, skills, permissions, and agent metadata |
| profile | Groups bundles into a launchable team and may set `defaultAgent` |

## Relationship to HR

- HR is for staffing, sourcing, candidate review, staging, and package assembly.
- `write-agent` is for direct asset authoring outside the HR pipeline.
- This skill is not itself a soul, agent class, or HR worker.

## Anti-patterns

- Creating a soul without a matching bundle.
- Hard-coding a model without a user request or clear policy reason.
- Adding guards reflexively instead of matching actual risk.
- Creating circular subagent relationships.
- Treating a profile as mandatory when only a bundle is needed.

## Verification

- Confirm the bundle references the intended soul.
- Confirm every listed skill and instruction exists.
- If a profile is added, verify its bundle list and `defaultAgent`.
- Use `agenthub start <profile> --assemble-only` when you need proof that composition succeeds.
