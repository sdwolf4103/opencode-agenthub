import { existsSync } from "node:fs";
import {
	lstat,
	mkdir,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	AgentRuntimeInfo,
	GuardRegistry,
	GuardResolutionError,
	PlanDetectionConfig,
	ResolvedGuard,
	RuntimeConfig,
} from "../types.js";
import {
	normalizeModelSelection,
	pickModelSelection,
} from "./model-utils.js";
import {
	loadNativeOpenCodeConfig,
	readAgentHubSettings,
	readNativePluginEntries,
	readWorkflowInjectionConfig,
} from "./settings.js";
import { readPackageVersion } from "./package-version.js";
import {
	generateRunCmd,
	generateRunScript,
	resolveHomeConfigRoot,
	symlinkType,
} from "./platform.js";
import { defaultHrHome } from "./bootstrap.js";

type Runtime = "native" | "omo";

type AgentConfig = {
	name?: string;
	mode?: "primary" | "subagent";
	hidden?: boolean;
	disable?: boolean;
	model?: string;
	variant?: string;
	description?: string;
	skills?: string[];
	prompt?: string;
	tools?: Record<string, unknown>;
	permission?: Record<string, unknown>;
	[key: string]: unknown;
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

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

const deepMergeRecords = (
	base: Record<string, unknown>,
	override: Record<string, unknown>,
): Record<string, unknown> => {
	const result: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const existing = result[key];
		result[key] =
			isPlainObject(existing) && isPlainObject(value)
				? deepMergeRecords(existing, value)
				: value;
	}
	return result;
};

type RawBundleSpec = Omit<BundleSpec, "soul"> & {
	soul?: string;
	prompt?: string;
};

type NativeAgentPolicy = "inherit" | "team-only" | "override";

type ProfileSpec = {
	name: string;
	description?: string;
	bundles: string[];
	defaultAgent?: string;
	plugins: string[];
	nativeAgentPolicy?: NativeAgentPolicy;
	/** @deprecated Use nativeAgentPolicy instead. */
	inheritNativeAgents?: boolean;
};

type ComposeHomeOptions = {
	homeRoot?: string;
	settingsRoot?: string;
};

type McpConfigEntry = Record<string, unknown>;

type ComposeResult = {
	workspace: string;
	configRoot: string;
	profile: ProfileSpec;
	bundles: BundleSpec[];
};

type RuntimeSourceMetadata = {
	kind: "personal-home" | "hr-home" | "hr-staged-package";
	label: string;
	packageId?: string;
};

type ToolInjectionResult = {
	workspace: string;
	configRoot: string;
	mcpNames: string[];
};

type CustomizedAgentResult = {
	workspace: string;
	configRoot: string;
	soul: string;
	skills: string[];
	mcpNames: string[];
};

const activeRuntimeDirName = "current";

const packageVersion = readPackageVersion();

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoSrcRoot = path.resolve(currentDir, "..");
const repoRoot = path.resolve(repoSrcRoot, "..");
const builtInLibraryRoot = path.join(currentDir, "library");
const templateRepoRoot = "${" + "REPO_ROOT}";
const templateRepoSrcRoot = "${" + "REPO_SRC_ROOT}";
const templateLibraryRoot = "${" + "LIBRARY_ROOT}";
const OPENCODE_BUILTIN_AGENTS = ["general", "explore", "plan", "build"] as const;

const unique = <T>(values: T[]): T[] => [...new Set(values)];

const resolveNativeAgentPolicy = (profile: ProfileSpec): NativeAgentPolicy => {
	if (profile.nativeAgentPolicy) return profile.nativeAgentPolicy;
	if (profile.inheritNativeAgents === false) return "override";
	return "inherit";
};

const isDisabledAgentEntry = (value: unknown) =>
	isPlainObject(value) && value.disable === true;

const validateProfileDefaultAgent = ({
	profile,
	bundles,
	agentConfig,
	nativeAgentPolicy,
}: {
	profile: ProfileSpec;
	bundles: BundleSpec[];
	agentConfig: Record<string, unknown>;
	nativeAgentPolicy: NativeAgentPolicy;
}) => {
	if (nativeAgentPolicy === "team-only" && !profile.defaultAgent?.trim()) {
		throw new Error(
			`Team-only profile '${profile.name}' must set defaultAgent explicitly so the runtime has a stable primary agent when built-ins are disabled.`,
		);
	}
	if (!profile.defaultAgent) return undefined;

	const configuredDefaultAgent = profile.defaultAgent.trim();
	if (!configuredDefaultAgent) return undefined;
	const bundleMatch = bundles.find((bundle) => bundle.name === configuredDefaultAgent);
	if (bundleMatch && bundleMatch.agent.name !== configuredDefaultAgent) {
		const availableAgents = Object.entries(agentConfig)
			.filter(([, entry]) => !isDisabledAgentEntry(entry))
			.map(([name]) => name)
			.sort();
		throw new Error(
			`Profile '${profile.name}' sets defaultAgent '${configuredDefaultAgent}', but that matches bundle '${bundleMatch.name}' instead of its bundle agent.name '${bundleMatch.agent.name}'. Set defaultAgent to '${bundleMatch.agent.name}'. Available agent names: ${availableAgents.join(", ") || "(none)"}.`,
		);
	}

	const matchedAgent = agentConfig[configuredDefaultAgent];
	if (matchedAgent && !isDisabledAgentEntry(matchedAgent)) {
		const matchedBundle = bundles.find((bundle) => bundle.agent.name === configuredDefaultAgent);
		if (matchedBundle?.agent.mode !== "primary") {
			throw new Error(
				`Profile '${profile.name}' defaultAgent '${configuredDefaultAgent}' must point to a primary agent, but the matched bundle uses mode '${matchedBundle?.agent.mode || "unknown"}'.`,
			);
		}
		return configuredDefaultAgent;
	}

	const bundleHint = bundleMatch
		? ` Bundle '${bundleMatch.name}' uses bundle agent.name '${bundleMatch.agent.name}'. Set defaultAgent to that value instead.`
		: "";
	const disabledHint = matchedAgent && isDisabledAgentEntry(matchedAgent)
		? ` Agent '${configuredDefaultAgent}' exists in the composed runtime but is disabled under nativeAgentPolicy '${nativeAgentPolicy}'.`
		: "";
	const availableAgents = Object.entries(agentConfig)
		.filter(([, entry]) => !isDisabledAgentEntry(entry))
		.map(([name]) => name)
		.sort();
	throw new Error(
		`Profile '${profile.name}' sets defaultAgent '${configuredDefaultAgent}', but no enabled generated agent matches that name.${bundleHint}${disabledHint} Available agent names: ${availableAgents.join(", ") || "(none)"}.`,
	);
};

