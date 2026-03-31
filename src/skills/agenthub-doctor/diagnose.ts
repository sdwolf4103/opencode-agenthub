import { readdir } from "node:fs/promises";
import path from "node:path";
import { readAgentHubSettings } from "../../composer/settings.js";
import { validateModelIdentifier } from "../../composer/model-utils.js";
import { pathExists, readJson } from "./checks/utils.js";

export interface DiagnosticIssue {
	type:
		| "missing_guards"
		| "orphaned_souls"
		| "orphaned_skills"
		| "no_profiles"
		| "no_bundles"
		| "invalid_settings"
		| "omo_mixed_profile"
		| "model_invalid_syntax"
		| "local_plugins_not_bridged"
		| "local_plugin_source_changed"
		| "omo_baseline_active"
		| "omo_baseline_missing";
	severity: "error" | "warning" | "info";
	message: string;
	details?: unknown;
	checkId?: string;
	remediation?: string;
	autoFixable?: boolean;
	docLink?: string;
}

export interface DiagnosticReport {
	verdict?: "pass" | "warn" | "fail";
	healthy: string[];
	issues: DiagnosticIssue[];
	metadata: {
		targetRoot: string;
		configRoot?: string;
		workspace?: string;
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
const withIssueDefaults = (issue: DiagnosticIssue): DiagnosticIssue => ({
	...issue,
	checkId: issue.checkId ?? issue.type,
	remediation: issue.remediation ?? "Review the reported issue and update the related Agent Hub configuration.",
	autoFixable: issue.autoFixable ?? false,
});

const computeVerdict = (issues: DiagnosticIssue[]): "pass" | "warn" | "fail" => {
	if (issues.some((issue) => issue.severity === "error")) return "fail";
	if (issues.some((issue) => issue.severity === "warning")) return "warn";
	return "pass";
};

export async function runDiagnostics(
	targetRoot: string,
	options?: { configRoot?: string; workspace?: string },
): Promise<DiagnosticReport> {
	const report: DiagnosticReport = {
		healthy: [],
		issues: [],
		metadata: {
			targetRoot,
			...(options?.configRoot ? { configRoot: options.configRoot } : {}),
			...(options?.workspace ? { workspace: options.workspace } : {}),
			timestamp: new Date().toISOString(),
		},
	};

	// Check settings.json exists
	const settingsPath = path.join(targetRoot, "settings.json");
	if (!(await pathExists(settingsPath))) {
		report.issues.push(withIssueDefaults({
			type: "invalid_settings",
			severity: "error",
			message: "settings.json not found",
			details: { path: settingsPath },
			remediation: "Create or restore settings.json in the target Agent Hub home.",
		}));
		report.verdict = computeVerdict(report.issues);
		return report; // Cannot continue without settings
	}
	report.healthy.push("Settings file exists");

	// Load settings
	const settings = await readAgentHubSettings(targetRoot);
	if (!settings) {
		report.issues.push(withIssueDefaults({
			type: "invalid_settings",
			severity: "error",
			message: "Failed to read settings.json",
			remediation: "Repair the JSON syntax in settings.json or restore it from backup.",
		}));
		report.verdict = computeVerdict(report.issues);
		return report;
	}

	// Check for missing guards
	const missingGuards = await diagnoseMissingGuards(settings);
	if (missingGuards.length > 0) {
		report.issues.push(withIssueDefaults({
			type: "missing_guards",
			severity: "warning",
			message: `Missing guards: ${missingGuards.join(", ")}`,
			details: { guards: missingGuards },
			remediation: "Run 'agenthub doctor --fix-all' to recreate the required guard definitions.",
			autoFixable: true,
			docLink: "docs/troubleshooting/guard-and-skill-conflicts.md",
		}));
	} else {
		report.healthy.push("All required guards present");
	}

	// Check for orphaned souls
	const orphanedSouls = await diagnoseOrphanedSouls(targetRoot);
	if (orphanedSouls.length > 0) {
		report.issues.push(withIssueDefaults({
			type: "orphaned_souls",
			severity: "warning",
			message: `${orphanedSouls.length} souls not referenced by any bundle`,
			details: { souls: orphanedSouls },
			remediation: "Create bundles for these souls or remove the unused soul files. 'agenthub doctor --fix-all' can create bundles automatically.",
			autoFixable: true,
			docLink: "docs/troubleshooting/guard-and-skill-conflicts.md",
		}));
	} else {
		report.healthy.push("All souls have bundles");
	}

	// Check for orphaned skills
	const orphanedSkills = await diagnoseOrphanedSkills(targetRoot);
	if (orphanedSkills.length > 0) {
		report.issues.push(withIssueDefaults({
			type: "orphaned_skills",
			severity: "info",
			message: `${orphanedSkills.length} skills not referenced by any bundle`,
			details: { skills: orphanedSkills },
			remediation: "Attach the skills to a bundle or remove them if they are no longer needed.",
			docLink: "docs/troubleshooting/guard-and-skill-conflicts.md",
		}));
	}

	// Check for profiles
	const profilesExist = await diagnoseProfiles(targetRoot);
	if (!profilesExist) {
		report.issues.push(withIssueDefaults({
			type: "no_profiles",
			severity: "error",
			message: "No profiles found - cannot run agents",
			remediation: "Create a profile or import one from another Agent Hub home. 'agenthub doctor --fix-all' can create a starter profile if bundles exist.",
			autoFixable: true,
			docLink: "docs/troubleshooting/compose-failures.md",
		}));
	} else {
		report.healthy.push("Profiles exist");
	}

	// Check for bundles
	const bundlesExist = await diagnoseBundles(targetRoot);
	if (!bundlesExist) {
		report.issues.push(withIssueDefaults({
			type: "no_bundles",
			severity: "error",
			message: "No bundles found - cannot compose agents",
			remediation: "Create or import at least one bundle before composing profiles.",
			docLink: "docs/troubleshooting/compose-failures.md",
		}));
	} else {
		report.healthy.push("Bundles exist");
	}

	// Check for OMO mixed profile issues
	const omoIssue = await diagnoseOmoMixedProfile(targetRoot);
	if (omoIssue) {
		report.issues.push(withIssueDefaults(omoIssue));
	}

	for (const issue of diagnoseInvalidModelSyntax(settings)) {
		report.issues.push(withIssueDefaults(issue));
	}

	for (const issue of await diagnoseLocalPluginBridge(targetRoot, settings)) {
		report.issues.push(withIssueDefaults(issue));
	}

	const omoBaselineIssue = await diagnoseOmoBaseline(settings);
	if (omoBaselineIssue) {
		report.issues.push(withIssueDefaults(omoBaselineIssue));
	}

	report.verdict = computeVerdict(report.issues);

	return report;
}

const diagnoseInvalidModelSyntax = (
	settings: Awaited<ReturnType<typeof readAgentHubSettings>>,
): DiagnosticIssue[] => {
	if (!settings?.agents) return [];
	const issues: DiagnosticIssue[] = [];
	for (const [agentName, agent] of Object.entries(settings.agents)) {
		if (typeof agent.model !== "string" || agent.model.trim().length === 0) continue;
		const syntax = validateModelIdentifier(agent.model);
		if (!syntax.ok) {
			issues.push({
				type: "model_invalid_syntax",
				severity: "error",
				message: `Agent '${agentName}' has an invalid model override: ${syntax.message}`,
				details: { agentName, model: agent.model },
				remediation: "Update the model override to provider/model format, for example openai/gpt-5.4-mini.",
				docLink: "docs/troubleshooting/model-configuration.md",
			});
		}
	}
	return issues;
};

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
					remediation: "Add the no_omo guard to native bundles in mixed OMO profiles, or run 'agenthub doctor --fix-all' if available.",
					autoFixable: true,
					docLink: "docs/troubleshooting/omo-mixed-profile.md",
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

async function diagnoseLocalPluginBridge(
	targetRoot: string,
	settings: Awaited<ReturnType<typeof readAgentHubSettings>>,
): Promise<DiagnosticIssue[]> {
	const issues: DiagnosticIssue[] = [];
	const homeDir = process.env.HOME || "";
	const sourceDir = homeDir
		? path.join(homeDir, ".config", "opencode", "plugins")
		: "";
	if (!sourceDir || !(await pathExists(sourceDir))) return issues;
	const entries = await readdir(sourceDir, { withFileTypes: true });
	const sourcePlugins = entries
		.filter((entry) => entry.isFile() && /\.(ts|js|mjs|cjs)$/i.test(entry.name))
		.map((entry) => entry.name)
		.sort();
	if (sourcePlugins.length === 0) return issues;
	if (settings?.localPlugins?.bridge === false) {
		issues.push({
			type: "local_plugins_not_bridged",
			severity: "info",
			message: `Local plugins exist in ${sourceDir} but bridge is disabled. Set localPlugins.bridge = true to copy them into the runtime.`,
			remediation: "Set localPlugins.bridge = true in settings.json, then re-compose your workspace runtime.",
			docLink: "docs/troubleshooting/plugin-degraded-mode.md",
			details: { sourceDir, plugins: sourcePlugins },
		});
		return issues;
	}
	issues.push({
		type: "local_plugin_source_changed",
		severity: "info",
		message: `Local plugin bridge is enabled. Re-compose workspaces after changing plugins in ${sourceDir}.`,
		remediation: "Run 'agenthub start <profile>' or 'agenthub hr <profile>' again to refresh copied plugin files.",
		docLink: "docs/troubleshooting/plugin-degraded-mode.md",
		details: { sourceDir, plugins: sourcePlugins },
	});
	return issues;
}

async function diagnoseOmoBaseline(
	settings: Awaited<ReturnType<typeof readAgentHubSettings>>,
): Promise<DiagnosticIssue | null> {
	const homeDir = process.env.HOME || "";
	const baselinePath = homeDir
		? path.join(homeDir, ".config", "opencode", "oh-my-opencode.json")
		: "";
	if (settings?.omoBaseline === "ignore") {
		return null;
	}
	if (baselinePath && (await pathExists(baselinePath))) {
		return {
			type: "omo_baseline_active",
			severity: "info",
			message: `Global OMO baseline is active from ${baselinePath}. Set omoBaseline = "ignore" in settings.json to isolate Agent Hub runtime from it.`,
			remediation: "Set omoBaseline = \"ignore\" in settings.json if you want Agent Hub runtime to stop inheriting the global baseline.",
			docLink: "docs/troubleshooting/omo-mixed-profile.md",
			details: { baselinePath },
		};
	}
	if (!settings?.omo?.defaultCategoryModel) {
		return null;
	}
	return {
		type: "omo_baseline_missing",
		severity: "info",
		message: "OMO baseline mode is inherit, but no global oh-my-opencode.json was found.",
		remediation: "Create a global oh-my-opencode.json if you want shared OMO categories, or set omoBaseline = \"ignore\" to silence this informational check.",
		docLink: "docs/troubleshooting/omo-mixed-profile.md",
	};
}
