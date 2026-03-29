import path from "node:path";
import { readdir, readFile, writeFile, access } from "node:fs/promises";
import { getDefaultProfilePlugins } from "../../composer/defaults.js";
import { readAgentHubSettings, writeAgentHubSettings } from "../../composer/settings.js";
import type { AgentHubSettings } from "../../types.js";

// Utility functions
const readJson = async <T>(filePath: string): Promise<T> => {
	const content = await readFile(filePath, "utf-8");
	return JSON.parse(content) as T;
};

const writeJson = async (filePath: string, data: unknown): Promise<void> => {
	await writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
};

const pathExists = async (p: string): Promise<boolean> => {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
};

/**
 * Default guard definitions
 */
const DEFAULT_GUARDS = {
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
		description: "Block OMO (Oh-My-OpenCode) multi-agent calls - for native agents in OMO profiles",
		blockedTools: ["call_omo_agent"],
		permission: {
			call_omo_agent: "deny",
		},
	},
};

export interface FixResult {
	success: boolean;
	message: string;
	details?: unknown;
}

/**
 * Add missing default guards to settings.json
 */
export async function fixMissingGuards(
	targetRoot: string,
	guardsToAdd: string[],
): Promise<FixResult> {
	try {
		const settings = await readAgentHubSettings(targetRoot);
		if (!settings) {
			return {
				success: false,
				message: "settings.json not found or invalid",
			};
		}

		// Initialize guards if it doesn't exist
		if (!settings.guards) {
			settings.guards = {};
		}

		// Add missing guards
		let addedCount = 0;
		for (const guardName of guardsToAdd) {
			if (!settings.guards[guardName] && DEFAULT_GUARDS[guardName as keyof typeof DEFAULT_GUARDS]) {
				settings.guards[guardName] = DEFAULT_GUARDS[guardName as keyof typeof DEFAULT_GUARDS];
				addedCount++;
			}
		}

		// Write back to settings.json
		await writeAgentHubSettings(targetRoot, settings);

		return {
			success: true,
			message: `Added ${addedCount} guard(s) to settings.json`,
			details: { guards: guardsToAdd },
		};
	} catch (error) {
		return {
			success: false,
			message: `Failed to fix guards: ${(error as Error).message}`,
		};
	}
}

type AgentMode = "primary" | "subagent";

type BundleAgentReference = {
	bundleName: string;
	agentName: string;
};

const readBundleAgentReferences = async (
	targetRoot: string,
	bundleNames: string[],
): Promise<BundleAgentReference[]> =>
	Promise.all(
		bundleNames.map(async (bundleName) => {
			const bundlePath = path.join(targetRoot, "bundles", `${bundleName}.json`);
			if (!(await pathExists(bundlePath))) {
				throw new Error(`Bundle '${bundleName}' not found in ${path.join(targetRoot, "bundles")}.`);
			}
			const bundle = await readJson<{ agent?: { name?: string } }>(bundlePath);
			const agentName = bundle.agent?.name?.trim();
			if (!agentName) {
				throw new Error(`Bundle '${bundleName}' is missing required agent.name.`);
			}
			return { bundleName, agentName };
		}),
	);

export async function resolveDefaultAgentForBundles(
	targetRoot: string,
	bundleNames: string[],
	requestedDefaultAgent?: string,
): Promise<string> {
	const references = await readBundleAgentReferences(targetRoot, bundleNames);
	const explicitDefaultAgent = requestedDefaultAgent?.trim();
	if (explicitDefaultAgent) {
		const bundleMatch = references.find(
			(reference) => reference.bundleName === explicitDefaultAgent,
		);
		if (bundleMatch && bundleMatch.agentName !== explicitDefaultAgent) {
			throw new Error(
				`Default agent '${explicitDefaultAgent}' matches bundle name, but profile defaultAgent must use bundle agent.name '${bundleMatch.agentName}'.`,
			);
		}
		if (references.some((reference) => reference.agentName === explicitDefaultAgent)) {
			return explicitDefaultAgent;
		}
		return explicitDefaultAgent;
	}

	return references[0].agentName;
}

type CreateBundleOptions = {
	agentName?: string;
	mode?: AgentMode;
	model?: string;
	skills?: string[];
	mcp?: string[];
	guards?: string[];
};

/**
 * Create a bundle for an orphaned soul
 */
export async function createBundleForSoul(
	targetRoot: string,
	soulName: string,
	options: CreateBundleOptions = {},
): Promise<FixResult> {
	try {
		const bundlesDir = path.join(targetRoot, "bundles");
		const bundlePath = path.join(bundlesDir, `${soulName}.json`);

		// Check if bundle already exists
		if (await pathExists(bundlePath)) {
			return {
				success: false,
				message: `Bundle '${soulName}' already exists`,
			};
		}

		// Create bundle
		const bundle: Record<string, unknown> = {
			name: soulName,
			runtime: "native",
			soul: soulName,
			skills: options.skills || [],
			mcp: options.mcp || [],
			agent: {
				name: options.agentName ?? soulName,
				mode: options.mode ?? "primary",
				model: options.model ?? "",
				description: "Auto-generated bundle for imported soul",
			},
		};

		if (options.guards && options.guards.length > 0) {
			bundle.guards = options.guards;
		}

		await writeJson(bundlePath, bundle);

		return {
			success: true,
			message: `Created bundle '${soulName}'`,
			details: { path: bundlePath },
		};
	} catch (error) {
		return {
			success: false,
			message: `Failed to create bundle for '${soulName}': ${(error as Error).message}`,
		};
	}
}

