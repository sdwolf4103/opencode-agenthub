# opencode-agenthub library

This directory is the built-in library shipped with the package. When you run `agenthub setup auto`, the coding assets here are installed into your Agent Hub Home (`~/.config/opencode-agenthub/` by default).

Examples below use the short CLI command `agenthub`. `opencode-agenthub` remains a compatibility alias.

## Asset layers

Core layers:

- `souls/` — agent identity files (system prompts). One file per agent.
- `bundles/` — bundle definitions (JSON). Each bundle maps one or more agents to a soul, skills, model, and tools.
- `profiles/` — profile definitions (JSON). A profile selects which bundles to activate in a workspace.
- `skills/` — skill directories. Each skill has a `SKILL.md` that opencode can load at runtime.

Advanced / optional layers:

- `instructions/` — shared instruction documents referenced by bundles.
- `mcp/` — MCP server registration JSONs.
- `mcp-servers/` — MCP server scripts referenced by `mcp/*.json`.

`setup auto` keeps the initial home small. Optional directories such as `instructions/`, `mcp/`, and `mcp-servers/` are created when you actually use them.

## Built-in profiles

| Profile | Bundles included |
|---|---|
| `auto` | `auto`, `plan`, `build` |
| `hr` | `hr`, `hr-sourcer`, `hr-evaluator`, `hr-cto`, `hr-adapter`, `hr-verifier`, `auto`, `plan`, `build` |

## Asset model

```
agent = soul + bundle + skills + runtime + policy
```

- **soul** — system prompt / behavioral identity (`souls/<name>.md`)
- **bundle** — agent definition: soul ref, model, skills, MCP, tool policy (`bundles/<name>.json`)
- **profile** — workspace composition: which bundles + which plugin + default agent (`profiles/<name>.json`)
- **skill** — injectable capability loaded on demand (`skills/<name>/SKILL.md`)

## MCP servers

To add a custom MCP server:

1. Put the server implementation in `mcp-servers/my-tool.ts`
2. Put the registration JSON in `mcp/my-tool.json`
3. Reference the MCP name in a bundle's `mcp` array

If you stage or export a team that depends on MCP tools, both directories matter:

- `mcp/` contains the registration JSONs
- `mcp-servers/` contains the runnable server implementations (and optionally `package.json` for dependencies)

Shipping only `mcp/*.json` without the referenced `mcp-servers/` files is incomplete and will fail at runtime.

Example `mcp/my-tool.json`:

```json
{
  "type": "local",
  "command": ["bun", "${LIBRARY_ROOT}/mcp-servers/my-tool.ts"],
  "timeout": 30000
}
```

Available path tokens inside MCP JSON values: `${LIBRARY_ROOT}`, `${REPO_SRC_ROOT}`, `${REPO_ROOT}`.

## Hub Home resolution order

1. `OPENCODE_AGENTHUB_HOME` environment variable
2. `~/.config/opencode-agenthub`
3. Built-in repo fallback under `src/composer/library`

## Example commands

```bash
agenthub setup auto
agenthub start
agenthub hr
agenthub hr recruiter-team
agenthub new bundle my-bundle
agenthub new profile my-profile
agenthub backup --output ./agenthub-backup
agenthub restore --source ./agenthub-backup --overwrite
```

## Restore / import behavior

- Skips colliding files by default and reports them
- `--overwrite` replaces colliding files
- `--settings replace` replaces the target `settings.json` (default: `preserve`)
- `hub-import` remains available for advanced import into a chosen target home
