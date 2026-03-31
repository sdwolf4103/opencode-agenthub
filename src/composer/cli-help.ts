import { displayHomeConfigPath } from "./platform.js";

const cliCommand = "agenthub";
const compatibilityCliCommand = "opencode-agenthub";

const fullHelpText = () => {
	const agentHubHomePath = displayHomeConfigPath("opencode-agenthub");
	const hrHomePath = displayHomeConfigPath("opencode-agenthub-hr");
	const hrSettingsPath = displayHomeConfigPath("opencode-agenthub-hr", ["settings.json"]);
	const hrStagingPath = displayHomeConfigPath("opencode-agenthub-hr", ["staging"]);
	return `${cliCommand} — Agent Hub for opencode (requires Node ≥ 18.0.0)

USAGE
  ${cliCommand} <command> [options]

ALIAS
  ${compatibilityCliCommand} <command> [options]

COMMANDS (everyday)
  start          Start My Team (default profile > last profile > auto)
  hr [profile]   Enter HR Office or test an HR profile in this workspace
  status         Show the current workspace runtime, source, agents, plugins, and health hints
  promote        Promote an approved staged HR package into My Team

COMMANDS (maintenance)
  backup         Back up My Team (personal home only)
  restore        Restore My Team from a backup bundle
  upgrade        Preview or sync built-in managed assets for Personal Home or HR Office

COMMANDS (advanced)
  setup          Initialize the Agent Hub home directory
  list           List installed assets (souls, bundles, profiles, skills, more)
  new            Create new souls, skills, bundles, profiles, and advanced assets
  plugin         Inspect plugin-only runtime health
  doctor         Inspect and fix Agent Hub home assets
  compose        Create a new profile or bundle scaffold (alias for new profile/bundle)

COMMANDS (compatibility aliases)
  run            Alias for 'start'
  hub-doctor     Alias for 'doctor'
  hub-export     Advanced: export a chosen Agent Hub home to a portable directory
  hub-import     Advanced: import a previously-exported Agent Hub home

BUILT-IN PROFILES (for use with 'start' / 'run')
  auto           Default coding agent (Auto + Plan + Build)
  hr             HR console with staffing subagents

EXAMPLES
  ${cliCommand} start
  ${cliCommand} start last
  ${cliCommand} start set reviewer-team
  ${cliCommand} hr
  ${cliCommand} hr last
  ${cliCommand} hr recruiter-team
  ${cliCommand} status
  ${cliCommand} status --short
  ${cliCommand} promote
  ${cliCommand} backup --output ./my-team-backup
  ${cliCommand} restore --source ./my-team-backup
  ${cliCommand} start auto --workspace /path/to/project
  ${cliCommand} list
  ${cliCommand} list bundles
  ${cliCommand} new soul reviewer
  ${cliCommand} new profile my-team --from auto --add hr-suite
  ${cliCommand} upgrade
  ${cliCommand} upgrade --force
  ${cliCommand} plugin doctor
  ${cliCommand} doctor --fix-all
  ${cliCommand} hub-export --output ./agenthub-backup
  ${cliCommand} hub-import --source ./agenthub-backup

FLAGS (global)
  --help, -h     Show this help message
  --version, -v  Print version

FLAGS (setup)
  setup [auto|minimal]           Setup mode (default: auto)
  --target-root <path>           Override Agent Hub home location
  --import-souls <path>          Import existing soul/agent prompt folder
  --import-instructions <path>   Import existing instructions folder
  --import-skills <path>         Import existing skills folder
  --import-mcp-servers <path>    Import existing MCP server folder

FLAGS (start / run)
  --workspace <path>   Target workspace (default: cwd)
  --config-root <path> Override .opencode config directory
  --assemble-only      Write config files but do not launch opencode
  --mode <tools-only|customized-agent>
                        Advanced: launch with a built-in bundle mode instead of a profile
  start last           Reuse the last profile used in this workspace (fallback: auto)
  start set <profile>  Save the default personal profile for future bare 'start'
  -- <args>            Pass remaining args to opencode

FLAGS (hr)
  hr                   Enter the isolated HR Office (bootstraps it on first use)
  hr <profile>         Test an HR-home profile in the current workspace
  hr last              Reuse the last HR profile tested in this workspace
  hr set <profile>     Unsupported (use explicit '${cliCommand} hr <profile>' each time)
  first bootstrap      HR first asks about your situation, inspects resources,
                       reports a recommendation, then lets you accept or override it

FLAGS (status)
  --workspace <path>   Inspect the runtime for a specific workspace (default: cwd)
  --config-root <path> Inspect a specific runtime config root
  --short              Print a compact one-block summary
  --json               Print machine-readable runtime status

FLAGS (new / compose profile)
  --from <profile>      Seed bundles/plugins from an existing profile
  --add <bundle|cap>    Add bundle(s) or capability shorthand (repeatable)
  --reserved-ok         Allow names that collide with built-in asset names

FLAGS (upgrade)
  --target-root <path>  Agent Hub home to inspect/sync; HR Office targets auto-sync HR built-ins and helper scripts
  --dry-run             Preview managed file changes (default)
  --force               Overwrite built-in managed files

FLAGS (plugin doctor)
  --config-root <path>  Inspect a specific opencode config root

FLAGS (doctor / hub-doctor)
  --target-root <path>   Agent Hub home to inspect (default: ${agentHubHomePath})
  --fix-all              Apply all safe automatic fixes
  --dry-run              Preview fixes without writing
  --json                 Print machine-readable diagnostic report
  --quiet                Print only the final doctor verdict
  --strict               Treat warnings as non-zero exit status
  --category <name>      Reserved for phased doctor filtering (environment|home|workspace|plugin)
  --agent <name>         Target a specific agent
  --model <model>        Override the agent's model
  --clear-model          Remove the agent's model override
  --prompt-file <path>   Set the agent's soul/prompt from a file
  --clear-prompt         Remove the agent's soul/prompt override

FLAGS (hub-export)
  --output <path>        Destination directory (required)
  --source-root <path>   Agent Hub home to export (default: ${agentHubHomePath})

FLAGS (hub-import)
  --source <path>        Exported Agent Hub directory to import (required)
  --target-root <path>   Destination Agent Hub home (default: ${agentHubHomePath})
  --overwrite            Overwrite matching entries
  --settings <preserve|replace>  How to handle settings (default: preserve)

FLAGS (backup)
  --output <path>        Destination directory (required; personal home only)

FLAGS (restore)
  --source <path>        Backup directory to restore from (required; personal home only)
  --overwrite            Overwrite matching entries
  --settings <preserve|replace>  How to handle settings (default: preserve)

FLAGS (promote)
  [package-id]           Staged package id under ${hrStagingPath}

PLUGIN-ONLY MODE
  Agent Hub ships as both a CLI and an opencode plugin. When loaded as
  a plugin without a configured hub runtime, it runs in degraded mode:
    - Tool blocking (blockedTools) is disabled
    - The call_omo_agent tool is blocked as a safety fallback
  Run '${cliCommand} setup' once to initialize the hub runtime and exit
  degraded mode. Features that require the hub runtime: profile composition,
  agent souls, skill injection, and plan detection.

HR HOME
  HR live state is stored separately at ${hrHomePath}
  Override with OPENCODE_AGENTHUB_HR_HOME environment variable.
  Use '${cliCommand} hr' to enter the HR Office. If HR is not installed yet, Agent Hub bootstraps it automatically.
  Use '${cliCommand} hr <profile>' to test an HR-home profile or a staged profile in a workspace before promote.
  Use '${cliCommand} upgrade --target-root ${hrHomePath}' to refresh HR Office built-ins and helper scripts. This never changes staged packages under ${hrStagingPath}.
  HR model overrides live in ${hrSettingsPath}.

NOTE
  This package requires Node on PATH.
  Windows users should use WSL 2 for the best experience; native Windows remains best-effort in alpha.

PLUGINS
  Config-declared plugins already inherit automatically.
  Local filesystem plugins from ~/.config/opencode/plugins/ are copied into the runtime by default.
  Disable with settings.json -> localPlugins.bridge = false

OMO COEXISTENCE
  Agent Hub can merge ~/.config/opencode/oh-my-opencode.json into runtime by default.
  Disable with settings.json -> omoBaseline = "ignore"
`;
};

