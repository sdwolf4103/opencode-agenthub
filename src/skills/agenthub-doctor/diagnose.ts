import path from "node:path";
import { readAgentHubSettings } from "../../composer/settings.js";
import { pathExists } from "./checks/utils.js";
import { checksForCategory } from "./checks/registry.js";

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
		| "omo_baseline_missing"
		| "environment_check";
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
	options?: {
		configRoot?: string;
		workspace?: string;
		category?: "environment" | "home" | "workspace" | "plugin";
	},
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

	const requestedCategory = options?.category;
	const runHomeChecks = !requestedCategory || requestedCategory === "home";
	const categoriesToRun = requestedCategory ? [requestedCategory] : ["home"];

	const settingsPath = path.join(targetRoot, "settings.json");
	if (runHomeChecks && !(await pathExists(settingsPath))) {
		report.issues.push(withIssueDefaults({
			type: "invalid_settings",
			severity: "error",
			message: "settings.json not found",
			details: { path: settingsPath },
			checkId: "home/settings-missing",
			remediation: "Create or restore settings.json in the target Agent Hub home.",
		}));
		report.verdict = computeVerdict(report.issues);
		return report; // Cannot continue without settings
	}

	if (runHomeChecks) {
		report.healthy.push("Settings file exists");
	}

	const settings = await readAgentHubSettings(targetRoot);
	if (runHomeChecks && !settings) {
		report.issues.push(withIssueDefaults({
			type: "invalid_settings",
			severity: "error",
			message: "Failed to read settings.json",
			checkId: "home/settings-unreadable",
			remediation: "Repair the JSON syntax in settings.json or restore it from backup.",
		}));
		report.verdict = computeVerdict(report.issues);
		return report;
	}

	for (const category of categoriesToRun) {
		for (const check of checksForCategory(category)) {
			const result = await check.run({
				targetRoot,
				configRoot: options?.configRoot,
				workspace: options?.workspace,
				category,
				settings,
			});
			for (const healthyItem of result.healthy || []) {
				report.healthy.push(healthyItem);
			}
			for (const issue of result.issues || []) {
				report.issues.push(withIssueDefaults(issue));
			}
		}
	}

	report.verdict = computeVerdict(report.issues);

	return report;
}
