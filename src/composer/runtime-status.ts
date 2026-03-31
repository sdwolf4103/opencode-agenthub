import { readFile } from "node:fs/promises";
import path from "node:path";
import { getWorkspaceRuntimeRoot } from "./compose.js";
import { readPackageVersion } from "./package-version.js";
import { defaultHrHome } from "./bootstrap.js";

type RuntimeSourceKind =
	| "personal-home"
	| "hr-home"
	| "hr-staged-package"
	| "tool-injection"
	| "customized-agent"
	| "unknown";

type RuntimeSource = {
	kind: RuntimeSourceKind;
	label: string;
	libraryRoot?: string;
	settingsRoot?: string;
	packageId?: string;
};

type RuntimeHealth = {
	staleRuntime: boolean;
	issues: string[];
	label: string;
};

export type ResolvedRuntimeStatus = {
	workspace?: string;
	configRoot: string;
	exists: boolean;
	profile?: string;
	defaultAgent?: string;
	nativeAgentPolicy?: string;
	composedAt?: string;
	composedWithVersion?: string;
	source: RuntimeSource;
	bundles: Array<{ name: string; runtime?: string; soul?: string }>;
	agents: {
		names: string[];
		visible: string[];
		hidden: string[];
	};
	plugins: {
		effective: string[];
	};
	localPlugins: {
		sourceDir: string | null;
		bridged: string[];
	};
	omoBaseline: {
		mode: "inherit" | "ignore";
		sourceFile: string | null;
	};
	health: RuntimeHealth;
};

const currentPackageVersion = readPackageVersion();

const parseGeneratedJson = (contents: string) => {
	const normalized = contents
		.split(/\r?\n/)
		.filter((line) => !line.startsWith("//"))
		.join("\n")
		.trim();
	if (!normalized) return null;
	return JSON.parse(normalized) as Record<string, unknown>;
};

const readGeneratedJsonIfExists = async (
	filePath: string,
): Promise<Record<string, unknown> | null> => {
	try {
		return parseGeneratedJson(await readFile(filePath, "utf8"));
	} catch {
		return null;
	}
};

const inferSourceFromLegacyFields = (
	libraryRoot?: string,
	settingsRoot?: string,
	mode?: string,
): RuntimeSource => {
	if (mode === "tool-injection") {
		return { kind: "tool-injection", label: "Tool injection mode" };
	}
	if (mode === "customized-agent") {
		return { kind: "customized-agent", label: "Customized agent mode" };
	}
	if (!libraryRoot) {
		return { kind: "unknown", label: "Unknown source" };
	}
	const resolvedLibraryRoot = path.resolve(libraryRoot);
	const resolvedSettingsRoot = settingsRoot ? path.resolve(settingsRoot) : resolvedLibraryRoot;
	const hrRoot = path.resolve(defaultHrHome());
	const stagedRoot = path.join(hrRoot, "staging");
	const stagedPrefix = `${stagedRoot}${path.sep}`;

	if (resolvedLibraryRoot.startsWith(stagedPrefix)) {
		const relative = path.relative(stagedRoot, resolvedLibraryRoot);
		const [packageId] = relative.split(path.sep);
		return {
			kind: "hr-staged-package",
			label: packageId ? `HR staged package ${packageId}` : "HR staged package",
			libraryRoot,
			settingsRoot,
			...(packageId ? { packageId } : {}),
		};
	}
	if (resolvedLibraryRoot === hrRoot || resolvedSettingsRoot === hrRoot) {
		return {
			kind: "hr-home",
			label: "HR Office",
			libraryRoot,
			settingsRoot,
		};
	}
	return {
		kind: "personal-home",
		label: "Personal Home",
		libraryRoot,
		settingsRoot,
	};
};

const normalizeSource = (lock: Record<string, unknown>): RuntimeSource => {
	const source = lock.source;
	if (source && typeof source === "object") {
		const raw = source as Record<string, unknown>;
		const kind =
			typeof raw.kind === "string"
				? (raw.kind as RuntimeSourceKind)
				: "unknown";
		const label = typeof raw.label === "string" ? raw.label : "Unknown source";
		return {
			kind,
			label,
			libraryRoot:
				typeof lock.libraryRoot === "string" ? (lock.libraryRoot as string) : undefined,
			settingsRoot:
				typeof lock.settingsRoot === "string" ? (lock.settingsRoot as string) : undefined,
			packageId:
				typeof raw.packageId === "string" ? (raw.packageId as string) : undefined,
		};
	}
	return inferSourceFromLegacyFields(
		typeof lock.libraryRoot === "string" ? (lock.libraryRoot as string) : undefined,
		typeof lock.settingsRoot === "string" ? (lock.settingsRoot as string) : undefined,
		typeof lock.mode === "string" ? (lock.mode as string) : undefined,
	);
};

