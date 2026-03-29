/**
 * Shared asset-listing helpers for the Agent Hub home directory.
 *
 * These functions are intentionally kept in the composer layer so that the
 * `list` command (and any future commands) can use them without depending on
 * the agenthub-doctor skill layer.
 */

import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const libraryRoot = path.join(currentDir, "library");

const pathExists = async (p: string): Promise<boolean> => {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
};

export const readJsonIfExists = async <T>(
	filePath: string,
): Promise<T | undefined> => {
	try {
		const content = await readFile(filePath, "utf-8");
		return JSON.parse(content) as T;
	} catch {
		return undefined;
	}
};

// ---------------------------------------------------------------------------
// Asset list queries
// ---------------------------------------------------------------------------

export const listSouls = async (targetRoot: string): Promise<string[]> => {
	const dir = path.join(targetRoot, "souls");
	if (!(await pathExists(dir))) return [];
	const entries = await readdir(dir, { withFileTypes: true });
	return entries
		.filter((e) => e.isFile() && e.name.endsWith(".md"))
		.map((e) => e.name.replace(/\.md$/, ""))
		.sort();
};

export const listSkills = async (targetRoot: string): Promise<string[]> => {
	const dir = path.join(targetRoot, "skills");
	if (!(await pathExists(dir))) return [];
	const entries = await readdir(dir, { withFileTypes: true });
	return entries
		.filter((e) => e.isDirectory())
		.map((e) => e.name)
		.sort();
};

export const listBundles = async (targetRoot: string): Promise<string[]> => {
	const dir = path.join(targetRoot, "bundles");
	if (!(await pathExists(dir))) return [];
	const entries = await readdir(dir, { withFileTypes: true });
	return entries
		.filter((e) => e.isFile() && e.name.endsWith(".json"))
		.map((e) => e.name.replace(/\.json$/, ""))
		.sort();
};

export const listProfiles = async (targetRoot: string): Promise<string[]> => {
	const dir = path.join(targetRoot, "profiles");
	if (!(await pathExists(dir))) return [];
	const entries = await readdir(dir, { withFileTypes: true });
	return entries
		.filter((e) => e.isFile() && e.name.endsWith(".json"))
		.map((e) => e.name.replace(/\.json$/, ""))
		.sort();
};

export const listInstructions = async (targetRoot: string): Promise<string[]> => {
	const dir = path.join(targetRoot, "instructions");
	if (!(await pathExists(dir))) return [];
	const entries = await readdir(dir, { withFileTypes: true });
	return entries
		.filter((e) => e.isFile() && e.name.endsWith(".md"))
		.map((e) => e.name.replace(/\.md$/, ""))
		.sort();
};

// ---------------------------------------------------------------------------
// Built-in library manifests (for source labeling)
// ---------------------------------------------------------------------------

const readLibraryNames = async (
	subdir: string,
	ext: string,
): Promise<Set<string>> => {
	const dir = path.join(libraryRoot, subdir);
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return new Set(
			entries
				.filter((e) => e.isFile() && e.name.endsWith(ext))
				.map((e) => e.name.slice(0, -ext.length)),
		);
	} catch {
		return new Set();
	}
};

const readLibrarySkillNames = async (): Promise<Set<string>> => {
	// Library skills live in src/skills/ (not in the library bundle dir).
	// We enumerate the known HR skill names statically to avoid depending on
	// src/ directory layout at runtime.
	return new Set([
		"hr-staffing",
		"hr-review",
		"hr-assembly",
		"hr-final-check",
	]);
};

export type SourceLabel = "built-in" | "custom";

export const labelSouls = async (
	targetRoot: string,
): Promise<Array<{ name: string; source: SourceLabel }>> => {
	const [names, builtIns] = await Promise.all([
		listSouls(targetRoot),
		readLibraryNames("souls", ".md"),
	]);
	return names.map((name) => ({
		name,
		source: builtIns.has(name) ? "built-in" : "custom",
	}));
};

export const labelBundles = async (
	targetRoot: string,
): Promise<Array<{ name: string; source: SourceLabel }>> => {
	const [names, builtIns] = await Promise.all([
		listBundles(targetRoot),
		readLibraryNames("bundles", ".json"),
	]);
	return names.map((name) => ({
		name,
		source: builtIns.has(name) ? "built-in" : "custom",
	}));
};

export const labelProfiles = async (
	targetRoot: string,
): Promise<Array<{ name: string; source: SourceLabel }>> => {
	const [names, builtIns] = await Promise.all([
		listProfiles(targetRoot),
		readLibraryNames("profiles", ".json"),
	]);
	return names.map((name) => ({
		name,
		source: builtIns.has(name) ? "built-in" : "custom",
	}));
};

export const labelSkills = async (
	targetRoot: string,
): Promise<Array<{ name: string; source: SourceLabel }>> => {
	const [names, builtIns] = await Promise.all([
		listSkills(targetRoot),
		readLibrarySkillNames(),
	]);
	return names.map((name) => ({
		name,
		source: builtIns.has(name) ? "built-in" : "custom",
	}));
};

export const labelInstructions = async (
	targetRoot: string,
): Promise<Array<{ name: string; source: SourceLabel }>> => {
	const [names, builtIns] = await Promise.all([
		listInstructions(targetRoot),
		readLibraryNames("instructions", ".md"),
	]);
	return names.map((name) => ({
		name,
		source: builtIns.has(name) ? "built-in" : "custom",
	}));
};
