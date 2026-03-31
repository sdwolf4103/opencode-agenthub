# Guard and skill conflicts

## Symptoms
- doctor reports missing guards
- mixed OMO/native profiles trigger warnings
- global OMO baseline is affecting Agent Hub unexpectedly
- souls or skills are present but not wired into bundles

## Cause
Agent Hub relies on guard definitions and bundle wiring to keep native and OMO behavior predictable. Conflicts usually come from partial profile edits or inherited global OMO settings.

## Fix
- Restore required guards: `read_only`, `no_task`, `no_omo`
- In mixed profiles, add `no_omo` to native bundles that should not call OMO
- If you want full isolation from global OMO config, set `omoBaseline` to `"ignore"` in `settings.json`
- Remove unused souls/skills or attach them to bundles deliberately

## Verify
Run `agenthub doctor --category home` and confirm the related warnings are gone.
