#!/usr/bin/env node

import { spawn } from "node:child_process";
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import type { BootstrapOptions } from "./bootstrap.js";
import {
	agentHubHomeInitialized,
	defaultAgentHubHome,
	defaultHrHome,
	hrHomeInitialized,
	installAgentHubHome,
	installHrOfficeHomeWithOptions,
	promptHubInitAnswers,
	syncBuiltInAgentHubAssets,
} from "./bootstrap.js";
import {
	getBuiltInManifestKeysForMode,
	listBuiltInAssetNames,
	type BuiltInAssetKind,
} from "./builtin-assets.js";
import {
	composeCustomizedAgent,
	composeToolInjection,
	composeWorkspace,
	getDefaultConfigRoot,
	getWorkspaceRuntimeRoot,
} from "./compose.js";
import { expandProfileAddSelections, listProfileAddCapabilityNames } from "./capabilities.js";
import {
	exportAgentHubHome,
	importAgentHubHome,
	type SettingsImportMode,
} from "./home-transfer.js";
import {
	inspectRuntimeConfig,
	resolvePluginConfigRoot,
	summarizeRuntimeFeatureState,
} from "../plugins/runtime-config.js";
import {
	renderComposeSummary,
	renderRuntimeStatus,
	renderRuntimeStatusShort,
	resolveRuntimeStatus,
} from "./runtime-status.js";
import { readPackageVersion } from "./package-version.js";
import {
	mergeAgentHubSettingsDefaults,
	hrPrimaryAgentName,
	hrSubagentNames,
	hrAgentNames,
	loadNativeOpenCodePreferences,
	listAvailableOpencodeModels,
	probeOpencodeModelAvailability,
	readHrKnownModelIds,
	recommendedHrBootstrapModel,
	recommendedHrBootstrapVariant,
	readAgentHubSettings,
	resolveHrBootstrapAgentModels,
	validateHrAgentModelConfiguration,
	writeAgentHubSettings,
	type HrBootstrapModelSelection,
	type HrSubagentModelStrategy,
} from "./settings.js";
import {
	validateModelAgainstCatalog,
	validateModelIdentifier,
} from "./model-utils.js";
import {
	displayHomeConfigPath,
	interactivePromptResetSequence,
	resolvePythonCommand,
	shouldChmod,
	shouldOfferEnvrc,
	shouldUseReadlineTerminal,
	spawnOptions,
	stripTerminalControlInput,
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

type AgentMode = "primary" | "subagent";
type Runtime = "native" | "omo";

type AgentConfig = {
	name: string;
	mode: AgentMode;
	hidden?: boolean;
	model: string;
	variant?: string;
	description?: string;
};

type BundleSpawnSpec = {
	strategy: "category-family";
	source: "categories";
	shared: {
		soul: string;
		skills: string[];
	};
};

type BundleSpec = {
	name: string;
	runtime: Runtime;
	soul: string;
	instructions?: string[];
	skills: string[];
	mcp?: string[];
	guards?: string[];
	categories?: Record<string, string>;
	spawn?: BundleSpawnSpec;
	agent: AgentConfig;
};

type ProfileSpec = {
	name: string;
	description?: string;
	bundles: string[];
	defaultAgent?: string;
	plugins: string[];
	nativeAgentPolicy?: "inherit" | "team-only" | "override";
	/** @deprecated Use nativeAgentPolicy instead. */
	inheritNativeAgents?: boolean;
};

type WorkspacePreferences = {
	_version?: 1;
	envrc?: {
		prompted: boolean;
		enabled: boolean;
	};
	start?: {
		lastProfile?: string;
	};
	hr?: {
		lastProfile?: string;
	};
};

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

type HrModelCheckResult =
	| { ok: true; selection: HrBootstrapModelSelection }
	| {
			ok: false;
			selection: HrBootstrapModelSelection;
			stage: "syntax" | "catalog" | "availability" | "probe_failed";
			message: string;
	  };

type HrBootstrapResourceAssessment = {
	configuredGithubSources: number | null;
	configuredModelCatalogSources: number | null;
	knownModels?: Set<string>;
	availableModels?: string[];
	freeModels: string[];
	nativeModel?: string;
	recommendedAvailability: Awaited<ReturnType<typeof probeOpencodeModelAvailability>>;
};

type HrBootstrapRecommendation = {
	strategy: "recommended" | "free" | "custom" | "native";
	summary: string;
	reason: string;
};

const formatCountLabel = (
	count: number | null,
	singular: string,
	plural = `${singular}s`,
) => {
	if (count === null) return `unknown ${plural}`;
	return `${count} ${count === 1 ? singular : plural}`;
};

const inspectHrBootstrapResources = async (
	hrRoot: string,
): Promise<HrBootstrapResourceAssessment> => {
	const [configuredGithubSources, configuredModelCatalogSources, knownModels, availableModels, freeModels, native] =
		await Promise.all([
			countConfiguredHrGithubSources(hrRoot),
			countConfiguredHrModelCatalogSources(hrRoot),
			readHrKnownModelIds(hrRoot),
			listAvailableOpencodeModels(),
			listOpencodeFreeModels(),
			loadNativeOpenCodePreferences(),
		]);
	const recommendedAvailability = await probeOpencodeModelAvailability(
		recommendedHrBootstrapModel,
		{ listModels: async () => availableModels },
	);
	return {
		configuredGithubSources,
		configuredModelCatalogSources,
		knownModels,
		availableModels,
		freeModels,
		nativeModel: native?.model,
		recommendedAvailability,
	};
};

const recommendHrBootstrapSelection = (
	resources: HrBootstrapResourceAssessment,
): HrBootstrapRecommendation => {
	if (resources.recommendedAvailability.available) {
		return {
			strategy: "recommended",
			summary: `I recommend starting with the recommended HR model (${recommendedHrBootstrapModel}).`,
			reason: "It is available in this opencode environment and matches the built-in HR default.",
		};
	}
	if (resources.freeModels.length > 0) {
		return {
			strategy: "free",
			summary: "I recommend starting with the best available free HR model.",
			reason: `${resources.recommendedAvailability.message} A free fallback is available right now.`,
		};
	}
	const nativeModelSyntax = resources.nativeModel
		? validateModelIdentifier(resources.nativeModel)
		: undefined;
	if (resources.nativeModel && nativeModelSyntax?.ok) {
		return {
			strategy: "native",
			summary: `I recommend reusing your native default model (${resources.nativeModel}).`,
			reason: "No verified free fallback is visible, but your native opencode default looks usable.",
		};
	}
	return {
		strategy: "custom",
		summary: "I recommend entering a custom HR model now.",
		reason: "The recommended preset is not currently verified and no safer automatic fallback was found.",
	};
};

const printHrBootstrapAssessment = (
	resources: HrBootstrapResourceAssessment,
	recommendation: HrBootstrapRecommendation,
) => {
	void resources;
	process.stdout.write(`\nRecommended setup:\n${recommendation.summary}\n\n`);
};

const buildHrModelSelection = async (
	rl: readline.Interface,
	hrRoot: string,
	strategy: "recommended" | "free" | "custom" | "native",
): Promise<HrBootstrapModelSelection> => {
	if (strategy === "recommended") {
		process.stdout.write(
			`[agenthub] Recommended HR preset requires OpenAI model access in your opencode environment.\n`,
		);
		return {
			consoleModel: recommendedHrBootstrapModel,
			subagentStrategy: "recommended",
			sharedSubagentModel: recommendedHrBootstrapModel,
		};
	}
	if (strategy === "native") {
		const native = await loadNativeOpenCodePreferences();
		if (!native?.model) {
			process.stdout.write("[agenthub] No native default model is configured. Choose another fallback.\n");
			return buildHrModelSelection(rl, hrRoot, "free");
		}
		return {
			consoleModel: native.model,
			subagentStrategy: "native",
			sharedSubagentModel: native.model,
		};
	}
	if (strategy === "free") {
		const freeModels = await listOpencodeFreeModels();
		const fallbackFreeModel = freeModels.includes("opencode/minimax-m2.5-free")
			? "opencode/minimax-m2.5-free"
			: (freeModels[0] || "opencode/minimax-m2.5-free");
		const choices = freeModels.length > 0 ? freeModels : [fallbackFreeModel];
		process.stdout.write("Current opencode free models:\n");
		const selected =
			choices.length === 1
				? (process.stdout.write(`  1. ${choices[0]}\n`), choices[0])
				: await promptIndexedChoice(
						rl,
						"Choose a free model for HR",
						choices,
						fallbackFreeModel,
					);
		return {
			consoleModel: selected,
			subagentStrategy: "free",
			sharedSubagentModel: selected,
		};
	}
	const custom = await promptRequired(rl, "Custom HR model", recommendedHrBootstrapModel);
	return {
		consoleModel: custom,
		subagentStrategy: "custom",
		sharedSubagentModel: custom,
	};
};

const checkHrBootstrapSelection = async (
	hrRoot: string,
	selection: HrBootstrapModelSelection,
): Promise<HrModelCheckResult> => {
	const model = selection.sharedSubagentModel || selection.consoleModel;
	if (!model) {
		return {
			ok: false,
			selection,
			stage: "syntax",
			message: "Model id cannot be blank.",
		};
	}
	const syntax = validateModelIdentifier(model);
	if (!syntax.ok) {
		return { ok: false, selection, stage: "syntax", message: syntax.message };
	}
	const knownModels = await readHrKnownModelIds(hrRoot);
	const catalog = validateModelAgainstCatalog(model, knownModels);
	if (!catalog.ok) {
		return { ok: false, selection, stage: "catalog", message: catalog.message };
	}
	const availability = await probeOpencodeModelAvailability(model, {
		listModels: listAvailableOpencodeModels,
	});
	if (!availability.available) {
		return {
			ok: false,
			selection,
			stage: availability.reason === "probe_failed" ? "probe_failed" : "availability",
			message: availability.message,
		};
	}
	return { ok: true, selection };
};

const promptValidatedHrModelSelection = async (
	rl: readline.Interface,
	hrRoot: string,
	strategy: "recommended" | "free" | "custom" | "native",
): Promise<HrBootstrapModelSelection> => {
	let selection = await buildHrModelSelection(rl, hrRoot, strategy);
	while (true) {
		const check = await checkHrBootstrapSelection(hrRoot, selection);
		if (check.ok) return check.selection;
		process.stdout.write(`${check.message}\n`);
		if (check.stage === "syntax" && selection.subagentStrategy === "custom") {
			selection = await buildHrModelSelection(rl, hrRoot, "custom");
			continue;
		}
		const action = await promptChoice(
			rl,
			check.stage === "probe_failed"
				? "Model verification failed — continue or choose a fallback"
				: "Choose a fallback",
			(["continue", "free", "native", "custom", "retry recommended"] as const),
			check.stage === "probe_failed" ? "continue" : "free",
		);
		if (action === "continue") return selection;
		selection = await buildHrModelSelection(
			rl,
			hrRoot,
			action === "retry recommended" ? "recommended" : action,
		);
	}
};

const promptHrBootstrapModelSelection = async (
	hrRoot: string,
): Promise<HrBootstrapModelSelection> => {
	const rl = createPromptInterface();
	try {
		process.stdout.write("\nFirst-time HR Office setup\n");
		const resources = await inspectHrBootstrapResources(hrRoot);
		const recommendation = recommendHrBootstrapSelection(resources);
		printHrBootstrapAssessment(resources, recommendation);
		while (true) {
			const action = await promptChoice(
				rl,
				"Apply this recommendation now",
				["accept", "recommended", "free", "native", "custom"] as const,
				"accept",
			);
			const strategy =
				action === "accept" ? recommendation.strategy : action;
			const validated = await promptValidatedHrModelSelection(rl, hrRoot, strategy);
			const finalModel = validated.sharedSubagentModel || validated.consoleModel;
			if (!finalModel) continue;
			const finalSyntax = validateModelIdentifier(finalModel);
			if (finalSyntax.ok) {
				return validated;
			}
		}
	} finally {
		rl.close();
	}
};

const shouldUseInteractivePrompts = () =>
	process.env.OPENCODE_AGENTHUB_FORCE_INTERACTIVE_PROMPTS === "1" ||
	Boolean(process.stdin.isTTY && process.stdout.isTTY);

const applyHrModelSelection = async (
	targetRoot: string,
	selection: HrBootstrapModelSelection,
) => {
	await installHrOfficeHomeWithOptions({
		hrRoot: targetRoot,
		hrModelSelection: selection,
	});
};

const repairHrModelConfigurationIfNeeded = async (targetRoot: string) => {
	const settings = await readAgentHubSettings(targetRoot);
	if (!shouldUseInteractivePrompts()) {
		for (const agentName of hrAgentNames) {
			const model = settings?.agents?.[agentName]?.model;
			if (typeof model !== "string" || model.trim().length === 0) continue;
			const syntax = validateModelIdentifier(model);
			if (!syntax.ok) {
				fail(`HR model configuration needs attention. Agent '${agentName}' model '${model}' is invalid: ${syntax.message}`);
			}
		}
		return;
	}
	const status = await validateHrAgentModelConfiguration(targetRoot, settings);
	if (status.valid) return;
	const rl = createPromptInterface();
	try {
		process.stdout.write("[agenthub] HR model configuration needs attention.\n");
		if (status.message) process.stdout.write(`${status.message}\n`);
		const repair = await promptBoolean(
			rl,
			"Reconfigure HR models now?",
			true,
		);
		if (!repair) {
			fail("Aborted before repairing invalid HR model configuration.");
		}
		const fallback = await promptChoice(
			rl,
			"Choose a fallback",
			["free", "native", "custom", "retry recommended"] as const,
			"free",
		);
		const validated = await promptValidatedHrModelSelection(
			rl,
			targetRoot,
			fallback === "retry recommended" ? "recommended" : fallback,
		);
		const resolved = await resolveHrBootstrapAgentModels({
			targetRoot,
			selection: validated,
		});
		const merged = mergeAgentHubSettingsDefaults(settings || {});
		merged.agents = merged.agents || {};
		for (const agentName of hrAgentNames) {
			const resolvedSelection = resolved.agentModels[agentName];
			merged.agents[agentName] = {
				...(merged.agents[agentName] || {}),
				model: resolvedSelection.model,
				...(resolvedSelection.variant ? { variant: resolvedSelection.variant } : {}),
			};
			if (!resolvedSelection.variant) delete merged.agents[agentName].variant;
		}
		merged.meta = {
			...merged.meta,
			onboarding: {
				...merged.meta?.onboarding,
				modelStrategy: resolved.strategy,
				mode: merged.meta?.onboarding?.mode || "hr-office",
				importedNativeBasics: merged.meta?.onboarding?.importedNativeBasics ?? true,
				importedNativeAgents: merged.meta?.onboarding?.importedNativeAgents ?? true,
				createdAt: merged.meta?.onboarding?.createdAt || new Date().toISOString(),
			},
		};
		await writeAgentHubSettings(targetRoot, merged);
		process.stdout.write("[agenthub] Updated HR model configuration.\n");
	} finally {
		rl.close();
	}
};

const printHrModelOverrideHint = (targetRoot: string) => {
	void targetRoot;
	process.stdout.write(`Tip: change HR models later with '${cliCommand} doctor'.\n`);
};

const countConfiguredHrGithubSources = async (targetRoot: string): Promise<number | null> => {
	try {
		const raw = JSON.parse(
			await readFile(path.join(targetRoot, "hr-config.json"), "utf-8"),
		) as { sources?: unknown; github?: unknown };
		const githubSources: unknown[] = [];

		if (Array.isArray(raw.sources)) {
			githubSources.push(...raw.sources);
		} else if (raw.sources && typeof raw.sources === "object") {
			const nestedGithub = (raw.sources as { github?: unknown }).github;
			if (Array.isArray(nestedGithub)) githubSources.push(...nestedGithub);
		}

		if (Array.isArray(raw.github)) githubSources.push(...raw.github);
		return githubSources.length;
	} catch {
		return null;
	}
};

const countConfiguredHrModelCatalogSources = async (
	targetRoot: string,
): Promise<number | null> => {
	try {
		const raw = JSON.parse(
			await readFile(path.join(targetRoot, "hr-config.json"), "utf-8"),
		) as { sources?: unknown; models?: unknown };
		const modelSources: unknown[] = [];

		if (raw.sources && typeof raw.sources === "object") {
			const nestedModels = (raw.sources as { models?: unknown }).models;
			if (Array.isArray(nestedModels)) modelSources.push(...nestedModels);
		}

		if (Array.isArray(raw.models)) modelSources.push(...raw.models);
		return modelSources.length;
	} catch {
		return null;
	}
};

const syncHrSourceInventoryOnFirstRun = async (targetRoot: string) => {
	const configuredSourceCount = await countConfiguredHrGithubSources(targetRoot);
	const configuredModelSourceCount = await countConfiguredHrModelCatalogSources(targetRoot);
	const sourceParts: string[] = [];
	if (configuredSourceCount && configuredSourceCount > 0) {
		sourceParts.push(
			`${configuredSourceCount} GitHub repo${configuredSourceCount === 1 ? "" : "s"}`,
		);
		}
	if (configuredModelSourceCount && configuredModelSourceCount > 0) {
		sourceParts.push(
			`${configuredModelSourceCount} model catalog${configuredModelSourceCount === 1 ? "" : "s"}`,
		);
	}
	const sourceLabel = sourceParts.length > 0
		? sourceParts.join(" + ")
		: "configured HR sources";
	process.stdout.write(
		`\nStep 3/3 · Sync inventory\nSync the HR sourcer inventory from ${sourceLabel} — this may take a moment, please wait...\n`,
	);

	try {
		const pythonCommand = resolvePythonCommand();
		const scriptPath = path.join(targetRoot, "bin", "sync_sources.py");
		const child = spawn(pythonCommand, [scriptPath], {
			cwd: targetRoot,
			env: {
				...process.env,
				OPENCODE_AGENTHUB_HR_HOME: targetRoot,
			},
			stdio: ["ignore", "pipe", "pipe"],
			...spawnOptions(),
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		const code = await new Promise<number>((resolve, reject) => {
			child.on("error", reject);
			child.on("close", (exitCode) => resolve(exitCode ?? 1));
		});

		const summary = stdout.trim();
		if (code === 0) {
			void summary;
			const repoSummary = configuredSourceCount && configuredSourceCount > 0
				? `${configuredSourceCount} repo${configuredSourceCount === 1 ? "" : "s"}`
				: "configured sources";
			process.stdout.write(`✓ HR sourcer inventory sync complete (${repoSummary}).\n`);
			return;
		}

		process.stderr.write(
			`[agenthub] Warning: first-run HR source sync did not complete. Continue using HR and retry later with '${pythonCommand} ${scriptPath}'.\n`,
		);
		if (stderr.trim()) process.stderr.write(`${stderr.trim()}\n`);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		const pythonCommand = resolvePythonCommand();
		process.stderr.write(
			`[agenthub] Warning: failed to launch first-run HR source sync (${reason}). Retry later with '${pythonCommand} ${path.join(targetRoot, "bin", "sync_sources.py")}'.\n`,
		);
	}
};

const ensureHrOfficeReadyOrBootstrap = async (
	targetRoot = defaultHrHome(),
	options: { syncSourcesOnFirstRun?: boolean } = {},
) => {
	if (await hrHomeInitialized(targetRoot)) return;
	const shouldPrompt = shouldUseInteractivePrompts();
	process.stdout.write("\nHR Office — first-time setup\n\n");
	process.stdout.write(
		"Heads up: a full HR assemble can take about 20–30 minutes because AI may need time to choose and evaluate the souls and skills your agents need.\n\n",
	);
	process.stdout.write("This will:\n");
	process.stdout.write("1. Choose an AI model for HR agents\n");
	process.stdout.write("2. Create the HR Office workspace\n");
	if (options.syncSourcesOnFirstRun ?? true) {
		process.stdout.write("3. Sync the HR sourcer inventory (this may take a little longer)\n\n");
	} else {
		process.stdout.write("3. Skip inventory sync for now because you are assembling only\n\n");
	}
	const hrModelSelection = shouldPrompt
		? await promptHrBootstrapModelSelection(targetRoot)
		: undefined;
	await applyHrModelSelection(targetRoot, hrModelSelection || {});
	process.stdout.write(`\nStep 2/3 · Create workspace\n✓ First run — initialised HR Office at ${targetRoot}\n`);
	printHrModelOverrideHint(targetRoot);
	if (options.syncSourcesOnFirstRun ?? true) {
		await syncHrSourceInventoryOnFirstRun(targetRoot);
	}
	process.stdout.write(`\n✓ HR Office is ready.\n`);
	suppressNextHrRuntimeBanner = true;
};

const isHrRuntimeSelection = (selection?: RuntimeSelection) =>
	selection?.kind === "profile" && selection.profile === "hr";

const normalizeCsv = (value: string): string[] =>
	value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);

const uniqueValues = (values: string[]): string[] => [...new Set(values)];

const normalizeOptional = (value: string): string | undefined => {
	const trimmed = value.trim();
	return trimmed || undefined;
};

const toJsonFile = (root: string, directory: string, name: string): string =>
	path.join(root, directory, `${name}.json`);

const listNamesByExt = async (dirPath: string, ext: string): Promise<string[]> => {
	try {
		const entries = await readdir(dirPath, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(ext))
			.map((entry) => entry.name.slice(0, -ext.length))
			.sort();
	} catch {
		return [];
	}
};

const writeJsonFile = async <T>(filePath: string, payload: T) => {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
};

const workspacePreferencesPath = (workspace: string) =>
	path.join(workspace, ".opencode-agenthub.user.json");

const readJsonIfExists = async <T>(
	filePath: string,
): Promise<T | undefined> => {
	try {
		const content = await readFile(filePath, "utf-8");
		const normalized = content
			.split("\n")
			.filter((line) => !line.trim().startsWith("//"))
			.join("\n");
		return JSON.parse(normalized) as T;
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "EISDIR") return undefined;
		throw e;
	}
};

const loadWorkspacePreferences = async (
	workspace: string,
): Promise<WorkspacePreferences> => {
	const raw =
		(await readJsonIfExists<WorkspacePreferences>(
			workspacePreferencesPath(workspace),
		)) || {};
	return {
		_version: 1,
		...raw,
	};
};

const saveWorkspacePreferences = async (
	workspace: string,
	preferences: WorkspacePreferences,
) => {
	await writeJsonFile(workspacePreferencesPath(workspace), {
		_version: 1,
		...preferences,
	});
};

const updateWorkspacePreferences = async (
	workspace: string,
	updater: (current: WorkspacePreferences) => WorkspacePreferences,
) => {
	const current = await loadWorkspacePreferences(workspace);
	await saveWorkspacePreferences(workspace, updater(current));
};

const readStartDefaultProfile = async (
	targetRoot = defaultAgentHubHome(),
): Promise<string | undefined> => {
	const settings = await readAgentHubSettings(targetRoot);
	return settings?.preferences?.defaultProfile?.trim() || undefined;
};

const setStartDefaultProfile = async (profile: string, targetRoot = defaultAgentHubHome()) => {
	const existingSettings = (await readAgentHubSettings(targetRoot)) || {};
	const mergedSettings = mergeAgentHubSettingsDefaults(existingSettings);
	await writeAgentHubSettings(targetRoot, {
		...mergedSettings,
		preferences: {
			...(mergedSettings.preferences || {}),
			defaultProfile: profile,
		},
	});
};

const resolveStartProfilePreference = async (
	workspace: string,
	targetRoot = defaultAgentHubHome(),
): Promise<{ profile: string; source: "default" | "last" | "fallback" }> => {
	const defaultProfile = await readStartDefaultProfile(targetRoot);
	if (defaultProfile) {
		return { profile: defaultProfile, source: "default" };
	}
	const preferences = await loadWorkspacePreferences(workspace);
	const lastProfile = preferences.start?.lastProfile?.trim();
	if (lastProfile) {
		return { profile: lastProfile, source: "last" };
	}
	return { profile: "auto", source: "fallback" };
};

const resolveHrLastProfilePreference = async (workspace: string): Promise<string | undefined> => {
	const preferences = await loadWorkspacePreferences(workspace);
	return preferences.hr?.lastProfile?.trim() || undefined;
};

const resolveStartLastProfilePreference = async (
	workspace: string,
): Promise<{ profile: string; source: "last" | "fallback" }> => {
	const preferences = await loadWorkspacePreferences(workspace);
	const lastProfile = preferences.start?.lastProfile?.trim();
	if (lastProfile) {
		return { profile: lastProfile, source: "last" };
	}
	return { profile: "auto", source: "fallback" };
};

const noteProfileResolution = (command: "start" | "hr", source: string, profile: string) => {
	if (source === "explicit") return;
	if (command === "start" && source === "default") {
		process.stderr.write(`[agenthub] start -> using personal default profile '${profile}'.\n`);
		return;
	}
	if (source === "last") {
		process.stderr.write(`[agenthub] ${command} -> using last profile '${profile}'.\n`);
		return;
	}
	if (command === "start" && source === "fallback") {
		process.stderr.write(`[agenthub] start -> no default or previous profile found; using 'auto'.\n`);
	}
};

const warnIfWorkspaceRuntimeWillBeReplaced = async (workspace: string, label: string) => {
	const lockPath = path.join(getWorkspaceRuntimeRoot(workspace), "agenthub-lock.json");
	if (!(await readJsonIfExists<Record<string, unknown>>(lockPath))) return;
	process.stderr.write(
		`[agenthub] Replacing the current workspace runtime with ${label}. Plain 'opencode' in this folder will use the new runtime after compose.\n`,
	);
};

const toWorkspaceEnvrc = (workspace: string, configRoot: string): string => {
	const resolvedConfigRoot = path.resolve(configRoot);
	const relativeConfigRoot = path.relative(workspace, resolvedConfigRoot);
	const configRootRef =
		relativeConfigRoot && !relativeConfigRoot.startsWith("..")
			? `$PWD/${relativeConfigRoot}`
			: resolvedConfigRoot;
	return `# Generated by opencode-agenthub. Remove this file to disable auto-activation.
export XDG_CONFIG_HOME="${configRootRef}/xdg"
export OPENCODE_DISABLE_PROJECT_CONFIG=true
export OPENCODE_CONFIG_DIR="${configRootRef}"
`;
};

const maybeConfigureEnvrc = async (workspace: string, configRoot: string) => {
	if (!shouldOfferEnvrc()) return;
	if (!process.stdin.isTTY || !process.stdout.isTTY) return;
	const preferences = await loadWorkspacePreferences(workspace);
	const envrcPath = path.join(workspace, ".envrc");
	const envrcExists = await stat(envrcPath)
		.then((s) => s.isFile() || s.isFIFO())
		.catch((e) => (e.code === "ENOENT" ? false : Promise.reject(e)));
	if (envrcExists) {
		if (!preferences.envrc?.enabled || !preferences.envrc?.prompted) {
			await saveWorkspacePreferences(workspace, {
				...preferences,
				envrc: { prompted: true, enabled: true },
			});
		}
		return;
	}
	if (preferences.envrc?.prompted) return;

	const rl = createPromptInterface();
	try {
		const enableEnvrc = await promptBoolean(
			rl,
			"Enable Agent Hub auto-activation with .envrc so plain 'opencode' works here?",
			false,
		);
		if (enableEnvrc) {
			await writeFile(
				envrcPath,
				toWorkspaceEnvrc(workspace, configRoot),
				"utf-8",
			);
			process.stdout.write(
				`Wrote ${envrcPath}. Run 'direnv allow' in this workspace to enable plain 'opencode'.\n`,
			);
		}
		await saveWorkspacePreferences(workspace, {
			...preferences,
			envrc: { prompted: true, enabled: enableEnvrc },
		});
	} finally {
		rl.close();
	}
};

const createPromptInterface = () => {
	const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
	const terminal = interactive && shouldUseReadlineTerminal();
	if (terminal) {
		const resetSequence = interactivePromptResetSequence();
		if (resetSequence) process.stdout.write(resetSequence);
	}
	return readline.createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal,
	});
};

