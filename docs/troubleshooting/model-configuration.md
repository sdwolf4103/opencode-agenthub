# Model configuration

## Symptoms
- doctor reports invalid model syntax for an agent override

## Cause
Agent model overrides must use `provider/model` format.

## Fix
- Update invalid overrides in `settings.json`
- Example: `openai/gpt-5.4-mini`
- Remove empty or partial override values

## Verify
Run `agenthub doctor --category home` and confirm the model warning is gone.