/**
 * Create bundles for multiple orphaned souls
 */
export async function createBundlesForSouls(
	targetRoot: string,
	soulNames: string[],
	options: {
		model?: string;
		skills?: string[];
		mcp?: string[];
	} = {},
): Promise<FixResult> {
	const results: FixResult[] = [];
	
	for (const soulName of soulNames) {
		const result = await createBundleForSoul(targetRoot, soulName, options);
		results.push(result);
	}

	const successCount = results.filter((r) => r.success).length;
	const failureCount = results.length - successCount;

	return {
		success: successCount > 0,
		message: `Created ${successCount} bundle(s)${failureCount > 0 ? `, ${failureCount} failed` : ""}`,
		details: { results },
	};
}

/**
 * Create a profile that references bundles
 */
export async function createProfile(
	targetRoot: string,
	profileName: string,
	options: {
		bundleNames?: string[];
		description?: string;
		defaultAgent?: string;
	} = {},
): Promise<FixResult> {
	try {
		const profilesDir = path.join(targetRoot, "profiles");
		const profilePath = path.join(profilesDir, `${profileName}.json`);

		// Check if profile already exists
		if (await pathExists(profilePath)) {
			return {
				success: false,
				message: `Profile '${profileName}' already exists`,
			};
		}

		// Get all bundles if not specified
		let bundleNames = options.bundleNames;
		if (!bundleNames) {
			bundleNames = await getAllBundleNames(targetRoot);
		}

		if (bundleNames.length === 0) {
			return {
				success: false,
				message: "No bundles found to include in profile",
			};
		}
		const defaultAgent = await resolveDefaultAgentForBundles(
			targetRoot,
			bundleNames,
			options.defaultAgent,
		);

		// Create profile
		const profile = {
			name: profileName,
			description: options.description || "Auto-generated profile for imported assets",
			bundles: bundleNames,
			defaultAgent,
			plugins: getDefaultProfilePlugins(),
		};

		await writeJson(profilePath, profile);

		return {
			success: true,
			message: `Created profile '${profileName}' with ${bundleNames.length} bundle(s)`,
			details: { path: profilePath, bundles: bundleNames },
		};
	} catch (error) {
		return {
			success: false,
			message: `Failed to create profile '${profileName}': ${(error as Error).message}`,
		};
	}
}

/**
 * Get all bundle names from the bundles directory
 */
async function getAllBundleNames(targetRoot: string): Promise<string[]> {
	const bundlesDir = path.join(targetRoot, "bundles");
	if (!(await pathExists(bundlesDir))) return [];

	const entries = await readdir(bundlesDir, { withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => entry.name.replace(/\.json$/, ""));
}

/**
 * Comprehensive fix that handles all common issues
 */
export async function validateAndFix(
	targetRoot: string,
	options: {
		fixGuards?: boolean;
		createBundles?: boolean;
		createProfile?: boolean;
		profileName?: string;
		model?: string;
	} = {},
): Promise<FixResult[]> {
	const results: FixResult[] = [];

	// Fix missing guards
	if (options.fixGuards) {
		const guardsResult = await fixMissingGuards(targetRoot, [
			"read_only",
			"no_task",
			"no_omo",
		]);
		results.push(guardsResult);
	}

	// Create bundles for orphaned souls
	if (options.createBundles) {
		const { runDiagnostics } = await import("./diagnose.js");
		const report = await runDiagnostics(targetRoot);
		const orphanedSoulsIssue = report.issues.find((i) => i.type === "orphaned_souls");
		
		if (orphanedSoulsIssue && orphanedSoulsIssue.details) {
			const souls = (orphanedSoulsIssue.details as { souls: string[] }).souls;
			if (souls.length > 0) {
				const bundlesResult = await createBundlesForSouls(targetRoot, souls, {
					model: options.model,
				});
				results.push(bundlesResult);
			}
		}
	}

	// Create profile
	if (options.createProfile) {
		const profileResult = await createProfile(
			targetRoot,
			options.profileName || "imported",
		);
		results.push(profileResult);
	}

	return results;
}

/**
 * Fix OMO mixed profile issue by adding no_omo guard to native agents
 */
export async function fixOmoMixedProfile(
	targetRoot: string,
	details: {
		profile: string;
		omoBundles: string[];
		nativeWithoutOmoGuard: string[];
	},
): Promise<FixResult> {
	try {
		const bundlesDir = path.join(targetRoot, "bundles");
		const fixed: string[] = [];

		for (const bundleName of details.nativeWithoutOmoGuard) {
			const bundlePath = path.join(bundlesDir, `${bundleName}.json`);
			if (!(await pathExists(bundlePath))) continue;

			const bundle = await readJson<{
				guards?: string[];
			}>(bundlePath);

			// Add no_omo guard if not already present
			if (!bundle.guards?.includes("no_omo")) {
				bundle.guards = [...(bundle.guards || []), "no_omo"];
				await writeJson(bundlePath, bundle);
				fixed.push(bundleName);
			}
		}

		if (fixed.length === 0) {
			return {
				success: true,
				message: "All native agents already have no_omo guard",
			};
		}

		return {
			success: true,
			message: `Added no_omo guard to ${fixed.length} native agent(s): ${fixed.join(", ")}`,
			details: { fixed },
		};
	} catch (error) {
		return {
			success: false,
			message: `Failed to fix OMO mixed profile: ${(error as Error).message}`,
		};
	}
}