const validateTeamHasPrimaryAgent = ({
	profile,
	bundles,
	nativeAgentPolicy,
}: {
	profile: ProfileSpec;
	bundles: BundleSpec[];
	nativeAgentPolicy: NativeAgentPolicy;
}) => {
	const hasVisiblePrimary = bundles.some(
		(bundle) => bundle.agent.mode === "primary" && bundle.agent.hidden !== true,
	);
	if (hasVisiblePrimary) return;
	if (nativeAgentPolicy === "team-only") {
		throw new Error(
			`Profile '${profile.name}' must include at least one primary, visible staged agent when nativeAgentPolicy is 'team-only'.`,
		);
	}
};

const workflowInjectionMatchesBundles = (
	workflowInjection: RuntimeConfig["workflowInjection"],
	bundleNames: string[] = [],
): boolean => {
	if (!workflowInjection?.enabled) return false;
	if (!workflowInjection.bundles || workflowInjection.bundles.length === 0) {
		return true;
	}
	return workflowInjection.bundles.some((bundleName) => bundleNames.includes(bundleName));
};

const resolveRuntimeSourceMetadata = (
	libraryRoot: string,
	settingsRoot: string,
): RuntimeSourceMetadata => {
	const resolvedLibraryRoot = path.resolve(libraryRoot);
	const resolvedSettingsRoot = path.resolve(settingsRoot);
	const resolvedHrRoot = path.resolve(defaultHrHome());
	const stagedRoot = path.join(resolvedHrRoot, "staging");
	const stagedPrefix = `${stagedRoot}${path.sep}`;

	if (resolvedLibraryRoot.startsWith(stagedPrefix)) {
		const relative = path.relative(stagedRoot, resolvedLibraryRoot);
		const [packageId] = relative.split(path.sep);
		return {
			kind: "hr-staged-package",
			label: packageId ? `HR staged package ${packageId}` : "HR staged package",
			...(packageId ? { packageId } : {}),
		};
	}

	if (resolvedLibraryRoot === resolvedHrRoot || resolvedSettingsRoot === resolvedHrRoot) {
		return {
			kind: "hr-home",
			label: "HR Office",
		};
	}

	return {
		kind: "personal-home",
		label: "Personal Home",
	};
};

const resolveRuntimeInjectionConfig = ({
	planDetection,
	workflowInjection,
	bundleNames = [],
}: {
	planDetection?: PlanDetectionConfig;
	workflowInjection: RuntimeConfig["workflowInjection"];
	bundleNames?: string[];
}): {
	planDetection?: PlanDetectionConfig;
	workflowInjection?: RuntimeConfig["workflowInjection"];
} => {
	if (workflowInjection) {
		const matchedWorkflowInjection = workflowInjectionMatchesBundles(workflowInjection, bundleNames)
			? workflowInjection
			: undefined;
		return {
			...(matchedWorkflowInjection ? { workflowInjection: matchedWorkflowInjection } : {}),
			...(matchedWorkflowInjection && planDetection?.enabled ? { planDetection } : {}),
		};
	}

	return {
		planDetection: planDetection?.enabled ? planDetection : undefined,
	};
};

const readJson = async <T>(filePath: string): Promise<T> => {
	const content = await readFile(filePath, "utf-8");
	return JSON.parse(content) as T;
};

const ensureDir = async (dirPath: string) => {
	await mkdir(dirPath, { recursive: true });
};

const pathExists = async (targetPath: string): Promise<boolean> => {
	try {
		await lstat(targetPath);
		return true;
	} catch {
		return false;
	}
};

const getAgentHubHome = (): string =>
	process.env.OPENCODE_AGENTHUB_HOME ||
	resolveHomeConfigRoot(os.homedir(), "opencode-agenthub");

const resolveLibraryRoot = (homeRoot = getAgentHubHome()): string => {
	const agentHubHome = homeRoot;
	if (
		existsSync(path.join(agentHubHome, "profiles")) &&
		existsSync(path.join(agentHubHome, "bundles"))
	) {
		return agentHubHome;
	}
	return builtInLibraryRoot;
};