const scriptedPromptAnswers = (() => {
	const raw = process.env.OPENCODE_AGENTHUB_SCRIPTED_ANSWERS;
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed)
			? parsed.map((value) => (typeof value === "string" ? value : String(value)))
			: undefined;
	} catch {
		return raw.split("\n");
	}
})();

let scriptedPromptIndex = 0;

const askPrompt = async (rl: readline.Interface, question: string): Promise<string> => {
	if (scriptedPromptAnswers && scriptedPromptIndex < scriptedPromptAnswers.length) {
		const answer = scriptedPromptAnswers[scriptedPromptIndex++] || "";
		const sanitized = stripTerminalControlInput(answer);
		process.stdout.write(`${question}${sanitized}\n`);
		return sanitized;
	}
	return stripTerminalControlInput(await rl.question(question));
};

const promptRequired = async (
	rl: readline.Interface,
	question: string,
	defaultValue?: string,
): Promise<string> => {
	while (true) {
		const answer = await askPrompt(
			rl,
			defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `,
		);
		const value = normalizeOptional(answer) || defaultValue;
		if (value) return value;
		process.stdout.write("This field is required.\n");
	}
};

const promptOptional = async (
	rl: readline.Interface,
	question: string,
	defaultValue?: string,
): Promise<string | undefined> => {
	const answer = await askPrompt(
		rl,
		defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `,
	);
	return normalizeOptional(answer) || defaultValue;
};

const promptCsv = async (
	rl: readline.Interface,
	question: string,
	defaultValues: string[] = [],
): Promise<string[]> => {
	const defaultValue = defaultValues.join(", ");
	const answer = await askPrompt(
		rl,
		defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `,
	);
	return normalizeCsv(answer || defaultValue);
};

const promptBoolean = async (
	rl: readline.Interface,
	question: string,
	defaultValue: boolean,
): Promise<boolean> => {
	const suffix = defaultValue ? "[Y/n]" : "[y/N]";
	while (true) {
		const answer = (await askPrompt(rl, `${question} ${suffix}: `))
			.trim()
			.toLowerCase();
		if (!answer) return defaultValue;
		if (answer === "y" || answer === "yes") return true;
		if (answer === "n" || answer === "no") return false;
		process.stdout.write("Please answer y or n.\n");
	}
};

const promptChoice = async <T extends string>(
	rl: readline.Interface,
	question: string,
	choices: readonly T[],
	defaultValue: T,
): Promise<T> => {
	const label = `${question} [${choices.join("/")}] (${defaultValue})`;
	while (true) {
		const answer = (await askPrompt(rl, `${label}: `)).trim().toLowerCase();
		if (!answer) return defaultValue;
		const match = choices.find((choice) => choice === answer);
		if (match) return match;
		process.stdout.write(`Choose one of: ${choices.join(", ")}\n`);
	}
};

const promptIndexedChoice = async (
	rl: readline.Interface,
	question: string,
	choices: string[],
	defaultValue: string,
): Promise<string> => {
	choices.forEach((choice, index) => {
		process.stdout.write(`  ${index + 1}. ${choice}\n`);
	});
	const defaultIndex = Math.max(choices.indexOf(defaultValue), 0) + 1;
	while (true) {
		const answer = (await askPrompt(
			rl,
			`${question} [1-${choices.length}] (${defaultIndex}): `,
		))
			.trim()
			.toLowerCase();
		if (!answer) return defaultValue;
		const numeric = Number(answer);
		if (Number.isInteger(numeric) && numeric >= 1 && numeric <= choices.length) {
			return choices[numeric - 1] || defaultValue;
		}
		const exactMatch = choices.find((choice) => choice.toLowerCase() === answer);
		if (exactMatch) return exactMatch;
		process.stdout.write("Choose a listed number or exact model id.\n");
	}
};

const listOpencodeFreeModels = async (): Promise<string[]> =>
	new Promise((resolve) => {
		const child = spawn("opencode", ["models", "opencode"], {
			stdio: ["ignore", "pipe", "ignore"],
			...spawnOptions(),
		});
		let stdout = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.on("error", () => resolve([]));
		child.on("close", () => {
			const models = stdout
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.startsWith("opencode/") && line.includes("free"));
			resolve([...new Set(models)].sort());
		});
	});

const promptOptionalCsvSelection = async (
	rl: readline.Interface,
	question: string,
	available: string[],
	defaultValues: string[] = [],
): Promise<string[]> => {
	const include = await promptBoolean(rl, question, false);
	if (!include) return [];
	if (available.length > 0) {
		process.stdout.write(`Available: ${available.join(", ")}\n`);
	}
	return promptCsv(rl, "Enter names (comma-separated)", defaultValues);
};

const listSkillNames = async (skillsDir: string): Promise<string[]> => {
	try {
		const entries = await readdir(skillsDir, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
};

const assertNameNotReserved = async (
	kind: BuiltInAssetKind,
	name: string,
	reservedOk: boolean,
) => {
	if (reservedOk) return;
	const builtIns = await listBuiltInAssetNames(kind);
	if (!builtIns.has(name)) return;
	fail(
		`'${name}' is a reserved built-in ${kind} name. Use a different name or pass '--reserved-ok' to override.`,
	);
};

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

const createSoulDefinition = async (
	root: string,
	name: string,
	reservedOk = false,
): Promise<string> => {
	await assertNameNotReserved("soul", name, reservedOk);
	const filePath = path.join(root, "souls", `${name}.md`);
	const rl = createPromptInterface();
	try {
		await maybeOverwrite(rl, filePath);
		const content = [
			`# ${name}`,
			"",
			"## Description",
			"Describe this soul's purpose and when to use it.",
			"",
			"## Behavior",
			"- Primary goals",
			"- Constraints",
			"- Expected output style",
			"",
		].join("\n");
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, content, "utf-8");
		return filePath;
	} finally {
		rl.close();
	}
};

