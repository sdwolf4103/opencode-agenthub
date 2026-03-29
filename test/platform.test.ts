import { describe, expect, test } from "bun:test";

import {
	displayHomeConfigPath,
	generateRunCmd,
	generateRunScript,
	isWindows,
	resolvePythonCommand,
	shouldChmod,
	shouldOfferEnvrc,
	resolveHomeConfigRoot,
	spawnOptions,
	symlinkType,
	windowsStartupNotice,
} from "../src/composer/platform.js";

describe("platform helpers", () => {
	test("isWindows respects explicit override", () => {
		expect(isWindows(false)).toBe(false);
		expect(isWindows(true)).toBe(true);
	});

	test("symlinkType uses junction on Windows and dir on POSIX", () => {
		expect(symlinkType(false)).toBe("dir");
		expect(symlinkType(true)).toBe("junction");
	});

	test("shouldChmod only enables chmod on POSIX", () => {
		expect(shouldChmod(false)).toBe(true);
		expect(shouldChmod(true)).toBe(false);
	});

	test("shouldOfferEnvrc skips native Windows", () => {
		expect(shouldOfferEnvrc(false)).toBe(true);
		expect(shouldOfferEnvrc(true)).toBe(false);
	});

	test("resolvePythonCommand picks platform-specific executable", () => {
		expect(resolvePythonCommand(false)).toBe("python3");
		expect(resolvePythonCommand(true)).toBe("python");
	});

	test("resolveHomeConfigRoot uses portable separators", () => {
		expect(resolveHomeConfigRoot("/home/test", "opencode-agenthub", false)).toBe(
			"/home/test/.config/opencode-agenthub",
		);
		expect(resolveHomeConfigRoot("C:\\Users\\test", "opencode-agenthub", true)).toBe(
			"C:\\Users\\test\\.config\\opencode-agenthub",
		);
	});

	test("displayHomeConfigPath renders shell-friendly help paths", () => {
		expect(displayHomeConfigPath("opencode-agenthub", [], false)).toBe(
			"~/.config/opencode-agenthub",
		);
		expect(displayHomeConfigPath("opencode-agenthub-hr", ["settings.json"], false)).toBe(
			"~/.config/opencode-agenthub-hr/settings.json",
		);
		expect(displayHomeConfigPath("opencode-agenthub", [], true)).toBe(
			"%USERPROFILE%\\.config\\opencode-agenthub",
		);
		expect(displayHomeConfigPath("opencode-agenthub-hr", ["staging"], true)).toBe(
			"%USERPROFILE%\\.config\\opencode-agenthub-hr\\staging",
		);
	});

	test("spawnOptions only enables shell mode on Windows", () => {
		expect(spawnOptions(false)).toEqual({});
		expect(spawnOptions(true)).toEqual({ shell: true });
	});

	test("generateRunScript returns bash launcher", () => {
		const script = generateRunScript();
		expect(script).toContain("#!/usr/bin/env bash");
		expect(script).toContain('export XDG_CONFIG_HOME="$SCRIPT_DIR/xdg"');
		expect(script).toContain("exec opencode");
	});

	test("generateRunCmd returns cmd launcher", () => {
		const script = generateRunCmd();
		expect(script).toContain("@echo off");
		expect(script).toContain('set "XDG_CONFIG_HOME=%SCRIPT_DIR%xdg"');
		expect(script).toContain('set "OPENCODE_CONFIG_DIR=%SCRIPT_DIR%"');
		expect(script).toContain("opencode %*");
	});

	test("current platform branch matches process.platform", () => {
		expect(isWindows()).toBe(process.platform === "win32");
	});

	test("windowsStartupNotice only returns text on native Windows", () => {
		expect(windowsStartupNotice(false)).toBeNull();
		const notice = windowsStartupNotice(true);
		expect(notice).toContain("native Windows detected");
		expect(notice).toContain("use WSL 2");
	});
});