const resolveCandidateLibraryRoots = (libraryRoot: string): string[] =>
	unique([libraryRoot, builtInLibraryRoot]);

const firstExistingPath = async (paths: string[]): Promise<string | null> => {
	for (const candidate of paths) {
		if (await pathExists(candidate)) {
			return candidate;
		}
	}
	return null;
};

const loadProfile = async (
	libraryRoot: string,
	profileName: string,
): Promise<ProfileSpec> => {
	for (const root of resolveCandidateLibraryRoots(libraryRoot)) {
		const profilePath = path.join(root, "profiles", `${profileName}.json`);
		const profile = await readJsonIfExists<ProfileSpec>(profilePath);
		if (profile) {
			return profile;
		}
	}
	throw new Error(
		`Profile '${profileName}' not found in ${path.join(libraryRoot, "profiles")} or ${path.join(builtInLibraryRoot, "profiles")}. Create that profile or re-run bootstrap with a starter kit.`,
	);
};

const loadBundle = async (
	libraryRoot: string,
	bundleName: string,
): Promise<BundleSpec> => {
	let raw: RawBundleSpec | null = null;
	for (const root of resolveCandidateLibraryRoots(libraryRoot)) {
		raw = await readJsonIfExists<RawBundleSpec>(
			path.join(root, "bundles", `${bundleName}.json`),
		);
		if (raw) break;
	}
	if (!raw) {
		throw new Error(
			`Bundle '${bundleName}' not found in ${path.join(libraryRoot, "bundles")} or ${path.join(builtInLibraryRoot, "bundles")}.`,
		);
	}
	const soul = raw.soul || raw.prompt;
	if (!soul) {
		throw new Error(`Bundle '${bundleName}' is missing required 'soul' field.`);
	}

	return {
		...raw,
		soul,
	};
};

const readJsonIfExists = async <T>(filePath: string): Promise<T | null> => {
	try {
		return await readJson<T>(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw error;
	}
};

const replaceTemplateTokens = (value: string, libraryRoot: string): string =>
	value
		.replaceAll(templateRepoRoot, repoRoot)
		.replaceAll(templateRepoSrcRoot, repoSrcRoot)
		.replaceAll(templateLibraryRoot, libraryRoot);

const resolveTemplateValue = (value: unknown, libraryRoot: string): unknown => {
	if (typeof value === "string") {
		return replaceTemplateTokens(value, libraryRoot);
	}
	if (Array.isArray(value)) {
		return value.map((item) => resolveTemplateValue(item, libraryRoot));
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(
				([key, entryValue]) => [
					key,
					resolveTemplateValue(entryValue, libraryRoot),
				],
			),
		);
	}
	return value;
};

const loadMcpEntry = async (
	libraryRoot: string,
	mcpName: string,
): Promise<McpConfigEntry> => {
	const candidateRoots = unique([libraryRoot, builtInLibraryRoot]);
	for (const root of candidateRoots) {
		const entry = await readJsonIfExists<McpConfigEntry>(
			path.join(root, "mcp", `${mcpName}.json`),
		);
		if (entry) {
			return resolveTemplateValue(entry, root) as McpConfigEntry;
		}
	}

	throw new Error(
		`Unknown MCP entry '${mcpName}'. Add ${mcpName}.json under ${path.join(libraryRoot, "mcp")} or ${path.join(builtInLibraryRoot, "mcp")}.`,
	);
};

const loadAllMcpEntries = async (
	libraryRoot: string,
): Promise<Record<string, McpConfigEntry>> => {
	const mcpNames = unique(
		(
			await Promise.all(
				resolveCandidateLibraryRoots(libraryRoot).map(async (root) => {
					const mcpDir = path.join(root, "mcp");
					if (!(await pathExists(mcpDir))) return [];
					const entries = await readdir(mcpDir, { withFileTypes: true });
					return entries
						.filter((entry) => entry.isFile() && path.extname(entry.name) === ".json")
						.map((entry) => path.basename(entry.name, ".json"));
				}),
			)
		).flat(),
	).sort();
	if (mcpNames.length === 0) return {};

	return Object.fromEntries(
		await Promise.all(
			mcpNames.map(async (name) => [
				name,
				await loadMcpEntry(libraryRoot, name),
			]),
		),
	);
};

const resetGeneratedDir = async (dirPath: string) => {
	await rm(dirPath, { recursive: true, force: true });
	await ensureDir(dirPath);
};

const listAgentHubSoulNames = async (libraryRoot: string): Promise<string[]> => {
	return unique(
		(
			await Promise.all(
				resolveCandidateLibraryRoots(libraryRoot).map(async (root) => {
					const soulsRoot = path.join(root, "souls");
					if (!(await pathExists(soulsRoot))) return [];
					const entries = await readdir(soulsRoot, { withFileTypes: true });
					return entries
						.filter((entry) => entry.isFile() && path.extname(entry.name) === ".md")
						.map((entry) => path.basename(entry.name, ".md"));
				}),
			)
		).flat(),
	).sort();
};