const listAgentNames = (agentConfig: unknown) => {
	if (!agentConfig || typeof agentConfig !== "object") {
		return { names: [], visible: [], hidden: [] };
	}
	const entries = Object.entries(agentConfig as Record<string, unknown>);
	const names: string[] = [];
	const visible: string[] = [];
	const hidden: string[] = [];
	for (const [name, value] of entries) {
		if (!value || typeof value !== "object") continue;
		const config = value as Record<string, unknown>;
		if (config.disable === true) continue;
		names.push(name);
		if (config.hidden === true) hidden.push(name);
		else visible.push(name);
	}
	return { names, visible, hidden };
};

const toHealth = (composedWithVersion?: string): RuntimeHealth => {
	const staleRuntime =
		typeof composedWithVersion === "string" && composedWithVersion.length > 0
			? composedWithVersion !== currentPackageVersion
			: false;
	const issues = staleRuntime
		? [`runtime was composed with ${composedWithVersion}; current package is ${currentPackageVersion}`]
		: [];
	return {
		staleRuntime,
		issues,
		label: staleRuntime ? "runtime may be stale" : "runtime is current",
	};
	};

export const resolveRuntimeStatus = async ({
	workspace,
	configRoot,
}: {
	workspace?: string;
	configRoot?: string;
}): Promise<ResolvedRuntimeStatus> => {
	const effectiveConfigRoot = configRoot || (workspace ? getWorkspaceRuntimeRoot(workspace) : process.cwd());
	const lock = await readGeneratedJsonIfExists(path.join(effectiveConfigRoot, "agenthub-lock.json"));
	const opencodeConfig = await readGeneratedJsonIfExists(path.join(effectiveConfigRoot, "opencode.jsonc"));
	const runtimeExists = Boolean(lock || opencodeConfig);

	if (!runtimeExists) {
		return {
			workspace,
			configRoot: effectiveConfigRoot,
			exists: false,
			source: { kind: "unknown", label: "Unknown source" },
			bundles: [],
			agents: { names: [], visible: [], hidden: [] },
			plugins: { effective: [] },
			localPlugins: { sourceDir: null, bridged: [] },
			omoBaseline: { mode: "inherit", sourceFile: null },
			health: { staleRuntime: false, issues: ["missing runtime"], label: "runtime missing" },
		};
	}

	const profile = typeof lock?.profile === "string" ? (lock.profile as string) : undefined;
	const defaultAgent =
		typeof opencodeConfig?.default_agent === "string"
			? (opencodeConfig.default_agent as string)
			: undefined;
	const nativeAgentPolicy =
		typeof lock?.nativeAgentPolicy === "string"
			? (lock.nativeAgentPolicy as string)
			: undefined;
	const composedAt =
		typeof lock?.composedAt === "string" ? (lock.composedAt as string) : undefined;
	const composedWithVersion =
		typeof lock?.composedWithVersion === "string"
			? (lock.composedWithVersion as string)
			: undefined;
	const bundles = Array.isArray(lock?.bundles)
		? (lock?.bundles as Array<Record<string, unknown>>).map((bundle) => ({
				name: typeof bundle.name === "string" ? bundle.name : "unknown",
				runtime: typeof bundle.runtime === "string" ? bundle.runtime : undefined,
				soul: typeof bundle.soul === "string" ? bundle.soul : undefined,
			}))
		: [];
	const agents = listAgentNames(opencodeConfig?.agent);
	const plugins = Array.isArray(opencodeConfig?.plugin)
		? (opencodeConfig.plugin as unknown[]).filter((entry): entry is string => typeof entry === "string")
		: [];
	const localPluginsRaw =
		lock?.localPlugins && typeof lock.localPlugins === "object"
			? (lock.localPlugins as Record<string, unknown>)
			: {};
	const omoBaselineRaw =
		lock?.omoBaseline && typeof lock.omoBaseline === "object"
			? (lock.omoBaseline as Record<string, unknown>)
			: {};

	return {
		workspace:
			workspace || (typeof lock?.workspace === "string" ? (lock.workspace as string) : undefined),
		configRoot: effectiveConfigRoot,
		exists: true,
		profile,
		defaultAgent,
		nativeAgentPolicy,
		composedAt,
		composedWithVersion,
		source: normalizeSource(lock || {}),
		bundles,
		agents,
		plugins: {
			effective: plugins,
		},
		localPlugins: {
			sourceDir:
				typeof localPluginsRaw.sourceDir === "string"
					? (localPluginsRaw.sourceDir as string)
					: null,
			bridged: Array.isArray(localPluginsRaw.bridged)
				? (localPluginsRaw.bridged as unknown[]).filter(
					(entry): entry is string => typeof entry === "string",
				)
				: [],
		},
		omoBaseline: {
			mode: omoBaselineRaw.mode === "ignore" ? "ignore" : "inherit",
			sourceFile:
				typeof omoBaselineRaw.sourceFile === "string"
					? (omoBaselineRaw.sourceFile as string)
					: null,
		},
		health: toHealth(composedWithVersion),
	};
};

