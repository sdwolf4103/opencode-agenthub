---
name: write-skill
description: Draft or update a portable Agent Hub skill with clean frontmatter and a practical workflow.
when_to_use: Use when creating a new skill asset or turning a rough prompt into a reusable SKILL.md.
---

# write-skill

## Purpose

Create a portable Agent Hub skill as markdown, not a product-internal code registration. The outcome should be a `SKILL.md` that another hub can read, validate, and reuse.

## Workflow

1. Gather the skill's job, trigger conditions, audience, constraints, and expected outputs.
2. Draft required frontmatter first: `name`, `description`, and `when_to_use`.
3. Add optional keys only when they genuinely help, such as `allowed-tools`, `paths`, `model`, or `agent`.
4. Draft the markdown body with focused sections like purpose, workflow, boundaries, verification, and anti-patterns.
5. Run `validateSkillFrontmatter` on the draft content before presenting it as done.
6. Write the file to the correct target:
   - user home skill: `agenthub-home/skills/<skill-name>/SKILL.md`
   - built-in hub-local skill: `src/skills/<skill-name>/SKILL.md`
7. Verify the file exists, frontmatter parses cleanly, and the body still matches the requested behavior.

## Frontmatter quick reference

| Key | Required | Use it for |
|---|---|---|
| `name` | yes | Stable skill id |
| `description` | yes | Short operator-facing summary |
| `when_to_use` | yes | Trigger guidance for the host agent |
| `allowed-tools` | optional | Tool restrictions or hints |
| `paths` | optional | Relevant repo areas |
| `model` / `agent` / `effort` | optional | Special runtime guidance only when justified |

## Drafting rules

- Prefer one focused job per skill.
- Keep instructions reusable across repos when possible.
- Explain the decision flow, not just the final output format.
- If the skill will edit files, say what must be verified after the edit.

## Anti-patterns

- Do not stuff multiple unrelated workflows into one skill.
- Do not add optional keys just because they exist.
- Do not describe skills as Claude-only internal bundles or code-registered objects.
- Do not skip frontmatter drafting and "add it later."

## Verification

- Confirm the frontmatter has the required keys.
- Run `validateSkillFrontmatter` and fix any hard errors.
- Treat unknown-key warnings as a prompt to simplify unless the extra key is intentionally supported.
- Re-read the body to ensure headings and workflow steps are present.
