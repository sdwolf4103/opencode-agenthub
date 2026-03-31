# HR Office

HR Office is Agent Hub's isolated place for discovering, testing, and promoting stronger custom teams.

Use it when you want to tell Agent Hub, in plain English, what kind of team you want, explore strong public agent / skill repos, and only then import the result into your normal setup.

> **Isolated by default:** HR Office never touches your Personal Home until you explicitly run `agenthub promote <package-id>`.

## Start here

```bash
agenthub hr
```

Example asks:

- `I want an agent that can build and verify TypeScript CLIs. Use strong public references, shortlist candidates, and stage a package for me.`
- `I want a frontend architect agent for Next.js and a11y review. Please source references, compare them, and propose a team.`

Default location:

```text
~/.config/opencode-agenthub-hr/
```

Override with `OPENCODE_AGENTHUB_HR_HOME`.

## HR commands

| Command | Effect |
|---|---|
| `agenthub hr` | Open or bootstrap the isolated HR Office |
| `agenthub hr <profile>` | Test an HR-home or staged HR profile in the current workspace before promote |
| `agenthub hr last` | Reuse the last HR profile tested in this workspace |
| `agenthub promote <package-id>` | Import an approved staged HR package into your Personal Home |

Typical staged-team flow:

1. HR builds a package under `~/.config/opencode-agenthub-hr/staging/<package-id>/`
2. Test it in your repo with `agenthub hr <profile>`
3. Promote it with `agenthub promote <package-id>` once satisfied

## Why HR Office matters

HR Office is the product path for building a better team than the default starter setup:

- it keeps sourcing and experiments isolated from your day-to-day environment
- it can evaluate public repos and stage a candidate team before you commit to it
- it lets you test the staged team in a real repo before promote

## HR runtime details

- HR syncs GitHub worker sources and a model catalog into `~/.config/opencode-agenthub-hr/inventory/`
- HR validates staged `provider/model` ids against that synced catalog instead of inventing names
- If a staged team should hide default opencode agents like `general`, `explore`, `plan`, and `build`, HR stages the profile with `nativeAgentPolicy: "team-only"`
- If approved during HR handoff, `agenthub promote <package-id>` can also make the promoted profile your new default bare `agenthub start` profile
- Model variants are stored separately as `model` + `variant`, not as one combined string

## HR structure

Inside `~/.config/opencode-agenthub-hr/` you will typically see:

```text
bin/
inventory/
logs/
output/
sources/
staging/
settings.json
hr-config.json
README.md
```

- `staging/` holds staged packages at `staging/<package-id>/agenthub-home/`
- `inventory/` and `sources/` hold synced worker and model source data
- `bin/` holds helper scripts used by staging and validation
- `README.md` inside the HR home explains the layout and common commands

## Default HR sources

HR Office bootstraps with these default GitHub sources:

- `garrytan/gstack`
- `anthropics/skills`
- `msitarzewski/agency-agents`
- `obra/superpowers`
- `K-Dense-AI/claude-scientific-skills`

It also bootstraps a default model catalog source:

- `https://models.dev/api.json`

Edit `~/.config/opencode-agenthub-hr/hr-config.json` to change either source set.

The synced model inventory is written under:

```text
~/.config/opencode-agenthub-hr/inventory/models/
```

This gives HR an exact local list of valid `provider/model` ids during architecture review and adaptation.

One good repo to add yourself if it matches your needs:

- `affaan-m/everything-claude-code` - broad practical Claude Code workflow pack if you want a larger, more opinionated source library

## HR upgrades are staging-safe

```bash
agenthub upgrade --target-root ~/.config/opencode-agenthub-hr
agenthub upgrade --target-root ~/.config/opencode-agenthub-hr --force
```

- HR upgrades refresh built-in HR assets and helper scripts
- HR upgrades never modify staged packages under `~/.config/opencode-agenthub-hr/staging/`
- Continue to test staged teams with `agenthub hr <profile>` before using `agenthub promote <package-id>`