const createInstructionDefinition = async (
	root: string,
	name: string,
	reservedOk = false,
): Promise<string> => {
	await assertNameNotReserved("instruction", name, reservedOk);
	const filePath = path.join(root, "instructions", `${name}.md`);
	const rl = createPromptInterface();
	try {
		await maybeOverwrite(rl, filePath);
		const content = [
			`# ${name}`,
			"",
			"## Purpose",
			"State the instruction this file adds to an agent.",
			"",
			"## Rules",
			"- Add concrete rules here",
			"",
		].join("\n");
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, content, "utf-8");
		return filePath;
	} finally {
		rl.close();
	}
};

const createSkillDefinition = async (
	root: string,
	name: string,
	reservedOk = false,
): Promise<string> => {
	await assertNameNotReserved("skill", name, reservedOk);
	const filePath = path.join(root, "skills", name, "SKILL.md");
	const rl = createPromptInterface();
	try {
		await maybeOverwrite(rl, filePath);
		const content = [
			`# ${name}`,
			"",
			"## When to use",
			"Describe when this skill should be loaded.",
			"",
			"## Instructions",
			"- Add the concrete workflow here",
			"",
		].join("\n");
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, content, "utf-8");
		return filePath;
	} finally {
		rl.close();
	}
};

const readProfileDefinition = async (
	root: string,
	name: string,
): Promise<ProfileSpec | undefined> =>
	readJsonIfExists<ProfileSpec>(path.join(root, "profiles", `${name}.json`));