const listAgentHubSkillNames = async (libraryRoot: string): Promise<string[]> => {
	return unique(
		(
			await Promise.all(
				resolveCandidateLibraryRoots(libraryRoot).map(async (root) => {
					const skillsRoot = path.join(root, "skills");
					if (!(await pathExists(skillsRoot))) return [];
					const entries = await readdir(skillsRoot, { withFileTypes: true });
					return entries
						.filter((entry) => entry.isDirectory())
						.map((entry) => entry.name);
				}),
			)
		).flat(),
	).sort();
};

const readWorkflowInjectionConfigWithFallback = async (
	libraryRoot: string,
	fallbackRoot?: string,
) => {
	for (const root of unique([libraryRoot, fallbackRoot, builtInLibraryRoot]).filter(Boolean)) {
		const config = await readWorkflowInjectionConfig(root);
		if (config) {
			return config;
		}
	}
	return null;
};

const resetWorkspaceRuntimeRoot = async (
	workspace: string,
	outputRoot: string,
) => {
	const workspaceRuntimeRoot = path.join(workspace, ".opencode-agenthub");
	if (
		path.resolve(path.dirname(outputRoot)) !==
		path.resolve(workspaceRuntimeRoot)
	) {
		await ensureDir(outputRoot);
		return;
	}

	await rm(workspaceRuntimeRoot, { recursive: true, force: true });
	await ensureDir(outputRoot);
	await writeFile(
		path.join(workspaceRuntimeRoot, "active-runtime.json"),
		`${JSON.stringify({ active: path.basename(outputRoot) }, null, 2)}\n`,
		"utf-8",
	);
};

const resolveSoulSource = async (
	libraryRoot: string,
	soulName: string,
): Promise<string> => {
	const source = await firstExistingPath([
		path.join(libraryRoot, "souls", `${soulName}.md`),
		path.join(libraryRoot, "agents", `${soulName}.md`),
		path.join(builtInLibraryRoot, "souls", `${soulName}.md`),
		path.join(builtInLibraryRoot, "agents", `${soulName}.md`),
		path.join(repoSrcRoot, "agents", `${soulName}.md`),
	]);
	if (!source) {
		throw new Error(
			`Unknown soul '${soulName}'. Add ${soulName}.md under ${path.join(libraryRoot, "souls")} or provide a repo source file.`,
		);
	}
	return source;
};

const resolveSkillSource = async (
	libraryRoot: string,
	skillName: string,
): Promise<string> => {
	const source = await firstExistingPath([
		path.join(libraryRoot, "skills", skillName),
		path.join(builtInLibraryRoot, "skills", skillName),
		path.join(repoSrcRoot, "skills", skillName),
	]);
	if (!source) {
		throw new Error(
			`Unknown skill '${skillName}'. Add ${skillName} under ${path.join(libraryRoot, "skills")} or provide a repo source directory.`,
		);
	}
	return source;
};

const resolveInstructionSource = async (
	libraryRoot: string,
	instructionName: string,
): Promise<string> => {
	const source = await firstExistingPath([
		path.join(libraryRoot, "instructions", `${instructionName}.md`),
		path.join(builtInLibraryRoot, "instructions", `${instructionName}.md`),
		path.join(repoSrcRoot, "instructions", `${instructionName}.md`),
	]);
	if (!source) {
		throw new Error(
			`Unknown instruction '${instructionName}'. Add ${instructionName}.md under ${path.join(libraryRoot, "instructions")} or provide a repo source file.`,
		);
	}
	return source;
};

const mergeAgentPrompt = async (
	libraryRoot: string,
	bundle: BundleSpec,
): Promise<string> => {
	const soulSource = await resolveSoulSource(libraryRoot, bundle.soul);
	const soulText = await readFile(soulSource, "utf-8");
	const instructionTexts = await Promise.all(
		(bundle.instructions || []).map(async (instructionName) => {
			const source = await resolveInstructionSource(libraryRoot, instructionName);
			const content = await readFile(source, "utf-8");
			return {
				instructionName,
				content: content.trim(),
			};
		}),
	);
	const sections = [soulText.trim()];
	for (const instruction of instructionTexts) {
		if (!instruction.content) continue;
		sections.push(`## Attached Instruction: ${instruction.instructionName}\n\n${instruction.content}`);
	}
	return `${sections.filter(Boolean).join("\n\n") }\n`;
};

const mountBundleArtifacts = async (
	outputRoot: string,
	libraryRoot: string,
	bundles: BundleSpec[],
) => {
	const agentsDir = path.join(outputRoot, "agents");
	const skillsDir = path.join(outputRoot, "skills");

	await Promise.all([
		resetGeneratedDir(agentsDir),
		resetGeneratedDir(skillsDir),
	]);

	const mountedAgentNames = new Set<string>();
	for (const bundle of bundles) {
		if (mountedAgentNames.has(bundle.agent.name)) continue;
		const mergedPrompt = await mergeAgentPrompt(libraryRoot, bundle);
		await writeFile(path.join(agentsDir, `${bundle.agent.name}.md`), mergedPrompt, "utf-8");
		mountedAgentNames.add(bundle.agent.name);
	}

	const skillNames = unique(bundles.flatMap((bundle) => bundle.skills));
	for (const skillName of skillNames) {
		const source = await resolveSkillSource(libraryRoot, skillName);
		await symlink(source, path.join(skillsDir, skillName), symlinkType());
	}
};

const toGeneratedHeader = (source: string) =>
	`// GENERATED BY opencode-agenthub. DO NOT EDIT.\n// Source: ${source}\n`;

