import type { DiagnosticCheck } from "./types.js";
import { inspectRuntimeConfig, summarizeRuntimeFeatureState } from "../../../plugins/runtime-config.js";
import { readBinaryVersion, resolveOnPath } from "./utils.js";

const environmentChecks: DiagnosticCheck[] = [
	{
		id: "environment/node",
		category: "environment",
		async run() {
			const nodePath = await resolveOnPath("node");
			if (!nodePath) {
				return {
					issues: [
						{
							type: "environment_check",
							severity: "info",
							message: "Node.js was not found on PATH.",
							remediation: "Install Node.js or ensure it is available on PATH if your Agent Hub workflows depend on it.",
							checkId: "environment/node",
							autoFixable: false,
						},
					],
				};
			}
			const version = await readBinaryVersion(nodePath);
			return {
				healthy: [`Node.js available: ${version || nodePath}`],
			};
		},
	},
	{
		id: "environment/opencode",
		category: "environment",
		async run() {
			const opencodePath = await resolveOnPath("opencode");
			if (!opencodePath) {
				return {
					issues: [
						{
							type: "environment_check",
							severity: "warning",
							message: "opencode was not found on PATH.",
							remediation: "Install opencode or add it to PATH so composed Agent Hub runtimes can be launched reliably.",
							checkId: "environment/opencode",
							autoFixable: false,
							docLink: "docs/troubleshooting/environment-setup.md",
						},
					],
				};
			}
			const version = await readBinaryVersion(opencodePath);
			return {
				healthy: [`opencode available: ${version || opencodePath}`],
			};
		},
	},
	{
		id: "environment/python",
		category: "environment",
		async run() {
			const pythonPath = (await resolveOnPath("python3")) || (await resolveOnPath("python"));
			if (!pythonPath) {
				return {
					issues: [
						{
							type: "environment_check",
							severity: "info",
							message: "Python was not found on PATH.",
							remediation: "Install python3 if you plan to use HR validation or Python-based helper workflows.",
							checkId: "environment/python",
							autoFixable: false,
							docLink: "docs/troubleshooting/environment-setup.md",
						},
					],
				};
			}
			const version = await readBinaryVersion(pythonPath, ["--version"]);
			return {
				healthy: [`Python available: ${version || pythonPath}`],
			};
		},
	},
];

const pluginChecks: DiagnosticCheck[] = [
	{
		id: "plugin/runtime-config",
		category: "plugin",
		async run(ctx) {
			const configRoot = ctx.configRoot;
			if (!configRoot) {
				return {
					issues: [
						{
							type: "invalid_settings",
							severity: "error",
							message: "Plugin diagnostics require a runtime config root.",
							remediation: "Pass --config-root <path> or run the command from a composed workspace.",
							checkId: "plugin/runtime-config",
							autoFixable: false,
						},
					],
				};
			}
			const inspection = await inspectRuntimeConfig(configRoot);
			if (!inspection.ok) {
				return {
					issues: [
						{
							type: "invalid_settings",
							severity: "warning",
							message: "runtime config is missing or unreadable; plugin is running in degraded mode",
							remediation: "Compose a workspace runtime with 'agenthub start <profile>' or 'agenthub hr <profile>'.",
							checkId: "plugin/runtime-config",
							autoFixable: false,
							docLink: "docs/troubleshooting/plugin-degraded-mode.md",
						},
					],
				};
			}
			const summary = summarizeRuntimeFeatureState(inspection.config);
			return {
				healthy: [
					`Plugin runtime config loaded from ${inspection.runtimeConfigPath}`,
					`Plugin blocked tools: ${Array.from(summary.blockedTools).sort().join(", ") || "(none)"}`,
				],
			};
		},
	},
];

const workspaceChecks: DiagnosticCheck[] = [
	{
		id: "workspace/runtime-root",
		category: "workspace",
		async run(ctx) {
			if (!ctx.configRoot) {
				return {
					issues: [
						{
							type: "invalid_settings",
							severity: "error",
							message: "Workspace diagnostics require a runtime config root.",
							remediation: "Pass --config-root <path> or run doctor from a composed workspace.",
							checkId: "workspace/runtime-root",
							autoFixable: false,
						},
					],
				};
			}
			return {
				healthy: [`Workspace runtime root: ${ctx.configRoot}`],
			};
		},
	},
];

export const registeredChecks: DiagnosticCheck[] = [
	...environmentChecks,
	...workspaceChecks,
	...pluginChecks,
];

export const checksForCategory = (category?: string): DiagnosticCheck[] =>
	category
		? registeredChecks.filter((check) => check.category === category)
		: registeredChecks;