const compactHelpText = `${cliCommand} — put a clear AI coding team into each repo

USAGE
  ${cliCommand} <command> [options]

ALIAS
  ${compatibilityCliCommand} <command> [options]

START HERE
  ${cliCommand} setup auto   Create your personal Agent Hub home
  ${cliCommand} start        Launch your default coding team in this repo
  ${cliCommand} status       Inspect the active workspace runtime
  ${cliCommand} doctor       Diagnose or fix setup/runtime problems

CORE COMMANDS
  start          Start My Team (default profile > last profile > auto)
  hr [profile]   Open HR Office or test an HR profile in this workspace
  status         Show the current runtime, source, agents, and health hints
  doctor         Diagnose home, environment, workspace, or plugin issues
  promote        Import an approved staged HR package into My Team
  upgrade        Refresh built-in managed assets for Personal Home or HR Office
  list           List installed assets
  new            Create souls, skills, bundles, and profiles

HR OFFICE
  ${cliCommand} hr is the next step when you want to source stronger custom teams
  from public repos, test them safely, and promote only what you trust.

EXAMPLES
  ${cliCommand} start
  ${cliCommand} start last
  ${cliCommand} hr
  ${cliCommand} hr <profile>
  ${cliCommand} status
  ${cliCommand} doctor --fix-all

MORE HELP
  Run '${cliCommand} help <command>' for flags and examples.
  Run '${cliCommand} help --all' for the full reference.
`;

