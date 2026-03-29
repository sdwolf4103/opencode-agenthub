import { chmod, cp, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { installPackageDependencies } from "./package-manager.js";
import {
	buildBuiltinVersionManifest,
	getManagedCodingHrHubAssetSpecs,
	getManagedHrHomeAssetSpecs,
	type BuiltInVersionManifest,
	type ManagedAssetSpec,
} from "./builtin-assets.js";
import { readPackageVersion } from "./package-version.js";
import { resolveHomeConfigRoot, shouldChmod } from "./platform.js";
import type { AgentHubSettings } from "../types.js";
import {
	buildInitialAgentHubSettings,
	resolveHrBootstrapAgentModels,
	mergeAgentHubSettingsDefaults,
	readAgentHubSettings,
	writeAgentHubSettings,
	type HrBootstrapModelSelection,
} from "./settings.js";

export type SetupMode = "minimal" | "auto";

export type BootstrapOptions = {
	targetRoot?: string;
	importSoulsPath?: string;
	importInstructionsPath?: string;
	importSkillsPath?: string;
	importMcpServersPath?: string;
	mode?: SetupMode;
};

export type BootstrapAnswers = {
	targetRoot: string;
	importSoulsPath?: string;
	importInstructionsPath?: string;
	importSkillsPath?: string;
	importMcpServersPath?: string;
	mode: SetupMode;
};

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const libraryRoot = path.join(currentDir, "library");

const sourceRoot = path.dirname(currentDir);

const defaultHrGithubSources = [
	"garrytan/gstack",
	"anthropics/skills",
	"msitarzewski/agency-agents",
	"obra/superpowers",
];

export type SyncManagedAssetsOptions = {
	force?: boolean;
	dryRun?: boolean;
};

export type SyncManagedAssetsReport = {
	added: string[];
	updated: string[];
	skipped: string[];
	manifest: BuiltInVersionManifest;
};

const syncManagedAssetSpecs = async (
	specs: ManagedAssetSpec[],
	version: string,
	options: SyncManagedAssetsOptions = {},
): Promise<SyncManagedAssetsReport> => {
	const added: string[] = [];
	const updated: string[] = [];
	const skipped: string[] = [];
	const manifest: BuiltInVersionManifest = {};

	for (const spec of specs) {
		const exists = await pathExists(spec.target);
		manifest[spec.manifestKey] = version;
		if (exists && !options.force) {
			skipped.push(spec.manifestKey);
			continue;
		}
		if (!options.dryRun) {
			await mkdir(path.dirname(spec.target), { recursive: true });
			await cp(spec.source, spec.target, {
				recursive: Boolean(spec.recursive),
				force: true,
			});
			if (spec.executable && shouldChmod()) {
				await chmod(spec.target, 0o755);
			}
		}
		(exists ? updated : added).push(spec.manifestKey);
	}

	return { added, updated, skipped, manifest };
};

const mergeBuiltinManifest = (
	existing: BuiltInVersionManifest | undefined,
	next: BuiltInVersionManifest,
): BuiltInVersionManifest => ({
	...(existing || {}),
	...next,
});

const pruneBuiltinManifest = (
	existing: BuiltInVersionManifest | undefined,
	allowedKeys: string[],
): BuiltInVersionManifest | undefined => {
	if (!existing) return undefined;
	const allowed = new Set(allowedKeys);
	const pruned = Object.fromEntries(
		Object.entries(existing).filter(([key]) => allowed.has(key)),
	);
	return Object.keys(pruned).length > 0 ? pruned : undefined;
};

const withBuiltinManifest = (
	settings: AgentHubSettings,
	manifest: BuiltInVersionManifest,
) => ({
	...settings,
	meta: {
		...settings.meta,
		builtinVersion: mergeBuiltinManifest(settings.meta?.builtinVersion, manifest),
	},
});

const withBuiltinManifestForMode = (
	settings: AgentHubSettings,
	manifest: BuiltInVersionManifest,
	mode: SetupMode | "hr-office",
) => ({
	...settings,
	meta: {
		...settings.meta,
		builtinVersion: mergeBuiltinManifest(
			pruneBuiltinManifest(
				settings.meta?.builtinVersion,
				Object.keys(buildBuiltinVersionManifest(mode, readPackageVersion())),
			),
			manifest,
		),
	},
});

const installCodingStarter = async (targetRoot: string, version: string) =>
	syncManagedAssetSpecs(
		getManagedCodingHrHubAssetSpecs(targetRoot, "auto"),
		version,
	);

const installHrOfficeStarter = async (targetRoot: string, version: string) =>
	syncManagedAssetSpecs(
		getManagedCodingHrHubAssetSpecs(targetRoot, "hr-office"),
		version,
	);

const installHrHelperScripts = async (hrRoot: string) => {
	const scriptsRoot = path.join(sourceRoot, "skills", "hr-support", "bin");
	const targetBinRoot = path.join(hrRoot, "bin");
	await mkdir(targetBinRoot, { recursive: true });

	for (const scriptName of [
		"sync_sources.py",
		"vendor_stage_skills.py",
		"validate_staged_package.py",
	]) {
		const source = path.join(scriptsRoot, scriptName);
		const target = path.join(targetBinRoot, scriptName);
		if (!(await pathExists(target))) {
			await cp(source, target, { force: true });
			if (shouldChmod()) {
				await chmod(target, 0o755);
			}
		}
	}
};

export const defaultAgentHubHome = () =>
	process.env.OPENCODE_AGENTHUB_HOME ||
	resolveHomeConfigRoot(os.homedir(), "opencode-agenthub");

export const defaultHrHome = () =>
	process.env.OPENCODE_AGENTHUB_HR_HOME ||
	resolveHomeConfigRoot(os.homedir(), "opencode-agenthub-hr");

const pathExists = async (target: string): Promise<boolean> => {
	try {
		await stat(target);
		return true;
	} catch {
		return false;
	}
};

export const ensureAgentHubSkeleton = async (targetRoot: string) => {
	await mkdir(targetRoot, { recursive: true });
	await mkdir(path.join(targetRoot, "souls"), { recursive: true });
	await mkdir(path.join(targetRoot, "skills"), { recursive: true });
	await mkdir(path.join(targetRoot, "bundles"), { recursive: true });
	await mkdir(path.join(targetRoot, "profiles"), { recursive: true });
};

/**
 * Ensure the HR home skeleton exists.
 *
 * The HR home is separate from both the workspace `.opencode/` directory and
 * the Agent Hub home.  Live HR state (inventory, sources, staging, logs,
 * architecture reviews) lives here and is never written to either of the other
 * two roots.
 *
 * Default path: ~/.config/opencode-agenthub-hr/
 * Override via:  OPENCODE_AGENTHUB_HR_HOME env variable
 */
export const ensureHrHomeSkeleton = async (hrRoot: string) => {
	await mkdir(hrRoot, { recursive: true });
	await mkdir(path.join(hrRoot, "bin"), { recursive: true });
	await mkdir(path.join(hrRoot, "inventory", "workers"), { recursive: true });
	await mkdir(path.join(hrRoot, "inventory", "models"), { recursive: true });
	await mkdir(path.join(hrRoot, "sources", "github"), { recursive: true });
	await mkdir(path.join(hrRoot, "staging"), { recursive: true });
	await mkdir(path.join(hrRoot, "output"), { recursive: true });
	await mkdir(path.join(hrRoot, "logs"), { recursive: true });
	await mkdir(path.join(hrRoot, "state", "staffing-plans"), { recursive: true });
	await mkdir(path.join(hrRoot, "state", "architecture-reviews"), { recursive: true });

	const configPath = path.join(hrRoot, "hr-config.json");
	if (!(await pathExists(configPath))) {
		const defaultConfig = {
			schema_version: "1.1",
			sources: {
				github: defaultHrGithubSources,
				models: [
					{
						source_id: "models-dev",
						url: "https://models.dev/api.json",
						format: "models.dev",
					},
				],
			},
			settings: {
				auto_sync: false,
				sync_depth: 1
			}
		};
		await writeFile(configPath, `${JSON.stringify(defaultConfig, null, 2)}\n`, "utf-8");
	}

	await installHrHelperScripts(hrRoot);
};

export const ensureHrOfficeSkeleton = async (hrRoot: string) => {
	await ensureHrHomeSkeleton(hrRoot);
	await ensureAgentHubSkeleton(hrRoot);
};

export const hrHomeInitialized = async (hrRoot = defaultHrHome()) => {
	const [libraryOk, configOk, profileOk, bundleOk, settingsOk] = await Promise.all([
		agentHubHomeInitialized(hrRoot),
		pathExists(path.join(hrRoot, "hr-config.json")),
		pathExists(path.join(hrRoot, "profiles", "hr.json")),
		pathExists(path.join(hrRoot, "bundles", "hr.json")),
		pathExists(path.join(hrRoot, "settings.json")),
	]);
	return libraryOk && configOk && profileOk && bundleOk && settingsOk;
};

export const installHrOfficeHome = async (hrRoot = defaultHrHome()) => {
	return installHrOfficeHomeWithOptions({ hrRoot });
};

export const installHrOfficeHomeWithOptions = async ({
	hrRoot = defaultHrHome(),
	hrModelSelection,
}: {
	hrRoot?: string;
	hrModelSelection?: HrBootstrapModelSelection;
}) => {
	const packageVersion = readPackageVersion();
	await ensureHrOfficeSkeleton(hrRoot);
	await copyLibraryReadme(hrRoot);
	await installHrOfficeStarter(hrRoot, packageVersion);
	const resolvedHrModels = await resolveHrBootstrapAgentModels({
		targetRoot: hrRoot,
		selection: hrModelSelection,
	});

	const existingSettings = await readAgentHubSettings(hrRoot);
	if (!existingSettings) {
		const initialSettings = await buildInitialAgentHubSettings({
			targetRoot: hrRoot,
			mode: "hr-office",
			hrResolvedModels: resolvedHrModels,
		});
		await writeAgentHubSettings(
			hrRoot,
			initialSettings,
		);
	} else {
		const mergedSettings = mergeAgentHubSettingsDefaults(existingSettings);
		const builtinVersion = buildBuiltinVersionManifest("hr-office", packageVersion);
		mergedSettings.agents = mergedSettings.agents || {};
		for (const [agentName, modelSelection] of Object.entries(resolvedHrModels.agentModels)) {
			const existingAgentSettings = mergedSettings.agents[agentName] || {};
			if (!existingAgentSettings.model || !existingAgentSettings.variant) {
				mergedSettings.agents[agentName] = {
					...existingAgentSettings,
					...(existingAgentSettings.model ? {} : { model: modelSelection.model }),
					...(existingAgentSettings.variant || !modelSelection.variant
						? {}
						: { variant: modelSelection.variant }),
				};
			}
		}
		mergedSettings.meta = {
			...mergedSettings.meta,
			onboarding: {
				...mergedSettings.meta?.onboarding,
				modelStrategy:
					mergedSettings.meta?.onboarding?.modelStrategy || resolvedHrModels.strategy,
			},
		};
		await writeAgentHubSettings(
			hrRoot,
			withBuiltinManifestForMode(mergedSettings, builtinVersion, "hr-office"),
		);
	}

	return hrRoot;
};

const copyLibraryReadme = async (targetRoot: string) => {
	const source = path.join(libraryRoot, "README.md");
	const target = path.join(targetRoot, "README.md");
	if (await pathExists(target)) return;
	await cp(source, target);
};

const copySkillsFrom = async (sourceRoot: string, targetRoot: string) => {
	const targetSkillsRoot = path.join(targetRoot, "skills");
	await mkdir(targetSkillsRoot, { recursive: true });
	for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const source = path.join(sourceRoot, entry.name);
		const target = path.join(targetSkillsRoot, entry.name);
		if (await pathExists(target)) continue;
		await cp(source, target, { recursive: true });
	}
};

