# Plugin degraded mode

## Symptoms
- plugin doctor reports degraded mode
- runtime config is missing or local plugins are not showing up
- local plugin changes do not appear in an existing composed workspace

## Cause
The composed workspace runtime config is missing, unreadable, or stale. Local filesystem plugins may also be blocked if `localPlugins.bridge` is disabled.

## Fix
- Re-compose the workspace with `agenthub start <profile>` or `agenthub hr <profile>`
- If you want local filesystem plugins copied in, set `localPlugins.bridge` to `true` in `settings.json`
- Re-compose after changing source plugin files

## Verify
Run `agenthub doctor --category plugin --config-root <runtime-config-root>` and confirm the runtime config loads cleanly.
