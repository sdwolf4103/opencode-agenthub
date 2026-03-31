# Compose failures

## Symptoms
- doctor reports no profiles or no bundles
- `agenthub start <profile>` cannot compose a runtime

## Cause
Agent Hub home is missing the minimum profile/bundle structure needed to compose an agent runtime.

## Fix
- Add at least one bundle under `bundles/*.json`
- Add at least one profile under `profiles/*.json`
- Make sure the profile references existing bundle names
- Re-run `agenthub doctor --fix-all` if the home is intended to be auto-repaired

## Verify
Run `agenthub doctor --category home` and then retry `agenthub start <profile>`.
