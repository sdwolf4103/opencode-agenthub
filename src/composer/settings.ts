import { readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
	PlanDetectionConfig,
	WorkflowInjectionAuthoringConfig,
	WorkflowInjectionConfig,
	WorkflowInjectionModeConfig,
	WorkflowInjectionSourceConfig,
	WorkflowInjectionTrigger,
} from "../types.js";
import { normalizeModelSelection, pickModelSelection } from "./model-utils.js";
import { buildBuiltinVersionManifest } from "./builtin-assets.js";
import { getDefaultProfilePlugins } from "./defaults.js";
import { readPackageVersion } from "./package-version.js";
import { resolveHomeConfigRoot } from "./platform.js";

type InstallMode = "minimal" | "auto" | "hr-office";

type BundleModelSpec = {
	name: string;
	agent?: {
		name?: string;
		model?: string;
		variant?: string;
	};
};

// Re-export the main settings type from types.ts
export type { AgentHubSettings } from "../types.js";

// Internal types for backward compatibility
type AgentSettings = {
	model?: string;
	variant?: string;
	permission?: Record<string, unknown>;
	guards?: string[];
};

export const hrPrimaryAgentName = "hr";
export const recommendedHrBootstrapModel = "openai/gpt-5.4-mini";
export const recommendedHrBootstrapVariant = "high";
export const hrSubagentNames = [
	"hr-planner",
	"hr-sourcer",
	"hr-evaluator",
	"hr-cto",
	"hr-adapter",
	"hr-verifier",
] as const;
export const hrAgentNames = [hrPrimaryAgentName, ...hrSubagentNames] as const;

export type HrPersistedModelStrategy = "native" | "recommended" | "free" | "custom";
export type HrSubagentModelStrategy = "auto" | HrPersistedModelStrategy;

export type HrBootstrapModelSelection = {
	consoleModel?: string;
	subagentStrategy?: HrSubagentModelStrategy;
	sharedSubagentModel?: string;
};

export type ResolvedHrBootstrapModels = {
	agentModels: Record<
		(typeof hrAgentNames)[number],
		{
			model: string;
			variant?: string;
		}
	>;
	strategy: HrPersistedModelStrategy;
};

type NativeOpenCodeConfig = {
	provider?: Record<string, unknown>;
	model?: string;
	small_model?: string;
	plugin?: unknown;
	agent?: Record<string, Record<string, unknown>>;
};

const readJson = async <T>(filePath: string): Promise<T> => {
	const content = await readFile(filePath, "utf-8");
	return JSON.parse(content) as T;
};

const titleCaseMode = (modeId: string) =>
	modeId.length > 0 ? `${modeId[0]?.toUpperCase() ?? ""}${modeId.slice(1)}` : modeId;

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const workflowClassificationTrigger = (label: string): WorkflowInjectionTrigger => ({
	type: "regex",
	value: `(?:^|\\n)\\s*(?:#{1,6}\\s*)?(?:\\*\\*)?Classification(?:\\s*:|:)(?:\\*\\*)?\\s*(?:\\[\\s*${escapeRegex(label)}\\s*\\]|${escapeRegex(label)})(?=[\\s:;,.!?-]|$)`,
	confidence: "high",
});

const workflowIDetectTriggers = (label: string): WorkflowInjectionTrigger[] => [
	{
		type: "regex",
		value: `(?:^|\\n)\\s*I\\s+detect\\s+(?:\\[\\s*${escapeRegex(label)}\\s*\\]|${escapeRegex(label)})(?=[\\s:;,.!?-]|$)`,
		confidence: "medium",
	},
];

const joinWorkflowLines = (...groups: Array<string[] | undefined>) =>
	groups
		.flatMap((group) => group ?? [])
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.join("\n");

const hasRuleArray = (
	config: WorkflowInjectionSourceConfig,
): config is WorkflowInjectionConfig => Array.isArray((config as WorkflowInjectionConfig).rules);

const normalizeWorkflowMode = (
	modeId: string,
	mode: WorkflowInjectionModeConfig,
	defaults: WorkflowInjectionAuthoringConfig["defaults"],
) => {
	const label = mode.label?.trim() || titleCaseMode(modeId);
	const useIDetectFallback = defaults?.useIDetectFallback ?? true;
	const triggers =
		mode.triggers && mode.triggers.length > 0
			? mode.triggers
			: [
					workflowClassificationTrigger(label),
					...(useIDetectFallback ? workflowIDetectTriggers(label) : []),
				];

	return {
		id: modeId,
		description: mode.description,
		enabled: mode.enabled,
		match: mode.match ?? defaults?.match ?? "any",
		triggers,
		reminderTemplate: joinWorkflowLines(
			mode.reminderPrefix,
			defaults?.reminderPrefix,
			mode.reminder,
			defaults?.reminderSuffix,
			mode.reminderSuffix,
		),
		queueVisibleReminderTemplate: mode.queueVisibleReminderTemplate,
	};
};

