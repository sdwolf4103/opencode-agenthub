# Promotion Memo: demo-coding-team

## Intent

Stage a public demo coding team for daily product delivery across Next.js, backend, OpenCode plugin work, Python, disciplined git execution, and wave-based verification.

## Packaged Profile

- Profile id: `demo-coding-team`
- Profile label: `demo-coding-team`
- Default agent: `demo-coding-team-coding-delivery-lead`
- Deployment shape: one primary host plus six callable specialists
- Default opencode agents: hidden via `nativeAgentPolicy: "team-only"`
- Promote default-profile behavior: leave existing default unchanged

## Encoded Workflow

- The host plans and codes, and can consult the plan specialist, architect, or any other specialist.
- The host synthesizes findings before delegating follow-up work.
- Plans or analysis must be saved to files before the phase verifier is asked to review them.
- The architect handles ADRs, design review, tradeoffs, and system boundaries rather than day-to-day implementation.
- The code reviewer can be called either before implementation starts or after implementation completes.
- Every completed phase must be sent to `demo-coding-team-phase-verifier` before the host claims success.
- The phase verifier intentionally keeps `bash` access for read-only evidence commands, while `plan` and `systems-architect` use path-scoped plan-write permissions and the other non-coding specialists keep `edit`/`write` denied.
- Git discipline stays with the host through `obra-superpowers-skills-using-git-worktrees-skill` for isolated flows and `agenthub-prepare-pr-skill` for normal feature-branch finishing.
- Plans may be written with optional wave checkpoints, and active functional verification can be handled through `agenthub-proactive-verify-skill` at those boundaries.

## Verifier Preconditions

- Every verifier handoff must be backed by a file-backed artifact: changed source files, saved plan markdown, saved analysis note, checklist, or equivalent on-disk evidence.
- Chat-only analysis is not a review surface.

## Source Basis / Provenance

- `coding-delivery-lead` — original role built during HR assembly
- `systems-architect` — adapted from `msitarzewski/agency-agents` Software Architect
- `frontend-consultant` — adapted from `msitarzewski/agency-agents` Frontend Developer
- `plan` — Claude Code-inspired planning specialist adapted into Agent Hub package form
- `phase-verifier` — adapted from `msitarzewski/agency-agents` Reality Checker
- `explore` — adapted from `msitarzewski/agency-agents` Evidence Collector
- `comprehensive-code-reviewer` — adapted from `obra/superpowers` code reviewer role
- Supporting vendored skills sourced from `obra/superpowers` and `anthropics/skills`

## Vendored Skill Subset

This built-in showcase vendors a lightweight subset of the skills used by the
source staged team so it stays small and runnable without extra browser engines,
Python packages, or heavyweight helper binaries.

Excluded from vendoring:

- `garrytan-gstack-browse-skill` — browser automation skill package
- `garrytan-gstack-plan-eng-review-skill` — heavyweight eng-review process skill
- `anthropics-skills-skills-webapp-testing-skill` — browser testing helper with Python examples
- `anthropics-skills-skills-mcp-builder-skill` — MCP reference skill with Python helpers

Roles that originally depended on those skills are re-mapped to the approved
lightweight skill set in this package. Their soul documents note the original
intent where useful, and the full skills can still be added independently later.
The seven-role team shape now uses one primary delivery lead plus six subagents: plan, systems-architect, frontend-consultant, phase-verifier, explore, and comprehensive-code-reviewer. The lead now carries two additional lightweight Agent Hub skills: `agenthub-proactive-verify` and `agenthub-prepare-pr`.

## Advisory Model Defaults

Bundle model settings mirror the approved defaults, but they remain advisory package defaults and depend on runtime availability. User-specified variants are staged in canonical opencode form (`model` + `variant`) when applicable.

## Import Paths

- Preferred test path: `agenthub hr demo-coding-team`
- Preferred promote path: `agenthub promote demo-coding-team`
- Manual fallback: `agenthub hub-import --source ~/.config/opencode-agenthub-hr/staging/demo-coding-team/agenthub-home`
