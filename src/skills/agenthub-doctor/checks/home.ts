import { readdir } from "node:fs/promises";
import path from "node:path";

import { validateModelIdentifier } from "../../../composer/model-utils.js";
import type { AgentHubSettings } from "../../../composer/settings.js";
import type { DiagnosticCheck } from "./types.js";
import { pathExists, readJson } from "./utils.js";

const REQUIRED_GUARDS = ["read_only", "no_task", "no_omo"];

const diagnoseMissingGuards = (settings: AgentHubSettings | null): string[] => {
	const existingGuards = Object.keys(settings?.guards || {});
	return REQUIRED_GUARDS.filter((guard) => !existingGuards.includes(guard));
};


const diagnoseInvalidModelSyntax = (settings: AgentHubSettings | null) => {
	const agents = settings?.agents ?? {};
	return Object.entries(agents).flatMap(([agentName, agent]) => {
		if (typeof agent.model !== "string" || agent.model.trim().length === 0) return [];
		const syntax = validateModelIdentifier(agent.model);
		if (syntax.ok) return [];
		return [
			{
				type: "model_invalid_syntax" as const,
				severity: "error" as const,
				message: `Agent '${agentName}' has an invalid model override: ${syntax.message}`,
				details: { agentName, model: agent.model },
				remediation:
					"Update the model override to provider/model format, for example openai/gpt-5.4-mini.",
				docLink: "docs/troubleshooting/model-configuration.md",
				checkId: "home/model-invalid-syntax",
			},
		];
	});
};

const diagnoseOrphanedSouls = async (targetRoot: string): Promise<string[]> => {
	const soulsDir = path.join(targetRoot, "souls");
	if (!(await pathExists(soulsDir))) return [];
	const entries = await readdir(soulsDir, { withFileTypes: true });
	const soulNames = entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.map((entry) => entry.name.replace(/\.md$/, ""));
	const bundlesDir = path.join(targetRoot, "bundles");
	if (!(await pathExists(bundlesDir))) return soulNames;
	const bundleEntries = await readdir(bundlesDir, { withFileTypes: true });
	const referencedSouls = new Set<string>();
	for (const entry of bundleEntries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		try {
			const bundlePath = path.join(bundlesDir, entry.name);
			const bundle = await readJson<{ soul?: string }>(bundlePath);
			if (bundle.soul) referencedSouls.add(bundle.soul);
		} catch {
			// ignore invalid bundle during diagnostics
		}
	}
	return soulNames.filter((soul) => !referencedSouls.has(soul));
};

const diagnoseOrphanedSkills = async (targetRoot: string): Promise<string[]> => {
	const skillsDir = path.join(targetRoot, "skills");
	if (!(await pathExists(skillsDir))) return [];
	const entries = await readdir(skillsDir, { withFileTypes: true });
	const skillNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	const bundlesDir = path.join(targetRoot, "bundles");
	if (!(await pathExists(bundlesDir))) return skillNames;
	const bundleEntries = await readdir(bundlesDir, { withFileTypes: true });
	const referencedSkills = new Set<string>();
	for (const entry of bundleEntries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		try {
			const bundlePath = path.join(bundlesDir, entry.name);
			const bundle = await readJson<{ skills?: string[] }>(bundlePath);
			for (const skill of bundle.skills || []) referencedSkills.add(skill);
		} catch {
			// ignore invalid bundle during diagnostics
		}
	}
	return skillNames.filter((skill) => !referencedSkills.has(skill));
};

const hasProfiles = async (targetRoot: string): Promise<boolean> => {
	const profilesDir = path.join(targetRoot, "profiles");
	if (!(await pathExists(profilesDir))) return false;
	const entries = await readdir(profilesDir, { withFileTypes: true });
	return entries.some((entry) => entry.isFile() && entry.name.endsWith(".json"));
};

const hasBundles = async (targetRoot: string): Promise<boolean> => {
	const bundlesDir = path.join(targetRoot, "bundles");
	if (!(await pathExists(bundlesDir))) return false;
	const entries = await readdir(bundlesDir, { withFileTypes: true });
	return entries.some((entry) => entry.isFile() && entry.name.endsWith(".json"));
};

