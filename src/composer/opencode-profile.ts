#!/usr/bin/env node

import { spawn } from "node:child_process";
import { chmod, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { BootstrapOptions } from "./bootstrap.js";
import {
	agentHubHomeInitialized,
	defaultAgentHubHome,
	defaultHrHome,
	hrHomeInitialized,
	installAgentHubHome,
	promptHubInitAnswers,
	syncBuiltInAgentHubAssets,
} from "./bootstrap.js";
import {
	getBuiltInManifestKeysForMode,
} from "./builtin-assets.js";
import {
	composeCustomizedAgent,
	composeToolInjection,
	composeWorkspace,
	getDefaultConfigRoot,
	getWorkspaceRuntimeRoot,
} from "./compose.js";
import {
	maybeConfigureEnvrc,
	noteProfileResolution,
	readJsonIfExists,
	resolveHrLastProfilePreference,
	resolveStartLastProfilePreference,
	resolveStartProfilePreference,
	setStartDefaultProfile,
	updateWorkspacePreferences,
	warnIfWorkspaceRuntimeWillBeReplaced,
	type WorkspacePreferences,
} from "./cli-home.js";
import {
	createPromptInterface,
	promptRequired,
} from "./cli-prompts.js";
import { ensureHrOfficeReadyOrBootstrap, repairHrModelConfigurationIfNeeded } from "./cli-hr-bootstrap.js";
import {
	createBundleDefinition,
	createInstructionDefinition,
	createProfileDefinition,
	createSkillDefinition,
	createSoulDefinition,
} from "./cli-scaffold.js";
import {
	exportAgentHubHome,
	importAgentHubHome,
	type SettingsImportMode,
} from "./home-transfer.js";
import {
	renderComposeSummary,
	renderRuntimeStatus,
	renderRuntimeStatusShort,
	resolveRuntimeStatus,
} from "./runtime-status.js";
import { readPackageVersion } from "./package-version.js";
import {
	readAgentHubSettings,
} from "./settings.js";
import {
	displayHomeConfigPath,
	shouldChmod,
	spawnOptions,
	windowsStartupNotice,
} from "./platform.js";

type Command =
	| "setup"
	| "hr"
	| "backup"
	| "restore"
	| "promote"
	| "new"
	| "plugin"
	| "compose"
	| "run"
	| "start"
	| "status"
	| "list"
	| "upgrade"
	| "hub-export"
	| "hub-import"
	| "doctor"
	| "hub-doctor";
type RuntimeSelection =
	| { kind: "profile"; profile: string }
	| { kind: "tools-only" }
	| { kind: "customized-agent" };

type ComposeSelection =
	| { kind: "profile"; name: string }
	| { kind: "bundle"; name: string }
	| { kind: "soul"; name: string }
	| { kind: "skill"; name: string }
	| { kind: "instruction"; name: string };

type StartIntent =
	| { kind: "compose"; profile?: string; source?: "explicit" | "default" | "last" | "fallback" }
	| { kind: "set-default"; profile: string };

type HrIntent =
	| { kind: "office" }
	| { kind: "compose"; profile?: string; source?: "explicit" | "last" };

type BundleName = "tools-only" | "customized-agent";

type ParsedArgs = {
	command: Command;
	runtimeSelection?: RuntimeSelection;
	composeSelection?: ComposeSelection;
	listTarget?: string;
	pluginSubcommand?: "doctor";
	workspace: string;
	configRoot?: string;
	assembleOnly: boolean;
	statusOptions: {
		short: boolean;
		json: boolean;
	};
	opencodeArgs: string[];
	bootstrapOptions: BootstrapOptions;
	profileCreateOptions: {
		fromProfile?: string;
		addBundles: string[];
		reservedOk: boolean;
	};
	upgradeOptions: {
		force: boolean;
		dryRun: boolean;
	};
	transferOptions: {
		sourceRoot?: string;
		outputRoot?: string;
		targetRoot?: string;
		overwrite: boolean;
		settingsMode: SettingsImportMode;
	};
	doctorOptions: {
		fixAll: boolean;
		dryRun: boolean;
		json?: boolean;
		quiet?: boolean;
		strict?: boolean;
		category?: "environment" | "home" | "workspace" | "plugin";
		agent?: string;
		model?: string;
		clearModel: boolean;
		promptFile?: string;
		clearPrompt: boolean;
	};
	promotePackageId?: string;
	startIntent?: StartIntent;
	hrIntent?: HrIntent;
};

const cliCommand = "agenthub";
const compatibilityCliCommand = "opencode-agenthub";

const printHelp = () => {
	const agentHubHomePath = displayHomeConfigPath("opencode-agenthub");
	const hrHomePath = displayHomeConfigPath("opencode-agenthub-hr");
	const hrSettingsPath = displayHomeConfigPath("opencode-agenthub-hr", ["settings.json"]);
	const hrStagingPath = displayHomeConfigPath("opencode-agenthub-hr", ["staging"]);
	process.stdout.write(`${cliCommand} — Agent Hub for opencode (requires Node ≥ 18.0.0)

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
`);
};

const fail = (message: string): never => {
	process.stderr.write(`${message}\n`);
	process.exit(1);
};

const formatWorkspaceAccessError = (workspace: string): string => {
	const quotedWorkspace = `'${workspace}'`;
	const macHint =
		process.platform === "darwin"
			? "\n\nOn macOS this usually means Terminal/Bun/opencode does not currently have permission to read that folder. Check Privacy & Security access for Documents/Desktop/iCloud-backed folders, then retry."
			: "";
	return [
		`Workspace ${quotedWorkspace} is not readable.`,
		"Agent Hub can assemble the runtime, but opencode will fail to launch if it cannot scan the workspace.",
		`Try: ls ${quotedWorkspace}`,
	].join("\n") + macHint;
};

const ensureWorkspaceReadable = async (workspace: string) => {
	try {
		await readdir(workspace);
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			(error.code === "EACCES" || error.code === "EPERM")
		) {
			fail(formatWorkspaceAccessError(workspace));
		}
		throw error;
	}
};

const parseSetupMode = (value?: string): BootstrapOptions["mode"] => {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "minimal" || normalized === "auto") {
		return normalized as BootstrapOptions["mode"];
	}
	return fail(`Invalid setup mode '${value}'. Use 'auto' or 'minimal'.`);
};

const normalizeRuntimeProfileName = (value: string): string => {
	return value;
};

const parseBundleName = (value: string): BundleName => {
	const normalized = value.trim().toLowerCase();
	if (normalized === "tools-only" || normalized === "customized-agent") {
		return normalized;
	}
	return fail(
		`Invalid bundle '${value}'. Use 'tools-only' or 'customized-agent'.`,
	);
};

const parseSettingsMode = (value?: string): SettingsImportMode => {
	if (!value || value === "preserve" || value === "replace")
		return value || "preserve";
	return fail(`Invalid settings mode '${value}'. Use 'preserve' or 'replace'.`);
};

