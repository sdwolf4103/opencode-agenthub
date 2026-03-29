import { readdir, readFile, access } from "node:fs/promises";
import path from "node:path";
import { readAgentHubSettings } from "../../composer/settings.js";

// Utility functions
const readJson = async <T>(filePath: string): Promise<T> => {
	const content = await readFile(filePath, "utf-8");
	return JSON.parse(content) as T;
};

const pathExists = async (p: string): Promise<boolean> => {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
};

export interface DiagnosticIssue {
	type: "missing_guards" | "orphaned_souls" | "orphaned_skills" | "no_profiles" | "no_bundles" | "invalid_settings" | "omo_mixed_profile";
	severity: "error" | "warning" | "info";
	message: string;
	details?: unknown;
}

export interface DiagnosticReport {
	healthy: string[];
	issues: DiagnosticIssue[];
	metadata: {
		targetRoot: string;
		timestamp: string;
	};
}

/**
 * Required default guards that should exist in settings.json
 */
const REQUIRED_GUARDS = ["read_only", "no_task", "no_omo"];

/**
 * Run comprehensive diagnostics on Agent Hub installation
 */
export async function runDiagnostics(targetRoot: string): Promise<DiagnosticReport> {
	const report: DiagnosticReport = {
		healthy: [],
		issues: [],
		metadata: {
			targetRoot,
			timestamp: new Date().toISOString(),
		},
	};

	// Check settings.json exists
	const settingsPath = path.join(targetRoot, "settings.json");
	if (!(await pathExists(settingsPath))) {
		report.issues.push({
			type: "invalid_settings",
			severity: "error",
			message: "settings.json not found",
			details: { path: settingsPath },
		});
		return report; // Cannot continue without settings
	}
	report.healthy.push("Settings file exists");

	// Load settings
	const settings = await readAgentHubSettings(targetRoot);
	if (!settings) {
		report.issues.push({
			type: "invalid_settings",
			severity: "error",
			message: "Failed to read settings.json",
		});
		return report;
	}

	// Check for missing guards
	const missingGuards = await diagnoseMissingGuards(settings);
	if (missingGuards.length > 0) {
		report.issues.push({
			type: "missing_guards",
			severity: "warning",
			message: `Missing guards: ${missingGuards.join(", ")}`,
			details: { guards: missingGuards },
		});
	} else {
		report.healthy.push("All required guards present");
	}

	// Check for orphaned souls
	const orphanedSouls = await diagnoseOrphanedSouls(targetRoot);
	if (orphanedSouls.length > 0) {
		report.issues.push({
			type: "orphaned_souls",
			severity: "warning",
			message: `${orphanedSouls.length} souls not referenced by any bundle`,
			details: { souls: orphanedSouls },
		});
	} else {
		report.healthy.push("All souls have bundles");
	}

	// Check for orphaned skills
	const orphanedSkills = await diagnoseOrphanedSkills(targetRoot);
	if (orphanedSkills.length > 0) {
		report.issues.push({
			type: "orphaned_skills",
			severity: "info",
			message: `${orphanedSkills.length} skills not referenced by any bundle`,
			details: { skills: orphanedSkills },
		});
	}

	// Check for profiles
	const profilesExist = await diagnoseProfiles(targetRoot);
	if (!profilesExist) {
		report.issues.push({
			type: "no_profiles",
			severity: "error",
			message: "No profiles found - cannot run agents",
		});
	} else {
		report.healthy.push("Profiles exist");
	}

	// Check for bundles
	const bundlesExist = await diagnoseBundles(targetRoot);
	if (!bundlesExist) {
		report.issues.push({
			type: "no_bundles",
			severity: "error",
			message: "No bundles found - cannot compose agents",
		});
	} else {
		report.healthy.push("Bundles exist");
	}

	// Check for OMO mixed profile issues
	const omoIssue = await diagnoseOmoMixedProfile(targetRoot);
	if (omoIssue) {
		report.issues.push(omoIssue);
	}

	return report;
}

/**
 * Check for missing required guards in settings
 */
async function diagnoseMissingGuards(settings: Awaited<ReturnType<typeof readAgentHubSettings>>): Promise<string[]> {
	if (!settings) return REQUIRED_GUARDS;
	
	const existingGuards = Object.keys(settings.guards || {});
	return REQUIRED_GUARDS.filter((guard) => !existingGuards.includes(guard));
}

/**
 * Find souls that are not referenced by any bundle
 */
