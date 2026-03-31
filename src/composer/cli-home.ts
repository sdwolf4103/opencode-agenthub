import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { defaultAgentHubHome } from "./bootstrap.js";
import { getWorkspaceRuntimeRoot } from "./compose.js";
import { createPromptInterface, promptBoolean } from "./cli-prompts.js";
import { shouldOfferEnvrc } from "./platform.js";
import {
	mergeAgentHubSettingsDefaults,
	readAgentHubSettings,
	writeAgentHubSettings,
} from "./settings.js";

export type WorkspacePreferences = {
	_version?: 1;
	envrc?: {
		prompted: boolean;
		enabled: boolean;
	};
	start?: {
		lastProfile?: string;
	};
	hr?: {
		lastProfile?: string;
	};
};

export const workspacePreferencesPath = (workspace: string) =>
	path.join(workspace, ".opencode-agenthub.user.json");

export const readJsonIfExists = async <T>(
	filePath: string,
): Promise<T | undefined> => {
	try {
		const content = await readFile(filePath, "utf-8");
		const normalized = content
			.split("\n")
			.filter((line) => !line.trim().startsWith("//"))
			.join("\n");
		return JSON.parse(normalized) as T;
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "EISDIR") return undefined;
		throw e;
	}
};

export const loadWorkspacePreferences = async (
	workspace: string,
): Promise<WorkspacePreferences> => {
	const raw =
		(await readJsonIfExists<WorkspacePreferences>(
			workspacePreferencesPath(workspace),
		)) || {};
	return {
		_version: 1,
		...raw,
	};
};

export const saveWorkspacePreferences = async (
	workspace: string,
	preferences: WorkspacePreferences,
) => {
	await mkdir(path.dirname(workspacePreferencesPath(workspace)), { recursive: true });
	await writeFile(
		workspacePreferencesPath(workspace),
		`${JSON.stringify({ _version: 1, ...preferences }, null, 2)}\n`,
		"utf-8",
	);
};

export const updateWorkspacePreferences = async (
	workspace: string,
	updater: (current: WorkspacePreferences) => WorkspacePreferences,
) => {
	const current = await loadWorkspacePreferences(workspace);
	await saveWorkspacePreferences(workspace, updater(current));
};

export const readStartDefaultProfile = async (
	targetRoot = defaultAgentHubHome(),
): Promise<string | undefined> => {
	const settings = await readAgentHubSettings(targetRoot);
	return settings?.preferences?.defaultProfile?.trim() || undefined;
};

export const setStartDefaultProfile = async (
	profile: string,
	targetRoot = defaultAgentHubHome(),
) => {
	const existingSettings = (await readAgentHubSettings(targetRoot)) || {};
	const mergedSettings = mergeAgentHubSettingsDefaults(existingSettings);
	await writeAgentHubSettings(targetRoot, {
		...mergedSettings,
		preferences: {
			...(mergedSettings.preferences || {}),
			defaultProfile: profile,
		},
	});
};

export const resolveStartProfilePreference = async (
	workspace: string,
	targetRoot = defaultAgentHubHome(),
): Promise<{ profile: string; source: "default" | "last" | "fallback" }> => {
	const defaultProfile = await readStartDefaultProfile(targetRoot);
	if (defaultProfile) {
		return { profile: defaultProfile, source: "default" };
	}
	const preferences = await loadWorkspacePreferences(workspace);
	const lastProfile = preferences.start?.lastProfile?.trim();
	if (lastProfile) {
		return { profile: lastProfile, source: "last" };
	}
	return { profile: "auto", source: "fallback" };
};

export const resolveHrLastProfilePreference = async (
	workspace: string,
): Promise<string | undefined> => {
	const preferences = await loadWorkspacePreferences(workspace);
	return preferences.hr?.lastProfile?.trim() || undefined;
};

export const resolveStartLastProfilePreference = async (
	workspace: string,
): Promise<{ profile: string; source: "last" | "fallback" }> => {
	const preferences = await loadWorkspacePreferences(workspace);
	const lastProfile = preferences.start?.lastProfile?.trim();
	if (lastProfile) {
		return { profile: lastProfile, source: "last" };
	}
	return { profile: "auto", source: "fallback" };
};

export const noteProfileResolution = (
	command: "start" | "hr",
	source: string,
	profile: string,
) => {
	if (source === "explicit") return;
	if (command === "start" && source === "default") {
		process.stderr.write(`[agenthub] start -> using personal default profile '${profile}'.\n`);
		return;
	}
	if (source === "last") {
		process.stderr.write(`[agenthub] ${command} -> using last profile '${profile}'.\n`);
		return;
	}
	if (command === "start" && source === "fallback") {
		process.stderr.write("[agenthub] start -> no default or previous profile found; using 'auto'.\n");
	}
};

export const warnIfWorkspaceRuntimeWillBeReplaced = async (
	workspace: string,
	label: string,
) => {
	const lockPath = path.join(getWorkspaceRuntimeRoot(workspace), "agenthub-lock.json");
	if (!(await readJsonIfExists<Record<string, unknown>>(lockPath))) return;
	process.stderr.write(
		`[agenthub] Replacing the current workspace runtime with ${label}. Plain 'opencode' in this folder will use the new runtime after compose.\n`,
	);
};

export const toWorkspaceEnvrc = (workspace: string, configRoot: string): string => {
	const resolvedConfigRoot = path.resolve(configRoot);
	const relativeConfigRoot = path.relative(workspace, resolvedConfigRoot);
	const configRootRef =
		relativeConfigRoot && !relativeConfigRoot.startsWith("..")
			? `$PWD/${relativeConfigRoot}`
			: resolvedConfigRoot;
	return `# Generated by opencode-agenthub. Remove this file to disable auto-activation.
export XDG_CONFIG_HOME="${configRootRef}/xdg"
export OPENCODE_DISABLE_PROJECT_CONFIG=true
export OPENCODE_CONFIG_DIR="${configRootRef}"
`;
};

export const maybeConfigureEnvrc = async (workspace: string, configRoot: string) => {
	if (!shouldOfferEnvrc()) return;
	if (!process.stdin.isTTY || !process.stdout.isTTY) return;
	const preferences = await loadWorkspacePreferences(workspace);
	const envrcPath = path.join(workspace, ".envrc");
	const envrcExists = await stat(envrcPath)
		.then((s) => s.isFile() || s.isFIFO())
		.catch((e) => (e.code === "ENOENT" ? false : Promise.reject(e)));
	if (envrcExists) {
		if (!preferences.envrc?.enabled || !preferences.envrc?.prompted) {
			await saveWorkspacePreferences(workspace, {
				...preferences,
				envrc: { prompted: true, enabled: true },
			});
		}
		return;
	}
	if (preferences.envrc?.prompted) return;

	const rl = createPromptInterface();
	try {
		const enableEnvrc = await promptBoolean(
			rl,
			"Enable Agent Hub auto-activation with .envrc so plain 'opencode' works here?",
			false,
		);
		if (enableEnvrc) {
			await writeFile(
				envrcPath,
				toWorkspaceEnvrc(workspace, configRoot),
				"utf-8",
			);
			process.stdout.write(
				`Wrote ${envrcPath}. Run 'direnv allow' in this workspace to enable plain 'opencode'.\n`,
			);
		}
		await saveWorkspacePreferences(workspace, {
			...preferences,
			envrc: { prompted: true, enabled: enableEnvrc },
		});
	} finally {
		rl.close();
	}
};
