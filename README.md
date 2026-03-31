# opencode-agenthub

[![npm version](https://img.shields.io/npm/v/opencode-agenthub.svg)](https://www.npmjs.com/package/opencode-agenthub)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> Requires Node >= 18.0.0. Supports macOS and Linux directly. Windows users should use WSL 2 for the best experience; native Windows support remains best-effort alpha.

`opencode-agenthub` puts a ready AI coding team into each repo you work in — and when you want a better one, its HR Office helps you assemble custom teams from strong public agent repos, test them safely, and adopt only what you trust.

Use it in two ways:

- **everyday coding** — get a ready `auto / plan / build` team into each repo with `setup auto` and `start`
- **HR Office** — source, test, and promote stronger custom teams without touching your normal setup until you are ready

The npm package name is `opencode-agenthub`. The CLI command is `agenthub`. `opencode-agenthub` also works as a compatibility alias.

---

## Install

```bash
npm install -g opencode-agenthub
```

Then verify:

```bash
agenthub --version
agenthub --help
```

## Requirements

- Node >= 18.0.0 on `PATH`
- [opencode](https://opencode.ai) on `PATH`
- Python 3 on `PATH` for HR inventory sync and staged-package helper scripts
- Bun (for tests/development only)

### Platform support

| Platform | Status |
|---|---|
| macOS | Supported |
| Linux | Supported |
| Windows via WSL 2 | Supported and recommended |
| Native Windows | Best-effort alpha support |

For Windows users, install and run Agent Hub inside [WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install). This matches OpenCode's recommended Windows setup and preserves expected POSIX behavior for bash launchers, Python helpers, symlinked skills, and shell tooling.

Native Windows is still best-effort in alpha. Agent Hub now emits a startup notice on native Windows, generates `run.cmd` alongside `run.sh`, and avoids a few common platform pitfalls, but HR and shell-centric workflows are still most reliable under WSL 2.

---

## Quick start

For most solo users, this is the whole flow:

### 1. Create your Agent Hub home

```bash
agenthub setup auto
```

This creates your personal Agent Hub home and installs the built-in `auto / plan / build` setup.

It also imports your existing opencode provider/model basics. If something looks wrong, `agenthub doctor` will tell you what to fix.

### 2. Start working in your repo

```bash
agenthub start
```

This activates your default coding team in the current repo.

After that, you can keep using plain `opencode` inside the folder for day-to-day work.

### 3. Inspect what is active

```bash
agenthub status
```

Use `status` any time you want to see which profile, agents, plugins, and runtime boundaries are active.

### 4. If something feels off, diagnose it

```bash
agenthub doctor
```

`doctor` checks your environment, home, workspace runtime, or plugin setup and points you to the right troubleshooting guide.

---

## HR Office — recruit a better team without touching your normal setup

The default `auto / plan / build` team gets you moving fast. HR Office is where Agent Hub becomes a stronger product:

- discover strong public agent / skill repos
- stage a candidate team in isolation
- test it in a real repo with `agenthub hr <profile>`
- promote only what you want into your normal setup

Start here:

```bash
agenthub hr
```

Read the full HR guide at [`docs/hr-office.md`](docs/hr-office.md).

## Everyday commands

| Command | Effect |
|---|---|
| `agenthub setup auto` | Create your personal home with the default coding team |
| `agenthub start` | Launch the default team in the current repo |
| `agenthub start last` | Reuse the last profile used in this workspace |
| `agenthub start <profile>` | Launch a specific profile in this workspace |
| `agenthub status` | Inspect the current workspace runtime and plugin boundary state |
| `agenthub doctor` | Diagnose setup/runtime issues and link to fixes |
| `agenthub doctor --fix-all` | Apply safe automatic fixes where possible |
| `agenthub hr` | Enter the isolated HR Office |
| `agenthub hr <profile>` | Test an HR-home or staged HR profile in this workspace |
| `agenthub promote <package-id>` | Import an approved staged HR package into your Personal Home |

If you want a blank structure and no built-in coding team yet:

```bash
agenthub setup minimal
```

---

## Runtime visibility and troubleshooting

When you want to inspect the active runtime, plugin boundary state, or why something feels off, start here:

```bash
agenthub status
agenthub status --short
agenthub status --json

agenthub doctor
agenthub doctor --category home
agenthub doctor --category environment
agenthub doctor --category workspace --config-root <path>
agenthub doctor --category plugin --config-root <path>
```

- `agenthub status` shows your active team, agents, plugins, and any health warnings.
- `agenthub doctor` checks your setup and tells you exactly what to fix.
- `plugin doctor` still works as a compatibility path, but it now routes through `agenthub doctor --category=plugin`.

For plugin bridge, OMO baseline, runtime boundary controls, and troubleshooting links, see [`docs/runtime-reference.md`](docs/runtime-reference.md).

---

## Build your own agents and teams

When you are ready to go beyond the default coding team:

| Command | Effect |
|---|---|
| `agenthub new soul reviewer` | Create a new soul scaffold |
| `agenthub new skill repo-audit` | Create a new skill scaffold |
| `agenthub new bundle reviewer` | Create a new bundle scaffold |
| `agenthub new profile my-team` | Create a new profile scaffold |
| `agenthub list` | List installed assets |
| `agenthub backup --output ./my-team-backup` | Back up your Personal Home |
| `agenthub restore --source ./my-team-backup` | Restore your Personal Home from a backup |

---

## What Agent Hub creates

| Part | What it does | Default location |
|---|---|---|
| **Personal Home** | Your reusable main library of teams, prompts, skills, and settings | `~/.config/opencode-agenthub/` |
| **Workspace Runtime** | The active composed runtime for one project | `<workspace>/.opencode-agenthub/current/` |
| **HR Office** | An isolated place to source, test, and stage stronger teams | `~/.config/opencode-agenthub-hr/` |

If you used `setup auto`, you already have a ready-to-run default profile.

> **Terminology:** A *profile* is a team. A *bundle* is one agent in that team. You only need these two terms until you start building custom teams.

---

## Storage layout

### Personal Home

Default location:

```text
~/.config/opencode-agenthub/
```

Created up front:

```text
souls/
skills/
bundles/
profiles/
settings.json
```

Created only when you actually use them:

```text
instructions/
mcp/
mcp-servers/
```

### Workspace Runtime

Default location:

```text
<workspace>/.opencode-agenthub/current/
```

Workspace-specific memory lives in:

```text
<workspace>/.opencode-agenthub.user.json
```

That file stores things like:

- last-used `start` profile in this workspace
- last-used `hr` test profile in this workspace
- `.envrc` preference state

## Upgrade

Use this only when you install a newer package version and want to refresh built-in managed files in an existing home.

```bash
# preview Personal Home built-in file changes
agenthub upgrade

# overwrite Personal Home managed built-in files
agenthub upgrade --force

# preview HR Office built-ins + helper scripts
agenthub upgrade --target-root ~/.config/opencode-agenthub-hr

# overwrite HR Office built-ins + helper scripts
agenthub upgrade --target-root ~/.config/opencode-agenthub-hr --force
```

Notes:

- `agenthub upgrade` targets your Personal Home by default
- `agenthub upgrade --target-root ~/.config/opencode-agenthub-hr` targets HR Office
- HR upgrade refreshes built-in HR assets and helper scripts, but **never modifies** staged packages under `~/.config/opencode-agenthub-hr/staging/`
- Continue to test staged teams with `agenthub hr <profile>` before using `agenthub promote <package-id>`

If a compose or runtime issue persists after upgrade, run `agenthub doctor` and follow the linked `docs/troubleshooting/...` guide for the reported category.

---

## Development

```bash
bun run test:smoke
npm run build
```