const parseArgs = (argv: string[]): ParsedArgs => {
	let command: Command = "run";
	let runtimeSelection: RuntimeSelection | undefined;
	let composeSelection: ComposeSelection | undefined;
	let listTarget: string | undefined;
	let pluginSubcommand: ParsedArgs["pluginSubcommand"];
	let workspace = process.cwd();
	let configRoot: string | undefined;
	let assembleOnly = false;
	const statusOptions: ParsedArgs["statusOptions"] = {
		short: false,
		json: false,
	};
	const opencodeArgs: string[] = [];
	const bootstrapOptions: BootstrapOptions = {};
	const profileCreateOptions: ParsedArgs["profileCreateOptions"] = {
		addBundles: [],
		reservedOk: false,
	};
	const upgradeOptions: ParsedArgs["upgradeOptions"] = {
		force: false,
		dryRun: true,
	};
	const transferOptions: ParsedArgs["transferOptions"] = {
		overwrite: false,
		settingsMode: "preserve",
	};
	const doctorOptions: ParsedArgs["doctorOptions"] = {
		fixAll: false,
		dryRun: false,
		json: false,
		quiet: false,
		strict: false,
		clearModel: false,
		clearPrompt: false,
	};
	let promotePackageId: string | undefined;
	let startIntent: StartIntent | undefined;
	let hrIntent: HrIntent | undefined;

	let index = 0;
	const maybeCommand = argv[0];
	if (
		maybeCommand === "setup" ||
		maybeCommand === "hr" ||
		maybeCommand === "backup" ||
		maybeCommand === "restore" ||
		maybeCommand === "promote" ||
		maybeCommand === "new" ||
		maybeCommand === "upgrade" ||
		maybeCommand === "plugin" ||
		maybeCommand === "hub-export" ||
		maybeCommand === "hub-import" ||
		maybeCommand === "compose" ||
		maybeCommand === "run" ||
		maybeCommand === "start" ||
		maybeCommand === "status" ||
		maybeCommand === "list" ||
		maybeCommand === "doctor" ||
		maybeCommand === "hub-doctor"
	) {
		command = maybeCommand;
		index = 1;
		const targetType = argv[index];
		const targetName = argv[index + 1];
		if (command === "hr") {
			if (targetType === "set") {
				fail(`'hr set <profile>' is not supported. Use '${cliCommand} hr <profile>' to test a temporary HR profile in this workspace.`);
			}
			if (targetType === "last") {
				hrIntent = { kind: "compose", source: "last" };
				index = 2;
			} else {
				const hrProfileArg = targetType && !targetType.startsWith("-") ? targetType : undefined;
				if (hrProfileArg) {
					hrIntent = {
						kind: "compose",
						profile: normalizeRuntimeProfileName(hrProfileArg),
						source: "explicit",
					};
					runtimeSelection = {
						kind: "profile",
						profile: normalizeRuntimeProfileName(hrProfileArg),
					};
					index = 2;
				} else {
					hrIntent = { kind: "office" };
					runtimeSelection = {
						kind: "profile",
						profile: "hr",
					};
				}
			}
		} else if (command === "promote" && targetType && !targetType.startsWith("-")) {
			promotePackageId = targetType;
			index = 2;
		}
		if ((command === "compose" || command === "new") && targetType === "profile") {
			const name = targetName?.trim();
			if (!name) {
				fail(`'${command} profile' requires a profile name.`);
			}
			composeSelection = { kind: "profile", name };
			index = 3;
		} else if ((command === "compose" || command === "new") && targetType === "bundle") {
			const name = targetName?.trim();
			if (!name) {
				fail(`'${command} bundle' requires a bundle name.`);
			}
			composeSelection = { kind: "bundle", name };
			index = 3;
		} else if (command === "new" && targetType === "soul") {
			const name = targetName?.trim();
			if (!name) fail("'new soul' requires a name.");
			composeSelection = { kind: "soul", name };
			index = 3;
		} else if (command === "new" && targetType === "skill") {
			const name = targetName?.trim();
			if (!name) fail("'new skill' requires a name.");
			composeSelection = { kind: "skill", name };
			index = 3;
		} else if (command === "new" && targetType === "instruction") {
			const name = targetName?.trim();
			if (!name) fail("'new instruction' requires a name.");
			composeSelection = { kind: "instruction", name };
			index = 3;
		} else if (command === "plugin" && targetType === "doctor") {
			pluginSubcommand = "doctor";
			index = 2;
		} else if (
			command === "setup" &&
			targetType &&
			!targetType.startsWith("-")
		) {
			bootstrapOptions.mode = parseSetupMode(targetType);
			index = 2;
		} else if (command === "run" && targetType === "profile") {
			startIntent = {
				kind: "compose",
				profile: normalizeRuntimeProfileName(targetName || "auto"),
				source: "explicit",
			};
			runtimeSelection = {
				kind: "profile",
				profile: normalizeRuntimeProfileName(targetName || "auto"),
			};
			index = 3;
		} else if (command === "run" && targetType === "bundle") {
			runtimeSelection = { kind: parseBundleName(targetName || "") };
			index = 3;
		} else if (command === "run" && targetType === "last") {
			startIntent = { kind: "compose", source: "last" };
			index = 2;
		} else if (command === "run" && targetType === "set") {
			const profile = normalizeRuntimeProfileName(targetName || "");
			if (!profile) {
				fail("'run set <profile>' requires a profile name.");
			}
			startIntent = { kind: "set-default", profile };
			index = 3;
		} else if (command === "run" && targetType && !targetType.startsWith("-")) {
			startIntent = {
				kind: "compose",
				profile: normalizeRuntimeProfileName(targetType),
				source: "explicit",
			};
			runtimeSelection = {
				kind: "profile",
				profile: normalizeRuntimeProfileName(targetType),
			};
			index = 2;
		} else if (command === "start" && targetType === "profile") {
			startIntent = {
				kind: "compose",
				profile: normalizeRuntimeProfileName(targetName || "auto"),
				source: "explicit",
			};
			runtimeSelection = {
				kind: "profile",
				profile: normalizeRuntimeProfileName(targetName || "auto"),
			};
			index = 3;
		} else if (command === "start" && targetType === "bundle") {
			runtimeSelection = { kind: parseBundleName(targetName || "") };
			index = 3;
		} else if (command === "start" && targetType === "last") {
			startIntent = { kind: "compose", source: "last" };
			index = 2;
		} else if (command === "start" && targetType === "set") {
			const profile = normalizeRuntimeProfileName(targetName || "");
			if (!profile) {
				fail("'start set <profile>' requires a profile name.");
			}
			startIntent = { kind: "set-default", profile };
			index = 3;
		} else if (command === "start" && targetType && !targetType.startsWith("-")) {
			startIntent = {
				kind: "compose",
				profile: normalizeRuntimeProfileName(targetType),
				source: "explicit",
			};
			runtimeSelection = {
				kind: "profile",
				profile: normalizeRuntimeProfileName(targetType),
			};
			index = 2;
		} else if (command === "list" && targetType && !targetType.startsWith("-")) {
			// list sub-command: profiles, bundles, souls, skills, instructions
			listTarget = targetType;
			index = 2;
		}
	}

	// Guard: if the first argument looks like a command (no leading '-') but
	// wasn't recognized, reject it immediately instead of silently falling
	// through to 'run'.
	if (
		maybeCommand &&
		!maybeCommand.startsWith("-") &&
		command === "run" &&
		maybeCommand !== "run" &&
		index === 0
	) {
		process.stderr.write(
			`Unknown command: '${maybeCommand}'\n\nRun '${cliCommand} --help' to see available commands.\n`,
		);
		process.exit(1);
	}

	for (; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") {
			printHelp();
			process.exit(0);
		}
		if (arg === "--version" || arg === "-v") {
			process.stdout.write(`${readPackageVersion()}\n`);
			process.exit(0);
		}
		if (arg === "--profile") {
			runtimeSelection = {
				kind: "profile",
				profile: normalizeRuntimeProfileName(argv[index + 1] || "auto"),
			};
			index += 1;
			continue;
		}
		if (arg === "--mode") {
			runtimeSelection = { kind: parseBundleName(argv[index + 1] || "") };
			index += 1;
			continue;
		}
		if (arg === "--from") {
			profileCreateOptions.fromProfile = argv[index + 1];
			index += 1;
			continue;
		}
		if (arg === "--add") {
			profileCreateOptions.addBundles.push(argv[index + 1] || "");
			index += 1;
			continue;
		}
		if (arg === "--reserved-ok") {
			profileCreateOptions.reservedOk = true;
			continue;
		}
		if (arg === "--workspace") {
			workspace = path.resolve(argv[index + 1] || workspace);
			index += 1;
			continue;
		}
		if (arg === "--config-root") {
			configRoot = path.resolve(argv[index + 1] || workspace);
			index += 1;
			continue;
		}
		if (arg === "--assemble-only") {
			assembleOnly = true;
			continue;
		}
		if (arg === "--short") {
			statusOptions.short = true;
			continue;
		}
		if (arg === "--json") {
			statusOptions.json = true;
			doctorOptions.json = true;
			continue;
		}
		if (arg === "--quiet") {
			doctorOptions.quiet = true;
			continue;
		}
		if (arg === "--strict") {
			doctorOptions.strict = true;
			continue;
		}
		if (arg === "--category") {
			const value = argv[index + 1];
			if (value === "environment" || value === "home" || value === "workspace" || value === "plugin") {
				doctorOptions.category = value;
				index += 1;
				continue;
			}
			fail("'--category' requires one of: environment, home, workspace, plugin");
		}
		if (arg === "--target-root") {
			const resolved = path.resolve(argv[index + 1] || defaultAgentHubHome());
			bootstrapOptions.targetRoot = resolved;
			transferOptions.targetRoot = resolved;
			index += 1;
			continue;
		}
		if (arg === "--source-root" || arg === "--source") {
			transferOptions.sourceRoot = path.resolve(argv[index + 1] || workspace);
			index += 1;
			continue;
		}
		if (arg === "--output") {
			transferOptions.outputRoot = path.resolve(argv[index + 1] || workspace);
			index += 1;
			continue;
		}
		if (arg === "--overwrite") {
			transferOptions.overwrite = true;
			continue;
		}
		if (arg === "--force") {
			upgradeOptions.force = true;
			continue;
		}
		if (arg === "--settings") {
			transferOptions.settingsMode = parseSettingsMode(argv[index + 1]);
			index += 1;
			continue;
		}
		if (arg === "--fix-all") {
			doctorOptions.fixAll = true;
			continue;
		}
		if (arg === "--dry-run") {
			doctorOptions.dryRun = true;
			upgradeOptions.dryRun = true;
			continue;
		}
		if (arg === "--agent") {
			doctorOptions.agent = argv[index + 1];
			index += 1;
			continue;
		}
		if (arg === "--model") {
			doctorOptions.model = argv[index + 1];
			index += 1;
			continue;
		}
		if (arg === "--clear-model") {
			doctorOptions.clearModel = true;
			continue;
		}
		if (arg === "--prompt-file") {
			doctorOptions.promptFile = path.resolve(argv[index + 1] || workspace);
			index += 1;
			continue;
		}
		if (arg === "--clear-prompt") {
			doctorOptions.clearPrompt = true;
			continue;
		}
		if (arg === "--import-souls") {
			bootstrapOptions.importSoulsPath = path.resolve(
				argv[index + 1] || workspace,
			);
			index += 1;
			continue;
		}
		if (arg === "--import-instructions") {
			bootstrapOptions.importInstructionsPath = path.resolve(
				argv[index + 1] || workspace,
			);
			index += 1;
			continue;
		}
		if (arg === "--import-skills") {
			bootstrapOptions.importSkillsPath = path.resolve(
				argv[index + 1] || workspace,
			);
			index += 1;
			continue;
		}
		if (arg === "--import-mcp-servers") {
			bootstrapOptions.importMcpServersPath = path.resolve(
				argv[index + 1] || workspace,
			);
			index += 1;
			continue;
		}
		if (arg === "--") {
			opencodeArgs.push(...argv.slice(index + 1));
			break;
		}
		if (command === "promote" && !arg.startsWith("-") && !promotePackageId) {
			promotePackageId = arg;
			continue;
		}
		opencodeArgs.push(arg);
	}

	if (command === "start" && !startIntent) {
		startIntent = { kind: "compose" };
	}

	if (command === "start" && startIntent?.kind === "compose" && !runtimeSelection) {
		runtimeSelection = { kind: "profile", profile: startIntent.profile || "auto" };
	}

	if (
		runtimeSelection &&
		runtimeSelection.kind !== "profile" &&
		command === "setup"
	) {
		fail(
			"'setup' does not accept '--mode'. Use 'setup minimal' for a minimal home.",
		);
	}

	if ((command === "compose" || command === "new") && !composeSelection) {
		if (command === "compose") {
			fail("Use 'compose profile <name>' or 'compose bundle <name>'.");
		}
		fail(
			"Use 'new soul <name>', 'new skill <name>', 'new instruction <name>', 'new bundle <name>', or 'new profile <name>'.",
		);
	}

	if (
		(profileCreateOptions.fromProfile || profileCreateOptions.addBundles.length > 0) &&
		composeSelection?.kind !== "profile"
	) {
		fail("'--from' and '--add' can only be used with 'compose profile' or 'new profile'.");
	}

	if (command === "doctor" || command === "hub-doctor") {
		const modelActionCount =
			Number(Boolean(doctorOptions.model)) + Number(doctorOptions.clearModel);
		const promptActionCount =
			Number(Boolean(doctorOptions.promptFile)) +
			Number(doctorOptions.clearPrompt);
		const totalActionCount = modelActionCount + promptActionCount;
		if (totalActionCount > 1) {
			fail(
				"Use exactly one of '--model <value>', '--clear-model', '--prompt-file <path>', or '--clear-prompt' with '--agent'.",
			);
		}
		if (totalActionCount > 0 && !doctorOptions.agent) {
			fail("'doctor' prompt/model override commands require '--agent <name>'.");
		}
		if (doctorOptions.agent && totalActionCount === 0) {
			fail(
				"'doctor --agent <name>' requires one of '--model <value>', '--clear-model', '--prompt-file <path>', or '--clear-prompt'.",
			);
		}
	}

	if (command === "hub-export" && !transferOptions.outputRoot) {
		fail("'hub-export' requires '--output <path>'.");
	}

	if (command === "hub-import" && !transferOptions.sourceRoot) {
		fail("'hub-import' requires '--source <path>'.");
	}

	if (command === "upgrade") {
		doctorOptions.dryRun = false;
		if (upgradeOptions.force) {
			upgradeOptions.dryRun = false;
		}
	}

	return {
		command,
		runtimeSelection,
		composeSelection,
		listTarget,
		pluginSubcommand,
		workspace,
		configRoot,
		assembleOnly,
		statusOptions,
		opencodeArgs,
		bootstrapOptions,
		profileCreateOptions,
		upgradeOptions,
		transferOptions,
		doctorOptions,
		promotePackageId,
		startIntent,
		hrIntent,
	};
};

