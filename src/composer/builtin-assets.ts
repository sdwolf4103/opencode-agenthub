import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { SetupMode } from "./bootstrap.js";

export type BuiltInAssetKind =
	| "bundle"
	| "profile"
	| "soul"
	| "instruction"
	| "skill";

export type BuiltInVersionManifest = Record<string, string>;

export type ManagedAssetSpec = {
	manifestKey: string;
	source: string;
	target: string;
	recursive?: boolean;
	executable?: boolean;
};

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const builtInLibraryRoot = path.join(currentDir, "library");
const builtInSkillsRoot = path.resolve(currentDir, "..", "skills");
const hrSupportBinRoot = path.join(builtInSkillsRoot, "hr-support", "bin");

const codingLibraryFiles = [
	"bundles/auto.json",
	"bundles/explore.json",
	"bundles/plan.json",
	"bundles/build.json",
	"profiles/auto.json",
	"souls/auto.md",
	"souls/explore.md",
	"souls/plan.md",
	"souls/build.md",
];

const hrLibraryFiles = [
	"bundles/hr.json",
	"bundles/hr-planner.json",
	"bundles/hr-sourcer.json",
	"bundles/hr-evaluator.json",
	"bundles/hr-cto.json",
	"bundles/hr-adapter.json",
	"bundles/hr-verifier.json",
	"instructions/hr-boundaries.md",
	"instructions/hr-protocol.md",
	"profiles/hr.json",
	"souls/hr.md",
	"souls/hr-planner.md",
	"souls/hr-sourcer.md",
	"souls/hr-evaluator.md",
	"souls/hr-cto.md",
	"souls/hr-adapter.md",
	"souls/hr-verifier.md",
];

const hrSkillDirectories = [
	"hr-staffing",
	"hr-review",
	"hr-assembly",
	"hr-final-check",
];

const hrHelperScripts = [
	"sync_sources.py",
	"vendor_stage_skills.py",
	"vendor_stage_mcps.py",
	"validate_staged_package.py",
];

const listNamesByExtension = async (
	root: string,
	extension: string,
): Promise<Set<string>> => {
	try {
		const entries = await readdir(root, { withFileTypes: true });
		return new Set(
			entries
				.filter((entry) => entry.isFile() && entry.name.endsWith(extension))
				.map((entry) => entry.name.slice(0, -extension.length)),
		);
	} catch {
		return new Set();
	}
};

const listDirectoryNames = async (root: string): Promise<Set<string>> => {
	try {
		const entries = await readdir(root, { withFileTypes: true });
		return new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
	} catch {
		return new Set();
	}
};

export const listBuiltInAssetNames = async (
	kind: BuiltInAssetKind,
): Promise<Set<string>> => {
	if (kind === "bundle") {
		return listNamesByExtension(path.join(builtInLibraryRoot, "bundles"), ".json");
	}
	if (kind === "profile") {
		return listNamesByExtension(path.join(builtInLibraryRoot, "profiles"), ".json");
	}
	if (kind === "soul") {
		return listNamesByExtension(path.join(builtInLibraryRoot, "souls"), ".md");
	}
	if (kind === "instruction") {
		return listNamesByExtension(path.join(builtInLibraryRoot, "instructions"), ".md");
	}
	return listDirectoryNames(builtInSkillsRoot);
};

type InstallMode = SetupMode | "hr-office";

const manifestScopeForMode = (mode: InstallMode): string[] => {
	if (mode === "auto") {
		return codingLibraryFiles;
	}
	if (mode === "hr-office") {
		return [
			...hrLibraryFiles,
			...hrSkillDirectories.map((name) => `skills/${name}`),
			...hrHelperScripts.map((name) => `hr-home/bin/${name}`),
		];
	}
	return [];
};

export const getBuiltInManifestKeysForMode = (mode: InstallMode): string[] =>
	manifestScopeForMode(mode);

export const buildBuiltinVersionManifest = (
	mode: InstallMode,
	version: string,
): BuiltInVersionManifest =>
	Object.fromEntries(
		getBuiltInManifestKeysForMode(mode).map((manifestKey) => [manifestKey, version]),
	);

export const getManagedHubAssetSpecs = (
	targetRoot: string,
	mode: InstallMode,
): ManagedAssetSpec[] => {
	const manifestKeys = manifestScopeForMode(mode).filter(
		(key) => !key.startsWith("hr-home/") && !key.startsWith("skills/"),
	);
	return manifestKeys.map((manifestKey) => ({
		manifestKey,
		source: path.join(builtInLibraryRoot, ...manifestKey.split("/")),
		target: path.join(targetRoot, ...manifestKey.split("/")),
		recursive: false,
	}));
};

export const getManagedCodingHrHubAssetSpecs = (
	targetRoot: string,
	mode: InstallMode,
): ManagedAssetSpec[] => {
	const specs = getManagedHubAssetSpecs(targetRoot, mode);
	if (mode !== "hr-office") return specs;

	return [
		...specs,
		...hrSkillDirectories.map((name) => ({
			manifestKey: `skills/${name}`,
			source: path.join(builtInSkillsRoot, name),
			target: path.join(targetRoot, "skills", name),
			recursive: true,
		})),
	];
};

export const getManagedHrHomeAssetSpecs = (
	hrRoot: string,
	mode: InstallMode,
): ManagedAssetSpec[] => {
	if (mode !== "hr-office") return [];
	return hrHelperScripts.map((name) => ({
		manifestKey: `hr-home/bin/${name}`,
		source: path.join(hrSupportBinRoot, name),
		target: path.join(hrRoot, "bin", name),
		recursive: false,
		executable: true,
	}));
};
