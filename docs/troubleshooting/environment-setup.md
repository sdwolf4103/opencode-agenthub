# Environment setup

## Symptoms
- `agenthub doctor --category environment` reports missing Node.js, Python, or `opencode`
- compose or HR flows fail before runtime startup

## Cause
Required binaries are not installed or not available on `PATH`.

## Fix
- Install Node.js if your workflows depend on JavaScript tooling
- Install `opencode` and confirm `opencode --version` works
- Install `python3` if you use HR validation or Python helpers
- Restart your shell so updated `PATH` entries are loaded

## Verify
Run:
- `agenthub doctor --category environment`
- `node --version`
- `opencode --version`
- `python3 --version`
