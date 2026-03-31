# Changelog

All notable changes to `opencode-agenthub` will be documented here.

## [0.1.5] — 2026-03-31

### Onboarding clarity and help

- clarify the primary `setup` / `start` / `status` / `doctor` onboarding flow across the README and CLI help surfaces
- add dedicated `docs/hr-office.md` and `docs/runtime-reference.md` guides so everyday usage stays concise while detailed HR/runtime behavior stays documented

### Built-in HR showcase demo

- ship a built-in `demo-coding-team` staged package so new HR Office users can immediately run `agenthub hr demo-coding-team`
- preserve a real seven-role team shape and public-repo provenance while vendoring a lightweight skill subset that stays runnable without heavyweight browser or Python helper dependencies
- support promoting the built-in demo into Personal Home with `agenthub promote demo-coding-team`, including showcase seeding/backfill and end-to-end CLI coverage

### Runtime safety and validation

- restore built-in guard fallbacks so default guards still compose correctly when settings omit explicit guard entries
- add regression coverage for showcase seeding, lightweight skill vendoring, demo promotion, and advisory-model metadata alignment

## [0.1.4] — 2026-03-31

### Runtime visibility

- add runtime status visibility with `agenthub status`, including normal, short, and JSON views for composed workspace runtimes
- surface runtime source, visible and hidden agents, effective plugins, and health hints after compose/start flows

### Plugin and OMO runtime boundaries

- expose plugin and OMO runtime boundaries in status and doctor output
- add local filesystem plugin bridge visibility and `settings.json -> localPlugins.bridge` control
- add global OMO baseline visibility and `settings.json -> omoBaseline` control

### doctor troubleshooting guidance

- make doctor category-aware across home, environment, workspace, and plugin scopes
- add structured check ids, remediation text, troubleshooting doc links, and category-specific troubleshooting guides
- complete doctor home checks through the shared registry execution path

## [0.1.3] — 2026-03-30

### HR defaults and staffing guidance

- add `K-Dense-AI/claude-scientific-skills` back to the default HR GitHub source set for fresh HR Office bootstraps
- restore HR guidance that teams larger than four agents should usually favor one to two primary agents with the rest deployed as subagents

### HR model confirmation and staging behavior

- stop asking operators about promote/default-profile choices during HR staffing flows while preserving compatibility for older staged handoffs
- make HR model confirmation follow the current opencode environment instead of the synced model inventory catalog
- if a user insists on a model that cannot be verified, leave staged `agent.model` blank so opencode falls back to its default model and direct the operator to edit the staged bundle or use `agenthub doctor` later

### Validation and docs

- add documentation-contract coverage for the restored default source list, large-team advisory, environment-based model confirmation, and blank-model fallback guidance

## [0.1.2] — 2026-03-30

### HR bootstrap and onboarding

- redesign first-run HR bootstrap flow so setup, intake, and staging guidance are simpler and more staged
- simplify HR intake and first-run messaging so model choices are deferred until later review instead of front-loading them

### Windows prompt resilience

- harden native Windows HR bootstrap prompts against degraded readline terminal behavior and escape-sequence noise
- sanitize degraded prompt fragments so interactive HR flows remain usable on Windows terminals

### HR staging and team structure

- tighten staged-team decisions and model guardrails during HR assembly
- require at least one primary-capable agent in staged teams instead of allowing all-subagent compositions
- auto-add hidden explore coverage when a `team-only` profile would otherwise hide all built-in exploration support

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