const normalizeWorkflowInjectionConfig = (
	config: WorkflowInjectionSourceConfig,
): WorkflowInjectionConfig => {
	if (hasRuleArray(config)) {
		return config;
	}

	const entries = Object.entries(config.modes ?? {}).filter(
		([modeId]) => modeId.trim().length > 0,
	);
	if (entries.length === 0) {
		throw new Error("Workflow injection authoring config must define at least one mode.");
	}

	return {
		enabled: config.enabled,
		bundles: config.bundles,
		debugLog: config.debugLog,
		queueVisibleReminder: config.queueVisibleReminder,
		queueVisibleReminderTemplate: config.queueVisibleReminderTemplate,
		scanLineLimit: config.scanLineLimit,
		scanCharLimit: config.scanCharLimit,
		maxInjectionsPerSession: config.maxInjectionsPerSession,
		rules: entries.map(([modeId, mode]) =>
			normalizeWorkflowMode(modeId, mode, config.defaults),
		),
	};
};

const formatNativeConfigError = (filePath: string, error: unknown) => {
	const reason = error instanceof Error ? error.message : String(error);
	return [
		`Failed to load native OpenCode config: ${filePath}`,
		`Reason: ${reason}`,
		"What you can do:",
		"  1. Fix the JSON or file permissions in that config file",
		"  2. Run with 'agenthub setup minimal' to keep setup minimal",
		"  3. Or set OPENCODE_AGENTHUB_NATIVE_CONFIG to another valid config",
	].join("\n");
};

export const settingsPathForRoot = (targetRoot: string) =>
	path.join(targetRoot, "settings.json");

export const workflowInjectionPathForRoot = (
	targetRoot: string,
	name = "auto-mode",
) => path.join(targetRoot, "workflow", `${name}.json`);

export const readAgentHubSettings = async (
	targetRoot: string,
): Promise<AgentHubSettings | null> => {
	try {
		return await readJson<AgentHubSettings>(settingsPathForRoot(targetRoot));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw error;
	}
};

export const writeAgentHubSettings = async (
	targetRoot: string,
	settings: AgentHubSettings,
) => {
	await writeFile(
		settingsPathForRoot(targetRoot),
		`${JSON.stringify(settings, null, 2)}\n`,
		"utf-8",
	);
};

export const readWorkflowInjectionConfig = async (
	targetRoot: string,
	name = "auto-mode",
): Promise<WorkflowInjectionConfig | null> => {
	try {
		const sourceConfig = await readJson<WorkflowInjectionSourceConfig>(
			workflowInjectionPathForRoot(targetRoot, name),
		);
		return normalizeWorkflowInjectionConfig(sourceConfig);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw error;
	}
};

const defaultOpenCodeConfigPath = path.join(
	resolveHomeConfigRoot(os.homedir(), "opencode"),
	"opencode.json",
);

export const defaultPlanDetectionSettings = (): PlanDetectionConfig => ({
	enabled: true,
	queueVisibleReminder: true,
	queueVisibleReminderTemplate: "[agenthub] Plan reminder injected for this turn.",
});

export const mergeAgentHubSettingsDefaults = (
	settings: AgentHubSettings,
): AgentHubSettings => ({
	...settings,
	preferences: settings.preferences ? { ...settings.preferences } : undefined,
	meta: {
		...settings.meta,
		builtinVersion:
			settings.meta?.builtinVersion && Object.keys(settings.meta.builtinVersion).length > 0
				? settings.meta.builtinVersion
				: undefined,
	},
	planDetection: settings.planDetection
		? { ...defaultPlanDetectionSettings(), ...settings.planDetection }
		: defaultPlanDetectionSettings(),
});

export { getDefaultProfilePlugins };

export const nativeOpenCodeConfigPath = () =>
	process.env.OPENCODE_AGENTHUB_NATIVE_CONFIG || defaultOpenCodeConfigPath;

export const loadNativeOpenCodeConfig =
	async (): Promise<NativeOpenCodeConfig | null> => {
		const filePath = nativeOpenCodeConfigPath();
		try {
			return await readJson<NativeOpenCodeConfig>(filePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return null;
			}
			throw new Error(formatNativeConfigError(filePath, error), {
				cause: error,
			});
		}
	};