const phaseDescription = (category: string): string =>
	`${category} phase worker generated from workflow bundle`;

const loadOmoBaseline = async (): Promise<Record<string, unknown> | null> => {
	const baselinePath = path.join(
		resolveHomeConfigRoot(os.homedir(), "opencode"),
		"oh-my-opencode.json",
	);
	return readJsonIfExists<Record<string, unknown>>(baselinePath);
};

const writeGeneratedRuntimeFiles = async ({
	outputRoot,
	source,
	opencodeConfig,
	lock,
	omoConfig,
	planDetection,
	workflowInjection,
}: {
	outputRoot: string;
	source: string;
	opencodeConfig: Record<string, unknown>;
	lock: Record<string, unknown>;
	omoConfig?: Record<string, unknown>;
	planDetection?: PlanDetectionConfig;
	workflowInjection?: RuntimeConfig["workflowInjection"];
}) => {
	const opencodeConfigText = `${toGeneratedHeader(source)}${JSON.stringify(opencodeConfig, null, 2)}\n`;
	await writeFile(
		path.join(outputRoot, "opencode.jsonc"),
		opencodeConfigText,
		"utf-8",
	);

	if (omoConfig && Object.keys(omoConfig).length > 0) {
		const omoConfigText = `${toGeneratedHeader(source)}${JSON.stringify(omoConfig, null, 2)}\n`;
		await writeFile(
			path.join(outputRoot, "oh-my-opencode.json"),
			omoConfigText,
			"utf-8",
		);
	}

	const xdgConfigText = `${toGeneratedHeader(source)}${JSON.stringify({
		$schema: "https://opencode.ai/config.json",
		plugin: Array.isArray(opencodeConfig.plugin) ? opencodeConfig.plugin : [],
	}, null, 2)}\n`;
	await writeFile(
		path.join(outputRoot, "xdg", "opencode", "opencode.json"),
		xdgConfigText,
		"utf-8",
	);
	await writeFile(
		path.join(outputRoot, "agenthub-lock.json"),
		`${toGeneratedHeader(source)}${JSON.stringify(lock, null, 2)}\n`,
		"utf-8",
	);

	// Write runtime config for plugin to read
	if (lock.runtimeInfo) {
		const runtimeConfig: RuntimeConfig = {
			generated: new Date().toISOString(),
			agents: lock.runtimeInfo as Record<string, AgentRuntimeInfo>,
			...(planDetection?.enabled ? { planDetection } : {}),
			...(workflowInjection?.enabled ? { workflowInjection } : {}),
		};
		await writeFile(
			path.join(outputRoot, "agenthub-runtime.json"),
			`${toGeneratedHeader(source)}${JSON.stringify(runtimeConfig, null, 2)}\n`,
			"utf-8",
		);
	}

	await writeFile(path.join(outputRoot, "run.sh"), generateRunScript(), "utf-8");
	await writeFile(path.join(outputRoot, "run.cmd"), generateRunCmd(), "utf-8");
};

/**
 * Resolves a guard with full inheritance chain processing
 * @param guardName - Name of the guard to resolve
 * @param guardRegistry - Registry of all guard definitions
 * @param visited - Set of already visited guards (for cycle detection)
 * @returns Resolved guard with merged permission and blockedTools
 * @throws GuardResolutionError if guard not found or circular dependency detected
 */
const resolveGuard = (
	guardName: string,
	guardRegistry: GuardRegistry,
	visited: Set<string> = new Set(),
): ResolvedGuard => {
	// Check for circular dependencies
	if (visited.has(guardName)) {
		const chain = Array.from(visited).concat(guardName);
		const error = new Error(
			`Circular guard dependency detected: ${chain.join(" -> ")}`,
		) as GuardResolutionError;
		error.name = "GuardResolutionError";
		// @ts-expect-error - Adding custom properties
		error.guardName = guardName;
		// @ts-expect-error - Adding custom properties
		error.chain = chain;
		throw error;
	}

	// Check if guard exists
	const guardDef = guardRegistry[guardName];
	if (!guardDef) {
		// For backward compatibility, log warning but continue with empty guard
		// This allows bundles with old/undefined guards to still work
		console.warn(`⚠️  Warning: Guard '${guardName}' not found in registry. Skipping.`);
		return { permission: {}, blockedTools: [] };
	}

	// Mark as visited
	const newVisited = new Set(visited);
	newVisited.add(guardName);

	// Resolve parent guards first (depth-first)
	const parentGuards: ResolvedGuard[] = [];
	if (guardDef.extends && guardDef.extends.length > 0) {
		for (const parentName of guardDef.extends) {
			parentGuards.push(resolveGuard(parentName, guardRegistry, newVisited));
		}
	}

	// Merge parent permissions and blockedTools
	const mergedPermission: Record<string, unknown> = {};
	const mergedBlockedTools: string[] = [];

	// Apply parent guards in order
	for (const parent of parentGuards) {
		Object.assign(mergedPermission, parent.permission);
		mergedBlockedTools.push(...parent.blockedTools);
	}

	// Apply current guard (overrides parents)
	if (guardDef.permission) {
		Object.assign(mergedPermission, guardDef.permission);
	}
	if (guardDef.blockedTools) {
		mergedBlockedTools.push(...guardDef.blockedTools);
	}

	// Return resolved guard with unique blockedTools
	return {
		permission: mergedPermission,
		blockedTools: unique(mergedBlockedTools),
	};
};