const printTransferReport = (
	action: string,
	report: {
		sourceRoot: string;
		targetRoot: string;
		sourceKind?: string;
		copied: string[];
		skipped: string[];
		overwritten: string[];
		warnings: string[];
		settingsAction: string;
	},
) => {
	process.stdout.write(`${action} complete\n`);
	process.stdout.write(`- source: ${report.sourceRoot}\n`);
	if (report.sourceKind) {
		process.stdout.write(`- source kind: ${report.sourceKind}\n`);
	}
	process.stdout.write(`- target: ${report.targetRoot}\n`);
	process.stdout.write(`- copied: ${report.copied.length}\n`);
	process.stdout.write(`- skipped: ${report.skipped.length}\n`);
	process.stdout.write(`- overwritten: ${report.overwritten.length}\n`);
	process.stdout.write(`- settings: ${report.settingsAction}\n`);
	if (report.warnings.length > 0) {
		process.stdout.write(`Warnings:\n`);
		for (const warning of report.warnings) {
			process.stdout.write(`- ${warning}\n`);
		}
	}
};

const printRuntimeBanner = (label: string, root: string) => {
	process.stdout.write(`[agenthub] Environment: ${label}\n`);
	process.stdout.write(`[agenthub] Home: ${root}\n`);
};

let suppressNextHrRuntimeBanner = false;

