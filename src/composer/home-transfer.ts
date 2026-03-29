import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultAgentHubHome, ensureAgentHubSkeleton } from "./bootstrap.js";
import { installPackageDependencies } from "./package-manager.js";

const libraryRootPlaceholder = "$" + "{LIBRARY_ROOT}";
const repoRootPlaceholder = "$" + "{REPO_ROOT}";
const repoSrcRootPlaceholder = "$" + "{REPO_SRC_ROOT}";

const managedDirectories = [
	"souls",
	"instructions",
	"skills",
	"workflow",
	"bundles",
	"profiles",
	"mcp",
	"mcp-servers",
] as const;

const exportManifestFileName = "agenthub-export.json";

type ManagedDirectory = (typeof managedDirectories)[number];
type SettingsImportMode = "preserve" | "replace";

type ExportManifest = {
	formatVersion: 1;
	createdAt: string;
	pluginVersion: string;
	sourceRoot: string;
	contents: Record<ManagedDirectory | "settings", boolean>;
	warnings: string[];
};

type ExportOptions = {
	sourceRoot?: string;
	outputRoot: string;
	pluginVersion?: string;
};

type ImportOptions = {
	sourceRoot: string;
	targetRoot?: string;
	overwrite?: boolean;
	settingsMode?: SettingsImportMode;
};

type TransferReport = {
	sourceRoot: string;
	targetRoot: string;
	sourceKind?: "export" | "raw";
	copied: string[];
	skipped: string[];
	overwritten: string[];
	warnings: string[];
	settingsAction: "copied" | "preserved" | "replaced" | "absent";
};

const settingsFileName = "settings.json";

const installImportedMcpServerDependencies = async (
	targetRoot: string,
	report: TransferReport,
) => {
	const targetMcpServersRoot = path.join(targetRoot, "mcp-servers");
	if (!(await pathExists(targetMcpServersRoot))) return;
	const packageManifest = path.join(targetMcpServersRoot, "package.json");
	if (!(await pathExists(packageManifest))) return;
	try {
		await installPackageDependencies(targetMcpServersRoot);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		report.warnings.push(`Failed to install MCP server dependencies: ${message}`);
	}
};

const pathExists = async (target: string): Promise<boolean> => {
	try {
		await stat(target);
		return true;
	} catch {
		return false;
	}
};

const ensureCleanDirectory = async (target: string) => {
	await mkdir(target, { recursive: true });
};

const isAbsolutePathString = (value: string) =>
	path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);

const normalizeMcpValue = (
	value: unknown,
	sourceRoot: string,
	relativeFile: string,
	warnings: string[],
): unknown => {
	if (typeof value === "string") {
		let normalized = value;
		if (normalized.includes(sourceRoot)) {
			normalized = normalized.split(sourceRoot).join(libraryRootPlaceholder);
		}
		if (
			isAbsolutePathString(normalized) &&
			!normalized.includes(libraryRootPlaceholder) &&
			!normalized.includes(repoRootPlaceholder) &&
			!normalized.includes(repoSrcRootPlaceholder)
		) {
			warnings.push(
				`MCP entry '${relativeFile}' contains an absolute path that may not be portable: ${value}`,
			);
		}
		return normalized;
	}
	if (Array.isArray(value)) {
		return value.map((item) =>
			normalizeMcpValue(item, sourceRoot, relativeFile, warnings),
		);
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, nested]) => [
				key,
				normalizeMcpValue(nested, sourceRoot, relativeFile, warnings),
			]),
		);
	}
	return value;
};

const copyManagedTree = async (
	sourceRoot: string,
	targetRoot: string,
	name: ManagedDirectory,
) => {
	const source = path.join(sourceRoot, name);
	if (!(await pathExists(source))) return false;
	await cp(source, path.join(targetRoot, name), { recursive: true });
	return true;
};

