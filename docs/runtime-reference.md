# Runtime reference

Use this page when you want the deeper runtime details behind `agenthub status` and `agenthub doctor`.

## Main commands

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

- `agenthub status` shows your active team, runtime source, agents, plugins, and health hints.
- `agenthub doctor` checks home, environment, workspace, or plugin-specific issues and prints remediation plus `docs/troubleshooting/...` links when available.

## Runtime boundary controls

- `settings.json -> localPlugins.bridge = true` keeps local filesystem plugins from `~/.config/opencode/plugins/` copied into composed runtimes. Set it to `false` if you want to disable that bridge.
- `settings.json -> omoBaseline = "ignore"` keeps Agent Hub isolated from the global `~/.config/opencode/oh-my-opencode.json` baseline. Keep the default inherited mode if you want shared OMO categories.
- Troubleshooting docs live under `docs/troubleshooting/` and are referenced directly by doctor output.

## When to use troubleshooting docs

- `docs/troubleshooting/environment-setup.md` — missing Node.js, Python, or `opencode`
- `docs/troubleshooting/compose-failures.md` — missing profiles, bundles, or broken compose prerequisites
- `docs/troubleshooting/plugin-degraded-mode.md` — runtime config or local plugin bridge problems
- `docs/troubleshooting/guard-and-skill-conflicts.md` — missing guards, mixed OMO/native profiles, or inherited OMO baseline issues
- `docs/troubleshooting/model-configuration.md` — invalid `provider/model` syntax in overrides
