# Changelog

All notable changes to `opencode-agenthub` will be documented here.

## [0.1.1] — 2026-03-29

### Bug fixes

- stop forcing `agenthub start` / `auto` bundles onto `github-copilot/claude-sonnet-4.5` when the user has no preset, and persist an empty model string instead
- harden native Windows `agenthub hr` bootstrap prompts against mouse-tracking escape-sequence input pollution

### Validation

- add regression coverage for blank auto-model defaults and noisy Windows HR bootstrap input

## [0.1.0] — 2026-03-29

### HR Office isolation

- add a fully isolated `hr` command that bootstraps and runs an HR Office rooted at `~/.config/opencode-agenthub-hr`
- keep Personal Home (`~/.config/opencode-agenthub`) as the stable everyday environment while routing new HR work into the separate HR Office
- update the built-in `hr` profile so it defaults to `hr` while also including `auto`, `plan`, and `build` through built-in fallback
- add explicit staged-team testing before promote via `agenthub hr <profile>` against HR-home and staged profiles
- add true `team-only` profile behavior that hides injected opencode built-ins by emitting same-name `disable: true` overrides
- allow promoted HR packages to optionally become the default bare `agenthub start` profile

### HR model validation and packaging

- split staged and composed agent model selections into canonical `model` + `variant` fields
- sync the authoritative model catalog from `https://models.dev/api.json` into HR inventory for exact `provider/model` validation
- harden HR prompts and helper flows so user-supplied model names are validated instead of invented
- track `instructions/hr-boundaries.md` as a managed HR built-in so upgrade paths keep the deny-list current

### Everyday command flow

- make bare `start` launch the personal `auto` profile by default
- add user-facing `backup`, `restore`, and `promote` commands for personal backup/restore and HR package promotion
- print explicit environment banners for My Team vs HR Office during runtime assembly

### Migration and docs

- add compatibility warnings when legacy HR assets are still present in the personal home
- document HR Office as the preferred path for new staffing work and `promote` as the preferred downstream path from staged HR packages

### UX and command surface

- promote `setup` / `start` as the primary CLI flow with compatibility alias for `run`
- add `list`, `new`, `plugin doctor`, and `upgrade` commands
- add built-in name protection with `--reserved-ok`

### Setup model and onboarding

- simplify setup to two paths: `setup minimal` and `setup auto`
- make `setup minimal` truly minimal by defaulting it to blank structure instead of importing native basics
- clarify that `opencode-agenthub hr` is an independent HR Office entrypoint that bootstraps itself on first use

### Authoring and discoverability

- add `new soul`, `new skill`, `new instruction`, `new bundle`, and `new profile`
- add profile seeding with `--from` and repeatable `--add`
- add capability shorthand expansion including `hr-suite`
- improve bundle/profile authoring prompts and installed asset discovery

### Runtime and packaging

- replace Bun-first distribution with a Node-compatible `dist/` build
- publish compiled Node entrypoints for the CLI and plugins
- add package-manager-aware dependency installation for imported MCP servers
- require Node >= 18.0.0 for runtime

### Drift control and home management

- track built-in managed asset versions in `settings.json -> meta.builtinVersion`
- warn on stale built-in assets during compose/start paths
- add dry-run-first `upgrade` sync with `--force` overwrite support
- add hub export/import improvements and home round-trip smoke coverage

### Validation

- expand smoke coverage for setup/start flows, package-manager detection, plugin doctor, profile seeding, reserved names, and upgrade behavior
- add smoke and unit coverage for staged HR profile resolution, model-variant parsing, true `team-only` built-in hiding, and HR model catalog sync
- keep `bun run test:smoke` green across the Wave 0–4 implementation set

### Initial public baseline

- initial Agent Hub Home model with souls, bundles, profiles, skills, workflow, MCP, and runtime plugin support
- built-in `auto` and `hr` profile families
- `setup`, `compose`, `run`, `hub-export`, `hub-import`, and `hub-doctor` commands