/**
 * Resolves multiple guards and merges them
 * @param guardNames - Array of guard names to resolve
 * @param guardRegistry - Registry of all guard definitions
 * @returns Merged resolved guard
 */
const resolveGuards = (
	guardNames: string[],
	guardRegistry: GuardRegistry,
): ResolvedGuard => {
	if (!guardNames || guardNames.length === 0) {
		return { permission: {}, blockedTools: [] };
	}

	const resolvedGuards = guardNames.map((name) =>
		resolveGuard(name, guardRegistry),
	);

	// Merge all resolved guards
	const mergedPermission: Record<string, unknown> = {};
	const mergedBlockedTools: string[] = [];

	for (const resolved of resolvedGuards) {
		Object.assign(mergedPermission, resolved.permission);
		mergedBlockedTools.push(...resolved.blockedTools);
	}

	return {
		permission: mergedPermission,
		blockedTools: unique(mergedBlockedTools),
	};
};

export const composeWorkspace = async (
	workspace: string,
	profileName: string,
	configRoot?: string,
	options: ComposeHomeOptions = {},
): Promise<ComposeResult> => {
	const libraryRoot = resolveLibraryRoot(options.homeRoot);
	const settingsRoot = options.settingsRoot || libraryRoot;
	const profile = await loadProfile(libraryRoot, profileName);
	const bundles = await Promise.all(
		profile.bundles.map((bundleName) => loadBundle(libraryRoot, bundleName)),
	);
	const nativeAgentPolicy = resolveNativeAgentPolicy(profile);
	if (
		nativeAgentPolicy === "team-only" &&
		!bundles.some((bundle) => bundle.agent.name === "explore")
	) {
		bundles.push(await loadBundle(libraryRoot, "explore"));
	}
	const outputRoot =
		configRoot ||
		path.join(workspace, ".opencode-agenthub", activeRuntimeDirName);

	await resetWorkspaceRuntimeRoot(workspace, outputRoot);
	await ensureDir(path.join(outputRoot, "xdg", "opencode"));
	await mountBundleArtifacts(outputRoot, libraryRoot, bundles);

	const allMcpNames = unique(bundles.flatMap((bundle) => bundle.mcp || []));
	const mcpEntries = Object.fromEntries(
		await Promise.all(
			allMcpNames.map(async (name) => [
				name,
				await loadMcpEntry(libraryRoot, name),
			]),
		),
	);
	const settings =
		(await readAgentHubSettings(libraryRoot)) ||
		(settingsRoot !== libraryRoot ? await readAgentHubSettings(settingsRoot) : null);
	const workflowInjectionConfig = await readWorkflowInjectionConfigWithFallback(
		libraryRoot,
		settingsRoot,
	);
	const runtimeInjectionConfig = resolveRuntimeInjectionConfig({
		planDetection: settings?.planDetection,
		workflowInjection: workflowInjectionConfig,
		bundleNames: bundles.map((bundle) => bundle.name),
	});

	const agentConfig: Record<string, unknown> = {};
	const omoCategories: Record<string, { model: string }> = {};
	const runtimeInfo: Record<string, AgentRuntimeInfo> = {};

	// Get guard registry from settings
	const guardRegistry = settings?.guards || {};

	// OMO MIXED PROFILE PROTECTION
	// If profile contains OMO bundles, auto-add no_omo guard to native agents
	const hasOmoBundle = bundles.some((b) => b.runtime === "omo");
	const nativeBundles = bundles.filter((b) => b.runtime === "native" || !b.runtime);
	
	if (hasOmoBundle && nativeBundles.length > 0) {
		for (const bundle of nativeBundles) {
			// Auto-add no_omo guard if not already present
			if (!bundle.guards?.includes("no_omo")) {
				bundle.guards = [...(bundle.guards || []), "no_omo"];
			}
		}
	}

	for (const bundle of bundles) {
		// 1. GUARD RESOLUTION
		// Collect guards from multiple sources (bundle + settings)
		const bundleGuards = bundle.guards || [];
		const settingsGuards = settings?.agents?.[bundle.agent.name]?.guards || [];
		const allGuards = unique([...bundleGuards, ...settingsGuards]);

		// Resolve guards to get permission and blockedTools
		const resolvedGuard = resolveGuards(allGuards, guardRegistry);

		// Start with bundle permission as base
		const settingsPermission = settings?.agents?.[bundle.agent.name]?.permission;
		const permission: Record<string, unknown> = {
			...(bundle.agent.permission || {}),
			...resolvedGuard.permission,  // Apply resolved guard permissions
			...(settingsPermission || {}),  // Settings override everything
		};

		// Track blocked tools for runtime config
		const blockedTools = [...resolvedGuard.blockedTools];

		const finalSkills = unique(bundle.skills || []);

		// 3. OMO RUNTIME HANDLING
		if (bundle.runtime === "omo" && bundle.categories) {
			permission.task = { "*": "deny" };
			for (const category of Object.keys(bundle.categories)) {
				(permission.task as Record<string, string>)[category] = "allow";
				omoCategories[category] = { model: bundle.categories[category] };
				agentConfig[category] = {
					mode: "subagent",
					hidden: true,
					description: phaseDescription(category),
				};
			}
			permission.question = "allow";
		}

		// Store runtime info for this agent
		runtimeInfo[bundle.agent.name] = {
			runtime: bundle.runtime,
			blockedTools,
			guards: allGuards,
			skills: finalSkills,
		};
		const resolvedModel = pickModelSelection(
			normalizeModelSelection(
				settings?.agents?.[bundle.agent.name]?.model,
				settings?.agents?.[bundle.agent.name]?.variant,
			),
			normalizeModelSelection(bundle.agent.model, bundle.agent.variant),
			normalizeModelSelection(settings?.opencode?.model),
		);

		agentConfig[bundle.agent.name] = {
			mode: bundle.agent.mode,
			hidden: bundle.agent.hidden,
			...(resolvedModel.model ? { model: resolvedModel.model } : {}),
			...(resolvedModel.variant ? { variant: resolvedModel.variant } : {}),
			...(typeof (bundle.agent as Record<string, unknown>).steps === "number"
				? { steps: (bundle.agent as Record<string, unknown>).steps }
				: {}),
			description: bundle.agent.description,
			...(finalSkills.length > 0 ? { skills: finalSkills } : {}),
			...(Object.keys(permission).length > 0 ? { permission } : {}),
		};
	}

	const nativeConfig = await loadNativeOpenCodeConfig();
	const nativePluginEntries = await readNativePluginEntries();
	const nativeAgents = nativeConfig?.agent || {};
	if (nativeAgentPolicy === "inherit") {
		for (const [agentName, nativeAgent] of Object.entries(nativeAgents)) {
			if (!nativeAgent || typeof nativeAgent !== "object") continue;
			if (agentConfig[agentName]) continue;

			const settingsAgent = settings?.agents?.[agentName];
			const resolvedModel = pickModelSelection(
				normalizeModelSelection(settingsAgent?.model, settingsAgent?.variant),
				normalizeModelSelection(
					typeof nativeAgent.model === "string" ? nativeAgent.model : undefined,
					typeof nativeAgent.variant === "string" ? nativeAgent.variant : undefined,
				),
			);
			const nativePermission =
				nativeAgent.permission && typeof nativeAgent.permission === "object"
					? (nativeAgent.permission as Record<string, unknown>)
					: undefined;
			const mergedPermission = deepMergeRecords(
				nativePermission || {},
				((settingsAgent?.permission as Record<string, unknown> | undefined) || {}),
			);

			agentConfig[agentName] = {
				...nativeAgent,
				...(resolvedModel.model ? { model: resolvedModel.model } : {}),
				...(resolvedModel.variant ? { variant: resolvedModel.variant } : {}),
				...(settingsAgent?.prompt ? { prompt: settingsAgent.prompt } : {}),
				...(Object.keys(mergedPermission).length > 0
					? { permission: mergedPermission }
					: {}),
			};
		}
	}
	if (nativeAgentPolicy === "team-only") {
		for (const builtInName of OPENCODE_BUILTIN_AGENTS) {
			if (!agentConfig[builtInName]) {
				agentConfig[builtInName] = { disable: true };
			}
		}
	}
	const resolvedDefaultAgent = validateProfileDefaultAgent({
		profile,
		bundles,
		agentConfig,
		nativeAgentPolicy,
	});
	validateTeamHasPrimaryAgent({
		profile,
		bundles,
		nativeAgentPolicy,
	});

	const omoBaseline =
		Object.keys(omoCategories).length > 0 ? await loadOmoBaseline() : null;
	const omoConfig =
		Object.keys(omoCategories).length > 0
			? {
				...(omoBaseline || {}),
				categories: {
					...((omoBaseline?.categories as Record<string, unknown> | undefined) || {}),
					...omoCategories,
				},
			}
			: undefined;

	const resolvedGlobalModel = normalizeModelSelection(settings?.opencode?.model);
	const opencodeConfig = {
		$schema: "https://opencode.ai/config.json",
		...(settings?.opencode?.provider ? { provider: settings.opencode.provider } : {}),
		...(resolvedGlobalModel.model ? { model: resolvedGlobalModel.model } : {}),
		...(settings?.opencode?.small_model
			? { small_model: settings.opencode.small_model }
			: {}),
		plugin: unique([...profile.plugins, ...nativePluginEntries]),
		...(Object.keys(mcpEntries).length > 0 ? { mcp: mcpEntries } : {}),
		...(resolvedDefaultAgent ? { default_agent: resolvedDefaultAgent } : {}),
		agent: agentConfig,
	};

	const lock = {
		profile: profile.name,
		nativeAgentPolicy,
		composedAt: new Date().toISOString(),
		composedWithVersion: packageVersion,
		source: resolveRuntimeSourceMetadata(libraryRoot, settingsRoot),
		libraryRoot,
		...(settingsRoot !== libraryRoot ? { settingsRoot } : {}),
		workspace,
		configRoot: outputRoot,
		bundles: bundles.map((bundle) => ({
			name: bundle.name,
			runtime: bundle.runtime,
			soul: bundle.soul,
			instructions: bundle.instructions || [],
			skills: bundle.skills,
			mcp: bundle.mcp || [],
			guards: bundle.guards || [],
		})),
		runtimeInfo,  // Add runtime info for plugin
	};
	await writeGeneratedRuntimeFiles({
		outputRoot,
		source: `profile:${profile.name}`,
		opencodeConfig,
		lock,
		omoConfig,
		planDetection: runtimeInjectionConfig.planDetection,
		workflowInjection: runtimeInjectionConfig.workflowInjection,
	});

	return { workspace, configRoot: outputRoot, profile, bundles };
};

