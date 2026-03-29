import { describe, expect, test } from "bun:test";

import {
	displayHomeConfigPath,
	generateRunCmd,
	generateRunScript,
	interactivePromptResetSequence,
	isWindows,
	resolvePythonCommand,
	stripTerminalControlInput,
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

	test("interactivePromptResetSequence disables mouse tracking on Windows", () => {
		expect(interactivePromptResetSequence(false)).toBe("");
		const sequence = interactivePromptResetSequence(true);
		expect(sequence).toContain("\u001b[?1000l");
		expect(sequence).toContain("\u001b[?1006l");
		expect(sequence).toContain("\u001b[?1015l");
	});

	test("stripTerminalControlInput removes mouse tracking noise", () => {
		const noisy = "\u001b[<35;24;14mrecom\u001b[<35;25;15mmen\u001b[<35;26;16mded";
		expect(stripTerminalControlInput(noisy)).toBe("recommended");
	});

	test("stripTerminalControlInput removes degraded Windows CSI fragments", () => {
		const noisy =
			"35;42m35;43m35;44m35;49m35;50m35;56;22m35;57;22m35;58;22mstaff";
		expect(stripTerminalControlInput(noisy)).toBe("staff");
	});

	test("stripTerminalControlInput preserves plain input", () => {
		expect(stripTerminalControlInput("custom")).toBe("custom");
	});
});