const listPromotablePackageIds = async (hrRoot = defaultHrHome()): Promise<string[]> => {
	try {
		const entries = await readdir(path.join(hrRoot, "staging"), { withFileTypes: true });
		return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
	} catch {
		return [];
	}
};

type PromoteHandoff = {
	promotion_id?: string;
	target_profile?: string;
	proposed_profile?: string;
	promotion_preferences?: {
		set_default_profile?: boolean;
	};
	operator_instructions?: {
		test_current_workspace?: string;
		use_in_another_workspace?: string;
		promote?: string;
		advanced_import?: string;
	};
	host_requirements?: {
		mcp_servers_bundled?: boolean;
		missing?: string[];
		runtimes?: string[];
		environment?: string[];
	};
};

const readPromoteHandoff = async (sourceRoot: string): Promise<PromoteHandoff | null> => {
	try {
		return JSON.parse(
			await readFile(path.join(path.dirname(sourceRoot), "handoff.json"), "utf-8"),
		) as PromoteHandoff;
	} catch {
		return null;
	}
};

const resolvePromoteDefaultProfile = (handoff: PromoteHandoff | null): string | undefined => {
	if (!handoff?.promotion_preferences?.set_default_profile) return undefined;
	const targetProfile = handoff.target_profile?.trim();
	if (targetProfile) return targetProfile;
	const proposedProfile = handoff.proposed_profile?.trim();
	return proposedProfile || undefined;
};

const resolvePromoteSourceRoot = async (
	packageId: string | undefined,
	hrRoot = defaultHrHome(),
): Promise<string> => {
	if (packageId) {
		return path.join(hrRoot, "staging", packageId, "agenthub-home");
	}
	const packageIds = await listPromotablePackageIds(hrRoot);
	if (packageIds.length === 0) {
		fail(`No staged HR packages found in ${path.join(hrRoot, "staging")}.`);
	}
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		fail(`'promote' requires a package id in non-interactive mode. Available: ${packageIds.join(", ")}`);
	}
	const rl = createPromptInterface();
	try {
		process.stdout.write(`Available HR packages: ${packageIds.join(", ")}\n`);
		const selected = await promptRequired(rl, "Package to promote", packageIds[0]);
		if (!packageIds.includes(selected)) {
			fail(`Unknown staged HR package '${selected}'. Available: ${packageIds.join(", ")}`);
		}
		return path.join(hrRoot, "staging", selected, "agenthub-home");
	} finally {
		rl.close();
	}
};

const validatePromoteSourceRoot = async (sourceRoot: string, hrRoot = defaultHrHome()) => {
	const resolvedSource = path.resolve(sourceRoot);
	const stagingRoot = path.resolve(path.join(hrRoot, "staging"));
	if (!resolvedSource.startsWith(`${stagingRoot}${path.sep}`)) {
		fail(`Promote source must be inside ${stagingRoot}`);
	}
	const finalChecklistPath = path.join(path.dirname(resolvedSource), "final-checklist.md");
	let finalChecklist: string | undefined;
	try {
		finalChecklist = await readFile(finalChecklistPath, "utf-8");
	} catch {
		finalChecklist = undefined;
	}
	if (!finalChecklist || !finalChecklist.includes("READY FOR HUMAN CONFIRMATION")) {
		process.stderr.write(
			`[agenthub] Warning: ${finalChecklistPath} is missing or not marked READY FOR HUMAN CONFIRMATION. Continuing with manual promote.\n`,
		);
	}
	const handoffPath = path.join(path.dirname(resolvedSource), "handoff.json");
	let handoff: PromoteHandoff | null = null;
	try {
		handoff = JSON.parse(await readFile(handoffPath, "utf-8")) as PromoteHandoff;
	} catch {
		process.stderr.write(`[agenthub] Warning: ${handoffPath} is missing.\n`);
		return;
	}

	const instructions = handoff.operator_instructions;
	if (!instructions?.test_current_workspace) {
		process.stderr.write(
			`[agenthub] Warning: ${handoffPath} is missing operator_instructions.test_current_workspace. Operators may not realize staged profiles can be tested before promote.\n`,
		);
	}
	if (!instructions?.use_in_another_workspace) {
		process.stderr.write(
			`[agenthub] Warning: ${handoffPath} is missing operator_instructions.use_in_another_workspace. Operators may not realize staged profiles can be used in another workspace before promote.\n`,
		);
	}
	if (!instructions?.promote) {
		process.stderr.write(
			`[agenthub] Warning: ${handoffPath} is missing operator_instructions.promote.\n`,
		);
	}
	if (!instructions?.advanced_import) {
		process.stderr.write(
			`[agenthub] Warning: ${handoffPath} is missing operator_instructions.advanced_import.\n`,
		);
	}
	const hostRequirements = handoff.host_requirements;
	if (hostRequirements?.mcp_servers_bundled === false) {
		const missing = hostRequirements.missing?.join(", ") || "MCP server artifacts";
		fail(
			`Staged package cannot be promoted yet because required MCP server artifacts are missing: ${missing}. Re-stage the package with bundled MCP servers first.`,
		);
	}
};

const ensureHomeReadyOrFail = async (targetRoot = defaultAgentHubHome()) => {
	if (await agentHubHomeInitialized(targetRoot)) return;
	fail(`Agent Hub home is not initialized. Run:\n  ${cliCommand} setup`);
};

const ensureSelectedHomeReadyOrFail = async (parsed: ParsedArgs) => {
	const targetRoot = resolveSelectedHomeRoot(parsed);
	if (parsed.command === "hr") {
		if (await hrHomeInitialized(targetRoot || defaultHrHome())) return;
		fail(`HR Office is not initialized. Run:\n  ${cliCommand} hr`);
	}
	await ensureHomeReadyOrFail(targetRoot);
};

const ensureHomeReadyOrBootstrap = async (targetRoot = defaultAgentHubHome()) => {
	if (await agentHubHomeInitialized(targetRoot)) return;
	await installAgentHubHome({ targetRoot, mode: "auto" });
	process.stdout.write(`✓ First run — initialised coding system at ${targetRoot}\n`);
};

const isHrRuntimeSelection = (selection?: RuntimeSelection) =>
	selection?.kind === "profile" && selection.profile === "hr";

const detectSetupModeForHome = async (
	targetRoot: string,
): Promise<NonNullable<BootstrapOptions["mode"]> | "hr-office"> => {
	const settings = await readAgentHubSettings(targetRoot);
	const mode = settings?.meta?.onboarding?.mode;
	if (mode === "auto" || mode === "minimal" || mode === "hr-office") {
		return mode;
	}
	const legacyStarter = settings?.meta?.onboarding?.starter;
	if (legacyStarter === "hr-office" || legacyStarter === "coding-hr") {
		return "hr-office";
	}
	if (legacyStarter === "none" || legacyStarter === "framework") {
		return "minimal";
	}
	return "auto";
};

const detectInstallModeForHome = async (
	targetRoot: string,
	isHrHome = false,
): Promise<NonNullable<BootstrapOptions["mode"]> | "hr-office"> => {
	if (isHrHome) return "hr-office";
	return detectSetupModeForHome(targetRoot);
};