const promptRecord = async (
	rl: readline.Interface,
	question: string,
): Promise<Record<string, string> | undefined> => {
	const answer = await askPrompt(
		rl,
		`${question} (comma-separated key=value, blank to skip): `,
	);
	const entries = normalizeCsv(answer);
	if (entries.length === 0) return undefined;

	const record: Record<string, string> = {};
	for (const entry of entries) {
		const separator = entry.indexOf("=");
		if (separator === -1) {
			fail(`Invalid entry '${entry}'. Use key=value format.`);
		}
		const key = entry.slice(0, separator).trim();
		const value = entry.slice(separator + 1).trim();
		if (!key || !value) {
			fail(`Invalid entry '${entry}'. Use key=value format.`);
		}
		record[key] = value;
	}
	return Object.keys(record).length > 0 ? record : undefined;
};

const maybeOverwrite = async (
	rl: readline.Interface,
	filePath: string,
): Promise<void> => {
	try {
		await readFile(filePath, "utf-8");
	} catch {
		return;
	}
	const overwrite = await promptBoolean(
		rl,
		`${path.basename(filePath)} already exists. Overwrite it?`,
		false,
	);
	if (!overwrite) {
		fail(`Aborted without changing ${filePath}`);
	}
};

const createProfileDefinition = async (
	root: string,
	name: string,
	options: ParsedArgs["profileCreateOptions"] = { addBundles: [], reservedOk: false },
): Promise<string> => {
	await assertNameNotReserved("profile", name, options.reservedOk);
	const filePath = toJsonFile(root, "profiles", name);
	const availableBundles = await listNamesByExt(path.join(root, "bundles"), ".json");
	const addCapabilities = listProfileAddCapabilityNames();
	const seededProfile = options.fromProfile
		? await readProfileDefinition(root, options.fromProfile)
		: undefined;
	if (options.fromProfile && !seededProfile) {
		const availableProfiles = await listNamesByExt(path.join(root, "profiles"), ".json");
		fail(
			`Profile '${options.fromProfile}' was not found. Available profiles: ${availableProfiles.join(", ") || "(none)"}`,
		);
	}
	const expandedAdds = expandProfileAddSelections(options.addBundles.filter(Boolean));
	const seededBundles = uniqueValues([
		...(seededProfile?.bundles || []),
		...expandedAdds,
	]);
	const invalidBundles = seededBundles.filter((bundle) => !availableBundles.includes(bundle));
	if (invalidBundles.length > 0) {
		fail(
			`Unknown bundle(s): ${invalidBundles.join(", ")}. Available bundles: ${availableBundles.join(", ") || "(none)"}. Capability shorthands: ${addCapabilities.join(", ") || "(none)"}`,
		);
	}
	const rl = createPromptInterface();
	try {
		await maybeOverwrite(rl, filePath);
		if (availableBundles.length > 0) {
			process.stdout.write(
				`Available bundles: ${availableBundles.join(", ")}\n`,
			);
		}
		if (addCapabilities.length > 0) {
			process.stdout.write(
				`Capability shorthands for --add: ${addCapabilities.join(", ")}\n`,
			);
		}
		const description = await promptOptional(rl, "Profile description");
		const bundles = await promptCsv(
			rl,
			"Bundles to include",
			seededBundles,
		);
		const defaultAgent = await promptOptional(
			rl,
			"Default agent (leave blank to let runtime decide)",
		);
		const plugins = await promptCsv(
			rl,
			"Plugins to enable (comma-separated package names or paths)",
			seededProfile?.plugins || [],
		);

		const payload: ProfileSpec = {
			name,
			bundles,
			plugins,
		};
		if (description) payload.description = description;
		if (defaultAgent) payload.defaultAgent = defaultAgent;

		await writeJsonFile(filePath, payload);
		return filePath;
	} finally {
		rl.close();
	}
};

