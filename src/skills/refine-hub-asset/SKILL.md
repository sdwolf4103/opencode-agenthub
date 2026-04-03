---
name: refine-hub-asset
description: Safely edit an existing Agent Hub asset with asset-type-specific checks and follow-up verification.
when_to_use: Use when modifying a soul, bundle, profile, instruction, or skill that already exists.
---

# refine-hub-asset

## Purpose

Refine one existing hub asset without guessing its type, location, or downstream effects.

## Workflow

1. Start with the explicit question: **Which asset type are you editing?**
2. Identify the exact asset name and file path before changing anything.
3. Confirm what should change, why it should change, and what must stay stable.
4. Create a backup or at minimum call out destructive risk before making a risky edit.
5. Apply asset-specific editing rules.
6. Verify syntax, references, and downstream effects after the edit.
7. Report what changed, what was checked, and any follow-up assets that may also need updates.

## Supported asset types

- **Soul**
- **Bundle**
- **Profile**
- **Instruction**
- **Skill**

## Asset-specific rules

- **Soul** — preserve key sections unless the request explicitly changes them.
- **Bundle** — validate referenced soul, skills, instructions, and mode fields.
- **Profile** — validate the bundle list and `defaultAgent`.
- **Instruction** — treat it as additive operating guidance, not a soul rewrite.
- **Skill** — preserve required frontmatter keys and run `validateSkillFrontmatter` after edits.

## Anti-patterns

- Do not guess the asset type.
- Do not skip backup thinking for destructive changes.
- Do not silently remove fields.
- Do not casually edit reserved built-in assets.

## Verification

- Re-open the edited file and verify the requested change is actually present.
- Re-check cross-references to other assets.
- For skills, run `validateSkillFrontmatter`.
- For bundles and profiles, verify referenced names still exist.