const warnIfBuiltInsDrifted = async (
	targetRoot: string,
	mode?: NonNullable<BootstrapOptions["mode"]> | "hr-office",
) => {
	const settings = await readAgentHubSettings(targetRoot);
	const builtinVersion = settings?.meta?.builtinVersion;
	if (!builtinVersion || Object.keys(builtinVersion).length === 0) return;
	const effectiveMode = mode ?? (await detectInstallModeForHome(targetRoot));
	const allowedKeys = new Set(getBuiltInManifestKeysForMode(effectiveMode));
	const currentVersion = readPackageVersion();
	const staleAssets = Object.entries(builtinVersion)
		.filter(([asset]) => allowedKeys.has(asset))
		.filter(([, installedVersion]) => installedVersion !== currentVersion)
		.map(([asset]) => asset)
		.sort();
	if (staleAssets.length === 0) return;
	process.stderr.write(
		[
			`[agenthub] Built-in assets may be stale (${staleAssets.length} item${staleAssets.length === 1 ? "" : "s"}) relative to package ${currentVersion}.`,
			`Run '${cliCommand} upgrade${targetRoot !== defaultAgentHubHome() ? ` --target-root ${targetRoot}` : ""}' to preview or sync updates.`,
		].join("\n") + "\n",
	);
};

const hrLegacyAssetNames = [
	"hr",
	"hr-sourcer",
	"hr-evaluator",
	"hr-cto",
	"hr-adapter",
	"hr-verifier",
] as const;

const warnAboutLegacyHrAssets = async (personalRoot = defaultAgentHubHome()) => {
	const hrBundleDir = path.join(personalRoot, "bundles");
	const found = await Promise.all(
		hrLegacyAssetNames.map(async (name) => ({
			name,
			exists: await readFile(path.join(hrBundleDir, `${name}.json`), "utf-8")
				.then(() => true)
				.catch(() => false),
		})),
	);
	const present = found.filter((entry) => entry.exists).map((entry) => entry.name);
	if (present.length === 0) return;
	process.stderr.write(
		[
			`[agenthub] Notice: legacy HR assets were found in your personal home (${present.join(", ")}).`,
			`[agenthub] They are left in place for compatibility. Use '${cliCommand} hr' for new isolated HR work.`,
		].join("\n") + "\n",
	);
};

const profileExistsInHome = async (targetRoot: string, profile: string) => {
	return Boolean(
		await readJsonIfExists<Record<string, unknown>>(
			path.join(targetRoot, "profiles", `${profile}.json`),
		),
	);
};

type StagedHrProfileMatch = {
	packageId: string;
	profile: string;
	libraryRoot: string;
	profilePath: string;
	modifiedAtMs: number;
};

const listStagedHrProfileMatches = async (
	profile: string,
	hrRoot = defaultHrHome(),
): Promise<StagedHrProfileMatch[]> => {
	try {
		const stagingRoot = path.join(hrRoot, "staging");
		const entries = await readdir(stagingRoot, { withFileTypes: true });
		const matches = await Promise.all(
			entries
				.filter((entry) => entry.isDirectory())
				.map(async (entry) => {
					const libraryRoot = path.join(stagingRoot, entry.name, "agenthub-home");
					const profilePath = path.join(libraryRoot, "profiles", `${profile}.json`);
					const profileStat = await stat(profilePath).catch(() => null);
					if (!profileStat?.isFile()) return null;
					return {
						packageId: entry.name,
						profile,
						libraryRoot,
						profilePath,
						modifiedAtMs: profileStat.mtimeMs,
					};
				}),
		);
		return matches
			.filter((match): match is StagedHrProfileMatch => Boolean(match))
			.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs || a.packageId.localeCompare(b.packageId));
	} catch {
		return [];
	}
};

const resolveHrProfileSource = async (
	profile: string,
	hrRoot = defaultHrHome(),
): Promise<{ libraryRoot: string; settingsRoot: string; kind: "home" | "staged"; match?: StagedHrProfileMatch }> => {
	if (await profileExistsInHome(hrRoot, profile)) {
		return {
			libraryRoot: hrRoot,
			settingsRoot: hrRoot,
			kind: "home",
		};
	}
	const stagedMatches = await listStagedHrProfileMatches(profile, hrRoot);
	if (stagedMatches.length > 0) {
		return {
			libraryRoot: stagedMatches[0].libraryRoot,
			settingsRoot: hrRoot,
			kind: "staged",
			match: stagedMatches[0],
		};
	}
	return {
		libraryRoot: hrRoot,
		settingsRoot: hrRoot,
		kind: "home",
	};
};

const printHrStagedProfileResolution = async (
	profile: string,
	match: StagedHrProfileMatch,
	hrRoot = defaultHrHome(),
) => {
	const stagedMatches = await listStagedHrProfileMatches(profile, hrRoot);
	process.stderr.write(
		`[agenthub] Staging test -> using profile '${profile}' from staged package '${match.packageId}'.\n`,
	);
	process.stderr.write(`[agenthub] Source: ${match.libraryRoot}\n`);
	if (stagedMatches.length > 1) {
		const alternates = stagedMatches
			.slice(1)
			.map((item) => item.packageId)
			.join(", ");
		process.stderr.write(
			`[agenthub] Warning: profile '${profile}' also exists in other staged packages: ${alternates}. Using the most recently updated match.\n`,
		);
	}
};

const printUpgradeReport = (
	targetRoot: string,
	installMode: NonNullable<BootstrapOptions["mode"]> | "hr-office",
	report: Awaited<ReturnType<typeof syncBuiltInAgentHubAssets>>,
	options: ParsedArgs["upgradeOptions"],
) => {
	const verb = options.dryRun ? "Would" : "Did";
	process.stdout.write(`Built-in asset sync ${options.dryRun ? "preview" : "complete"}\n`);
	process.stdout.write(`- target: ${targetRoot}\n`);
	process.stdout.write(`- target kind: ${installMode === "hr-office" ? "HR Office" : "Personal Home"}\n`);
	process.stdout.write(`- mode: ${options.dryRun ? "dry-run" : options.force ? "force" : "safe"}\n`);
	process.stdout.write(`- add: ${report.added.length}\n`);
	process.stdout.write(`- update: ${report.updated.length}\n`);
	process.stdout.write(`- skip: ${report.skipped.length}\n`);
	if (installMode === "hr-office") {
		process.stdout.write(`- note: staged packages under ${path.join(targetRoot, "staging")} are not modified by upgrade\n`);
	}
	for (const [label, entries] of [
		[`${verb} add`, report.added],
		[`${verb} update`, report.updated],
		[`${verb} skip`, report.skipped],
	] as const) {
		if (entries.length === 0) continue;
		process.stdout.write(`${label}:\n`);
		for (const entry of entries) {
			process.stdout.write(`- ${entry}\n`);
		}
	}
	if (options.dryRun) {
		process.stdout.write("Run again with '--force' to overwrite managed built-in files.\n");
	} else if (!options.force) {
		process.stdout.write("Existing managed files were left in place; re-run with '--force' to overwrite them.\n");
	}
};

const resolveConfigRoot = (parsed: ParsedArgs): string => {
	if (parsed.configRoot) return parsed.configRoot;
	if (!parsed.runtimeSelection) {
		return parsed.workspace;
	}
	if (parsed.runtimeSelection.kind === "tools-only") {
		return getWorkspaceRuntimeRoot(parsed.workspace);
	}
	if (parsed.runtimeSelection.kind === "customized-agent") {
		return getWorkspaceRuntimeRoot(parsed.workspace);
	}
	return getDefaultConfigRoot(
		parsed.workspace,
		parsed.runtimeSelection.profile,
	);
};

const resolveSelectedHomeRoot = (parsed: ParsedArgs): string | undefined => {
	if (parsed.bootstrapOptions.targetRoot) {
		return parsed.bootstrapOptions.targetRoot;
	}
	if (parsed.command === "hr") {
		return defaultHrHome();
	}
	return undefined;
};