const diagnoseOmoMixedProfile = async (targetRoot: string) => {
	const profilesDir = path.join(targetRoot, "profiles");
	if (!(await pathExists(profilesDir))) return null;
	const profileEntries = await readdir(profilesDir, { withFileTypes: true });
	for (const profileEntry of profileEntries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))) {
		const profilePath = path.join(profilesDir, profileEntry.name);
		try {
			const profile = await readJson<{ bundles?: string[] }>(profilePath);
			if (!profile.bundles?.length) continue;
			const bundlesDir = path.join(targetRoot, "bundles");
			const omoBundles: string[] = [];
			const nativeWithoutOmoGuard: string[] = [];
			for (const bundleName of profile.bundles) {
				const bundlePath = path.join(bundlesDir, `${bundleName}.json`);
				if (!(await pathExists(bundlePath))) continue;
				const bundle = await readJson<{ runtime?: string; guards?: string[] }>(bundlePath);
				const runtime = bundle.runtime || "native";
				if (runtime === "omo") omoBundles.push(bundleName);
				else if (runtime === "native" && !bundle.guards?.includes("no_omo")) nativeWithoutOmoGuard.push(bundleName);
			}
			if (omoBundles.length > 0 && nativeWithoutOmoGuard.length > 0) {
				return {
					type: "omo_mixed_profile" as const,
					severity: "warning" as const,
					message: `Profile '${profileEntry.name.replace(".json", "")}' has OMO bundles but native agents lack no_omo guard`,
					remediation:
						"Add the no_omo guard to native bundles in mixed OMO profiles, or run 'agenthub doctor --fix-all' if available.",
					autoFixable: true,
					docLink: "docs/troubleshooting/guard-and-skill-conflicts.md",
					checkId: "home/omo-mixed-profile",
					details: {
						profile: profileEntry.name.replace(".json", ""),
						omoBundles,
						nativeWithoutOmoGuard,
					},
				};
			}
		} catch {
			// ignore invalid profile during diagnostics
		}
	}
	return null;
};

const diagnoseLocalPluginBridge = async (settings: AgentHubSettings | null) => {
	const homeDir = process.env.HOME || "";
	const sourceDir = homeDir ? path.join(homeDir, ".config", "opencode", "plugins") : "";
	if (!sourceDir || !(await pathExists(sourceDir))) return [];
	const entries = await readdir(sourceDir, { withFileTypes: true });
	const sourcePlugins = entries
		.filter((entry) => entry.isFile() && /\.(ts|js|mjs|cjs)$/i.test(entry.name))
		.map((entry) => entry.name)
		.sort();
	if (sourcePlugins.length === 0) return [];
	if (settings?.localPlugins?.bridge === false) {
		return [
			{
				type: "local_plugins_not_bridged" as const,
				severity: "info" as const,
				message: `Local plugins exist in ${sourceDir} but bridge is disabled. Set localPlugins.bridge = true to copy them into the runtime.`,
				remediation:
					"Set localPlugins.bridge = true in settings.json, then re-compose your workspace runtime.",
				docLink: "docs/troubleshooting/plugin-degraded-mode.md",
				checkId: "home/local-plugin-bridge",
				details: { sourceDir, plugins: sourcePlugins },
			},
		];
	}
	return [
		{
			type: "local_plugin_source_changed" as const,
			severity: "info" as const,
			message: `Local plugin bridge is enabled. Re-compose workspaces after changing plugins in ${sourceDir}.`,
			remediation:
				"Run 'agenthub start <profile>' or 'agenthub hr <profile>' again to refresh copied plugin files.",
			docLink: "docs/troubleshooting/plugin-degraded-mode.md",
			checkId: "home/local-plugin-refresh",
			details: { sourceDir, plugins: sourcePlugins },
		},
	];
};

const diagnoseOmoBaseline = async (settings: AgentHubSettings | null) => {
	const homeDir = process.env.HOME || "";
	const baselinePath = homeDir ? path.join(homeDir, ".config", "opencode", "oh-my-opencode.json") : "";
	if (settings?.omoBaseline === "ignore") return null;
	if (baselinePath && (await pathExists(baselinePath))) {
		return {
			type: "omo_baseline_active" as const,
			severity: "info" as const,
			message: `Global OMO baseline is active from ${baselinePath}. Set omoBaseline = "ignore" in settings.json to isolate Agent Hub runtime from it.`,
			remediation:
				"Set omoBaseline = \"ignore\" in settings.json if you want Agent Hub runtime to stop inheriting the global baseline.",
			docLink: "docs/troubleshooting/guard-and-skill-conflicts.md",
			checkId: "home/omo-baseline-active",
			details: { baselinePath },
		};
	}
	const defaultCategoryModel = settings?.omo?.defaultCategoryModel;
	if (!defaultCategoryModel) return null;
	return {
		type: "omo_baseline_missing" as const,
		severity: "info" as const,
		message: "OMO baseline mode is inherit, but no global oh-my-opencode.json was found.",
		remediation:
			"Create a global oh-my-opencode.json if you want shared OMO categories, or set omoBaseline = \"ignore\" to silence this informational check.",
		docLink: "docs/troubleshooting/guard-and-skill-conflicts.md",
		checkId: "home/omo-baseline-missing",
	};
};

