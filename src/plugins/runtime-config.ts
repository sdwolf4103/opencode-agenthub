import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
	PlanDetectionConfig,
	RuntimeConfig,
	WorkflowInjectionConfig,
} from "../types.js";

export const resolvePluginConfigRoot = (explicitRoot?: string): string => {
	if (explicitRoot?.trim()) return path.resolve(explicitRoot);
	const fromEnv = typeof process !== "undefined"
		? process.env.OPENCODE_CONFIG_DIR
		: undefined;
	if (fromEnv?.trim()) return path.resolve(fromEnv);
	return path.resolve(".opencode");
};

export const runtimeConfigPathForRoot = (configRoot: string): string =>
	path.join(configRoot, "agenthub-runtime.json");

export const parseRuntimeJson = (content: string): RuntimeConfig => {
	const jsonContent = content
		.split("\n")
		.filter((line) => !line.trim().startsWith("//"))
		.join("\n");
	return JSON.parse(jsonContent) as RuntimeConfig;
};

export const inspectRuntimeConfig = async (
	configRoot = resolvePluginConfigRoot(),
): Promise<
	| {
			ok: true;
			configRoot: string;
			runtimeConfigPath: string;
			config: RuntimeConfig;
	  }
	| {
			ok: false;
			configRoot: string;
			runtimeConfigPath: string;
			error: unknown;
	  }
> => {
	const runtimeConfigPath = runtimeConfigPathForRoot(configRoot);
	try {
		const content = await readFile(runtimeConfigPath, "utf-8");
		return {
			ok: true,
			configRoot,
			runtimeConfigPath,
			config: parseRuntimeJson(content),
		};
	} catch (error) {
		return {
			ok: false,
			configRoot,
			runtimeConfigPath,
			error,
		};
	}
};

export const summarizeRuntimeFeatureState = (
	config: RuntimeConfig,
): {
	blockedTools: Set<string>;
	planDetection?: PlanDetectionConfig;
	workflowInjection?: WorkflowInjectionConfig;
} => {
	const allBlockedTools = new Set<string>();

	if (config.globalBlockedTools) {
		for (const tool of config.globalBlockedTools) {
			allBlockedTools.add(tool);
		}
	}

	for (const agentInfo of Object.values(config.agents)) {
		for (const tool of agentInfo.blockedTools) {
			allBlockedTools.add(tool);
		}
	}

	return {
		blockedTools: allBlockedTools,
		planDetection: config.planDetection,
		workflowInjection: config.workflowInjection,
	};
};