const composeSelection = async (parsed: ParsedArgs, configRoot: string) => {
	let homeRoot = resolveSelectedHomeRoot(parsed);
	let settingsRoot = homeRoot;
	if (!parsed.runtimeSelection) {
		return { workspace: parsed.workspace, configRoot };
	}
	if (
		parsed.command === "hr" &&
		parsed.hrIntent?.kind === "compose" &&
		parsed.runtimeSelection.kind === "profile"
	) {
		const resolved = await resolveHrProfileSource(
			parsed.runtimeSelection.profile,
			defaultHrHome(),
		);
		homeRoot = resolved.libraryRoot;
		settingsRoot = resolved.settingsRoot;
		if (resolved.kind === "staged" && resolved.match) {
			await printHrStagedProfileResolution(
				parsed.runtimeSelection.profile,
				resolved.match,
				defaultHrHome(),
			);
		}
	}
	if (parsed.runtimeSelection.kind === "tools-only") {
		return composeToolInjection(parsed.workspace, configRoot, { homeRoot, settingsRoot });
	}
	if (parsed.runtimeSelection.kind === "customized-agent") {
		return composeCustomizedAgent(parsed.workspace, configRoot, { homeRoot, settingsRoot });
	}
	return composeWorkspace(
		parsed.workspace,
		parsed.runtimeSelection.profile,
		configRoot,
		{ homeRoot, settingsRoot },
	);
};

const printComposeSummaryForConfigRoot = async (
	workspace: string,
	configRoot: string,
) => {
	const status = await resolveRuntimeStatus({ workspace, configRoot });
	process.stdout.write(renderComposeSummary(status));
};

const runOpencode = async (
	workspace: string,
	configRoot?: string,
	opencodeArgs: string[],
) => {
	const env = configRoot
		? {
				...process.env,
				XDG_CONFIG_HOME: path.join(configRoot, "xdg"),
				OPENCODE_DISABLE_PROJECT_CONFIG: "true",
				OPENCODE_CONFIG_DIR: configRoot,
			}
		: process.env;

	const child = spawn("opencode", opencodeArgs, {
		cwd: workspace,
		stdio: "inherit",
		env,
		...spawnOptions(),
	});

	child.on("exit", (code, signal) => {
		if (signal) {
			process.kill(process.pid, signal);
			return;
		}
		process.exit(code ?? 0);
	});
};

const parsed = parseArgs(process.argv.slice(2));
const startupNotice = windowsStartupNotice();
if (startupNotice) {
	process.stderr.write(`${startupNotice}\n`);
}

if (parsed.command === "start" || parsed.command === "run") {
	if (
		parsed.runtimeSelection?.kind === "profile" &&
		parsed.runtimeSelection.profile === "hr"
	) {
		fail(
			`'start hr' and 'run hr' are no longer supported. Use '${cliCommand} hr' for HR Office or '${cliCommand} hr <profile>' to test an HR profile in this workspace.`,
		);
	}

	if (parsed.startIntent?.kind === "set-default") {
		const targetRoot = resolveSelectedHomeRoot(parsed) || defaultAgentHubHome();
		await ensureHomeReadyOrFail(targetRoot);
		if (!(await profileExistsInHome(targetRoot, parsed.startIntent.profile))) {
			fail(
				`Profile '${parsed.startIntent.profile}' not found in ${path.join(targetRoot, "profiles")}.`,
			);
		}
		await setStartDefaultProfile(parsed.startIntent.profile, targetRoot);
		process.stdout.write(
			`Set default start profile to '${parsed.startIntent.profile}' for ${targetRoot}\n`,
		);
		process.exit(0);
	}

	if (parsed.startIntent?.kind === "compose" && !parsed.startIntent.profile) {
		const resolved =
			parsed.startIntent.source === "last"
				? await resolveStartLastProfilePreference(parsed.workspace)
				: await resolveStartProfilePreference(
					parsed.workspace,
					resolveSelectedHomeRoot(parsed) || defaultAgentHubHome(),
				);
		parsed.startIntent = {
			kind: "compose",
			profile: resolved.profile,
			source: resolved.source,
		};
		parsed.runtimeSelection = {
			kind: "profile",
			profile: resolved.profile,
		};
		noteProfileResolution("start", resolved.source, resolved.profile);
	}
}

if (parsed.command === "hr" && parsed.hrIntent?.kind === "compose" && parsed.hrIntent.source === "last") {
	const lastProfile = await resolveHrLastProfilePreference(parsed.workspace);
	if (!lastProfile) {
		fail(`No previous HR workspace profile for this folder. Use: ${cliCommand} hr <profile>`);
	}
	parsed.hrIntent = { kind: "compose", profile: lastProfile, source: "last" };
	parsed.runtimeSelection = {
		kind: "profile",
		profile: lastProfile,
	};
	noteProfileResolution("hr", "last", lastProfile);
}

if (parsed.command === "setup") {
	const options = Object.keys(parsed.bootstrapOptions).length
		? parsed.bootstrapOptions
		: await promptHubInitAnswers();
	const targetRoot = await installAgentHubHome(options);
	const mode = options.mode ?? "auto";
	if (mode === "auto") {
		process.stdout.write(`✓ Coding system ready. Run: ${cliCommand} start\n`);
	} else {
		process.stdout.write("✓ Minimal Agent Hub structure ready. Add your own assets anytime.\n");
	}
	process.stdout.write(`${targetRoot}\n`);
	process.exit(0);
}

if (parsed.command === "backup") {
	const outputRoot = parsed.transferOptions.outputRoot;
	if (!outputRoot) {
		fail("'backup' requires '--output <path>'.");
	}
	const report = await exportAgentHubHome({
		sourceRoot: defaultAgentHubHome(),
		outputRoot,
		pluginVersion: readPackageVersion(),
	});
	printTransferReport("Backup", report);
	process.exit(0);
}

if (parsed.command === "restore") {
	const importSourceRoot = parsed.transferOptions.sourceRoot;
	if (!importSourceRoot) {
		fail("'restore' requires '--source <path>'.");
	}
	const report = await importAgentHubHome({
		sourceRoot: importSourceRoot,
		targetRoot: defaultAgentHubHome(),
		overwrite: parsed.transferOptions.overwrite,
		settingsMode: parsed.transferOptions.settingsMode,
	});
	printTransferReport("Restore", report);
	process.exit(0);
}

if (parsed.command === "promote") {
	const hrRoot = defaultHrHome();
	const sourceRoot = await resolvePromoteSourceRoot(parsed.promotePackageId, hrRoot);
	const handoff = await readPromoteHandoff(sourceRoot);
	await validatePromoteSourceRoot(sourceRoot, hrRoot);
	const report = await importAgentHubHome({
		sourceRoot,
		targetRoot: defaultAgentHubHome(),
		overwrite: false,
		settingsMode: "preserve",
	});
	const defaultProfile = resolvePromoteDefaultProfile(handoff);
	if (defaultProfile) {
		await setStartDefaultProfile(defaultProfile);
	}
	printTransferReport("Promote", report);
	if (defaultProfile) {
		process.stdout.write(`- default profile updated: ${defaultProfile}\n`);
	}
	process.exit(0);
}

if (parsed.command === "hub-export") {
	const outputRoot = parsed.transferOptions.outputRoot;
	if (!outputRoot) {
		fail("'hub-export' requires '--output <path>'.");
	}
	const report = await exportAgentHubHome({
		sourceRoot: parsed.transferOptions.sourceRoot,
		outputRoot,
		pluginVersion: readPackageVersion(),
	});
	printTransferReport("Export", report);
	process.exit(0);
}

if (parsed.command === "hub-import") {
	const importSourceRoot = parsed.transferOptions.sourceRoot;
	if (!importSourceRoot) {
		fail("'hub-import' requires '--source <path>'.");
	}
	const report = await importAgentHubHome({
		sourceRoot: importSourceRoot,
		targetRoot: parsed.transferOptions.targetRoot,
		overwrite: parsed.transferOptions.overwrite,
		settingsMode: parsed.transferOptions.settingsMode,
	});
	printTransferReport("Import", report);
	process.exit(0);
}