export const homeChecks: DiagnosticCheck[] = [
	{
		id: "home/missing-guards",
		category: "home",
		async run(ctx) {
			const missingGuards = diagnoseMissingGuards(ctx.settings);
			return missingGuards.length > 0
				? {
					issues: [
						{
							type: "missing_guards",
							severity: "warning",
							message: `Missing guards: ${missingGuards.join(", ")}`,
							details: { guards: missingGuards },
							remediation: "Run 'agenthub doctor --fix-all' to recreate the required guard definitions.",
							autoFixable: true,
							docLink: "docs/troubleshooting/guard-and-skill-conflicts.md",
							checkId: "home/missing-guards",
						},
					],
				}
				: { healthy: ["All required guards present"] };
		},
	},
	{
		id: "home/orphaned-souls",
		category: "home",
		async run(ctx) {
			const orphanedSouls = await diagnoseOrphanedSouls(ctx.targetRoot);
			return orphanedSouls.length > 0
				? {
					issues: [
						{
							type: "orphaned_souls",
							severity: "warning",
							message: `${orphanedSouls.length} souls not referenced by any bundle`,
							details: { souls: orphanedSouls },
							remediation:
								"Create bundles for these souls or remove the unused soul files. 'agenthub doctor --fix-all' can create bundles automatically.",
							autoFixable: true,
							docLink: "docs/troubleshooting/guard-and-skill-conflicts.md",
							checkId: "home/orphaned-souls",
						},
					],
				}
				: { healthy: ["All souls have bundles"] };
		},
	},
	{
		id: "home/orphaned-skills",
		category: "home",
		async run(ctx) {
			const orphanedSkills = await diagnoseOrphanedSkills(ctx.targetRoot);
			return orphanedSkills.length > 0
				? {
					issues: [
						{
							type: "orphaned_skills",
							severity: "info",
							message: `${orphanedSkills.length} skills not referenced by any bundle`,
							details: { skills: orphanedSkills },
							remediation: "Attach the skills to a bundle or remove them if they are no longer needed.",
							docLink: "docs/troubleshooting/guard-and-skill-conflicts.md",
							checkId: "home/orphaned-skills",
						},
					],
				}
				: {};
		},
	},
	{
		id: "home/profiles",
		category: "home",
		async run(ctx) {
			const profilesExist = await hasProfiles(ctx.targetRoot);
			return profilesExist
				? { healthy: ["Profiles exist"] }
				: {
					issues: [
						{
							type: "no_profiles",
							severity: "error",
							message: "No profiles found - cannot run agents",
							remediation:
								"Create a profile or import one from another Agent Hub home. 'agenthub doctor --fix-all' can create a starter profile if bundles exist.",
							autoFixable: true,
							docLink: "docs/troubleshooting/compose-failures.md",
							checkId: "home/profiles",
						},
					],
				};
		},
	},
	{
		id: "home/bundles",
		category: "home",
		async run(ctx) {
			const bundlesExist = await hasBundles(ctx.targetRoot);
			return bundlesExist
				? { healthy: ["Bundles exist"] }
				: {
					issues: [
						{
							type: "no_bundles",
							severity: "error",
							message: "No bundles found - cannot compose agents",
							remediation: "Create or import at least one bundle before composing profiles.",
							docLink: "docs/troubleshooting/compose-failures.md",
							checkId: "home/bundles",
						},
					],
				};
		},
	},
	{
		id: "home/omo-mixed-profile",
		category: "home",
		async run(ctx) {
			const issue = await diagnoseOmoMixedProfile(ctx.targetRoot);
			return issue ? { issues: [issue] } : {};
		},
	},
	{
		id: "home/model-invalid-syntax",
		category: "home",
		async run(ctx) {
			return { issues: diagnoseInvalidModelSyntax(ctx.settings) };
		},
	},
	{
		id: "home/local-plugin-bridge",
		category: "home",
		async run(ctx) {
			return { issues: await diagnoseLocalPluginBridge(ctx.settings) };
		},
	},
	{
		id: "home/omo-baseline",
		category: "home",
		async run(ctx) {
			const issue = await diagnoseOmoBaseline(ctx.settings);
			return issue ? { issues: [issue] } : {};
		},
	},
];