export const readNativePluginEntries = async (): Promise<string[]> => {
	const config = await loadNativeOpenCodeConfig();
	return Array.isArray(config?.plugin)
		? config.plugin.filter(
				(entry): entry is string =>
					typeof entry === "string" && entry.trim().length > 0,
			)
		: [];
};

export const loadNativeOpenCodePreferences =
	async (): Promise<NativeOpenCodeConfig | null> => {
		try {
			const config = await loadNativeOpenCodeConfig();
			if (!config) return null;
			const safe: NativeOpenCodeConfig = {};
			if (config.provider && typeof config.provider === "object") {
				safe.provider = config.provider;
			}
			if (typeof config.model === "string" && config.model.trim()) {
				safe.model = config.model;
			}
			if (typeof config.small_model === "string" && config.small_model.trim()) {
				safe.small_model = config.small_model;
			}
			return Object.keys(safe).length > 0 ? safe : null;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return null;
			}
			throw error;
		}
	};

export const readNativeAgentOverrides = async (): Promise<
	Record<string, AgentSettings>
> => {
	const config = await loadNativeOpenCodeConfig();
	if (!config?.agent || typeof config.agent !== "object") return {};

	return Object.fromEntries(
		Object.entries(config.agent)
			.filter(([name, agent]) => {
				if (!name.trim() || !agent || typeof agent !== "object") return false;
				return (
					(typeof agent.model === "string" && agent.model.trim().length > 0) ||
					(typeof agent.variant === "string" && agent.variant.trim().length > 0) ||
					(agent.permission && typeof agent.permission === "object")
				);
			})
			.map(([name, agent]) => [
				name,
				{
					...normalizeModelSelection(
						typeof agent.model === "string" ? agent.model : undefined,
						typeof agent.variant === "string" ? agent.variant : undefined,
					),
					...(agent.permission && typeof agent.permission === "object"
						? { permission: agent.permission }
						: {}),
				},
			]),
	);
};

const modePrimaryAgentName = (mode: InstallMode): string | undefined => {
	if (mode === "auto") return "auto";
	if (mode === "hr-office") return "hr";
	return undefined;
};