if (parsed.command === "compose" || parsed.command === "new") {
	const agentHubHome = parsed.bootstrapOptions.targetRoot || defaultAgentHubHome();
	await ensureHomeReadyOrFail(agentHubHome);
	const composeSelection = parsed.composeSelection;
	if (!composeSelection) {
		fail(
			parsed.command === "compose"
				? "Use 'compose profile <name>' or 'compose bundle <name>'."
				: "Use 'new soul <name>', 'new skill <name>', 'new instruction <name>', 'new bundle <name>', or 'new profile <name>'.",
		);
	}
	const filePath =
		composeSelection.kind === "profile"
			? await createProfileDefinition(
				agentHubHome,
				composeSelection.name,
				parsed.profileCreateOptions,
				fail,
			)
			: composeSelection.kind === "bundle"
				? await createBundleDefinition(
					agentHubHome,
					composeSelection.name,
					parsed.profileCreateOptions.reservedOk,
					fail,
				)
				: composeSelection.kind === "soul"
					? await createSoulDefinition(
						agentHubHome,
						composeSelection.name,
						parsed.profileCreateOptions.reservedOk,
						fail,
					)
					: composeSelection.kind === "skill"
						? await createSkillDefinition(
							agentHubHome,
							composeSelection.name,
							parsed.profileCreateOptions.reservedOk,
							fail,
						)
						: await createInstructionDefinition(
							agentHubHome,
							composeSelection.name,
							parsed.profileCreateOptions.reservedOk,
							fail,
						);
	await warnIfBuiltInsDrifted(agentHubHome, await detectSetupModeForHome(agentHubHome));
	process.stdout.write(`${filePath}\n`);
	process.exit(0);
}

if (parsed.command === "plugin") {
	if (parsed.pluginSubcommand !== "doctor") {
		fail("Use 'plugin doctor'.");
	}
	process.stderr.write(`[agenthub] 'plugin doctor' is deprecated; use '${cliCommand} doctor --category=plugin' instead.\n`);
	parsed.command = "doctor";
	parsed.doctorOptions.category = "plugin";
	parsed.doctorOptions.quiet = true;
}

if (parsed.command === "status") {
	const status = await resolveRuntimeStatus({
		workspace: parsed.workspace,
		configRoot: parsed.configRoot,
	});
	if (!status.exists) {
		process.stderr.write(
			`No Agent Hub runtime found at ${status.configRoot}.\nRun '${cliCommand} start' or '${cliCommand} hr <profile>' first.\n`,
		);
		process.exit(1);
	}
	if (parsed.statusOptions.json) {
		process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
	} else if (parsed.statusOptions.short) {
		process.stdout.write(renderRuntimeStatusShort(status));
	} else {
		process.stdout.write(renderRuntimeStatus(status));
	}
	process.exit(0);
}

if (parsed.command === "upgrade") {
	const targetRoot = resolveSelectedHomeRoot(parsed) || defaultAgentHubHome();
	await ensureHomeReadyOrFail(targetRoot);
	const mode = await detectSetupModeForHome(targetRoot);
	const report = await syncBuiltInAgentHubAssets({
		targetRoot,
		mode,
		force: parsed.upgradeOptions.force,
		dryRun: parsed.upgradeOptions.dryRun,
	});
	printUpgradeReport(targetRoot, mode, report, parsed.upgradeOptions);
	process.exit(0);
}

if ((parsed.command === "run" || parsed.command === "start") && !parsed.runtimeSelection) {
	if (parsed.assembleOnly) {
		fail("'run'/'start' without a profile cannot be used with '--assemble-only'.");
	}
	if (process.stderr.isTTY) {
		process.stderr.write(
			"⚠  No profile selected — launching plain opencode (hub runtime is inactive)\n",
		);
	}
	await ensureWorkspaceReadable(parsed.workspace);
	await runOpencode(parsed.workspace, undefined, parsed.opencodeArgs);
	process.exit(0);
}

if (parsed.command === "doctor" || parsed.command === "hub-doctor") {
	const targetRoot =
		parsed.bootstrapOptions.targetRoot || defaultAgentHubHome();
	const {
		runDiagnostics,
		interactiveAssembly,
		interactiveDoctor,
		updateAgentModelOverride,
		updateAgentPromptOverride,
		fixMissingGuards,
		createBundleForSoul,
		createProfile,
		fixOmoMixedProfile,
		getAvailableBundles,
	} = await import("../skills/agenthub-doctor/index.js");

	if (parsed.doctorOptions.agent) {
		const promptFilePath = parsed.doctorOptions.promptFile;
		const message =
			parsed.doctorOptions.model || parsed.doctorOptions.clearModel
				? await updateAgentModelOverride(
						targetRoot,
						parsed.doctorOptions.agent,
						parsed.doctorOptions.clearModel
							? ""
							: parsed.doctorOptions.model || "",
					)
				: await updateAgentPromptOverride(
						targetRoot,
						parsed.doctorOptions.agent,
						parsed.doctorOptions.clearPrompt
							? ""
							: promptFilePath
								? await readFile(promptFilePath, "utf-8")
								: fail(
										"'doctor --prompt-file <path>' requires a prompt file path.",
									),
					);
		process.stdout.write(`${message}\n`);
		process.exit(0);
	}

	if (!parsed.doctorOptions.json && !parsed.doctorOptions.quiet) {
		process.stdout.write("🔍 Running Agent Hub diagnostics...\n\n");
	}
	const report = await runDiagnostics(targetRoot, {
		configRoot: parsed.configRoot,
		workspace: parsed.workspace,
		category: parsed.doctorOptions.category,
	});
	const strictMode = parsed.doctorOptions.strict === true;
	const renderCompactVerdict = () => {
		if (report.verdict === "fail") return "Doctor: fail";
		if (report.verdict === "warn") return "Doctor: warnings present";
		return "Doctor: pass";
	};
	const doctorExitCode =
		report.verdict === "fail" || (strictMode && report.verdict === "warn") ? 1 : 0;

	if (parsed.doctorOptions.json) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		process.exit(doctorExitCode);
	}
	if (parsed.doctorOptions.quiet) {
		process.stdout.write(`${renderCompactVerdict()}\n`);
		process.exit(doctorExitCode);
	}

	if (report.healthy.length > 0) {
		process.stdout.write("✅ Healthy:\n");
		for (const item of report.healthy) {
			process.stdout.write(`  - ${item}\n`);
		}
		process.stdout.write("\n");
	}

	if (report.issues.length === 0) {
		process.stdout.write("✅ No issues found! Agent Hub is ready to use.\n");
		if (
			parsed.doctorOptions.fixAll ||
			parsed.doctorOptions.dryRun ||
			!process.stdin.isTTY
		) {
			process.exit(0);
		}
		await interactiveDoctor(targetRoot, report);
		process.exit(0);
	}

	process.stdout.write("⚠️  Issues Found:\n");
	for (const issue of report.issues) {
		const icon =
			issue.severity === "error"
				? "❌"
				: issue.severity === "warning"
					? "⚠️ "
					: "ℹ️ ";
		process.stdout.write(`  ${icon} ${issue.message}\n`);
		if (issue.remediation) {
			process.stdout.write(`     → ${issue.remediation}\n`);
		}
		if (issue.docLink) {
			process.stdout.write(`     → See: ${issue.docLink}\n`);
		}
	}
	process.stdout.write("\n");

	if (parsed.doctorOptions.dryRun) {
		process.stdout.write("(Dry run - no fixes applied)\n");
		process.exit(doctorExitCode);
	}

	if (parsed.doctorOptions.fixAll) {
		process.stdout.write("🔧 Applying fixes...\n\n");

		const missingGuardsIssue = report.issues.find(
			(i) => i.type === "missing_guards",
		);
		if (missingGuardsIssue) {
			const guards = (missingGuardsIssue.details as { guards: string[] })
				.guards;
			const result = await fixMissingGuards(targetRoot, guards);
			process.stdout.write(
				`  ${result.success ? "✓" : "✗"} ${result.message}\n`,
			);
		}

		const orphanedSoulsIssue = report.issues.find(
			(i) => i.type === "orphaned_souls",
		);
		if (orphanedSoulsIssue) {
			const souls = (orphanedSoulsIssue.details as { souls: string[] }).souls;
			for (const soul of souls) {
				const result = await createBundleForSoul(targetRoot, soul);
				process.stdout.write(
					`  ${result.success ? "✓" : "✗"} ${result.message}\n`,
				);
			}
		}

		const noProfilesIssue = report.issues.find((i) => i.type === "no_profiles");
		if (noProfilesIssue) {
			const bundles = await getAvailableBundles(targetRoot);
			if (bundles.length > 0) {
				const result = await createProfile(targetRoot, "imported", {
					bundleNames: bundles,
				});
				process.stdout.write(
					`  ${result.success ? "✓" : "✗"} ${result.message}\n`,
				);
			}
		}

		const omoIssue = report.issues.find((i) => i.type === "omo_mixed_profile");
		if (omoIssue) {
			const result = await fixOmoMixedProfile(
				targetRoot,
				omoIssue.details as {
					profile: string;
					omoBundles: string[];
					nativeWithoutOmoGuard: string[];
				},
			);
			process.stdout.write(
				`  ${result.success ? "✓" : "✗"} ${result.message}\n`,
			);
		}

		process.stdout.write("\n🔁 Re-running diagnostics...\n");
		const rerun = await runDiagnostics(targetRoot, {
			configRoot: parsed.configRoot,
			workspace: parsed.workspace,
			category: parsed.doctorOptions.category,
		});
		process.stdout.write(
			rerun.issues.length === 0
				? "✅ All fixes applied and re-verified cleanly!\n"
				: `⚠️  Fixes applied, but ${rerun.issues.length} issue(s) remain.\n`,
		);
		process.exit(
			rerun.verdict === "fail" || (strictMode && rerun.verdict === "warn") ? 1 : 0,
		);
	}

	await interactiveAssembly(targetRoot, report);
	process.exit(doctorExitCode);
}