const copySoulsFrom = async (sourceRoot: string, targetRoot: string) => {
	const targetSoulsRoot = path.join(targetRoot, "souls");
	await mkdir(targetSoulsRoot, { recursive: true });
	for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
		if (!entry.isFile() || path.extname(entry.name) !== ".md") continue;
		const source = path.join(sourceRoot, entry.name);
		const target = path.join(targetSoulsRoot, entry.name);
		if (await pathExists(target)) continue;
		await cp(source, target);
	}
};

const copyInstructionsFrom = async (sourceRoot: string, targetRoot: string) => {
	const targetInstructionsRoot = path.join(targetRoot, "instructions");
	await mkdir(targetInstructionsRoot, { recursive: true });
	for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
		if (!entry.isFile() || path.extname(entry.name) !== ".md") continue;
		const source = path.join(sourceRoot, entry.name);
		const target = path.join(targetInstructionsRoot, entry.name);
		if (await pathExists(target)) continue;
		await cp(source, target);
	}
};

const supportedMcpServerExtensions = new Set([".ts", ".js", ".mjs", ".cjs"]);
const mcpServerPackageManifest = "package.json";

const copyMcpServersFrom = async (
	sourceRoot: string,
	targetRoot: string,
): Promise<Array<{ name: string; fileName: string }>> => {
	const targetMcpServersRoot = path.join(targetRoot, "mcp-servers");
	await mkdir(targetMcpServersRoot, { recursive: true });

	const importedServers: Array<{ name: string; fileName: string }> = [];
	const sourcePackageManifest = path.join(sourceRoot, mcpServerPackageManifest);
	const targetPackageManifest = path.join(
		targetMcpServersRoot,
		mcpServerPackageManifest,
	);
	if (await pathExists(sourcePackageManifest)) {
		await cp(sourcePackageManifest, targetPackageManifest, { force: true });
	}
	for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const extension = path.extname(entry.name);
		if (!supportedMcpServerExtensions.has(extension)) continue;

		const source = path.join(sourceRoot, entry.name);
		const target = path.join(targetMcpServersRoot, entry.name);
		if (!(await pathExists(target))) {
			await cp(source, target);
		}

		importedServers.push({
			name: path.basename(entry.name, extension),
			fileName: entry.name,
		});
	}

	return importedServers;
};