export const composeToolInjection = async (
	workspace: string,
	configRoot?: string,
	options: ComposeHomeOptions = {},
): Promise<ToolInjectionResult> => {
	const libraryRoot = resolveLibraryRoot(options.homeRoot);
	const settingsRoot = options.settingsRoot || libraryRoot;
	const outputRoot =
		configRoot ||
		path.join(workspace, ".opencode-agenthub", activeRuntimeDirName);

	await resetWorkspaceRuntimeRoot(workspace, outputRoot);
	await ensureDir(path.join(outputRoot, "xdg", "opencode"));
	await resetGeneratedDir(path.join(outputRoot, "agents"));
	await resetGeneratedDir(path.join(outputRoot, "skills"));

	const mcpEntries = await loadAllMcpEntries(libraryRoot);
	const opencodeConfig = {
		$schema: "https://opencode.ai/config.json",
		...(Object.keys(mcpEntries).length > 0 ? { mcp: mcpEntries } : {}),
	};
	const lock = {
		mode: "tool-injection",
		composedAt: new Date().toISOString(),
		composedWithVersion: packageVersion,
		libraryRoot,
		workspace,
		configRoot: outputRoot,
		mcp: Object.keys(mcpEntries),
	};
	const workflowInjectionConfig = await readWorkflowInjectionConfigWithFallback(
		libraryRoot,
		settingsRoot,
	);

	await writeGeneratedRuntimeFiles({
		outputRoot,
		source: "mode:tool-injection",
		opencodeConfig,
		lock,
		workflowInjection: workflowInjectionMatchesBundles(workflowInjectionConfig)
			? workflowInjectionConfig
			: undefined,
	});

	return {
		workspace,
		configRoot: outputRoot,
		mcpNames: Object.keys(mcpEntries),
	};
};

