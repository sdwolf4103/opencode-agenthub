# HR Office Home

This directory is Agent Hub's isolated HR workspace. HR sourcing, evaluation, staging, and helper state live here instead of in your Personal Home.

## Key folders

- `inventory/` — sourced worker and model inventory
- `sources/` — cached upstream repos and model catalogs
- `staging/` — staged Agent Hub packages at `staging/<package-id>/agenthub-home/`
- `output/` — generated reports and handoff artifacts
- `logs/` — HR run logs
- `bin/` — helper scripts used by HR staging and validation

## Key files

- `settings.json` — HR Office settings, model choices, and managed built-in version metadata
- `hr-config.json` — source configuration for inventory sync
- `README.md` — this guide

## Common usage

Enter HR Office:

```bash
agenthub hr
```

Test an HR-home or staged profile in any workspace before promote:

```bash
agenthub hr <profile>
```

Built-in demo example:

```bash
agenthub hr demo-coding-team
agenthub promote demo-coding-team
```

After you try the staged demo in a real repo, promote it with 'agenthub promote demo-coding-team' to copy the same team into your Personal Home.

Validate a staged package directly:

```bash
python3 ~/.config/opencode-agenthub-hr/bin/validate_staged_package.py ~/.config/opencode-agenthub-hr/staging/<package-id>
```

Promote an approved staged package into your Personal Home:

```bash
agenthub promote <package-id>
```

Refresh HR Office built-ins and helper scripts:

```bash
agenthub upgrade --target-root ~/.config/opencode-agenthub-hr
agenthub upgrade --target-root ~/.config/opencode-agenthub-hr --force
```

`upgrade` never modifies staged packages under `staging/`.