async function diagnoseOrphanedSouls(targetRoot: string): Promise<string[]> {
	const soulsDir = path.join(targetRoot, "souls");
	if (!(await pathExists(soulsDir))) return [];

	// Get all soul files
	const entries = await readdir(soulsDir, { withFileTypes: true });
	const soulNames = entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.map((entry) => entry.name.replace(/\.md$/, ""));

	// Get all bundles and their referenced souls
	const bundlesDir = path.join(targetRoot, "bundles");
	if (!(await pathExists(bundlesDir))) return soulNames; // All souls orphaned if no bundles

	const bundleEntries = await readdir(bundlesDir, { withFileTypes: true });
	const referencedSouls = new Set<string>();

	for (const entry of bundleEntries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		
		try {
			const bundlePath = path.join(bundlesDir, entry.name);
			const bundle = await readJson<{ soul?: string }>(bundlePath);
			if (bundle.soul) {
				referencedSouls.add(bundle.soul);
			}
		} catch {
			// Skip invalid bundles
		}
	}

	return soulNames.filter((soul) => !referencedSouls.has(soul));
}

/**
 * Find skills that are not referenced by any bundle
 */
async function diagnoseOrphanedSkills(targetRoot: string): Promise<string[]> {
	const skillsDir = path.join(targetRoot, "skills");
	if (!(await pathExists(skillsDir))) return [];

	// Get all skill directories
	const entries = await readdir(skillsDir, { withFileTypes: true });
	const skillNames = entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);

	// Get all bundles and their referenced skills
	const bundlesDir = path.join(targetRoot, "bundles");
	if (!(await pathExists(bundlesDir))) return skillNames; // All skills orphaned if no bundles

	const bundleEntries = await readdir(bundlesDir, { withFileTypes: true });
	const referencedSkills = new Set<string>();

	for (const entry of bundleEntries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		
		try {
			const bundlePath = path.join(bundlesDir, entry.name);
			const bundle = await readJson<{ skills?: string[] }>(bundlePath);
			if (bundle.skills) {
				for (const skill of bundle.skills) {
					referencedSkills.add(skill);
				}
			}
		} catch {
			// Skip invalid bundles
		}
	}

	return skillNames.filter((skill) => !referencedSkills.has(skill));
}

/**
 * Check if any profiles exist
 */
async function diagnoseProfiles(targetRoot: string): Promise<boolean> {
	const profilesDir = path.join(targetRoot, "profiles");
	if (!(await pathExists(profilesDir))) return false;

	const entries = await readdir(profilesDir, { withFileTypes: true });
	return entries.some((entry) => entry.isFile() && entry.name.endsWith(".json"));
}

/**
 * Check if any bundles exist
 */
async function diagnoseBundles(targetRoot: string): Promise<boolean> {
	const bundlesDir = path.join(targetRoot, "bundles");
	if (!(await pathExists(bundlesDir))) return false;

	const entries = await readdir(bundlesDir, { withFileTypes: true });
	return entries.some((entry) => entry.isFile() && entry.name.endsWith(".json"));
}

/**
 * Check for OMO mixed profile issues
 * When a profile contains both OMO and native bundles,
 * native agents should have no_omo guard to prevent accidental OMO calls
 */
async function diagnoseOmoMixedProfile(
	targetRoot: string,
): Promise<DiagnosticIssue | null> {
	const profilesDir = path.join(targetRoot, "profiles");
	if (!(await pathExists(profilesDir))) return null;

	const profileEntries = await readdir(profilesDir, { withFileTypes: true });
	const profileFiles = profileEntries.filter(
		(e) => e.isFile() && e.name.endsWith(".json"),
	);

	for (const profileEntry of profileFiles) {
		const profilePath = path.join(profilesDir, profileEntry.name);
		try {
			const profile = await readJson<{ bundles?: string[] }>(profilePath);
			if (!profile.bundles || profile.bundles.length === 0) continue;

			// Check each bundle in the profile
			const bundlesDir = path.join(targetRoot, "bundles");
			const omoBundles: string[] = [];
			const nativeWithoutOmoGuard: string[] = [];

			for (const bundleName of profile.bundles) {
				const bundlePath = path.join(bundlesDir, `${bundleName}.json`);
				if (!(await pathExists(bundlePath))) continue;

				const bundle = await readJson<{
					runtime?: string;
					guards?: string[];
				}>(bundlePath);

				const runtime = bundle.runtime || "native";

				if (runtime === "omo") {
					omoBundles.push(bundleName);
				} else if (runtime === "native") {
					// Check if native bundle has no_omo guard
					if (!bundle.guards?.includes("no_omo")) {
						nativeWithoutOmoGuard.push(bundleName);
					}
				}
			}

			// If profile has both OMO and native without guard, report issue
			if (omoBundles.length > 0 && nativeWithoutOmoGuard.length > 0) {
				return {
					type: "omo_mixed_profile",
					severity: "warning",
					message: `Profile '${profileEntry.name.replace(".json", "")}' has OMO bundles but native agents lack no_omo guard`,
					details: {
						profile: profileEntry.name.replace(".json", ""),
						omoBundles,
						nativeWithoutOmoGuard,
					},
				};
			}
		} catch {
			// Skip invalid profiles
		}
	}

	return null;
}