const writeNormalizedMcpEntries = async (
	sourceRoot: string,
	outputRoot: string,
	warnings: string[],
) => {
	const sourceMcpRoot = path.join(sourceRoot, "mcp");
	if (!(await pathExists(sourceMcpRoot))) return false;
	const outputMcpRoot = path.join(outputRoot, "mcp");
	await mkdir(outputMcpRoot, { recursive: true });
	for (const entry of await readdir(sourceMcpRoot, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const sourceFile = path.join(sourceMcpRoot, entry.name);
		const relativeFile = path.join("mcp", entry.name);
		const parsed = JSON.parse(await readFile(sourceFile, "utf8"));
		const normalized = normalizeMcpValue(parsed, sourceRoot, relativeFile, warnings);
		await writeFile(
			path.join(outputMcpRoot, entry.name),
			`${JSON.stringify(normalized, null, 2)}\n`,
			"utf8",
		);
	}
	return true;
};

const detectContents = async (root: string) => {
	const entries = await Promise.all([
		...managedDirectories.map((name) => pathExists(path.join(root, name))),
		pathExists(path.join(root, settingsFileName)),
	]);
	return {
		souls: entries[0],
		instructions: entries[1],
		skills: entries[2],
		workflow: entries[3],
		bundles: entries[4],
		profiles: entries[5],
		mcp: entries[6],
		"mcp-servers": entries[7],
		settings: entries[8],
	};
};

const isRawImportSource = async (sourceRoot: string): Promise<boolean> => {
	const contents = await detectContents(sourceRoot);
	return contents.bundles && contents.profiles;
};

const detectImportSourceKind = async (
	sourceRoot: string,
): Promise<"export" | "raw"> => {
	if (await pathExists(path.join(sourceRoot, exportManifestFileName))) {
		return "export";
	}
	if (await isRawImportSource(sourceRoot)) {
		return "raw";
	}
	throw new Error(
		`Import source '${sourceRoot}' is neither an export bundle nor a raw Agent Hub home/vault. Expected ${exportManifestFileName} or at least 'bundles/' and 'profiles/'.`,
	);
};

const readExportManifest = async (sourceRoot: string): Promise<ExportManifest> => {
	const manifestPath = path.join(sourceRoot, exportManifestFileName);
	if (!(await pathExists(manifestPath))) {
		throw new Error(
			`Export source '${sourceRoot}' is missing ${exportManifestFileName}. Run 'hub-export' first.`,
		);
	}
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ExportManifest;
	if (manifest.formatVersion !== 1) {
		throw new Error(
			`Unsupported export format version '${String(manifest.formatVersion)}'.`,
		);
	}
	return manifest;
};

export const validateAgentHubHome = async (targetRoot: string): Promise<boolean> => {
	const contents = await detectContents(targetRoot);
	return contents.souls && contents.skills && contents.bundles && contents.profiles;
};

export const exportAgentHubHome = async ({
	sourceRoot = defaultAgentHubHome(),
	outputRoot,
	pluginVersion = "0.0.0",
}: ExportOptions): Promise<TransferReport> => {
	const resolvedSourceRoot = path.resolve(sourceRoot);
	const resolvedOutputRoot = path.resolve(outputRoot);
	if (!(await validateAgentHubHome(resolvedSourceRoot))) {
		throw new Error(
			`Source '${resolvedSourceRoot}' is not an initialized Agent Hub home.`,
		);
	}
	await ensureCleanDirectory(resolvedOutputRoot);

	const warnings: string[] = [];
	const copied: string[] = [];
	for (const name of managedDirectories) {
		if (name === "mcp") continue;
		if (await copyManagedTree(resolvedSourceRoot, resolvedOutputRoot, name)) {
			copied.push(name);
		}
	}
	if (await writeNormalizedMcpEntries(resolvedSourceRoot, resolvedOutputRoot, warnings)) {
		copied.push("mcp");
	}
	const sourceSettings = path.join(resolvedSourceRoot, settingsFileName);
	let settingsAction: TransferReport["settingsAction"] = "absent";
	if (await pathExists(sourceSettings)) {
		await writeFile(
			path.join(resolvedOutputRoot, settingsFileName),
			await readFile(sourceSettings, "utf8"),
			"utf8",
		);
		copied.push(settingsFileName);
		settingsAction = "copied";
	}

	const contents = await detectContents(resolvedOutputRoot);
	const manifest: ExportManifest = {
		formatVersion: 1,
		createdAt: new Date().toISOString(),
		pluginVersion,
		sourceRoot: resolvedSourceRoot,
		contents,
		warnings,
	};
	await writeFile(
		path.join(resolvedOutputRoot, exportManifestFileName),
		`${JSON.stringify(manifest, null, 2)}\n`,
		"utf8",
	);

	return {
		sourceRoot: resolvedSourceRoot,
		targetRoot: resolvedOutputRoot,
		copied,
		skipped: [],
		overwritten: [],
		warnings,
		settingsAction,
	};
};

const importDirectoryEntries = async (
	sourceRoot: string,
	targetRoot: string,
	overwrite: boolean,
	report: TransferReport,
) => {
	for (const name of managedDirectories) {
		const source = path.join(sourceRoot, name);
		if (!(await pathExists(source))) continue;
		const target = path.join(targetRoot, name);
		await mkdir(target, { recursive: true });
		for (const entry of await readdir(source, { withFileTypes: true })) {
			const sourceEntry = path.join(source, entry.name);
			const targetEntry = path.join(target, entry.name);
			if (await pathExists(targetEntry)) {
				if (!overwrite) {
					report.skipped.push(path.join(name, entry.name));
					continue;
				}
				report.overwritten.push(path.join(name, entry.name));
			} else {
				report.copied.push(path.join(name, entry.name));
			}
			await cp(sourceEntry, targetEntry, { recursive: true, force: overwrite });
		}
	}
};

const importSettingsFile = async (
	sourceRoot: string,
	targetRoot: string,
	mode: SettingsImportMode,
	report: TransferReport,
) => {
	const source = path.join(sourceRoot, settingsFileName);
	if (!(await pathExists(source))) {
		report.settingsAction = "absent";
		return;
	}
	const target = path.join(targetRoot, settingsFileName);
	if (await pathExists(target)) {
		if (mode === "preserve") {
			report.settingsAction = "preserved";
			report.skipped.push(settingsFileName);
			return;
		}
		report.settingsAction = "replaced";
		report.overwritten.push(settingsFileName);
	} else {
		report.settingsAction = "copied";
		report.copied.push(settingsFileName);
	}
	await writeFile(target, await readFile(source, "utf8"), "utf8");
};

export const importAgentHubHome = async ({
	sourceRoot,
	targetRoot = defaultAgentHubHome(),
	overwrite = false,
	settingsMode = "preserve",
}: ImportOptions): Promise<TransferReport> => {
	const resolvedSourceRoot = path.resolve(sourceRoot);
	const resolvedTargetRoot = path.resolve(targetRoot);
	const sourceKind = await detectImportSourceKind(resolvedSourceRoot);
	await ensureAgentHubSkeleton(resolvedTargetRoot);

	const report: TransferReport = {
		sourceRoot: resolvedSourceRoot,
		targetRoot: resolvedTargetRoot,
		sourceKind,
		copied: [],
		skipped: [],
		overwritten: [],
		warnings:
			sourceKind === "export"
				? [...(await readExportManifest(resolvedSourceRoot)).warnings]
				: [
					"Importing from a raw Agent Hub home/vault. Files are copied as-is; no export manifest normalization was applied.",
				],
		settingsAction: "absent",
	};

	await importDirectoryEntries(resolvedSourceRoot, resolvedTargetRoot, overwrite, report);
	await importSettingsFile(
		resolvedSourceRoot,
		resolvedTargetRoot,
		settingsMode,
		report,
	);
	await installImportedMcpServerDependencies(resolvedTargetRoot, report);

	return report;
};

export type { ExportManifest, ExportOptions, ImportOptions, SettingsImportMode, TransferReport };
