# Final Checklist — demo-coding-team

READY FOR HUMAN CONFIRMATION

- Demo package root present at `staging/demo-coding-team/`.
- Required staged import root present at `staging/demo-coding-team/agenthub-home/`.
- Package includes `handoff.json`, `worker-card.json`, `promotion-memo.md`, all referenced bundles, all referenced souls, and all referenced vendored skills.
- Profile `demo-coding-team` references seven bundles and defaults to `coding-delivery-lead`.
- Bundle metadata aligns with one primary host plus six subagents.
- Coding-delivery-lead bundle includes `agenthub-proactive-verify` and `agenthub-prepare-pr` alongside the existing execution and git hygiene skills.
- No MCP consultant bundle references remain.
- Canonical explore naming is used throughout the package.
- Non-coding specialist bundles explicitly harden permissions; `plan` and `systems-architect` use path-scoped plan-write permissions while verifier retains bash for evidence commands and other non-coding specialists remain edit/write denied.
- Provenance is documented in the promotion memo and worker card.
- Verifier handoff only happens after a concrete file artifact exists for the claimed phase.
- Preferred test path: `agenthub hr demo-coding-team`.
- Preferred promote path: `agenthub promote demo-coding-team`.