const commandHelpText = (command: string) => {
	const agentHubHomePath = displayHomeConfigPath("opencode-agenthub");
	const hrHomePath = displayHomeConfigPath("opencode-agenthub-hr");
	const helpByCommand: Record<string, string> = {
		start: `${cliCommand} start — launch your active team in this repo

USAGE
  ${cliCommand} start
  ${cliCommand} start last
  ${cliCommand} start <profile>
  ${cliCommand} start set <profile>

FLAGS (start / run)
  --workspace <path>   Target workspace (default: cwd)
  --config-root <path> Override .opencode config directory
  --assemble-only      Write config files but do not launch opencode
  --mode <tools-only|customized-agent>
                        Advanced: launch with a built-in bundle mode instead of a profile
  -- <args>            Pass remaining args to opencode

EXAMPLES
  ${cliCommand} start
  ${cliCommand} start last
  ${cliCommand} start reviewer-team
  ${cliCommand} start set reviewer-team
`,
		run: `${compatibilityCliCommand} run is a compatibility alias for '${cliCommand} start'.

Use '${cliCommand} help start' for the full command reference.
`,
		hr: `${cliCommand} hr — enter HR Office or test an HR profile

USAGE
  ${cliCommand} hr
  ${cliCommand} hr last
  ${cliCommand} hr <profile>

DETAILS
  HR Office lives separately at ${hrHomePath}
  and stages candidate teams before you promote them into your normal setup.

EXAMPLES
  ${cliCommand} hr
  ${cliCommand} hr coding-team
  ${cliCommand} hr last
  ${cliCommand} promote <package-id>
`,
		status: `${cliCommand} status — inspect the active runtime

USAGE
  ${cliCommand} status
  ${cliCommand} status --short
  ${cliCommand} status --json

FLAGS (status)
  --workspace <path>   Inspect the runtime for a specific workspace (default: cwd)
  --config-root <path> Inspect a specific runtime config root
  --short              Print a compact one-block summary
  --json               Print machine-readable runtime status
`,
		doctor: `${cliCommand} doctor — diagnose and repair Agent Hub issues

USAGE
  ${cliCommand} doctor
  ${cliCommand} doctor --fix-all
  ${cliCommand} doctor --category workspace

FLAGS (doctor / hub-doctor)
  --target-root <path>   Agent Hub home to inspect (default: ${agentHubHomePath})
  --fix-all              Apply all safe automatic fixes
  --dry-run              Preview fixes without writing
  --json                 Print machine-readable diagnostic report
  --quiet                Print only the final doctor verdict
  --strict               Treat warnings as non-zero exit status
  --category <name>      environment|home|workspace|plugin
  --agent <name>         Target a specific agent
  --model <model>        Override the agent's model
  --clear-model          Remove the agent's model override
  --prompt-file <path>   Set the agent's soul/prompt from a file
  --clear-prompt         Remove the agent's soul/prompt override
`,
		setup: `${cliCommand} setup — initialize your Agent Hub home

USAGE
  ${cliCommand} setup auto
  ${cliCommand} setup minimal

FLAGS (setup)
  --target-root <path>           Override Agent Hub home location
  --import-souls <path>          Import existing soul/agent prompt folder
  --import-instructions <path>   Import existing instructions folder
  --import-skills <path>         Import existing skills folder
  --import-mcp-servers <path>    Import existing MCP server folder
`,
		promote: `${cliCommand} promote — import a staged HR package into My Team

USAGE
  ${cliCommand} promote <package-id>

DETAILS
  Promote copies a staged HR package into your Personal Home and can optionally
  update the default start profile when the handoff requests it.
`,
		upgrade: `${cliCommand} upgrade — preview or sync built-in managed assets

USAGE
  ${cliCommand} upgrade
  ${cliCommand} upgrade --force
  ${cliCommand} upgrade --target-root ${hrHomePath}

FLAGS (upgrade)
  --target-root <path>  Agent Hub home to inspect/sync
  --dry-run             Preview managed file changes (default)
  --force               Overwrite built-in managed files
`,
		list: `${cliCommand} list — show installed assets

USAGE
  ${cliCommand} list
  ${cliCommand} list bundles
  ${cliCommand} list profiles
`,
		new: `${cliCommand} new — create Agent Hub assets

USAGE
  ${cliCommand} new soul <name>
  ${cliCommand} new skill <name>
  ${cliCommand} new bundle <name>
  ${cliCommand} new profile <name>

FLAGS (new / compose profile)
  --from <profile>      Seed bundles/plugins from an existing profile
  --add <bundle|cap>    Add bundle(s) or capability shorthand (repeatable)
  --reserved-ok         Allow names that collide with built-in asset names
`,
		compose: `${cliCommand} compose is a compatibility path for profile/bundle creation.

Use:
  ${cliCommand} compose profile <name>
  ${cliCommand} compose bundle <name>

Or prefer:
  ${cliCommand} new profile <name>
  ${cliCommand} new bundle <name>
`,
		backup: `${cliCommand} backup — export your Personal Home to a portable directory

USAGE
  ${cliCommand} backup --output ./my-team-backup
`,
		restore: `${cliCommand} restore — restore your Personal Home from a backup

USAGE
  ${cliCommand} restore --source ./my-team-backup
  ${cliCommand} restore --source ./my-team-backup --overwrite
`,
		plugin: `${cliCommand} plugin — plugin-only runtime health helpers

USAGE
  ${cliCommand} plugin doctor

DETAILS
  '${cliCommand} plugin doctor' is deprecated in favor of '${cliCommand} doctor --category=plugin'.
`,
		"hub-export": `${cliCommand} hub-export — export an Agent Hub home

USAGE
  ${cliCommand} hub-export --output ./agenthub-backup
`,
		"hub-import": `${cliCommand} hub-import — import a previously exported Agent Hub home

USAGE
  ${cliCommand} hub-import --source ./agenthub-backup
  ${cliCommand} hub-import --source ./agenthub-backup --overwrite
`,
	};
	return helpByCommand[command];
};

export const printHelp = () => {
	process.stdout.write(compactHelpText);
};

export const printFullHelp = () => {
	process.stdout.write(fullHelpText());
};

export const printCommandHelp = (command: string) => {
	const normalized = command === compatibilityCliCommand ? cliCommand : command;
	const helpText =
		normalized === "--all"
			? fullHelpText()
			: commandHelpText(normalized) ||
				`Unknown help topic '${command}'.\n\nRun '${cliCommand} --help' for the compact overview or '${cliCommand} help --all' for the full reference.\n`;
	process.stdout.write(helpText);
};

export const handleExplicitHelpCommand = (argv: string[]): boolean => {
	if (argv[0] !== "help") return false;
	const topic = argv[1];
	if (!topic || topic === "--all") {
		printFullHelp();
		return true;
	}
	printCommandHelp(topic);
	return true;
};