export const composeCustomizedAgent = async (
	workspace: string,
	configRoot?: string,
	options: ComposeHomeOptions = {},
): Promise<CustomizedAgentResult> => {
	const libraryRoot = resolveLibraryRoot(options.homeRoot);
	const settingsRoot = options.settingsRoot || libraryRoot;
	const outputRoot =
		configRoot || path.join(workspace, ".opencode-agenthub", activeRuntimeDirName);
	const souls = await listAgentHubSoulNames(libraryRoot);
	if (souls.length === 0) {
		throw new Error(
			`customized-agent mode requires at least one soul in ${path.join(libraryRoot, "souls")}`,
		);
	}

	const selectedSoul = souls[0];
	const skills = await listAgentHubSkillNames(libraryRoot);
	const mcpEntries = await loadAllMcpEntries(libraryRoot);
	const mcpNames = Object.keys(mcpEntries).sort();
	const agentName = selectedSoul;

	await resetWorkspaceRuntimeRoot(workspace, outputRoot);
	await ensureDir(path.join(outputRoot, "xdg", "opencode"));
	await mountBundleArtifacts(outputRoot, libraryRoot, [
		{
			name: "customized-agent",
			runtime: "native",
			soul: selectedSoul,
			instructions: [],
			skills,
			mcp: mcpNames,
			guards: ["no_task"],
			agent: {
				name: agentName,
				mode: "primary",
				hidden: false,
				model: "github-copilot/claude-haiku-4.5",
				description: "Auto-generated native agent from imported Agent Hub assets",
			},
		},
	]);

	const opencodeConfig = {
		$schema: "https://opencode.ai/config.json",
		plugin: ["opencode-agenthub"],
		...(mcpNames.length > 0 ? { mcp: mcpEntries } : {}),
		agent: {
			[agentName]: {
				mode: "primary",
				hidden: false,
				model: "github-copilot/claude-haiku-4.5",
				description: "Auto-generated native agent from imported Agent Hub assets",
				permission: {
					task: { "*": "deny" },
				},
			},
		},
	};
	const lock = {
		mode: "customized-agent",
		composedAt: new Date().toISOString(),
		composedWithVersion: packageVersion,
		libraryRoot,
		workspace,
		configRoot: outputRoot,
		soul: selectedSoul,
		skills,
		mcp: mcpNames,
	};

	const workflowInjectionConfig = await readWorkflowInjectionConfigWithFallback(
		libraryRoot,
		settingsRoot,
	);
	await writeGeneratedRuntimeFiles({
		outputRoot,
		source: "mode:customized-agent",
		opencodeConfig,
		lock,
		workflowInjection: workflowInjectionMatchesBundles(workflowInjectionConfig)
			? workflowInjectionConfig
			: undefined,
	});

	return {
		workspace,
		configRoot: outputRoot,
		soul: selectedSoul,
		skills,
		mcpNames,
	};
};

export const getDefaultConfigRoot = (
	workspace: string,
	_profileName: string,
): string => path.join(workspace, ".opencode-agenthub", activeRuntimeDirName);


export const getWorkspaceRuntimeRoot = (workspace: string): string =>
	path.join(workspace, ".opencode-agenthub", activeRuntimeDirName);

export const getAgentHubPaths = () => ({
	repoRoot,
	repoSrcRoot,
	builtInLibraryRoot,
	agentHubHome: getAgentHubHome(),
});