const registerImportedMcpServers = async (
	servers: Array<{ name: string; fileName: string }>,
	targetRoot: string,
) => {
	const targetMcpRoot = path.join(targetRoot, "mcp");
	await mkdir(targetMcpRoot, { recursive: true });

	for (const server of servers) {
		const target = path.join(targetMcpRoot, `${server.name}.json`);
		if (await pathExists(target)) continue;

		const extension = path.extname(server.fileName);
		const scriptPath = `${"$"}{LIBRARY_ROOT}/mcp-servers/${server.fileName}`;
		const payload = {
			type: "local",
			command:
				extension === ".ts"
					? [
							"node",
							"--import",
							`${"$"}{LIBRARY_ROOT}/mcp-servers/node_modules/tsx/dist/loader.mjs`,
							scriptPath,
						]
					: ["node", scriptPath],
			timeout: 30000,
		};

		await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
	}
};

const installMcpServerDependencies = async (targetRoot: string) => {
	const targetMcpServersRoot = path.join(targetRoot, "mcp-servers");
	const packageManifest = path.join(
		targetMcpServersRoot,
		mcpServerPackageManifest,
	);
	if (!(await pathExists(packageManifest))) return;
	await installPackageDependencies(targetMcpServersRoot);
};

export const installAgentHubHome = async ({
	targetRoot = defaultAgentHubHome(),
	importSoulsPath,
	importInstructionsPath,
	importSkillsPath,
	importMcpServersPath,
	mode = "auto",
}: BootstrapOptions = {}) => {
	let importedServers: Array<{ name: string; fileName: string }> = [];
	const packageVersion = readPackageVersion();

	await ensureAgentHubSkeleton(targetRoot);
	await copyLibraryReadme(targetRoot);

	if (mode === "auto") {
		await installCodingStarter(targetRoot, packageVersion);
	}

	if (importSoulsPath) {
		await copySoulsFrom(importSoulsPath, targetRoot);
	}

	if (importInstructionsPath) {
		await copyInstructionsFrom(importInstructionsPath, targetRoot);
	}

	if (importSkillsPath) {
		await copySkillsFrom(importSkillsPath, targetRoot);
	}

	if (importMcpServersPath) {
		importedServers = await copyMcpServersFrom(
			importMcpServersPath,
			targetRoot,
		);
		await registerImportedMcpServers(importedServers, targetRoot);
		await installMcpServerDependencies(targetRoot);
	}

	const existingSettings = await readAgentHubSettings(targetRoot);
	if (!existingSettings) {
		await writeAgentHubSettings(
			targetRoot,
			await buildInitialAgentHubSettings({ targetRoot, mode }),
		);
	} else {
		const mergedSettings = mergeAgentHubSettingsDefaults(existingSettings);
		const builtinVersion = buildBuiltinVersionManifest(mode, packageVersion);
		await writeAgentHubSettings(
			targetRoot,
			withBuiltinManifestForMode(mergedSettings, builtinVersion, mode),
		);
	}

	return targetRoot;
};