if (parsed.command === "list") {
	const {
		labelSouls,
		labelBundles,
		labelProfiles,
		labelSkills,
		labelInstructions,
	} = await import("./query.js");
	const hubHome = parsed.bootstrapOptions.targetRoot || defaultAgentHubHome();
	const target = parsed.listTarget;

	const printSection = (
		title: string,
		items: Array<{ name: string; source: string }>,
	) => {
		process.stdout.write(`\n${title} (${items.length}):\n`);
		if (items.length === 0) {
			process.stdout.write("  (none)\n");
		} else {
			for (const item of items) {
				process.stdout.write(`  ${item.name}  [${item.source}]\n`);
			}
		}
	};

	if (!target || target === "souls") {
		printSection("Souls", await labelSouls(hubHome));
	}
	if (!target || target === "bundles") {
		printSection("Bundles", await labelBundles(hubHome));
	}
	if (!target || target === "profiles") {
		printSection("Profiles", await labelProfiles(hubHome));
	}
	if (!target || target === "skills") {
		printSection("Skills", await labelSkills(hubHome));
	}
	if (!target || target === "instructions") {
		printSection("Instructions", await labelInstructions(hubHome));
	}

	if (target && !["souls", "bundles", "profiles", "skills", "instructions"].includes(target)) {
		fail(`Unknown list target '${target}'. Use: souls, bundles, profiles, skills, instructions`);
	}

	process.stdout.write("\n");
	process.exit(0);
}

if (parsed.command === "hr") {
	const hrBootstrapped = await ensureHrOfficeReadyOrBootstrap(resolveSelectedHomeRoot(parsed), {
		syncSourcesOnFirstRun: !parsed.assembleOnly,
		cliCommand,
	});
	if (hrBootstrapped) {
		suppressNextHrRuntimeBanner = true;
	}
	await repairHrModelConfigurationIfNeeded(resolveSelectedHomeRoot(parsed) || defaultHrHome(), {
		fail,
	});
	if (parsed.hrIntent?.kind === "office") {
		parsed.workspace = resolveSelectedHomeRoot(parsed) || defaultHrHome();
	} else if (parsed.hrIntent?.kind === "compose") {
		await warnIfWorkspaceRuntimeWillBeReplaced(
			parsed.workspace,
			`HR profile '${parsed.hrIntent.profile}'`,
		);
	}
} else if (parsed.command === "start" || parsed.command === "run") {
	await ensureHomeReadyOrBootstrap(resolveSelectedHomeRoot(parsed));
	await warnAboutLegacyHrAssets(resolveSelectedHomeRoot(parsed) || defaultAgentHubHome());
} else {
	await ensureSelectedHomeReadyOrFail(parsed);
}

{
	const selectedHome = resolveSelectedHomeRoot(parsed) || defaultAgentHubHome();
	const selectedMode = await detectInstallModeForHome(selectedHome, parsed.command === "hr");
	await warnIfBuiltInsDrifted(selectedHome, selectedMode);
}

if (parsed.command === "run" || parsed.command === "start" || parsed.command === "hr") {
	await ensureWorkspaceReadable(parsed.workspace);
}

const finalConfigRoot = resolveConfigRoot(parsed);
const result = await composeSelection(parsed, finalConfigRoot);
if (!(parsed.command === "hr" && suppressNextHrRuntimeBanner)) {
	printRuntimeBanner(
		parsed.command === "hr"
			? "HR Office"
			: "My Team",
		resolveSelectedHomeRoot(parsed) || defaultAgentHubHome(),
	);
}
suppressNextHrRuntimeBanner = false;
if (shouldChmod()) {
	await chmod(path.join(result.configRoot, "run.sh"), 0o755);
}

if (parsed.command === "start" || parsed.command === "run" || parsed.command === "hr") {
	await printComposeSummaryForConfigRoot(parsed.workspace, result.configRoot);
}

if (
	(parsed.command === "start" || parsed.command === "run") &&
	parsed.runtimeSelection?.kind === "profile"
) {
	await updateWorkspacePreferences(parsed.workspace, (current) => ({
		...current,
		start: {
			...(current.start || {}),
			lastProfile: parsed.runtimeSelection?.kind === "profile" ? parsed.runtimeSelection.profile : undefined,
		},
	}));
}

if (
	parsed.command === "hr" &&
	parsed.hrIntent?.kind === "compose" &&
	parsed.runtimeSelection?.kind === "profile"
) {
	await updateWorkspacePreferences(parsed.workspace, (current) => ({
		...current,
		hr: {
			...(current.hr || {}),
			lastProfile: parsed.runtimeSelection?.kind === "profile" ? parsed.runtimeSelection.profile : undefined,
		},
	}));
}

if (
	(parsed.command === "run" || parsed.command === "start" || (parsed.command === "hr" && parsed.hrIntent?.kind === "compose")) &&
	parsed.runtimeSelection?.kind === "profile" &&
	!parsed.assembleOnly
) {
	await maybeConfigureEnvrc(parsed.workspace, result.configRoot);
}

if (parsed.command === "compose" || parsed.assembleOnly) {
	process.stdout.write(`${result.configRoot}\n`);
	process.exit(0);
}

await runOpencode(parsed.workspace, result.configRoot, parsed.opencodeArgs);
