const detectWindows = (): boolean => process.platform === "win32";

/** True when running on native Windows. WSL reports itself as linux. */
export const isWindows = (win?: boolean) => win ?? detectWindows();

/** Use junctions on Windows so skill links work without extra privileges. */
export const symlinkType = (win?: boolean): "dir" | "junction" =>
	isWindows(win) ? "junction" : "dir";

/** chmod is only meaningful on POSIX filesystems. */
export const shouldChmod = (win?: boolean) => !isWindows(win);

/** Skip .envrc guidance on native Windows because direnv flows are POSIX-first. */
export const shouldOfferEnvrc = (win?: boolean) => !isWindows(win);

/** Python command name differs between POSIX shells and native Windows. */
export const resolvePythonCommand = (win?: boolean) =>
	isWindows(win) ? "python" : "python3";

/**
 * Use shell mode on Windows so .cmd shims resolve for opencode/npm/bun.
 * Never pair this with unvalidated external input because shell parsing applies.
 */
export const spawnOptions = (win?: boolean): { shell?: boolean } =>
	isWindows(win) ? { shell: true } : {};

const csiSequencePattern = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const oscSequencePattern = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const singleEscapePattern = /\u001b[@-_]/g;
const controlCharacterPattern = /[\u0000-\u001f\u007f]/g;
const degradedLeadingCsiFragmentPattern = /^(?:(?:\d{1,3};){1,10}\d{1,3}m)+/;

export const stripTerminalControlInput = (value: string): string =>
	value
		.replace(oscSequencePattern, "")
		.replace(csiSequencePattern, "")
		.replace(singleEscapePattern, "")
		.replace(controlCharacterPattern, "")
		.replace(degradedLeadingCsiFragmentPattern, "");

export const interactivePromptResetSequence = (win = detectWindows()) =>
	isWindows(win)
		? [
			"\u001b[?1000l",
			"\u001b[?1001l",
			"\u001b[?1002l",
			"\u001b[?1003l",
			"\u001b[?1005l",
			"\u001b[?1006l",
			"\u001b[?1015l",
		].join("")
		: "";

export const generateRunScript = () => `#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
export XDG_CONFIG_HOME="$SCRIPT_DIR/xdg"
export OPENCODE_DISABLE_PROJECT_CONFIG=true
export OPENCODE_CONFIG_DIR="$SCRIPT_DIR"

exec opencode "$@"
`;

export const generateRunCmd = () => `@echo off
set "SCRIPT_DIR=%~dp0"
set "XDG_CONFIG_HOME=%SCRIPT_DIR%xdg"
set "OPENCODE_DISABLE_PROJECT_CONFIG=true"
set "OPENCODE_CONFIG_DIR=%SCRIPT_DIR%"

opencode %*
`;

export const windowsStartupNotice = (win = detectWindows()) => {
	if (!isWindows(win)) return null;
	return [
		"[agenthub] Notice: native Windows detected.",
		"Windows users should use WSL 2 for the best experience; native Windows remains best-effort in alpha.",
		"Install WSL: https://learn.microsoft.com/en-us/windows/wsl/install",
	].join("\n");
};

// TODO: consider migrating native Windows installs to %APPDATA% once we have a
// compatibility plan for existing ~/.config-style Agent Hub homes.
export const resolveHomeConfigRoot = (
	homeDir: string,
	appName: string,
	win?: boolean,
) =>
	isWindows(win)
		? `${homeDir}\\.config\\${appName}`
		: `${homeDir}/.config/${appName}`;

/** Human-facing path text for help output and docs examples. */
export const displayHomeConfigPath = (
	appName: string,
	subpaths: string[] = [],
	win?: boolean,
) =>
	isWindows(win)
		? ["%USERPROFILE%", ".config", appName, ...subpaths].join("\\")
		: ["~", ".config", appName, ...subpaths].join("/");