export const syncBuiltInAgentHubAssets = async ({
	targetRoot = defaultAgentHubHome(),
	mode = "auto",
	force = false,
	dryRun = false,
}: BootstrapOptions & SyncManagedAssetsOptions): Promise<SyncManagedAssetsReport> => {
	if (!dryRun) {
		await ensureAgentHubSkeleton(targetRoot);
	}
	const report = await syncManagedAssetSpecs(
		getManagedCodingHrHubAssetSpecs(targetRoot, mode),
		readPackageVersion(),
		{ force, dryRun },
	);

	if (!dryRun) {
		const existingSettings = await readAgentHubSettings(targetRoot);
		if (existingSettings) {
			await writeAgentHubSettings(targetRoot, withBuiltinManifestForMode(existingSettings, report.manifest, mode));
		}
	}

	return report;
};

export const agentHubHomeInitialized = async (
	targetRoot = defaultAgentHubHome(),
) => {
	const [soulsOk, skillsOk, bundlesOk, profilesOk] =
		await Promise.all([
			pathExists(path.join(targetRoot, "souls")),
			pathExists(path.join(targetRoot, "skills")),
			pathExists(path.join(targetRoot, "bundles")),
			pathExists(path.join(targetRoot, "profiles")),
		]);
	return soulsOk && skillsOk && bundlesOk && profilesOk;
};

