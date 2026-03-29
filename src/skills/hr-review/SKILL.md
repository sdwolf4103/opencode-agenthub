---
name: hr-review
description: "Review local inventory workers for security, compatibility, testing readiness, and description clarity"
audience: "HR evaluator subagent"
license: MIT
compatibility: "opencode >= 0.1"
metadata:
  domain: agent-review
  version: "1.0"
---

# HR Review Protocol

## Purpose

Update a local inventory worker card and write review notes for a single candidate.

## Output Files

Read and update:

- `$HR_HOME/inventory/workers/<candidate-slug>.json`

Write:

- `$HR_HOME/inventory/workers/<candidate-slug>.review.md`

## Compact Review Shape

Keep `<candidate-slug>.review.md` compact and field-based. Use this shape:

```text
## <candidate-slug> Review
fit: <high|medium|low>
agent_class: <pure-soul|mixed-soul-skill|skill>
deployment_role: <primary-capable|subagent-preferred|skill-attachment>
risk_tier: <low|medium|high>
testing_readiness: <ready|partial|unclear>
description_clarity: <clear|needs-clarification|unclear>
gaps: <comma list or none>
notes: <1-2 sentences>
```

## Required Worker Card Keys

- `schema_version`
- `candidate_slug`
- `worker_id`
- `name`
- `summary`
- `source_id`
- `source_path`
- `source_commit`
- `inventory_status`
- `asset_kind`
- `agent_class`
- `deployment_role`
- `type`
- `hire_shape`
- `host_requirement`
- `self_contained`
- `compatibility`
- `risk_tier`
- `testing_readiness`
- `description_clarity`
- `recommended_hosts`
- `flags`
- `artifacts`

## Inventory Status Values

- `draft`
- `available`
- `retired`

Use `draft` when first discovered or still incomplete, `available` when reviewed and fit for staffing, and `retired` when kept for reference but excluded from staffing.

## Review Dimensions

1. **Provenance** — can the source be traced cleanly?
2. **Security** — prompt injection, dangerous shell or code instructions, hidden external dependencies
3. **Compatibility** — can this become a native Agent Hub asset without pretending it is something else?
4. **Testing readiness** — are there enough instructions to test or verify the adapted asset?
5. **Clarity**
   - **subagent description clear** = the description states scope, inputs, outputs, and limits
   - **skill description clear** = the description states trigger/use-case, procedure, and expected output

Update `inventory_status` conservatively. Do not mark a worker `available` when provenance, safety, or clarity remain unresolved.

## Clarity Ratings

- `clear`
- `needs-clarification`
- `unclear`

## Agent Class Rules

- `pure-soul` when the candidate is primarily an identity/behavior contract and can host multiple tasks.
- `mixed-soul-skill` when identity and specialized workflow are fused and should usually stay narrow.
- `skill` assets are attachments and must not be upgraded into full agents without explicit adaptation work.
