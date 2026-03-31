import type { DiagnosticCheck } from "./types.js";
import { inspectRuntimeConfig, summarizeRuntimeFeatureState } from "../../../plugins/runtime-config.js";

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
	...workspaceChecks,
	...pluginChecks,
];

export const checksForCategory = (category?: string): DiagnosticCheck[] =>
	category
		? registeredChecks.filter((check) => check.category === category)
		: registeredChecks;