const normalizeOptionalPath = (value: string): string | undefined => {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return path.resolve(trimmed);
};

const promptSetupMode = async (
	rl: readline.Interface,
): Promise<SetupMode> => {
	while (true) {
		process.stdout.write("\nSetup options:\n");
		process.stdout.write("  auto  - Full setup with built-in Auto + Plan + Build\n");
		process.stdout.write("  minimal - Structure only\n\n");
		const modeAnswer = await rl.question(
			"Setup [auto/minimal] (recommended: auto): ",
		);
		const normalizedMode = modeAnswer.trim().toLowerCase();
		if (!normalizedMode) return "auto";
		if (normalizedMode === "minimal" || normalizedMode === "auto") {
			return normalizedMode as SetupMode;
		}
		process.stdout.write(
			"Invalid setup choice. Type 'auto', 'minimal', or press Enter for the recommended default.\n",
		);
	}
};

export const promptHubInitAnswers = async (): Promise<BootstrapAnswers> => {
	const rl = readline.createInterface({ input, output });
	try {
		const suggestedRoot = defaultAgentHubHome();
		const locationAnswer = await rl.question(
			`Agent Hub home location [${suggestedRoot}]: `,
		);
		const targetRoot = normalizeOptionalPath(locationAnswer) || suggestedRoot;

		const mode = await promptSetupMode(rl);

		// For the primary setup paths, keep the flow simple:
		// - auto = full managed setup
		// - minimal = blank structure with optional imports
		let importSoulsPath: string | undefined;
		let importInstructionsPath: string | undefined;
		let importSkillsPath: string | undefined;
		let importMcpServersPath: string | undefined;

		if (mode === "minimal") {
			const importSoulsAnswer = await rl.question(
				"Existing soul/agent prompt folder to import (leave blank to skip): ",
			);
			importSoulsPath = normalizeOptionalPath(importSoulsAnswer);

			const importInstructionsAnswer = await rl.question(
				"Existing instructions folder to import (leave blank to skip): ",
			);
			importInstructionsPath = normalizeOptionalPath(importInstructionsAnswer);

			const importAnswer = await rl.question(
				"Existing skills folder to import (leave blank to skip): ",
			);
			importSkillsPath = normalizeOptionalPath(importAnswer);

			const importMcpAnswer = await rl.question(
				"Existing MCP server folder to import (leave blank to skip): ",
			);
			importMcpServersPath = normalizeOptionalPath(importMcpAnswer);
		}

		return {
			targetRoot,
			importSoulsPath,
			importInstructionsPath,
			importSkillsPath,
			importMcpServersPath,
			mode,
		};
	} finally {
		rl.close();
	}
};