export const renderRuntimeStatus = (status: ResolvedRuntimeStatus): string => {
	const lines = ["Agent Hub runtime status"];
	if (status.workspace) lines.push(`- workspace: ${status.workspace}`);
	lines.push(`- runtime: ${status.configRoot}`);
	if (status.profile) lines.push(`- profile: ${status.profile}`);
	lines.push(`- source: ${status.source.label}`);
	if (status.source.packageId) lines.push(`- package id: ${status.source.packageId}`);
	if (status.defaultAgent) lines.push(`- default agent: ${status.defaultAgent}`);
	if (status.agents.visible.length > 0) {
		lines.push(`- visible agents: ${status.agents.visible.join(", ")}`);
	}
	if (status.agents.hidden.length > 0) {
		lines.push(`- hidden agents: ${status.agents.hidden.join(", ")}`);
	}
	lines.push(
		`- plugins: ${status.plugins.effective.length > 0 ? status.plugins.effective.join(", ") : "(none)"}`,
	);
	if (status.localPlugins.bridged.length > 0) {
		lines.push(
			`- local plugins: ${status.localPlugins.bridged.length} copied (${status.localPlugins.bridged.join(", ")})`,
		);
	} else if (status.localPlugins.sourceDir) {
		lines.push(`- local plugins: bridge disabled or none copied (${status.localPlugins.sourceDir})`);
	} else {
		lines.push(`- local plugins: (none)`);
	}
	if (status.omoBaseline.mode === "ignore") {
		lines.push(`- omo baseline: ignored (per settings)`);
	} else if (status.omoBaseline.sourceFile) {
		lines.push(`- omo baseline: inherited from ${status.omoBaseline.sourceFile}`);
	} else {
		lines.push(`- omo baseline: inherit (no global file found)`);
	}
	lines.push(`- health: ${status.health.label}`);
	return `${lines.join("\n")}\n`;
};

export const renderRuntimeStatusShort = (status: ResolvedRuntimeStatus): string => {
	const heading = `${status.profile || "unknown"} · ${status.source.label}`;
	const lines = [
		heading,
		`default: ${status.defaultAgent || "(none)"}`,
		`agents: ${status.agents.names.length} total (${status.agents.visible.length} visible, ${status.agents.hidden.length} hidden)`,
		`plugins: ${status.plugins.effective.length}`,
		`local plugins: ${status.localPlugins.bridged.length}`,
		`health: ${status.health.label}`,
	];
	return `${lines.join("\n")}\n`;
};

export const renderComposeSummary = (status: ResolvedRuntimeStatus): string => {
	const lines = [
		"Composed workspace runtime",
		`- profile: ${status.profile || "(mode runtime)"}`,
		`- source: ${status.source.label}`,
		`- default agent: ${status.defaultAgent || "(none)"}`,
		`- agents: ${status.agents.names.length} total (${status.agents.visible.length} visible, ${status.agents.hidden.length} hidden)`,
		`- plugins: ${status.plugins.effective.length}`,
		"Run 'agenthub status' for full details.",
		"If this runtime behaves unexpectedly, run 'agenthub doctor --category workspace'.",
		"Troubleshooting: docs/troubleshooting/compose-failures.md",
	];
	return `${lines.join("\n")}\n`;
};