const readInstalledBundleModels = async (
	targetRoot: string,
): Promise<Record<string, AgentSettings & { model: string }>> => {
	const bundlesDir = path.join(targetRoot, "bundles");
	try {
		const entries = await readdir(bundlesDir, { withFileTypes: true });
		const bundleFiles = entries.filter(
			(entry) => entry.isFile() && path.extname(entry.name) === ".json",
		);
		const specs = await Promise.all(
			bundleFiles.map((entry) =>
				readJson<BundleModelSpec>(path.join(bundlesDir, entry.name)),
			),
		);
		return Object.fromEntries(
			specs
				.filter(
					(spec) =>
						typeof spec.agent?.name === "string" &&
						typeof spec.agent?.model === "string" &&
						spec.agent.name.trim() &&
						spec.agent.model.trim(),
				)
				.map((spec) => {
					const agent = spec.agent;
					if (!agent)
						throw new Error(`Missing agent config for bundle ${spec.name}`);
					const modelSelection = normalizeModelSelection(agent.model, agent.variant);
					return [
						agent.name,
						{
							...(modelSelection.model ? { model: modelSelection.model } : {}),
							...(modelSelection.variant ? { variant: modelSelection.variant } : {}),
						},
					];
				}),
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
};

const normalizeConfiguredModel = (value?: string | null) => {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
};

const fallbackInstalledModel = (
	installedModels: Record<string, AgentSettings & { model: string }>,
	nativeModel?: string,
) =>
	installedModels[hrPrimaryAgentName]?.model ||
	installedModels.auto?.model ||
	Object.values(installedModels)[0]?.model ||
	nativeModel;

export const resolveHrBootstrapAgentModels = async ({
	targetRoot,
	selection,
}: {
	targetRoot: string;
	selection?: HrBootstrapModelSelection;
}): Promise<ResolvedHrBootstrapModels> => {
	const imported = await loadNativeOpenCodePreferences();
	const installedModels = await readInstalledBundleModels(targetRoot);
	const nativeModel = normalizeModelSelection(imported?.model);
	const fallbackModel =
		recommendedHrBootstrapModel || fallbackInstalledModel(installedModels, nativeModel.model);
	if (!fallbackModel) {
		throw new Error(`Unable to resolve an initial HR model for ${targetRoot}`);
	}

	const requestedStrategy = selection?.subagentStrategy || "auto";
	const effectiveStrategy: HrPersistedModelStrategy =
		requestedStrategy === "auto"
			? "recommended"
			: requestedStrategy === "native" && !nativeModel
				? "recommended"
				: requestedStrategy;

	const explicitConsoleModel = normalizeModelSelection(selection?.consoleModel);
	const explicitSharedModel = normalizeModelSelection(selection?.sharedSubagentModel);
	const recommendedModel = {
		model: recommendedHrBootstrapModel,
		variant: recommendedHrBootstrapVariant,
	};
	const fallbackSelection = { model: fallbackModel };
	const sharedAgentModel = pickModelSelection(
		explicitSharedModel,
		explicitConsoleModel,
		effectiveStrategy === "native" ? nativeModel : undefined,
		recommendedModel,
		fallbackSelection,
	);
	const consoleModel = pickModelSelection(explicitConsoleModel, sharedAgentModel);

	const subagentModels = Object.fromEntries(
		hrSubagentNames.map((agentName) => [
			agentName,
			effectiveStrategy === "custom" ||
			effectiveStrategy === "free" ||
			effectiveStrategy === "recommended"
				? sharedAgentModel
				: effectiveStrategy === "native"
					? pickModelSelection(nativeModel, sharedAgentModel)
					: sharedAgentModel,
		]),
	) as Record<(typeof hrSubagentNames)[number], { model: string; variant?: string }>;

	return {
		agentModels: {
			[hrPrimaryAgentName]: consoleModel,
			...subagentModels,
		},
		strategy: effectiveStrategy,
	};
};

export const buildInitialAgentHubSettings = async ({
	targetRoot,
	mode,
	hrResolvedModels,
}: {
	targetRoot: string;
	mode: InstallMode;
	hrResolvedModels?: ResolvedHrBootstrapModels;
}): Promise<AgentHubSettings> => {
	const shouldImportNativeBasics = mode !== "minimal";
	const shouldImportNativeAgents = mode !== "minimal";

	const imported = shouldImportNativeBasics
		? await loadNativeOpenCodePreferences()
		: null;
	const installedModels = await readInstalledBundleModels(targetRoot);
	const nativeAgentOverrides = shouldImportNativeAgents
		? await readNativeAgentOverrides()
		: {};
	const primaryAgentName = modePrimaryAgentName(mode);
	const fallbackModel =
		(primaryAgentName && installedModels[primaryAgentName]?.model) ||
		installedModels.auto?.model ||
		Object.values(installedModels)[0]?.model;
	const sharedModel = imported?.model || fallbackModel;
	const agentOverrides = { ...nativeAgentOverrides };
	if (mode === "hr-office") {
		const resolvedHrModels =
			hrResolvedModels ||
			(await resolveHrBootstrapAgentModels({
				targetRoot,
			}));
		for (const [agentName, modelSelection] of Object.entries(resolvedHrModels.agentModels)) {
			agentOverrides[agentName] = {
				...(agentOverrides[agentName] || {}),
				model: modelSelection.model,
				...(modelSelection.variant ? { variant: modelSelection.variant } : {}),
			};
		}
	}

	const guardDefinitions: NonNullable<AgentHubSettings["guards"]> = {
		read_only: {
			description: "Read-only access - no file modifications",
			permission: {
				edit: "deny",
				write: "deny",
				bash: "deny",
			},
		},
		no_subagent: {
			description: "Legacy alias for no_task",
			blockedTools: ["task"],
			permission: {
				task: { "*": "deny" },
			},
		},
		no_task: {
			description: "Block task tool",
			blockedTools: ["task"],
			permission: {
				task: { "*": "deny" },
			},
		},
		no_omo: {
			description:
				"Block OMO (Oh-My-OpenCode) multi-agent calls - for native agents in OMO profiles",
			blockedTools: ["call_omo_agent"],
			permission: {
				call_omo_agent: "deny",
			},
		},
	};

	const settings: AgentHubSettings = {
		...(imported?.provider ||
		imported?.model ||
		imported?.small_model ||
		sharedModel
			? {
					opencode: {
						...(imported?.provider ? { provider: imported.provider } : {}),
						...(sharedModel ? { model: sharedModel } : {}),
						...(imported?.small_model
							? { small_model: imported.small_model }
							: {}),
					},
				}
			: {}),
		agents: agentOverrides,
		guards: guardDefinitions,
		planDetection: defaultPlanDetectionSettings(),
		meta: {
			onboarding: {
				mode,
				...(mode === "hr-office" && hrResolvedModels
					? { modelStrategy: hrResolvedModels.strategy }
					: {}),
				importedNativeBasics: shouldImportNativeBasics,
				importedNativeAgents: shouldImportNativeAgents,
				createdAt: new Date().toISOString(),
			},
			builtinVersion: buildBuiltinVersionManifest(mode, readPackageVersion()),
		},
	};

	return settings;
};