const createBundleDefinition = async (
	root: string,
	name: string,
	reservedOk = false,
): Promise<string> => {
	await assertNameNotReserved("bundle", name, reservedOk);
	const filePath = toJsonFile(root, "bundles", name);
	const availableSouls = await listNamesByExt(path.join(root, "souls"), ".md");
	const availableInstructions = await listNamesByExt(
		path.join(root, "instructions"),
		".md",
	);
	const availableSkills = await listSkillNames(path.join(root, "skills"));
	const availableMcp = await listNamesByExt(path.join(root, "mcp"), ".json");
	const rl = createPromptInterface();
	try {
		await maybeOverwrite(rl, filePath);
		if (availableSouls.length > 0) {
			process.stdout.write(`Available souls: ${availableSouls.join(", ")}\n`);
		}
		if (availableInstructions.length > 0) {
			process.stdout.write(`Available instructions: ${availableInstructions.join(", ")}\n`);
		}
		if (availableSkills.length > 0) {
			process.stdout.write(`Available skills: ${availableSkills.join(", ")}\n`);
		}
		const runtime = await promptChoice(
			rl,
			"Runtime",
			["native", "omo"],
			"native",
		);
		const readOnly =
			runtime === "native"
				? await promptBoolean(
						rl,
						"Read-only agent? (Y = plan-like, N = build-like)",
						true,
					)
				: false;
		const soul = await promptRequired(rl, "Soul name", availableSouls[0]);
		const instructions = await promptOptionalCsvSelection(
			rl,
			"Attach instructions from instructions/?",
			availableInstructions,
		);
		const skills = await promptOptionalCsvSelection(
			rl,
			"Attach skills from skills/?",
			availableSkills,
		);
		const mcp = await promptOptionalCsvSelection(
			rl,
			"Attach custom MCP tools? (basic opencode tools stay available)",
			availableMcp,
		);
		const guards = await promptCsv(rl, "Extra guards (comma-separated)");
		const categories =
			runtime === "omo"
				? await promptRecord(rl, "Category model mapping")
				: undefined;
		const agentName = await promptRequired(rl, "Agent name", name);
		const agentMode = await promptChoice(
			rl,
			"Agent mode",
			["primary", "subagent"],
			"primary",
		);
		const hidden = await promptBoolean(
			rl,
			"Hide this agent from normal listings?",
			false,
		);
		const model = await promptRequired(rl, "Agent model");
		const description = await promptOptional(rl, "Agent description");

		const payload: BundleSpec = {
			name,
			runtime,
			soul,
			...(instructions.length > 0 ? { instructions } : {}),
			skills,
			agent: {
				name: agentName,
				mode: agentMode,
				hidden,
				model,
			},
		};
		if (readOnly) {
			payload.guards = uniqueValues([...(payload.guards || []), "no_task"]);
		}
		if (mcp.length > 0) payload.mcp = mcp;
		if (guards.length > 0) {
			payload.guards = uniqueValues([...(payload.guards || []), ...guards]);
		}
		if (description) payload.agent.description = description;
		if (categories && Object.keys(categories).length > 0) {
			payload.categories = categories;
			const enableSpawn = await promptBoolean(
				rl,
				"Generate category-family spawn config from those categories?",
				true,
			);
			if (enableSpawn) {
				payload.spawn = {
					strategy: "category-family",
					source: "categories",
					shared: {
						soul,
						skills,
					},
				};
			}
		}

		await writeJsonFile(filePath, payload);
		return filePath;
	} finally {
		rl.close();
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
			)
			: composeSelection.kind === "bundle"
				? await createBundleDefinition(
					agentHubHome,
					composeSelection.name,
					parsed.profileCreateOptions.reservedOk,
				)
				: composeSelection.kind === "soul"
					? await createSoulDefinition(
						agentHubHome,
						composeSelection.name,
						parsed.profileCreateOptions.reservedOk,
					)
					: composeSelection.kind === "skill"
						? await createSkillDefinition(
							agentHubHome,
							composeSelection.name,
							parsed.profileCreateOptions.reservedOk,
						)
						: await createInstructionDefinition(
							agentHubHome,
							composeSelection.name,
							parsed.profileCreateOptions.reservedOk,
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
	await ensureHrOfficeReadyOrBootstrap(resolveSelectedHomeRoot(parsed), {
		syncSourcesOnFirstRun: !parsed.assembleOnly,
	});
	await repairHrModelConfigurationIfNeeded(resolveSelectedHomeRoot(parsed) || defaultHrHome());
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
