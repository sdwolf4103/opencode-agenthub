---
name: hr-assembly
description: "Adapt approved candidates into staged Agent Hub packages for test and promote"
audience: "HR adapter subagent"
license: MIT
compatibility: "opencode >= 0.1"
metadata:
  domain: agent-assembly
  version: "1.0"
---

# HR Assembly Protocol

## Purpose

Generate a staged package under `$HR_HOME/staging/<package-id>/` without mutating imported home assets.

## Required Package Layout

```text
$HR_HOME/staging/<package-id>/
  handoff.json
  promotion-memo.md
  worker-card.json
  agenthub-home/
    bundles/
    profiles/
    souls/ or skills/
    mcp/
    mcp-servers/
```

## Staging Rules

- For **pure-soul agents**, stage a soul file plus bundle and profile.
- For **mixed soul+skill agents**, preserve specialized scope and prefer `subagent` mode unless the user explicitly wants otherwise.
- For **skill assets**, stage a skill directory plus a bundle/profile that preserves host selection requirements.
- If a staged bundle references a skill, stage that skill directory under `agenthub-home/skills/<skill-name>/` unless the package is explicitly documented as depending on a separately imported prerequisite package.
- If a staged bundle references an MCP tool, stage the matching `agenthub-home/mcp/<name>.json` registration file and the referenced `agenthub-home/mcp-servers/` implementation files. If the command relies on `mcp-servers/node_modules/...`, also stage `mcp-servers/package.json` so dependencies can be installed on import/promote.
- Do **not** invent runtime semantics in bundle `metadata`. Keys such as `optional_skills` or `runtime_conditional_skills` are notes only and are not valid substitutes for staged skills or real platform behavior.
- Prefer namespaced bundle/soul/profile names for adapted teams or rewrites so the package does not overwrite shared starter assets like `plan`, `build`, or `explore` unless the human explicitly requests replacement.
- If a staged profile sets `defaultAgent`, it must use the staged bundle's `agent.name` value, not the bundle filename. This matters when bundle filenames are namespaced but `agent.name` is shorter.
- Before final assembly, confirm whether the operator wants to keep default opencode agents such as `general`, `explore`, `plan`, and `build`. If not, the staged profile must set `"nativeAgentPolicy": "team-only"`. This suppresses host native agent merges and emits `disable: true` overrides for default opencode agents that are not supplied by the staged team itself.
- If `nativeAgentPolicy` is `team-only` and the staged bundle set does not already provide `explore`, automatically include the built-in hidden `explore` subagent so the team retains investigation coverage without another user prompt.
- Before final assembly, MUST verify the staged bundle set includes at least one `agent.mode: "primary"` agent that is not hidden. If all sourced candidates are subagent-style, either add/create a primary host agent or keep native agents visible. Never stage an all-subagent team as `team-only`.
- If a prior or external flow has set `promotion_preferences.set_default_profile`, preserve it in `handoff.json`. Do not proactively ask the operator about default-profile preferences during assembly.
- If AI models are still unresolved when final assembly begins, stop and confirm the exact model choice here before writing staged agent defaults. Model confirmation must use opencode environment availability probing, not the synced inventory catalog.
- If the operator specifies a model variant such as `xhigh`, `high`, or `thinking`, store it canonically as `agent.model: "provider/model"` plus `agent.variant: "..."`. For backward compatibility, combined strings like `"provider/model xhigh"` may still be accepted on read, but staged output should prefer the split form.
- The package must be promotable by:

```bash
agenthub promote <package-id>
```

- Advanced/manual fallback remains:

```bash
agenthub hub-import --source <package_root>/agenthub-home
```

- Standard handoff must tell the operator to test the staged team before promote with:

```bash
agenthub hr <profile-name>
```

- That test path must be described as a workspace runtime test that does not modify the operator's personal home.
- Standard handoff must also say that the same staged profile can be used in another workspace before promote by running the same command there.
- Promote must be described as the step that imports the package into the personal home so future bare `agenthub start` runs can use it.

## Required Handoff Fields

- `schema_version`
- `promotion_id`
- `worker_id`
- `asset_kind`
- `agent_class`
- `deployment_role`
- `target_profile`
- `proposed_profile`
- `package_layout_version`
- `artifacts`
- `generated_at`
- `promotion_preferences`
- `operator_instructions`
- `host_requirements` when MCP tools or other host-side dependencies exist

## Required Handoff Structure

`operator_instructions` must include:

- `test_current_workspace`
- `use_in_another_workspace`
- `promote`
- `advanced_import`

If MCP tools are referenced, `artifacts` must also include:

- `mcp_configs`
- `mcp_servers`

If MCP tools are referenced, `host_requirements` must explicitly state whether MCP servers are bundled and what runtime/environment dependencies remain on the host.

## Soul Adaptation Rule

When staging a **pure-soul** agent, the adapted soul must explicitly list:

- the intended skill set
- the intended tool set
- the agent's boundaries

This prevents vague souls that only describe personality.

## Mandatory Validation

Before you present a staged package as ready, run all of the following from the workspace root:

```bash
python3 $HR_HOME/bin/vendor_stage_skills.py $HR_HOME/staging/<package-id>
python3 $HR_HOME/bin/vendor_stage_mcps.py $HR_HOME/staging/<package-id>
python3 $HR_HOME/bin/validate_staged_package.py $HR_HOME/staging/<package-id>
```

If validation fails, the package is not ready.
