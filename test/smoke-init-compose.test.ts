import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { installAgentHubHome, installHrOfficeHome, installHrOfficeHomeWithOptions } from "../src/composer/bootstrap.js";
import { buildBuiltinVersionManifest } from "../src/composer/builtin-assets.js";
import { expandProfileAddSelections } from "../src/composer/capabilities.js";
import { getDefaultProfilePlugins } from "../src/composer/defaults.js";
import {
	composeCustomizedAgent,
	composeToolInjection,
	composeWorkspace,
} from "../src/composer/compose.js";
import {
	displayHomeConfigPath,
	isWindows,
	resolvePythonCommand,
	shouldChmod,
	spawnOptions,
} from "../src/composer/platform.js";
import { createBundleForSoul, createProfile } from "../src/skills/agenthub-doctor/fix.js";

const splitLines = (contents: string) => contents.split(/\r?\n/);

const parseGeneratedJson = (contents: string) => {
	const normalized = splitLines(contents)
		.filter((line) => !line.startsWith("//"))
		.join("\n")
		.trim();
	return JSON.parse(normalized);
};

const pathExists = async (target: string) => {
	try {
		await stat(target);
		return true;
	} catch {
		return false;
	}
};

const cliEntry = path.join(process.cwd(), "src", "composer", "opencode-profile.ts");
const windows = isWindows();
const pythonCommand = resolvePythonCommand(windows);

const hasCommandOnPath = (command: string) => {
	const extensions = windows ? ["", ".exe", ".cmd", ".bat"] : [""];
	for (const rawDir of (process.env.PATH || "").split(path.delimiter)) {
		const dir = rawDir.replace(/^"|"$/g, "");
		if (!dir) continue;
		for (const extension of extensions) {
			if (existsSync(path.join(dir, `${command}${extension}`))) {
				return true;
			}
		}
	}
	return false;
};

const opencodeIntegrationTest = hasCommandOnPath("opencode") ? test : test.skip;

const writeExecutable = async ({
	targetBase,
	posixContents,
	windowsContents,
}: {
	targetBase: string;
	posixContents: string;
	windowsContents: string;
}) => {
	const targetPath = windows ? `${targetBase}.cmd` : targetBase;
	await writeFile(targetPath, windows ? windowsContents : posixContents, "utf8");
	if (shouldChmod(windows)) {
		await chmod(targetPath, 0o755);
	}
	return targetPath;
};

const writeFakeOpencodeModels = async ({
	targetBase,
	allModels,
	freeModels,
}: {
	targetBase: string;
	allModels: string[];
	freeModels: string[];
}) =>
	writeExecutable({
		targetBase,
		posixContents: [
			"#!/usr/bin/env node",
			"const args = process.argv.slice(2);",
			`const allModels = ${JSON.stringify(allModels)};`,
			`const freeModels = ${JSON.stringify(freeModels)};`,
			"if (args[0] === 'models' && args[1] === 'opencode') {",
			"  process.stdout.write(freeModels.join(String.fromCharCode(10)) + (freeModels.length ? String.fromCharCode(10) : ''));",
			"  process.exit(0);",
			"}",
			"if (args[0] === 'models') {",
			"  process.stdout.write(allModels.join(String.fromCharCode(10)) + (allModels.length ? String.fromCharCode(10) : ''));",
			"  process.exit(0);",
			"}",
			"process.exit(0);",
			"",
		].join("\n"),
		windowsContents: [
			"@echo off",
			'if "%1"=="models" if "%2"=="opencode" (',
			...freeModels.map((model) => `  echo ${model}`),
			"  exit /b 0",
			")",
			'if "%1"=="models" (',
			...allModels.map((model) => `  echo ${model}`),
			"  exit /b 0",
			")",
			"exit /b 0",
			"",
		].join("\r\n"),
	});

const runCli = async ({
	args,
	cwd,
	env,
	input = "",
}: {
	args: string[];
	cwd: string;
	env?: Record<string, string | undefined>;
	input?: string;
}) => {
	const scriptedAnswers = input
		? JSON.stringify(
				input
					.split("\n")
					.filter((line, index, values) => line.length > 0 || index < values.length - 1),
			)
		: undefined;
	const child = spawn("bun", [cliEntry, ...args], {
		...spawnOptions(windows),
		cwd,
		env: {
			...process.env,
			...(scriptedAnswers ? { OPENCODE_AGENTHUB_SCRIPTED_ANSWERS: scriptedAnswers } : {}),
			...env,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});

	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	child.stdin.end();

	const code = await new Promise<number>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (exitCode) => resolve(exitCode ?? 0));
	});

	return { code, stdout, stderr };
};

const runOpencode = async ({
	args,
	cwd,
	env,
}: {
	args: string[];
	cwd: string;
	env?: Record<string, string | undefined>;
}) => {
	const child = spawn("opencode", args, {
		...spawnOptions(windows),
		cwd,
		env: { ...process.env, ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});

	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});

	const code = await new Promise<number>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (exitCode) => resolve(exitCode ?? 0));
	});

	return { code, stdout, stderr };
};

test("setup mode settings compose into runtime config", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-smoke-"));
	const originalHome = process.env.HOME;
	const originalXdgHome = process.env.XDG_CONFIG_HOME;
	const originalAgentHubHome = process.env.OPENCODE_AGENTHUB_HOME;
	const originalNativeConfig = process.env.OPENCODE_AGENTHUB_NATIVE_CONFIG;

	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const agentHubHome = path.join(tempRoot, "agenthub-home");
		const workspace = path.join(tempRoot, "workspace");

		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
		]);

		process.env.HOME = homeDir;
		process.env.XDG_CONFIG_HOME = xdgHomeDir;
		process.env.OPENCODE_AGENTHUB_HOME = agentHubHome;
		delete process.env.OPENCODE_AGENTHUB_NATIVE_CONFIG;

		const installedRoot = await installAgentHubHome({
			targetRoot: agentHubHome,
			mode: "auto",
		});
		expect(installedRoot).toBe(agentHubHome);

        const defaultProfilePath = path.join(agentHubHome, "profiles", "default.json");
        await expect(readFile(defaultProfilePath, "utf8")).rejects.toThrow();

		const settingsPath = path.join(agentHubHome, "settings.json");
		const settings = JSON.parse(await readFile(settingsPath, "utf8"));
		expect(settings.agents).toEqual({});
		expect(settings.meta.builtinVersion["bundles/auto.json"]).toBeDefined();

		const result = await composeWorkspace(workspace, "auto");
		const opencodeConfigPath = path.join(result.configRoot, "opencode.jsonc");
		const xdgConfigPath = path.join(result.configRoot, "xdg", "opencode", "opencode.json");
		const runScriptPath = path.join(result.configRoot, "run.sh");
		const runCmdPath = path.join(result.configRoot, "run.cmd");
		const opencodeConfig = parseGeneratedJson(
			await readFile(opencodeConfigPath, "utf8"),
		);
		const xdgConfig = parseGeneratedJson(
			await readFile(xdgConfigPath, "utf8"),
		);
		const runScript = await readFile(runScriptPath, "utf8");
		const runCmd = await readFile(runCmdPath, "utf8");

		expect(opencodeConfig.default_agent).toBe("auto");
		expect(opencodeConfig.agent.auto.permission["*"]).toBe("allow");
		expect(opencodeConfig.agent.plan.permission.bash).toBe("ask");
		expect(opencodeConfig.agent.plan.permission.task).toBeUndefined();
		expect(opencodeConfig.agent.build.model).toBeDefined();
		expect(opencodeConfig.$schema).toBe("https://opencode.ai/config.json");
		expect(opencodeConfig.plugin).toContain("opencode-agenthub");
		expect(xdgConfig.plugin).toEqual(opencodeConfig.plugin);
		expect(runScript).toContain("#!/usr/bin/env bash");
		expect(runCmd).toContain("@echo off");
		expect(runCmd).toContain("opencode %*");
		expect(getDefaultProfilePlugins()).toEqual(["opencode-agenthub"]);
	} finally {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;

		if (originalXdgHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXdgHome;

		if (originalAgentHubHome === undefined) delete process.env.OPENCODE_AGENTHUB_HOME;
		else process.env.OPENCODE_AGENTHUB_HOME = originalAgentHubHome;

		if (originalNativeConfig === undefined) delete process.env.OPENCODE_AGENTHUB_NATIVE_CONFIG;
		else process.env.OPENCODE_AGENTHUB_NATIVE_CONFIG = originalNativeConfig;

		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("auto bundle keeps model blank when no user default exists", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-auto-blank-model-"));
	try {
		const agentHubHome = path.join(tempRoot, "agenthub-home");
		await installAgentHubHome({ targetRoot: agentHubHome, mode: "auto" });

		const autoBundle = JSON.parse(
			await readFile(path.join(agentHubHome, "bundles", "auto.json"), "utf8"),
		);
		expect(autoBundle.agent.model).toBe("");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("doctor bundle creation leaves model blank without explicit selection", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-doctor-blank-model-"));
	try {
		const targetRoot = path.join(tempRoot, "agenthub-home");
		await mkdir(path.join(targetRoot, "bundles"), { recursive: true });

		const result = await createBundleForSoul(targetRoot, "auto", {});
		expect(result.success).toBe(true);

		const createdBundle = JSON.parse(
			await readFile(path.join(targetRoot, "bundles", "auto.json"), "utf8"),
		);
		expect(createdBundle.agent.model).toBe("");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("package exposes short agenthub bin alias", async () => {
	const pkg = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8"));
	expect(pkg.bin.agenthub).toBe("dist/composer/opencode-profile.js");
	expect(pkg.bin["opencode-agenthub"]).toBe("dist/composer/opencode-profile.js");
});

test("HR built-in manifest includes hr-boundaries instruction", () => {
	const manifest = buildBuiltinVersionManifest("hr-office", "test-version");
	expect(manifest["instructions/hr-boundaries.md"]).toBe("test-version");
	expect(manifest["instructions/hr-protocol.md"]).toBe("test-version");
});

test("help shows agenthub as primary command", async () => {
	const result = await runCli({ args: ["--help"], cwd: process.cwd(), env: {} });
	expect(result.code).toBe(0);
	expect(result.stdout).toContain("agenthub <command> [options]");
	expect(result.stdout).toContain("opencode-agenthub <command> [options]");
	expect(result.stdout).toContain("agenthub start");
	expect(result.stdout).toContain("agenthub hr");
	expect(result.stdout).toContain(`default: ${displayHomeConfigPath("opencode-agenthub")}`);
	expect(result.stdout).toContain(displayHomeConfigPath("opencode-agenthub-hr"));
	expect(result.stdout).toContain(
		displayHomeConfigPath("opencode-agenthub-hr", ["settings.json"]),
	);
	expect(result.stdout).toContain(displayHomeConfigPath("opencode-agenthub-hr", ["staging"]));
	expect(result.stdout).toContain("Windows users should use WSL 2");
	expect(result.stderr).toBe("");
});

test("setup minimal keeps optional directories lazy", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-skeleton-"));

	try {
		const agentHubHome = path.join(tempRoot, "agenthub-home");
		await installAgentHubHome({ targetRoot: agentHubHome, mode: "minimal" });

		expect(await pathExists(path.join(agentHubHome, "souls"))).toBe(true);
		expect(await pathExists(path.join(agentHubHome, "skills"))).toBe(true);
		expect(await pathExists(path.join(agentHubHome, "bundles"))).toBe(true);
		expect(await pathExists(path.join(agentHubHome, "profiles"))).toBe(true);
		expect(await pathExists(path.join(agentHubHome, "settings.json"))).toBe(true);

		expect(await pathExists(path.join(agentHubHome, "instructions"))).toBe(false);
		expect(await pathExists(path.join(agentHubHome, "workflow"))).toBe(false);
		expect(await pathExists(path.join(agentHubHome, "mcp"))).toBe(false);
		expect(await pathExists(path.join(agentHubHome, "mcp-servers"))).toBe(false);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("new soul command creates markdown scaffold", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-new-soul-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const agentHubHome = path.join(tempRoot, "agenthub-home");
		const workspace = path.join(tempRoot, "workspace");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
		]);
		await installAgentHubHome({ targetRoot: agentHubHome, mode: "auto" });
		const result = await runCli({
			args: ["new", "soul", "reviewer"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: agentHubHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});
		expect(result.code).toBe(0);
		expect(await readFile(path.join(agentHubHome, "souls", "reviewer.md"), "utf8")).toContain("## Description");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("new skill command creates SKILL.md scaffold", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-new-skill-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const agentHubHome = path.join(tempRoot, "agenthub-home");
		const workspace = path.join(tempRoot, "workspace");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
		]);
		await installAgentHubHome({ targetRoot: agentHubHome, mode: "auto" });
		const result = await runCli({
			args: ["new", "skill", "repo-audit"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: agentHubHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});
		expect(result.code).toBe(0);
		expect(await readFile(path.join(agentHubHome, "skills", "repo-audit", "SKILL.md"), "utf8")).toContain("## When to use");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("new instruction command creates markdown scaffold", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-new-instruction-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const agentHubHome = path.join(tempRoot, "agenthub-home");
		const workspace = path.join(tempRoot, "workspace");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
		]);
		await installAgentHubHome({ targetRoot: agentHubHome, mode: "auto" });
		const result = await runCli({
			args: ["new", "instruction", "repo-rules-2"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: agentHubHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});
		expect(result.code).toBe(0);
		expect(await readFile(path.join(agentHubHome, "instructions", "repo-rules-2.md"), "utf8")).toContain("## Purpose");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("plugin doctor reports degraded mode when runtime config is missing", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-plugin-doctor-"));
	try {
		const workspace = path.join(tempRoot, "workspace");
		await mkdir(workspace, { recursive: true });
		const result = await runCli({
			args: ["plugin", "doctor", "--config-root", path.join(tempRoot, "missing-config")],
			cwd: workspace,
		});
		expect(result.code).toBe(0);
		expect(result.stderr).toContain("deprecated");
		expect(result.stdout).toContain("Doctor:");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("hr-suite capability expands to all HR bundles", () => {
	expect(expandProfileAddSelections(["hr-suite"])).toEqual([
		"hr",
		"hr-planner",
		"hr-sourcer",
		"hr-evaluator",
		"hr-cto",
		"hr-adapter",
		"hr-verifier",
	]);
});

test("new profile --from missing-profile fails with available profile list", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-new-profile-from-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const agentHubHome = path.join(tempRoot, "agenthub-home");
		const workspace = path.join(tempRoot, "workspace");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
		]);
		await installAgentHubHome({ targetRoot: agentHubHome, mode: "auto" });
		const result = await runCli({
			args: ["new", "profile", "broken", "--from", "missing-profile"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: agentHubHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("Profile 'missing-profile' was not found.");
		expect(result.stderr).toContain("Available profiles:");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("new profile rejects built-in reserved names without --reserved-ok", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-reserved-profile-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const agentHubHome = path.join(tempRoot, "agenthub-home");
		const workspace = path.join(tempRoot, "workspace");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
		]);
		await installAgentHubHome({ targetRoot: agentHubHome, mode: "auto" });
		const result = await runCli({
			args: ["new", "profile", "auto"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: agentHubHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("reserved built-in profile name");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("new bundle rejects built-in reserved names without --reserved-ok", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-reserved-bundle-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const agentHubHome = path.join(tempRoot, "agenthub-home");
		const workspace = path.join(tempRoot, "workspace");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
		]);
		await installAgentHubHome({ targetRoot: agentHubHome, mode: "auto" });
		const result = await runCli({
			args: ["new", "bundle", "auto"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: agentHubHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("reserved built-in bundle name");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("new soul rejects built-in reserved names without --reserved-ok", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-reserved-soul-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const agentHubHome = path.join(tempRoot, "agenthub-home");
		const workspace = path.join(tempRoot, "workspace");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
		]);
		await installAgentHubHome({ targetRoot: agentHubHome, mode: "auto" });
		const result = await runCli({
			args: ["new", "soul", "auto"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: agentHubHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("reserved built-in soul name");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("new skill rejects built-in reserved names without --reserved-ok", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-reserved-skill-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const agentHubHome = path.join(tempRoot, "agenthub-home");
		const workspace = path.join(tempRoot, "workspace");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
		]);
		await installAgentHubHome({ targetRoot: agentHubHome, mode: "auto" });
		const result = await runCli({
			args: ["new", "skill", "agenthub-doctor"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: agentHubHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("reserved built-in skill name");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("new instruction rejects built-in reserved names without --reserved-ok", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-reserved-instruction-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const agentHubHome = path.join(tempRoot, "agenthub-home");
		const workspace = path.join(tempRoot, "workspace");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
		]);
		await installAgentHubHome({ targetRoot: agentHubHome, mode: "auto" });
		const result = await runCli({
			args: ["new", "instruction", "hr-boundaries"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: agentHubHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("reserved built-in instruction name");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("upgrade dry-run previews stale built-in assets", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-upgrade-preview-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const agentHubHome = path.join(tempRoot, "agenthub-home");
		const workspace = path.join(tempRoot, "workspace");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
		]);
		await installAgentHubHome({ targetRoot: agentHubHome, mode: "auto" });
		const settingsPath = path.join(agentHubHome, "settings.json");
		const settings = JSON.parse(await readFile(settingsPath, "utf8"));
		settings.meta.builtinVersion["bundles/auto.json"] = "0.0.1";
		await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

		const startResult = await runCli({
			args: ["start", "auto", "--assemble-only"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: agentHubHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});
		expect(startResult.code).toBe(0);
		expect(startResult.stderr).toContain("Built-in assets may be stale");

		const previewResult = await runCli({
			args: ["upgrade", "--target-root", agentHubHome],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: agentHubHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});
		expect(previewResult.code).toBe(0);
		expect(previewResult.stdout).toContain("Built-in asset sync preview");
		expect(previewResult.stdout).toContain("Would skip:");
		expect(previewResult.stdout).toContain("bundles/auto.json");

		const settingsAfterPreview = JSON.parse(await readFile(settingsPath, "utf8"));
		expect(settingsAfterPreview.meta.builtinVersion["bundles/auto.json"]).toBe("0.0.1");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("upgrade --force refreshes builtin version manifest", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-upgrade-force-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const agentHubHome = path.join(tempRoot, "agenthub-home");
		const workspace = path.join(tempRoot, "workspace");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
		]);
		await installAgentHubHome({ targetRoot: agentHubHome, mode: "auto" });
		const settingsPath = path.join(agentHubHome, "settings.json");
		const settings = JSON.parse(await readFile(settingsPath, "utf8"));
		settings.meta.builtinVersion["bundles/auto.json"] = "0.0.1";
		await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

		const result = await runCli({
			args: ["upgrade", "--target-root", agentHubHome, "--force"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: agentHubHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Built-in asset sync complete");
		expect(result.stdout).toContain("Did update:");

		const upgradedSettings = JSON.parse(await readFile(settingsPath, "utf8"));
		expect(upgradedSettings.meta.builtinVersion["bundles/auto.json"]).not.toBe("0.0.1");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("upgrade --force refreshes HR Office managed assets and helper scripts", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-hr-upgrade-force-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const hrHome = path.join(tempRoot, "hr-home");
		const workspace = path.join(tempRoot, "workspace");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
		]);
		await installHrOfficeHomeWithOptions({ hrRoot: hrHome });

		const hrBundlePath = path.join(hrHome, "bundles", "hr.json");
		const helperPath = path.join(hrHome, "bin", "sync_sources.py");
		const settingsPath = path.join(hrHome, "settings.json");

		await writeFile(hrBundlePath, "tampered bundle\n", "utf8");
		await writeFile(helperPath, "tampered script\n", "utf8");

		const settings = JSON.parse(await readFile(settingsPath, "utf8"));
		settings.meta.builtinVersion["bundles/hr.json"] = "0.0.1";
		settings.meta.builtinVersion["hr-home/bin/sync_sources.py"] = "0.0.1";
		await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

		const result = await runCli({
			args: ["upgrade", "--target-root", hrHome, "--force"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HR_HOME: hrHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Built-in asset sync complete");
		expect(result.stdout).toContain("target kind: HR Office");
		expect(result.stdout).toContain("staging");

		const upgradedBundle = await readFile(hrBundlePath, "utf8");
		const upgradedHelper = await readFile(helperPath, "utf8");
		const upgradedSettings = JSON.parse(await readFile(settingsPath, "utf8"));

		expect(upgradedBundle).not.toContain("tampered bundle");
		expect(upgradedHelper).not.toContain("tampered script");
		expect(upgradedSettings.meta.builtinVersion["bundles/hr.json"]).not.toBe("0.0.1");
		expect(upgradedSettings.meta.builtinVersion["hr-home/bin/sync_sources.py"]).not.toBe("0.0.1");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("upgrade never modifies staged HR packages", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-hr-upgrade-staging-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const hrHome = path.join(tempRoot, "hr-home");
		const workspace = path.join(tempRoot, "workspace");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
		]);
		await installHrOfficeHomeWithOptions({ hrRoot: hrHome });

		const stagedProfilePath = path.join(
			hrHome,
			"staging",
			"candidate-one",
			"agenthub-home",
			"profiles",
			"candidate-one.json",
		);
		await mkdir(path.dirname(stagedProfilePath), { recursive: true });
		await writeFile(stagedProfilePath, '{"name":"candidate-one"}\n', "utf8");

		const before = await readFile(stagedProfilePath, "utf8");

		const result = await runCli({
			args: ["upgrade", "--target-root", hrHome, "--force"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HR_HOME: hrHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});

		expect(result.code).toBe(0);
		expect(await readFile(stagedProfilePath, "utf8")).toBe(before);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("setup imports user native opencode overrides for managed agents", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-native-import-"));
	const originalHome = process.env.HOME;
	const originalXdgHome = process.env.XDG_CONFIG_HOME;
	const originalAgentHubHome = process.env.OPENCODE_AGENTHUB_HOME;
	const originalNativeConfig = process.env.OPENCODE_AGENTHUB_NATIVE_CONFIG;

	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const agentHubHome = path.join(tempRoot, "agenthub-home");
		const workspace = path.join(tempRoot, "workspace");
		const nativeConfigPath = path.join(tempRoot, "opencode.json");

		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
		]);

		await writeFile(
			nativeConfigPath,
			`${JSON.stringify({
				model: "openai/gpt-5",
				small_model: "openai/gpt-5-mini",
				agent: {
					build: {
						model: "github-copilot/gpt-5",
					},
					plan: {
						permission: {
							bash: "ask",
						},
					},
				},
			}, null, 2)}\n`,
			"utf8",
		);

		process.env.HOME = homeDir;
		process.env.XDG_CONFIG_HOME = xdgHomeDir;
		process.env.OPENCODE_AGENTHUB_HOME = agentHubHome;
		process.env.OPENCODE_AGENTHUB_NATIVE_CONFIG = nativeConfigPath;

		await installAgentHubHome({
			targetRoot: agentHubHome,
			mode: "auto",
		});

		const settingsPath = path.join(agentHubHome, "settings.json");
		const settings = JSON.parse(await readFile(settingsPath, "utf8"));
		expect(settings.opencode.model).toBe("openai/gpt-5");
		expect(settings.opencode.small_model).toBe("openai/gpt-5-mini");
		expect(settings.agents.build.model).toBe("github-copilot/gpt-5");
		expect(settings.agents.plan.permission.bash).toBe("ask");

		const result = await composeWorkspace(workspace, "auto");
		const opencodeConfigPath = path.join(result.configRoot, "opencode.jsonc");
		const opencodeConfig = parseGeneratedJson(
			await readFile(opencodeConfigPath, "utf8"),
		);

		expect(opencodeConfig.model).toBe("openai/gpt-5");
		expect(opencodeConfig.small_model).toBe("openai/gpt-5-mini");
		expect(opencodeConfig.agent.build.model).toBe("github-copilot/gpt-5");
		expect(opencodeConfig.agent.plan.permission.bash).toBe("ask");
	} finally {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;

		if (originalXdgHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXdgHome;

		if (originalAgentHubHome === undefined) delete process.env.OPENCODE_AGENTHUB_HOME;
		else process.env.OPENCODE_AGENTHUB_HOME = originalAgentHubHome;

		if (originalNativeConfig === undefined) delete process.env.OPENCODE_AGENTHUB_NATIVE_CONFIG;
		else process.env.OPENCODE_AGENTHUB_NATIVE_CONFIG = originalNativeConfig;

		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("composeWorkspace splits per-agent model variants into model and variant fields", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-model-variant-"));
	const originalHome = process.env.HOME;
	const originalXdgHome = process.env.XDG_CONFIG_HOME;
	const originalAgentHubHome = process.env.OPENCODE_AGENTHUB_HOME;

	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const agentHubHome = path.join(tempRoot, "agenthub-home");
		const workspace = path.join(tempRoot, "workspace");

		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			installAgentHubHome({ targetRoot: agentHubHome, mode: "minimal" }),
		]);

		await writeFile(path.join(agentHubHome, "souls", "variant-agent.md"), "# variant agent\n", "utf8");
		await writeFile(
			path.join(agentHubHome, "bundles", "variant-agent.json"),
			`${JSON.stringify({
				name: "variant-agent",
				runtime: "native",
				soul: "variant-agent",
				skills: [],
				agent: {
					name: "variant-agent",
					mode: "primary",
					model: "github-copilot/gpt-5.4 xhigh",
					description: "Variant test agent",
					permission: {
						"*": "allow",
					},
				},
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(agentHubHome, "profiles", "variant-team.json"),
			`${JSON.stringify({
				name: "variant-team",
				bundles: ["variant-agent"],
				defaultAgent: "variant-agent",
				plugins: [],
			}, null, 2)}\n`,
			"utf8",
		);

		process.env.HOME = homeDir;
		process.env.XDG_CONFIG_HOME = xdgHomeDir;
		process.env.OPENCODE_AGENTHUB_HOME = agentHubHome;

		const result = await composeWorkspace(workspace, "variant-team");
		const opencodeConfig = parseGeneratedJson(
			await readFile(path.join(result.configRoot, "opencode.jsonc"), "utf8"),
		);

		expect(opencodeConfig.agent["variant-agent"].model).toBe("github-copilot/gpt-5.4");
		expect(opencodeConfig.agent["variant-agent"].variant).toBe("xhigh");
	} finally {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;

		if (originalXdgHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXdgHome;

		if (originalAgentHubHome === undefined) delete process.env.OPENCODE_AGENTHUB_HOME;
		else process.env.OPENCODE_AGENTHUB_HOME = originalAgentHubHome;

		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("composeWorkspace lets explicit variant override parsed bundle variant", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-explicit-variant-"));
	const originalHome = process.env.HOME;
	const originalXdgHome = process.env.XDG_CONFIG_HOME;
	const originalAgentHubHome = process.env.OPENCODE_AGENTHUB_HOME;

	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const agentHubHome = path.join(tempRoot, "agenthub-home");
		const workspace = path.join(tempRoot, "workspace");

		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			installAgentHubHome({ targetRoot: agentHubHome, mode: "minimal" }),
		]);

		await writeFile(path.join(agentHubHome, "souls", "variant-agent.md"), "# variant agent\n", "utf8");
		await writeFile(
			path.join(agentHubHome, "bundles", "variant-agent.json"),
			`${JSON.stringify({
				name: "variant-agent",
				runtime: "native",
				soul: "variant-agent",
				skills: [],
				agent: {
					name: "variant-agent",
					mode: "primary",
					model: "github-copilot/gpt-5.4 xhigh",
					variant: "high",
					description: "Variant test agent",
					permission: {
						"*": "allow",
					},
				},
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(agentHubHome, "profiles", "variant-team.json"),
			`${JSON.stringify({
				name: "variant-team",
				bundles: ["variant-agent"],
				defaultAgent: "variant-agent",
				plugins: [],
			}, null, 2)}\n`,
			"utf8",
		);

		process.env.HOME = homeDir;
		process.env.XDG_CONFIG_HOME = xdgHomeDir;
		process.env.OPENCODE_AGENTHUB_HOME = agentHubHome;

		const result = await composeWorkspace(workspace, "variant-team");
		const opencodeConfig = parseGeneratedJson(
			await readFile(path.join(result.configRoot, "opencode.jsonc"), "utf8"),
		);

		expect(opencodeConfig.agent["variant-agent"].model).toBe("github-copilot/gpt-5.4");
		expect(opencodeConfig.agent["variant-agent"].variant).toBe("high");
	} finally {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;

		if (originalXdgHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXdgHome;

		if (originalAgentHubHome === undefined) delete process.env.OPENCODE_AGENTHUB_HOME;
		else process.env.OPENCODE_AGENTHUB_HOME = originalAgentHubHome;

		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("composeWorkspace lets settings variant override bundle variant", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-settings-variant-"));
	const originalHome = process.env.HOME;
	const originalXdgHome = process.env.XDG_CONFIG_HOME;
	const originalAgentHubHome = process.env.OPENCODE_AGENTHUB_HOME;

	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const agentHubHome = path.join(tempRoot, "agenthub-home");
		const workspace = path.join(tempRoot, "workspace");

		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			installAgentHubHome({ targetRoot: agentHubHome, mode: "minimal" }),
		]);

		await writeFile(path.join(agentHubHome, "souls", "variant-agent.md"), "# variant agent\n", "utf8");
		await writeFile(
			path.join(agentHubHome, "bundles", "variant-agent.json"),
			`${JSON.stringify({
				name: "variant-agent",
				runtime: "native",
				soul: "variant-agent",
				skills: [],
				agent: {
					name: "variant-agent",
					mode: "primary",
					model: "github-copilot/gpt-5.4",
					variant: "high",
					description: "Variant test agent",
					permission: {
						"*": "allow",
					},
				},
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(agentHubHome, "profiles", "variant-team.json"),
			`${JSON.stringify({
				name: "variant-team",
				bundles: ["variant-agent"],
				defaultAgent: "variant-agent",
				plugins: [],
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(agentHubHome, "settings.json"),
			`${JSON.stringify({
				agents: {
					"variant-agent": {
						variant: "xhigh",
					},
				},
			}, null, 2)}\n`,
			"utf8",
		);

		process.env.HOME = homeDir;
		process.env.XDG_CONFIG_HOME = xdgHomeDir;
		process.env.OPENCODE_AGENTHUB_HOME = agentHubHome;

		const result = await composeWorkspace(workspace, "variant-team");
		const opencodeConfig = parseGeneratedJson(
			await readFile(path.join(result.configRoot, "opencode.jsonc"), "utf8"),
		);

		expect(opencodeConfig.agent["variant-agent"].model).toBe("github-copilot/gpt-5.4");
		expect(opencodeConfig.agent["variant-agent"].variant).toBe("xhigh");
	} finally {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;

		if (originalXdgHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXdgHome;

		if (originalAgentHubHome === undefined) delete process.env.OPENCODE_AGENTHUB_HOME;
		else process.env.OPENCODE_AGENTHUB_HOME = originalAgentHubHome;

		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("composeWorkspace strips unsupported top-level variant while keeping agent fallback variant", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-global-variant-"));
	const originalHome = process.env.HOME;
	const originalXdgHome = process.env.XDG_CONFIG_HOME;
	const originalAgentHubHome = process.env.OPENCODE_AGENTHUB_HOME;

	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const agentHubHome = path.join(tempRoot, "agenthub-home");
		const workspace = path.join(tempRoot, "workspace");

		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			installAgentHubHome({ targetRoot: agentHubHome, mode: "minimal" }),
		]);

		await writeFile(path.join(agentHubHome, "souls", "variant-agent.md"), "# variant agent\n", "utf8");
		await writeFile(
			path.join(agentHubHome, "bundles", "variant-agent.json"),
			`${JSON.stringify({
				name: "variant-agent",
				runtime: "native",
				soul: "variant-agent",
				skills: [],
				agent: {
					name: "variant-agent",
					mode: "primary",
					description: "Variant test agent",
					permission: {
						"*": "allow",
					},
				},
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(agentHubHome, "profiles", "variant-team.json"),
			`${JSON.stringify({
				name: "variant-team",
				bundles: ["variant-agent"],
				defaultAgent: "variant-agent",
				plugins: [],
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(agentHubHome, "settings.json"),
			`${JSON.stringify({
				opencode: {
					model: "github-copilot/gpt-5.4 xhigh",
				},
			}, null, 2)}\n`,
			"utf8",
		);

		process.env.HOME = homeDir;
		process.env.XDG_CONFIG_HOME = xdgHomeDir;
		process.env.OPENCODE_AGENTHUB_HOME = agentHubHome;

		const result = await composeWorkspace(workspace, "variant-team");
		const opencodeConfig = parseGeneratedJson(
			await readFile(path.join(result.configRoot, "opencode.jsonc"), "utf8"),
		);

		expect(opencodeConfig.model).toBe("github-copilot/gpt-5.4");
		expect(opencodeConfig.variant).toBeUndefined();
		expect(opencodeConfig.agent["variant-agent"].model).toBe("github-copilot/gpt-5.4");
		expect(opencodeConfig.agent["variant-agent"].variant).toBe("xhigh");
	} finally {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;

		if (originalXdgHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXdgHome;

		if (originalAgentHubHome === undefined) delete process.env.OPENCODE_AGENTHUB_HOME;
		else process.env.OPENCODE_AGENTHUB_HOME = originalAgentHubHome;

		await rm(tempRoot, { recursive: true, force: true });
	}
});

	test("composeWorkspace ignores unsupported top-level variant field", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-global-explicit-variant-"));
	const originalHome = process.env.HOME;
	const originalXdgHome = process.env.XDG_CONFIG_HOME;
	const originalAgentHubHome = process.env.OPENCODE_AGENTHUB_HOME;

	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const agentHubHome = path.join(tempRoot, "agenthub-home");
		const workspace = path.join(tempRoot, "workspace");

		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			installAgentHubHome({ targetRoot: agentHubHome, mode: "minimal" }),
		]);

		await writeFile(path.join(agentHubHome, "souls", "variant-agent.md"), "# variant agent\n", "utf8");
		await writeFile(
			path.join(agentHubHome, "bundles", "variant-agent.json"),
			`${JSON.stringify({
				name: "variant-agent",
				runtime: "native",
				soul: "variant-agent",
				skills: [],
				agent: {
					name: "variant-agent",
					mode: "primary",
					description: "Variant test agent",
					permission: {
						"*": "allow",
					},
				},
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(agentHubHome, "profiles", "variant-team.json"),
			`${JSON.stringify({
				name: "variant-team",
				bundles: ["variant-agent"],
				defaultAgent: "variant-agent",
				plugins: [],
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(agentHubHome, "settings.json"),
			`${JSON.stringify({
				opencode: {
					model: "openai/gpt-5.4-mini",
					variant: "high",
				},
			}, null, 2)}\n`,
			"utf8",
		);

		process.env.HOME = homeDir;
		process.env.XDG_CONFIG_HOME = xdgHomeDir;
		process.env.OPENCODE_AGENTHUB_HOME = agentHubHome;

		const result = await composeWorkspace(workspace, "variant-team");
		const opencodeConfig = parseGeneratedJson(
			await readFile(path.join(result.configRoot, "opencode.jsonc"), "utf8"),
		);

		expect(opencodeConfig.model).toBe("openai/gpt-5.4-mini");
		expect(opencodeConfig.variant).toBeUndefined();
	} finally {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;

		if (originalXdgHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXdgHome;

		if (originalAgentHubHome === undefined) delete process.env.OPENCODE_AGENTHUB_HOME;
		else process.env.OPENCODE_AGENTHUB_HOME = originalAgentHubHome;

		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("composeWorkspace merges explicitly configured native plugins", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-plugin-import-"));
	const originalHome = process.env.HOME;
	const originalXdgHome = process.env.XDG_CONFIG_HOME;
	const originalAgentHubHome = process.env.OPENCODE_AGENTHUB_HOME;
	const originalNativeConfig = process.env.OPENCODE_AGENTHUB_NATIVE_CONFIG;

	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const agentHubHome = path.join(tempRoot, "agenthub-home");
		const workspace = path.join(tempRoot, "workspace");
		const nativeConfigDir = path.join(tempRoot, "native-opencode");
		const nativeConfigPath = path.join(nativeConfigDir, "opencode.json");

		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(agentHubHome, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			mkdir(nativeConfigDir, { recursive: true }),
		]);

		await writeFile(
			nativeConfigPath,
			`${JSON.stringify({
				plugin: ["@company/shared-plugin", "/custom/plugins/rtk.ts"],
			}, null, 2)}\n`,
			"utf8",
		);

		process.env.HOME = homeDir;
		process.env.XDG_CONFIG_HOME = xdgHomeDir;
		process.env.OPENCODE_AGENTHUB_HOME = agentHubHome;
		process.env.OPENCODE_AGENTHUB_NATIVE_CONFIG = nativeConfigPath;

		await installAgentHubHome({
			targetRoot: agentHubHome,
			mode: "auto",
		});

		const result = await composeWorkspace(workspace, "auto");
		const opencodeConfigPath = path.join(result.configRoot, "opencode.jsonc");
		const xdgConfigPath = path.join(result.configRoot, "xdg", "opencode", "opencode.json");
		const opencodeConfig = parseGeneratedJson(
			await readFile(opencodeConfigPath, "utf8"),
		);
		const xdgConfig = parseGeneratedJson(
			await readFile(xdgConfigPath, "utf8"),
		);

		expect(opencodeConfig.plugin).toContain("opencode-agenthub");
		expect(opencodeConfig.plugin).toContain("@company/shared-plugin");
		expect(opencodeConfig.plugin).toContain("/custom/plugins/rtk.ts");
		expect(xdgConfig.plugin).toEqual(opencodeConfig.plugin);
	} finally {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;

		if (originalXdgHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXdgHome;

		if (originalAgentHubHome === undefined) delete process.env.OPENCODE_AGENTHUB_HOME;
		else process.env.OPENCODE_AGENTHUB_HOME = originalAgentHubHome;

		if (originalNativeConfig === undefined) delete process.env.OPENCODE_AGENTHUB_NATIVE_CONFIG;
		else process.env.OPENCODE_AGENTHUB_NATIVE_CONFIG = originalNativeConfig;

		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("composeWorkspace legacy inheritNativeAgents=false only suppresses host native merges", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-isolated-profile-"));
	const originalHome = process.env.HOME;
	const originalXdgHome = process.env.XDG_CONFIG_HOME;
	const originalAgentHubHome = process.env.OPENCODE_AGENTHUB_HOME;
	const originalNativeConfig = process.env.OPENCODE_AGENTHUB_NATIVE_CONFIG;

	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const agentHubHome = path.join(tempRoot, "agenthub-home");
		const workspace = path.join(tempRoot, "workspace");
		const nativeConfigPath = path.join(tempRoot, "native-opencode.json");

		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			installAgentHubHome({ targetRoot: agentHubHome, mode: "auto" }),
		]);

		await writeFile(
			nativeConfigPath,
			`${JSON.stringify({
				agent: {
					general: { model: "test-general" },
					explore: { model: "test-explore" },
					plan: { model: "test-plan" },
					build: { model: "test-build" },
				},
			}, null, 2)}\n`,
			"utf8",
		);

		await writeFile(path.join(agentHubHome, "souls", "coding-lead.md"), "# coding lead\n", "utf8");
		await writeFile(
			path.join(agentHubHome, "bundles", "coding-lead.json"),
			`${JSON.stringify({
				name: "coding-lead",
				runtime: "native",
				soul: "coding-lead",
				skills: [],
				agent: {
					name: "coding-lead",
					mode: "primary",
					model: "team-model",
					description: "Coding lead",
				},
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(agentHubHome, "profiles", "coding-team.json"),
			`${JSON.stringify({
				name: "coding-team",
				bundles: ["coding-lead"],
				defaultAgent: "coding-lead",
				plugins: ["opencode-agenthub"],
				inheritNativeAgents: false,
			}, null, 2)}\n`,
			"utf8",
		);

		process.env.HOME = homeDir;
		process.env.XDG_CONFIG_HOME = xdgHomeDir;
		process.env.OPENCODE_AGENTHUB_HOME = agentHubHome;
		process.env.OPENCODE_AGENTHUB_NATIVE_CONFIG = nativeConfigPath;

		const result = await composeWorkspace(workspace, "coding-team");
		const opencodeConfig = parseGeneratedJson(
			await readFile(path.join(result.configRoot, "opencode.jsonc"), "utf8"),
		);
		const lock = parseGeneratedJson(
			await readFile(path.join(result.configRoot, "agenthub-lock.json"), "utf8"),
		);

		expect(opencodeConfig.default_agent).toBe("coding-lead");
		expect(opencodeConfig.agent["coding-lead"].model).toBe("team-model");
		expect(opencodeConfig.agent.general).toBeUndefined();
		expect(opencodeConfig.agent.explore).toBeUndefined();
		expect(opencodeConfig.agent.plan).toBeUndefined();
		expect(opencodeConfig.agent.build).toBeUndefined();
		expect(lock.nativeAgentPolicy).toBe("override");
	} finally {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;

		if (originalXdgHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXdgHome;

		if (originalAgentHubHome === undefined) delete process.env.OPENCODE_AGENTHUB_HOME;
		else process.env.OPENCODE_AGENTHUB_HOME = originalAgentHubHome;

		if (originalNativeConfig === undefined) delete process.env.OPENCODE_AGENTHUB_NATIVE_CONFIG;
		else process.env.OPENCODE_AGENTHUB_NATIVE_CONFIG = originalNativeConfig;

		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("composeWorkspace keeps native agent merging by default", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-native-inherit-"));
	const originalHome = process.env.HOME;
	const originalXdgHome = process.env.XDG_CONFIG_HOME;
	const originalAgentHubHome = process.env.OPENCODE_AGENTHUB_HOME;
	const originalNativeConfig = process.env.OPENCODE_AGENTHUB_NATIVE_CONFIG;

	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const agentHubHome = path.join(tempRoot, "agenthub-home");
		const workspace = path.join(tempRoot, "workspace");
		const nativeConfigPath = path.join(tempRoot, "native-opencode.json");

		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			installAgentHubHome({ targetRoot: agentHubHome, mode: "auto" }),
		]);

		await writeFile(
			nativeConfigPath,
			`${JSON.stringify({
				agent: {
					general: { model: "test-general" },
					explore: { model: "test-explore" },
					plan: { model: "test-plan" },
					build: { model: "test-build" },
				},
			}, null, 2)}\n`,
			"utf8",
		);

		await writeFile(path.join(agentHubHome, "souls", "coding-lead.md"), "# coding lead\n", "utf8");
		await writeFile(
			path.join(agentHubHome, "bundles", "coding-lead.json"),
			`${JSON.stringify({
				name: "coding-lead",
				runtime: "native",
				soul: "coding-lead",
				skills: [],
				agent: {
					name: "coding-lead",
					mode: "primary",
					model: "team-model",
					description: "Coding lead",
				},
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(agentHubHome, "profiles", "coding-team.json"),
			`${JSON.stringify({
				name: "coding-team",
				bundles: ["coding-lead"],
				defaultAgent: "coding-lead",
				plugins: ["opencode-agenthub"],
			}, null, 2)}\n`,
			"utf8",
		);

		process.env.HOME = homeDir;
		process.env.XDG_CONFIG_HOME = xdgHomeDir;
		process.env.OPENCODE_AGENTHUB_HOME = agentHubHome;
		process.env.OPENCODE_AGENTHUB_NATIVE_CONFIG = nativeConfigPath;

		const result = await composeWorkspace(workspace, "coding-team");
		const opencodeConfig = parseGeneratedJson(
			await readFile(path.join(result.configRoot, "opencode.jsonc"), "utf8"),
		);
		const lock = parseGeneratedJson(
			await readFile(path.join(result.configRoot, "agenthub-lock.json"), "utf8"),
		);

		expect(opencodeConfig.agent["coding-lead"].model).toBe("team-model");
		expect(opencodeConfig.agent.general.model).toBe("test-general");
		expect(opencodeConfig.agent.explore.model).toBe("test-explore");
		expect(opencodeConfig.agent.plan.model).toBe("test-plan");
		expect(opencodeConfig.agent.build.model).toBe("test-build");
		expect(opencodeConfig.agent.general.disable).toBeUndefined();
		expect(lock.nativeAgentPolicy).toBe("inherit");
	} finally {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;

		if (originalXdgHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXdgHome;

		if (originalAgentHubHome === undefined) delete process.env.OPENCODE_AGENTHUB_HOME;
		else process.env.OPENCODE_AGENTHUB_HOME = originalAgentHubHome;

		if (originalNativeConfig === undefined) delete process.env.OPENCODE_AGENTHUB_NATIVE_CONFIG;
		else process.env.OPENCODE_AGENTHUB_NATIVE_CONFIG = originalNativeConfig;

		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("composeWorkspace nativeAgentPolicy team-only disables default opencode agents", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-team-only-profile-"));
	const originalHome = process.env.HOME;
	const originalXdgHome = process.env.XDG_CONFIG_HOME;
	const originalAgentHubHome = process.env.OPENCODE_AGENTHUB_HOME;
	const originalNativeConfig = process.env.OPENCODE_AGENTHUB_NATIVE_CONFIG;

	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const agentHubHome = path.join(tempRoot, "agenthub-home");
		const workspace = path.join(tempRoot, "workspace");
		const nativeConfigPath = path.join(tempRoot, "native-opencode.json");

		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			installAgentHubHome({ targetRoot: agentHubHome, mode: "auto" }),
		]);

		await writeFile(
			nativeConfigPath,
			`${JSON.stringify({
				agent: {
					general: { model: "test-general" },
					explore: { model: "test-explore" },
					plan: { model: "test-plan" },
					build: { model: "test-build" },
				},
			}, null, 2)}\n`,
			"utf8",
		);

		await writeFile(path.join(agentHubHome, "souls", "coding-lead.md"), "# coding lead\n", "utf8");
		await writeFile(
			path.join(agentHubHome, "bundles", "coding-lead.json"),
			`${JSON.stringify({
				name: "coding-lead",
				runtime: "native",
				soul: "coding-lead",
				skills: [],
				agent: {
					name: "coding-lead",
					mode: "primary",
					model: "team-model",
					description: "Coding lead",
				},
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(agentHubHome, "profiles", "coding-team.json"),
			`${JSON.stringify({
				name: "coding-team",
				bundles: ["coding-lead"],
				defaultAgent: "coding-lead",
				plugins: ["opencode-agenthub"],
				nativeAgentPolicy: "team-only",
			}, null, 2)}\n`,
			"utf8",
		);

		process.env.HOME = homeDir;
		process.env.XDG_CONFIG_HOME = xdgHomeDir;
		process.env.OPENCODE_AGENTHUB_HOME = agentHubHome;
		process.env.OPENCODE_AGENTHUB_NATIVE_CONFIG = nativeConfigPath;

		const result = await composeWorkspace(workspace, "coding-team");
		const opencodeConfig = parseGeneratedJson(
			await readFile(path.join(result.configRoot, "opencode.jsonc"), "utf8"),
		);
		const lock = parseGeneratedJson(
			await readFile(path.join(result.configRoot, "agenthub-lock.json"), "utf8"),
		);

		expect(opencodeConfig.default_agent).toBe("coding-lead");
		expect(opencodeConfig.agent["coding-lead"].model).toBe("team-model");
		expect(opencodeConfig.agent.general).toEqual({ disable: true });
		expect(opencodeConfig.agent.explore.mode).toBe("subagent");
		expect(opencodeConfig.agent.explore.hidden).toBe(true);
		expect(opencodeConfig.agent.plan).toEqual({ disable: true });
		expect(opencodeConfig.agent.build).toEqual({ disable: true });
		expect(lock.nativeAgentPolicy).toBe("team-only");
	} finally {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;

		if (originalXdgHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXdgHome;

		if (originalAgentHubHome === undefined) delete process.env.OPENCODE_AGENTHUB_HOME;
		else process.env.OPENCODE_AGENTHUB_HOME = originalAgentHubHome;

		if (originalNativeConfig === undefined) delete process.env.OPENCODE_AGENTHUB_NATIVE_CONFIG;
		else process.env.OPENCODE_AGENTHUB_NATIVE_CONFIG = originalNativeConfig;

		await rm(tempRoot, { recursive: true, force: true });
	}
});

opencodeIntegrationTest("team-only runtime hides default opencode agents from opencode agent list", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-team-only-runtime-"));
	const originalHome = process.env.HOME;
	const originalXdgHome = process.env.XDG_CONFIG_HOME;
	const originalAgentHubHome = process.env.OPENCODE_AGENTHUB_HOME;
	const originalNativeConfig = process.env.OPENCODE_AGENTHUB_NATIVE_CONFIG;

	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const agentHubHome = path.join(tempRoot, "agenthub-home");
		const workspace = path.join(tempRoot, "workspace");
		const nativeConfigPath = path.join(tempRoot, "native-opencode.json");

		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			installAgentHubHome({ targetRoot: agentHubHome, mode: "auto" }),
		]);

		await writeFile(
			nativeConfigPath,
			`${JSON.stringify({
				agent: {
					general: { model: "test-general" },
					explore: { model: "test-explore" },
					plan: { model: "test-plan" },
					build: { model: "test-build" },
				},
			}, null, 2)}\n`,
			"utf8",
		);

		await writeFile(path.join(agentHubHome, "souls", "coding-lead.md"), "# coding lead\n", "utf8");
		await writeFile(
			path.join(agentHubHome, "bundles", "coding-lead.json"),
			`${JSON.stringify({
				name: "coding-lead",
				runtime: "native",
				soul: "coding-lead",
				skills: [],
				agent: {
					name: "coding-lead",
					mode: "primary",
					model: "team-model",
					description: "Coding lead",
				},
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(agentHubHome, "profiles", "coding-team.json"),
			`${JSON.stringify({
				name: "coding-team",
				bundles: ["coding-lead"],
				defaultAgent: "coding-lead",
				plugins: ["opencode-agenthub"],
				nativeAgentPolicy: "team-only",
			}, null, 2)}\n`,
			"utf8",
		);

		process.env.HOME = homeDir;
		process.env.XDG_CONFIG_HOME = xdgHomeDir;
		process.env.OPENCODE_AGENTHUB_HOME = agentHubHome;
		process.env.OPENCODE_AGENTHUB_NATIVE_CONFIG = nativeConfigPath;

		const result = await composeWorkspace(workspace, "coding-team");
		const opencodeResult = await runOpencode({
			args: ["agent", "list"],
			cwd: workspace,
			env: {
				OPENCODE_DISABLE_PROJECT_CONFIG: "true",
				OPENCODE_CONFIG_DIR: result.configRoot,
				XDG_CONFIG_HOME: path.join(result.configRoot, "xdg"),
			},
		});

		expect(opencodeResult.code).toBe(0);
		expect(opencodeResult.stdout).toContain("coding-lead");
		expect(opencodeResult.stdout).not.toContain("general (");
		expect(opencodeResult.stdout).toContain("explore (subagent)");
		expect(opencodeResult.stdout).not.toContain("plan (");
		expect(opencodeResult.stdout).not.toContain("build (");
	} finally {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;

		if (originalXdgHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXdgHome;

		if (originalAgentHubHome === undefined) delete process.env.OPENCODE_AGENTHUB_HOME;
		else process.env.OPENCODE_AGENTHUB_HOME = originalAgentHubHome;

		if (originalNativeConfig === undefined) delete process.env.OPENCODE_AGENTHUB_NATIVE_CONFIG;
		else process.env.OPENCODE_AGENTHUB_NATIVE_CONFIG = originalNativeConfig;

		await rm(tempRoot, { recursive: true, force: true });
	}
}, 15000);

test("composeWorkspace team-only keeps a bundle-provided built-in agent active", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-team-only-builtins-"));
	const originalHome = process.env.HOME;
	const originalXdgHome = process.env.XDG_CONFIG_HOME;
	const originalAgentHubHome = process.env.OPENCODE_AGENTHUB_HOME;

	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const agentHubHome = path.join(tempRoot, "agenthub-home");
		const workspace = path.join(tempRoot, "workspace");

		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			installAgentHubHome({ targetRoot: agentHubHome, mode: "auto" }),
		]);

		await writeFile(path.join(agentHubHome, "souls", "coding-lead.md"), "# coding lead\n", "utf8");
		await writeFile(
			path.join(agentHubHome, "bundles", "coding-lead.json"),
			`${JSON.stringify({
				name: "coding-lead",
				runtime: "native",
				soul: "coding-lead",
				skills: [],
				agent: {
					name: "coding-lead",
					mode: "primary",
					model: "team-model",
					description: "Coding lead",
				},
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(agentHubHome, "profiles", "coding-team.json"),
			`${JSON.stringify({
				name: "coding-team",
				bundles: ["coding-lead", "plan"],
				defaultAgent: "coding-lead",
				plugins: ["opencode-agenthub"],
				nativeAgentPolicy: "team-only",
			}, null, 2)}\n`,
			"utf8",
		);

		process.env.HOME = homeDir;
		process.env.XDG_CONFIG_HOME = xdgHomeDir;
		process.env.OPENCODE_AGENTHUB_HOME = agentHubHome;

		const result = await composeWorkspace(workspace, "coding-team");
		const opencodeConfig = parseGeneratedJson(
			await readFile(path.join(result.configRoot, "opencode.jsonc"), "utf8"),
		);

		expect(opencodeConfig.agent.plan.disable).toBeUndefined();
		expect(opencodeConfig.agent.plan.model).toBeDefined();
		expect(opencodeConfig.agent.general).toEqual({ disable: true });
		expect(opencodeConfig.agent.explore.mode).toBe("subagent");
		expect(opencodeConfig.agent.explore.hidden).toBe(true);
		expect(opencodeConfig.agent.build).toEqual({ disable: true });
	} finally {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;

		if (originalXdgHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXdgHome;

		if (originalAgentHubHome === undefined) delete process.env.OPENCODE_AGENTHUB_HOME;
		else process.env.OPENCODE_AGENTHUB_HOME = originalAgentHubHome;

		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("composeWorkspace team-only auto-injects hidden explore when team provides no explore coverage", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-team-only-auto-explore-"));
	const originalHome = process.env.HOME;
	const originalXdgHome = process.env.XDG_CONFIG_HOME;
	const originalAgentHubHome = process.env.OPENCODE_AGENTHUB_HOME;

	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const agentHubHome = path.join(tempRoot, "agenthub-home");
		const workspace = path.join(tempRoot, "workspace");

		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			installAgentHubHome({ targetRoot: agentHubHome, mode: "auto" }),
		]);

		await writeFile(path.join(agentHubHome, "souls", "coding-lead.md"), "# coding lead\n", "utf8");
		await writeFile(
			path.join(agentHubHome, "bundles", "coding-lead.json"),
			`${JSON.stringify({
				name: "coding-lead",
				runtime: "native",
				soul: "coding-lead",
				skills: [],
				agent: {
					name: "coding-lead",
					mode: "primary",
					hidden: false,
					model: "team-model",
					description: "Coding lead",
				},
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(agentHubHome, "profiles", "coding-team.json"),
			`${JSON.stringify({
				name: "coding-team",
				bundles: ["coding-lead"],
				defaultAgent: "coding-lead",
				plugins: ["opencode-agenthub"],
				nativeAgentPolicy: "team-only",
			}, null, 2)}\n`,
			"utf8",
		);

		process.env.HOME = homeDir;
		process.env.XDG_CONFIG_HOME = xdgHomeDir;
		process.env.OPENCODE_AGENTHUB_HOME = agentHubHome;

		const result = await composeWorkspace(workspace, "coding-team");
		const opencodeConfig = parseGeneratedJson(
			await readFile(path.join(result.configRoot, "opencode.jsonc"), "utf8"),
		);

		expect(opencodeConfig.agent.explore.disable).toBeUndefined();
		expect(opencodeConfig.agent.explore.mode).toBe("subagent");
		expect(opencodeConfig.agent.explore.hidden).toBe(true);
	} finally {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;

		if (originalXdgHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXdgHome;

		if (originalAgentHubHome === undefined) delete process.env.OPENCODE_AGENTHUB_HOME;
		else process.env.OPENCODE_AGENTHUB_HOME = originalAgentHubHome;

		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("composeWorkspace team-only does not duplicate explore when team already provides it", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-team-only-custom-explore-"));
	const originalHome = process.env.HOME;
	const originalXdgHome = process.env.XDG_CONFIG_HOME;
	const originalAgentHubHome = process.env.OPENCODE_AGENTHUB_HOME;

	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const agentHubHome = path.join(tempRoot, "agenthub-home");
		const workspace = path.join(tempRoot, "workspace");

		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			installAgentHubHome({ targetRoot: agentHubHome, mode: "auto" }),
		]);

		await writeFile(path.join(agentHubHome, "souls", "coding-lead.md"), "# coding lead\n", "utf8");
		await writeFile(path.join(agentHubHome, "souls", "explore.md"), "# custom explore\n", "utf8");
		await writeFile(
			path.join(agentHubHome, "bundles", "coding-lead.json"),
			`${JSON.stringify({
				name: "coding-lead",
				runtime: "native",
				soul: "coding-lead",
				skills: [],
				agent: {
					name: "coding-lead",
					mode: "primary",
					hidden: false,
					model: "team-model",
					description: "Coding lead",
				},
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(agentHubHome, "bundles", "explore.json"),
			`${JSON.stringify({
				name: "explore",
				runtime: "native",
				soul: "explore",
				skills: [],
				agent: {
					name: "explore",
					mode: "subagent",
					hidden: true,
					model: "custom-explore-model",
					description: "Custom explore",
				},
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(agentHubHome, "profiles", "coding-team.json"),
			`${JSON.stringify({
				name: "coding-team",
				bundles: ["coding-lead", "explore"],
				defaultAgent: "coding-lead",
				plugins: ["opencode-agenthub"],
				nativeAgentPolicy: "team-only",
			}, null, 2)}\n`,
			"utf8",
		);

		process.env.HOME = homeDir;
		process.env.XDG_CONFIG_HOME = xdgHomeDir;
		process.env.OPENCODE_AGENTHUB_HOME = agentHubHome;

		const result = await composeWorkspace(workspace, "coding-team");
		const opencodeConfig = parseGeneratedJson(
			await readFile(path.join(result.configRoot, "opencode.jsonc"), "utf8"),
		);

		expect(opencodeConfig.agent.explore.model).toBe("custom-explore-model");
	} finally {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;

		if (originalXdgHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXdgHome;

		if (originalAgentHubHome === undefined) delete process.env.OPENCODE_AGENTHUB_HOME;
		else process.env.OPENCODE_AGENTHUB_HOME = originalAgentHubHome;

		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("composeWorkspace rejects defaultAgent that matches bundle name instead of agent.name", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-default-agent-mismatch-"));
	const originalHome = process.env.HOME;
	const originalXdgHome = process.env.XDG_CONFIG_HOME;
	const originalAgentHubHome = process.env.OPENCODE_AGENTHUB_HOME;

	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const agentHubHome = path.join(tempRoot, "agenthub-home");
		const workspace = path.join(tempRoot, "workspace");

		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			installAgentHubHome({ targetRoot: agentHubHome, mode: "auto" }),
		]);

		await writeFile(
			path.join(agentHubHome, "souls", "coding-lead.md"),
			"# coding lead\n",
			"utf8",
		);
		await writeFile(
			path.join(
				agentHubHome,
				"bundles",
				"sdwo-coding-first-team-coding-delivery-lead.json",
			),
			`${JSON.stringify({
				name: "sdwo-coding-first-team-coding-delivery-lead",
				runtime: "native",
				soul: "coding-lead",
				skills: [],
				agent: {
					name: "coding-delivery-lead",
					mode: "primary",
					model: "team-model",
					description: "Coding lead",
				},
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(agentHubHome, "profiles", "coding-team.json"),
			`${JSON.stringify({
				name: "coding-team",
				bundles: ["sdwo-coding-first-team-coding-delivery-lead"],
				defaultAgent: "sdwo-coding-first-team-coding-delivery-lead",
				plugins: ["opencode-agenthub"],
				nativeAgentPolicy: "team-only",
			}, null, 2)}\n`,
			"utf8",
		);

		process.env.HOME = homeDir;
		process.env.XDG_CONFIG_HOME = xdgHomeDir;
		process.env.OPENCODE_AGENTHUB_HOME = agentHubHome;

		await expect(composeWorkspace(workspace, "coding-team")).rejects.toThrow(
			/defaultAgent .*sdwo-coding-first-team-coding-delivery-lead.*coding-delivery-lead/s,
		);
	} finally {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;

		if (originalXdgHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXdgHome;

		if (originalAgentHubHome === undefined) delete process.env.OPENCODE_AGENTHUB_HOME;
		else process.env.OPENCODE_AGENTHUB_HOME = originalAgentHubHome;

		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("composeWorkspace rejects unknown defaultAgent with clear available agent names", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-default-agent-unknown-"));
	const originalHome = process.env.HOME;
	const originalXdgHome = process.env.XDG_CONFIG_HOME;
	const originalAgentHubHome = process.env.OPENCODE_AGENTHUB_HOME;

	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const agentHubHome = path.join(tempRoot, "agenthub-home");
		const workspace = path.join(tempRoot, "workspace");

		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			installAgentHubHome({ targetRoot: agentHubHome, mode: "auto" }),
		]);

		await writeFile(path.join(agentHubHome, "souls", "coding-lead.md"), "# coding lead\n", "utf8");
		await writeFile(
			path.join(agentHubHome, "bundles", "coding-lead.json"),
			`${JSON.stringify({
				name: "coding-lead",
				runtime: "native",
				soul: "coding-lead",
				skills: [],
				agent: {
					name: "coding-delivery-lead",
					mode: "primary",
					model: "team-model",
				},
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(agentHubHome, "profiles", "coding-team.json"),
			`${JSON.stringify({
				name: "coding-team",
				bundles: ["coding-lead"],
				defaultAgent: "missing-agent",
				plugins: ["opencode-agenthub"],
			}, null, 2)}\n`,
			"utf8",
		);

		process.env.HOME = homeDir;
		process.env.XDG_CONFIG_HOME = xdgHomeDir;
		process.env.OPENCODE_AGENTHUB_HOME = agentHubHome;

		await expect(composeWorkspace(workspace, "coding-team")).rejects.toThrow(
			/defaultAgent 'missing-agent'.*Available agent names: .*coding-delivery-lead/s,
		);
	} finally {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;

		if (originalXdgHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXdgHome;

		if (originalAgentHubHome === undefined) delete process.env.OPENCODE_AGENTHUB_HOME;
		else process.env.OPENCODE_AGENTHUB_HOME = originalAgentHubHome;

		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("composeWorkspace requires explicit defaultAgent for team-only profiles", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-team-only-default-required-"));
	const originalHome = process.env.HOME;
	const originalXdgHome = process.env.XDG_CONFIG_HOME;
	const originalAgentHubHome = process.env.OPENCODE_AGENTHUB_HOME;

	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const agentHubHome = path.join(tempRoot, "agenthub-home");
		const workspace = path.join(tempRoot, "workspace");

		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			installAgentHubHome({ targetRoot: agentHubHome, mode: "auto" }),
		]);

		await writeFile(path.join(agentHubHome, "souls", "coding-lead.md"), "# coding lead\n", "utf8");
		await writeFile(
			path.join(agentHubHome, "bundles", "coding-lead.json"),
			`${JSON.stringify({
				name: "coding-lead",
				runtime: "native",
				soul: "coding-lead",
				skills: [],
				agent: {
					name: "coding-delivery-lead",
					mode: "primary",
					model: "team-model",
				},
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(agentHubHome, "profiles", "coding-team.json"),
			`${JSON.stringify({
				name: "coding-team",
				bundles: ["coding-lead"],
				plugins: ["opencode-agenthub"],
				nativeAgentPolicy: "team-only",
			}, null, 2)}\n`,
			"utf8",
		);

		process.env.HOME = homeDir;
		process.env.XDG_CONFIG_HOME = xdgHomeDir;
		process.env.OPENCODE_AGENTHUB_HOME = agentHubHome;

		await expect(composeWorkspace(workspace, "coding-team")).rejects.toThrow(
			/Team-only profile 'coding-team' must set defaultAgent explicitly/s,
		);
	} finally {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;

		if (originalXdgHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXdgHome;

		if (originalAgentHubHome === undefined) delete process.env.OPENCODE_AGENTHUB_HOME;
		else process.env.OPENCODE_AGENTHUB_HOME = originalAgentHubHome;

		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("composeWorkspace rejects team-only profiles when every staged agent is a subagent", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-team-only-all-subagents-"));
	const originalHome = process.env.HOME;
	const originalXdgHome = process.env.XDG_CONFIG_HOME;
	const originalAgentHubHome = process.env.OPENCODE_AGENTHUB_HOME;

	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const agentHubHome = path.join(tempRoot, "agenthub-home");
		const workspace = path.join(tempRoot, "workspace");

		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			installAgentHubHome({ targetRoot: agentHubHome, mode: "auto" }),
		]);

		await writeFile(path.join(agentHubHome, "souls", "reviewer.md"), "# reviewer\n", "utf8");
		await writeFile(
			path.join(agentHubHome, "bundles", "reviewer.json"),
			`${JSON.stringify({
				name: "reviewer",
				runtime: "native",
				soul: "reviewer",
				skills: [],
				agent: {
					name: "reviewer",
					mode: "subagent",
					model: "team-model",
					description: "Reviewer",
				},
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(agentHubHome, "profiles", "review-team.json"),
			`${JSON.stringify({
				name: "review-team",
				bundles: ["reviewer"],
				defaultAgent: "reviewer",
				plugins: ["opencode-agenthub"],
				nativeAgentPolicy: "team-only",
			}, null, 2)}\n`,
			"utf8",
		);

		process.env.HOME = homeDir;
		process.env.XDG_CONFIG_HOME = xdgHomeDir;
		process.env.OPENCODE_AGENTHUB_HOME = agentHubHome;

		await expect(composeWorkspace(workspace, "review-team")).rejects.toThrow(
			/defaultAgent .* must point to a primary agent/i,
		);
	} finally {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;

		if (originalXdgHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXdgHome;

		if (originalAgentHubHome === undefined) delete process.env.OPENCODE_AGENTHUB_HOME;
		else process.env.OPENCODE_AGENTHUB_HOME = originalAgentHubHome;

		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("composeWorkspace rejects defaultAgent that points to a subagent in team-only mode", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-team-only-subagent-default-"));
	const originalHome = process.env.HOME;
	const originalXdgHome = process.env.XDG_CONFIG_HOME;
	const originalAgentHubHome = process.env.OPENCODE_AGENTHUB_HOME;

	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const agentHubHome = path.join(tempRoot, "agenthub-home");
		const workspace = path.join(tempRoot, "workspace");

		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			installAgentHubHome({ targetRoot: agentHubHome, mode: "auto" }),
		]);

		await writeFile(path.join(agentHubHome, "souls", "host.md"), "# host\n", "utf8");
		await writeFile(path.join(agentHubHome, "souls", "reviewer.md"), "# reviewer\n", "utf8");
		await writeFile(
			path.join(agentHubHome, "bundles", "host.json"),
			`${JSON.stringify({
				name: "host",
				runtime: "native",
				soul: "host",
				skills: [],
				agent: {
					name: "host",
					mode: "primary",
					model: "team-model",
					description: "Host",
				},
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(agentHubHome, "bundles", "reviewer.json"),
			`${JSON.stringify({
				name: "reviewer",
				runtime: "native",
				soul: "reviewer",
				skills: [],
				agent: {
					name: "reviewer",
					mode: "subagent",
					model: "team-model",
					description: "Reviewer",
				},
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(agentHubHome, "profiles", "review-team.json"),
			`${JSON.stringify({
				name: "review-team",
				bundles: ["host", "reviewer"],
				defaultAgent: "reviewer",
				plugins: ["opencode-agenthub"],
				nativeAgentPolicy: "team-only",
			}, null, 2)}\n`,
			"utf8",
		);

		process.env.HOME = homeDir;
		process.env.XDG_CONFIG_HOME = xdgHomeDir;
		process.env.OPENCODE_AGENTHUB_HOME = agentHubHome;

		await expect(composeWorkspace(workspace, "review-team")).rejects.toThrow(
			/defaultAgent .* must point to a primary agent/i,
		);
	} finally {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;

		if (originalXdgHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXdgHome;

		if (originalAgentHubHome === undefined) delete process.env.OPENCODE_AGENTHUB_HOME;
		else process.env.OPENCODE_AGENTHUB_HOME = originalAgentHubHome;

		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("doctor createProfile defaults to the first bundle agent.name", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-doctor-default-agent-"));
	try {
		const targetRoot = path.join(tempRoot, "agenthub-home");
		await Promise.all([
			mkdir(path.join(targetRoot, "bundles"), { recursive: true }),
			mkdir(path.join(targetRoot, "profiles"), { recursive: true }),
		]);
		await writeFile(
			path.join(targetRoot, "bundles", "sdwo-coding-first-team-coding-delivery-lead.json"),
			`${JSON.stringify({
				name: "sdwo-coding-first-team-coding-delivery-lead",
				runtime: "native",
				soul: "coding-lead",
				skills: [],
				agent: {
					name: "coding-delivery-lead",
					mode: "primary",
					model: "team-model",
				},
			}, null, 2)}\n`,
			"utf8",
		);

		const result = await createProfile(targetRoot, "coding-team", {
			bundleNames: ["sdwo-coding-first-team-coding-delivery-lead"],
		});

		expect(result.success).toBe(true);
		const profile = JSON.parse(
			await readFile(path.join(targetRoot, "profiles", "coding-team.json"), "utf8"),
		);
		expect(profile.defaultAgent).toBe("coding-delivery-lead");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("composeWorkspace honors explicit homeRoot over environment home", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-explicit-root-"));
	const originalAgentHubHome = process.env.OPENCODE_AGENTHUB_HOME;

	try {
		const sourceHome = path.join(tempRoot, "source-home");
		const targetHome = path.join(tempRoot, "target-home");
		const workspace = path.join(tempRoot, "workspace");

		await Promise.all([
			mkdir(workspace, { recursive: true }),
			installAgentHubHome({ targetRoot: sourceHome, mode: "auto" }),
			installAgentHubHome({ targetRoot: targetHome, mode: "auto" }),
		]);
		await Promise.all([
			mkdir(path.join(sourceHome, "instructions"), { recursive: true }),
			mkdir(path.join(targetHome, "instructions"), { recursive: true }),
		]);

		await writeFile(
			path.join(sourceHome, "instructions", "home-marker.md"),
			"SOURCE HOME\n",
			"utf8",
		);
		await writeFile(
			path.join(targetHome, "instructions", "home-marker.md"),
			"TARGET HOME\n",
			"utf8",
		);

		for (const home of [sourceHome, targetHome]) {
			const autoBundlePath = path.join(home, "bundles", "auto.json");
			const autoBundle = JSON.parse(await readFile(autoBundlePath, "utf8"));
			autoBundle.instructions = ["home-marker"];
			await writeFile(autoBundlePath, `${JSON.stringify(autoBundle, null, 2)}\n`, "utf8");
		}

		process.env.OPENCODE_AGENTHUB_HOME = sourceHome;
		const result = await composeWorkspace(workspace, "auto", undefined, {
			homeRoot: targetHome,
		});

		expect(
			await readFile(path.join(result.configRoot, "agents", "auto.md"), "utf8"),
		).toContain("TARGET HOME");
		const lock = parseGeneratedJson(
			await readFile(path.join(result.configRoot, "agenthub-lock.json"), "utf8"),
		);
		expect(lock.libraryRoot).toBe(targetHome);
	} finally {
		if (originalAgentHubHome === undefined) delete process.env.OPENCODE_AGENTHUB_HOME;
		else process.env.OPENCODE_AGENTHUB_HOME = originalAgentHubHome;
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("composeWorkspace explicit homeRoot falls back to built-in shared assets", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-builtins-fallback-"));

	try {
		const isolatedHome = path.join(tempRoot, "isolated-home");
		const workspace = path.join(tempRoot, "workspace");
		await Promise.all([
			mkdir(path.join(isolatedHome, "profiles"), { recursive: true }),
			mkdir(path.join(isolatedHome, "bundles"), { recursive: true }),
			mkdir(workspace, { recursive: true }),
		]);

		await writeFile(
			path.join(isolatedHome, "profiles", "hr-office.json"),
			`${JSON.stringify(
				{
					name: "hr-office",
					description: "Isolated root that relies on built-in coding assets",
					bundles: ["auto", "plan", "build"],
					defaultAgent: "auto",
					plugins: ["opencode-agenthub"],
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		const result = await composeWorkspace(workspace, "hr-office", undefined, {
			homeRoot: isolatedHome,
		});

		const opencodeConfig = parseGeneratedJson(
			await readFile(path.join(result.configRoot, "opencode.jsonc"), "utf8"),
		);
		const runtimeConfig = parseGeneratedJson(
			await readFile(path.join(result.configRoot, "agenthub-runtime.json"), "utf8"),
		);

		expect(opencodeConfig.default_agent).toBe("auto");
		expect(Object.keys(opencodeConfig.agent)).toEqual(
			expect.arrayContaining(["auto", "plan", "build"]),
		);
		expect(runtimeConfig.workflowInjection?.enabled).toBe(true);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("start hr now redirects users to hr command", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-hr-office-cli-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const personalHome = path.join(tempRoot, "personal-home");
		const hrHome = path.join(tempRoot, "hr-home");
		const workspace = path.join(tempRoot, "workspace");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
		]);

		const result = await runCli({
			args: ["start", "hr", "--assemble-only"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				OPENCODE_AGENTHUB_HR_HOME: hrHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("'start hr' and 'run hr' are no longer supported");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("run hr now redirects users to hr command", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-hr-office-missing-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const personalHome = path.join(tempRoot, "personal-home");
		const hrHome = path.join(tempRoot, "hr-home");
		const workspace = path.join(tempRoot, "workspace");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
		]);

		const result = await runCli({
			args: ["run", "hr", "--assemble-only"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				OPENCODE_AGENTHUB_HR_HOME: hrHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("'start hr' and 'run hr' are no longer supported");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("bare hr command bootstraps isolated HR Office", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-hr-command-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const personalHome = path.join(tempRoot, "personal-home");
		const hrHome = path.join(tempRoot, "hr-home");
		const workspace = path.join(tempRoot, "workspace");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
		]);

		const result = await runCli({
			args: ["hr", "--assemble-only"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				OPENCODE_AGENTHUB_HR_HOME: hrHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("HR Office — first-time setup");
		expect(result.stdout).toContain("full HR assemble can take about 20–30 minutes");
		expect(result.stdout).toContain("This will:");
		expect(result.stdout).toContain("Choose an AI model for HR agents");
		expect(result.stdout).toContain("Create the HR Office workspace");
		expect(result.stdout).toContain("Skip inventory sync for now because you are assembling only");
		expect(result.stdout).toContain("initialised HR Office");
		expect(result.stdout).toContain("HR Office is ready");
		expect(result.stdout).toContain("Tip: change HR models later with 'agenthub doctor'.");
		expect(result.stdout).not.toContain("Environment: HR Office");
		expect(result.stdout).not.toContain("HR model settings:");
		await expect(
			readFile(path.join(workspace, ".opencode-agenthub.user.json"), "utf8"),
		).rejects.toThrow();
		const settings = JSON.parse(await readFile(path.join(hrHome, "settings.json"), "utf8"));
		expect(settings.agents.hr.model).toBe("openai/gpt-5.4-mini");
		expect(settings.agents.hr.variant).toBe("high");
		expect(settings.agents["hr-planner"].model).toBe("openai/gpt-5.4-mini");
		expect(settings.agents["hr-planner"].variant).toBe("high");
		expect(settings.agents["hr-sourcer"].model).toBe("openai/gpt-5.4-mini");
		expect(settings.agents["hr-sourcer"].variant).toBe("high");
		expect(settings.agents["hr-evaluator"].model).toBe("openai/gpt-5.4-mini");
		expect(settings.agents["hr-evaluator"].variant).toBe("high");
		expect(settings.meta.onboarding.modelStrategy).toBe("recommended");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("first non-assemble hr run syncs source inventory on bootstrap", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-hr-first-sync-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const personalHome = path.join(tempRoot, "personal-home");
		const hrHome = path.join(tempRoot, "hr-home");
		const workspace = path.join(tempRoot, "workspace");
		const fakeBin = path.join(tempRoot, "bin");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			mkdir(fakeBin, { recursive: true }),
		]);

		await writeExecutable({
			targetBase: path.join(fakeBin, pythonCommand),
			posixContents: `#!/bin/sh
mkdir -p "$OPENCODE_AGENTHUB_HR_HOME/inventory"
cat > "$OPENCODE_AGENTHUB_HR_HOME/source-status.json" <<'EOF'
{
  "schema_version": "1.0",
  "sources": {
    "fake": {
      "repo": "stub/source"
    }
  }
}
EOF
cat > "$OPENCODE_AGENTHUB_HR_HOME/inventory/SUMMARY.md" <<'EOF'
# Inventory Sync Summary

- fake sync complete
EOF
printf '# Inventory Sync Summary\n\n- fake sync complete\n'
`,
			windowsContents: `@echo off
node -e "const fs=require('fs'); const path=require('path'); const root=process.env.OPENCODE_AGENTHUB_HR_HOME; fs.mkdirSync(path.join(root,'inventory'), { recursive: true }); fs.writeFileSync(path.join(root,'source-status.json'), JSON.stringify({ schema_version: '1.0', sources: { fake: { repo: 'stub/source' } } }, null, 2) + '\\n'); fs.writeFileSync(path.join(root,'inventory','SUMMARY.md'), '# Inventory Sync Summary\\n\\n- fake sync complete\\n'); process.stdout.write('# Inventory Sync Summary\\n\\n- fake sync complete\\n');"
`,
		});

		await writeExecutable({
			targetBase: path.join(fakeBin, "opencode"),
			posixContents: "#!/bin/sh\nexit 0\n",
			windowsContents: "@echo off\r\nexit /b 0\r\n",
		});

		const result = await runCli({
			args: ["hr"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				OPENCODE_AGENTHUB_HR_HOME: hrHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
				PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
			},
		});

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("HR Office — first-time setup");
		expect(result.stdout).toContain("full HR assemble can take about 20–30 minutes");
		expect(result.stdout).toContain("This will:");
		expect(result.stdout).toContain("initialised HR Office");
		expect(result.stdout).toContain("Sync the HR sourcer inventory");
		expect(result.stdout).toContain("this may take a moment, please wait");
		expect(result.stdout).toContain("HR sourcer inventory sync complete");
		expect(result.stdout).toContain("HR Office is ready");
		expect(result.stdout).not.toContain("fake sync complete");
		expect(result.stdout).not.toContain("Inventory Sync Summary");
		expect(result.stdout).not.toContain("HR source status:");
		expect(result.stdout).not.toContain("Environment: HR Office");
		const sourceStatus = JSON.parse(await readFile(path.join(hrHome, "source-status.json"), "utf8"));
		expect(sourceStatus.sources.fake.repo).toBe("stub/source");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("bare hr command keeps recommended HR model even when native config exists", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-hr-native-default-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const personalHome = path.join(tempRoot, "personal-home");
		const hrHome = path.join(tempRoot, "hr-home");
		const workspace = path.join(tempRoot, "workspace");
		const nativeConfigPath = path.join(tempRoot, "native-opencode.json");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			writeFile(
				nativeConfigPath,
				`${JSON.stringify({ model: "openai/gpt-5-mini" }, null, 2)}\n`,
				"utf8",
			),
		]);

		const result = await runCli({
			args: ["hr", "--assemble-only"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				OPENCODE_AGENTHUB_HR_HOME: hrHome,
				OPENCODE_AGENTHUB_NATIVE_CONFIG: nativeConfigPath,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});

		expect(result.code).toBe(0);
		const settings = JSON.parse(await readFile(path.join(hrHome, "settings.json"), "utf8"));
		expect(settings.agents.hr.model).toBe("openai/gpt-5.4-mini");
		expect(settings.agents.hr.variant).toBe("high");
		expect(settings.agents["hr-planner"].model).toBe("openai/gpt-5.4-mini");
		expect(settings.agents["hr-planner"].variant).toBe("high");
		expect(settings.agents["hr-sourcer"].model).toBe("openai/gpt-5.4-mini");
		expect(settings.agents["hr-sourcer"].variant).toBe("high");
		expect(settings.agents["hr-evaluator"].model).toBe("openai/gpt-5.4-mini");
		expect(settings.agents["hr-evaluator"].variant).toBe("high");
		expect(settings.agents["hr-cto"].model).toBe("openai/gpt-5.4-mini");
		expect(settings.agents["hr-cto"].variant).toBe("high");
		expect(settings.agents["hr-adapter"].model).toBe("openai/gpt-5.4-mini");
		expect(settings.agents["hr-adapter"].variant).toBe("high");
		expect(settings.agents["hr-verifier"].model).toBe("openai/gpt-5.4-mini");
		expect(settings.agents["hr-verifier"].variant).toBe("high");
		expect(settings.meta.onboarding.modelStrategy).toBe("recommended");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("interactive HR bootstrap strips Windows mouse-tracking escape noise", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-hr-windows-mouse-noise-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const personalHome = path.join(tempRoot, "personal-home");
		const hrHome = path.join(tempRoot, "hr-home");
		const workspace = path.join(tempRoot, "workspace");
		const fakeBin = path.join(tempRoot, "bin");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			mkdir(fakeBin, { recursive: true }),
		]);
		await writeFakeOpencodeModels({
			targetBase: path.join(fakeBin, "opencode"),
			allModels: ["openai/gpt-5.4-mini", "opencode/minimax-m2.5-free"],
			freeModels: ["opencode/minimax-m2.5-free"],
		});

		const result = await runCli({
			args: ["hr", "--assemble-only"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				OPENCODE_AGENTHUB_HR_HOME: hrHome,
				OPENCODE_AGENTHUB_FORCE_INTERACTIVE_PROMPTS: "1",
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
				PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
			},
			input: "\u001b[<35;24;14maccept\n",
		});

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("HR Office — first-time setup");
		expect(result.stdout).toContain("full HR assemble can take about 20–30 minutes");
		expect(result.stdout).toContain("Recommended setup:");
		expect(result.stdout).not.toContain("[ASSESSMENT]");
		expect(result.stdout).not.toContain("[RECOMMENDATION]");
		expect(result.stdout).not.toContain("[PROCESS]");
		expect(result.stdout).not.toContain("[REQUIREMENTS]");
		expect(result.stdout).not.toContain("HR situation");
		expect(result.stdout).not.toContain("Configured HR sources:");
		expect(result.stdout).not.toContain("35;24;14m");
		const settings = JSON.parse(await readFile(path.join(hrHome, "settings.json"), "utf8"));
		expect(settings.agents.hr.model).toBe("openai/gpt-5.4-mini");
		expect(settings.meta.onboarding.modelStrategy).toBe("recommended");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("interactive hr bootstrap recommends a fallback after assessing available resources", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-hr-recommended-fallback-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const personalHome = path.join(tempRoot, "personal-home");
		const hrHome = path.join(tempRoot, "hr-home");
		const workspace = path.join(tempRoot, "workspace");
		const fakeBin = path.join(tempRoot, "bin");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			mkdir(fakeBin, { recursive: true }),
		]);
		await writeFakeOpencodeModels({
			targetBase: path.join(fakeBin, "opencode"),
			allModels: ["opencode/minimax-m2.5-free"],
			freeModels: ["opencode/minimax-m2.5-free"],
		});

		const result = await runCli({
			args: ["hr", "--assemble-only"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				OPENCODE_AGENTHUB_HR_HOME: hrHome,
				OPENCODE_AGENTHUB_FORCE_INTERACTIVE_PROMPTS: "1",
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
				PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
			},
			input: "accept\n",
		});

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("full HR assemble can take about 20–30 minutes");
		expect(result.stdout).toContain("Recommended setup:");
		expect(result.stdout).toContain("I recommend starting with the best available free HR model");
		expect(result.stdout).not.toContain("Today:");
		expect(result.stdout).not.toContain("HR situation");
		expect(result.stdout).not.toContain("Model 'openai/gpt-5.4-mini' is not available");
		expect(result.stdout).not.toContain("Configured HR sources:");
		expect(result.stdout).toContain("Apply this recommendation now");
		const settings = JSON.parse(await readFile(path.join(hrHome, "settings.json"), "utf8"));
		expect(settings.meta.onboarding.modelStrategy).toBe("free");
		expect(settings.agents.hr.model).toBe("opencode/minimax-m2.5-free");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("interactive hr bootstrap re-prompts until custom model id is valid", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-hr-custom-validation-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const personalHome = path.join(tempRoot, "personal-home");
		const hrHome = path.join(tempRoot, "hr-home");
		const workspace = path.join(tempRoot, "workspace");
		const fakeBin = path.join(tempRoot, "bin");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			mkdir(fakeBin, { recursive: true }),
		]);
		await writeFakeOpencodeModels({
			targetBase: path.join(fakeBin, "opencode"),
			allModels: ["openai/gpt-5.4-mini", "opencode/minimax-m2.5-free"],
			freeModels: ["opencode/minimax-m2.5-free"],
		});

		const result = await runCli({
			args: ["hr", "--assemble-only"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				OPENCODE_AGENTHUB_HR_HOME: hrHome,
				OPENCODE_AGENTHUB_FORCE_INTERACTIVE_PROMPTS: "1",
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
				PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
			},
			input: "custom\nbadmodel\nopenai/gpt-5.4-mini\n",
		});

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("full HR assemble can take about 20–30 minutes");
		expect(result.stdout).toContain("Recommended setup:");
		expect(result.stdout).toContain("Apply this recommendation now");
		expect(result.stdout).not.toContain("Today:");
		expect(result.stdout).not.toContain("HR situation");
		expect(result.stdout).not.toContain("Configured HR sources:");
		expect(result.stdout).toContain("Model id must use provider/model format.");
		const settings = JSON.parse(await readFile(path.join(hrHome, "settings.json"), "utf8"));
		expect(settings.meta.onboarding.modelStrategy).toBe("custom");
		expect(settings.agents.hr.model).toBe("openai/gpt-5.4-mini");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("interactive hr command repairs invalid persisted hr models before compose", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-hr-repair-invalid-model-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const personalHome = path.join(tempRoot, "personal-home");
		const hrHome = path.join(tempRoot, "hr-home");
		const workspace = path.join(tempRoot, "workspace");
		const fakeBin = path.join(tempRoot, "bin");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			mkdir(fakeBin, { recursive: true }),
		]);
		await installHrOfficeHomeWithOptions({ hrRoot: hrHome });
		const settingsPath = path.join(hrHome, "settings.json");
		const settings = JSON.parse(await readFile(settingsPath, "utf8"));
		settings.meta.onboarding.modelStrategy = "custom";
		for (const agentName of ["hr", "hr-planner", "hr-sourcer", "hr-evaluator", "hr-cto", "hr-adapter", "hr-verifier"]) {
			settings.agents[agentName].model = "badmodel";
			delete settings.agents[agentName].variant;
		}
		await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
		await writeFakeOpencodeModels({
			targetBase: path.join(fakeBin, "opencode"),
			allModels: ["opencode/minimax-m2.5-free"],
			freeModels: ["opencode/minimax-m2.5-free"],
		});

		const result = await runCli({
			args: ["hr", "--assemble-only"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				OPENCODE_AGENTHUB_HR_HOME: hrHome,
				OPENCODE_AGENTHUB_FORCE_INTERACTIVE_PROMPTS: "1",
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
				PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
			},
			input: "y\nfree\n",
		});

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("HR model configuration needs attention");
		expect(result.stdout).toContain("Updated HR model configuration");
		const repaired = JSON.parse(await readFile(settingsPath, "utf8"));
		expect(repaired.meta.onboarding.modelStrategy).toBe("free");
		expect(repaired.agents.hr.model).toBe("opencode/minimax-m2.5-free");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("explicit HR bootstrap model selection materializes and preserves custom overrides", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-hr-explicit-models-"));
	try {
		const hrHome = path.join(tempRoot, "hr-home");
		await installHrOfficeHomeWithOptions({
			hrRoot: hrHome,
			hrModelSelection: {
				consoleModel: "openai/gpt-5",
				subagentStrategy: "custom",
				sharedSubagentModel: "openai/gpt-5-mini",
			},
		});

		let settings = JSON.parse(await readFile(path.join(hrHome, "settings.json"), "utf8"));
		expect(settings.agents.hr.model).toBe("openai/gpt-5");
		expect(settings.agents["hr-sourcer"].model).toBe("openai/gpt-5-mini");
		expect(settings.agents["hr-planner"].model).toBe("openai/gpt-5-mini");
		expect(settings.agents["hr-evaluator"].model).toBe("openai/gpt-5-mini");
		expect(settings.agents["hr-cto"].model).toBe("openai/gpt-5-mini");
		expect(settings.agents["hr-adapter"].model).toBe("openai/gpt-5-mini");
		expect(settings.agents["hr-verifier"].model).toBe("openai/gpt-5-mini");
		expect(settings.meta.onboarding.modelStrategy).toBe("custom");

		await installHrOfficeHomeWithOptions({ hrRoot: hrHome });
		settings = JSON.parse(await readFile(path.join(hrHome, "settings.json"), "utf8"));
		expect(settings.agents.hr.model).toBe("openai/gpt-5");
		expect(settings.agents["hr-evaluator"].model).toBe("openai/gpt-5-mini");
		expect(settings.meta.onboarding.modelStrategy).toBe("custom");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("free HR bootstrap strategy materializes chosen free model for all HR agents", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-hr-free-model-"));
	try {
		const hrHome = path.join(tempRoot, "hr-home");
		await installHrOfficeHomeWithOptions({
			hrRoot: hrHome,
			hrModelSelection: {
				subagentStrategy: "free",
				sharedSubagentModel: "opencode/minimax-m2.5-free",
			},
		});

		const settings = JSON.parse(await readFile(path.join(hrHome, "settings.json"), "utf8"));
		expect(settings.agents.hr.model).toBe("opencode/minimax-m2.5-free");
		expect(settings.agents["hr-sourcer"].model).toBe("opencode/minimax-m2.5-free");
		expect(settings.agents["hr-planner"].model).toBe("opencode/minimax-m2.5-free");
		expect(settings.agents["hr-evaluator"].model).toBe("opencode/minimax-m2.5-free");
		expect(settings.agents["hr-cto"].model).toBe("opencode/minimax-m2.5-free");
		expect(settings.agents["hr-adapter"].model).toBe("opencode/minimax-m2.5-free");
		expect(settings.agents["hr-verifier"].model).toBe("opencode/minimax-m2.5-free");
		expect(settings.meta.onboarding.modelStrategy).toBe("free");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("bare hr command reuses an existing HR Office without reinitializing it", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-hr-command-reuse-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const personalHome = path.join(tempRoot, "personal-home");
		const hrHome = path.join(tempRoot, "hr-home");
		const workspace = path.join(tempRoot, "workspace");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			installHrOfficeHome(hrHome),
		]);

		const result = await runCli({
			args: ["hr", "--assemble-only"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				OPENCODE_AGENTHUB_HR_HOME: hrHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Environment: HR Office");
		expect(result.stdout).not.toContain("initialised HR Office");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("hr custom-profile resolves from HR Office root", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-hr-custom-profile-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const personalHome = path.join(tempRoot, "personal-home");
		const hrHome = path.join(tempRoot, "hr-home");
		const workspace = path.join(tempRoot, "workspace");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			installHrOfficeHome(hrHome),
			installAgentHubHome({ targetRoot: personalHome, mode: "auto" }),
		]);

		await writeFile(
			path.join(hrHome, "profiles", "recruiter-team.json"),
			`${JSON.stringify(
				{
					name: "recruiter-team",
					description: "HR custom profile",
					bundles: ["hr", "auto"],
					defaultAgent: "hr",
					plugins: ["opencode-agenthub"],
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		const result = await runCli({
			args: ["hr", "recruiter-team", "--assemble-only"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				OPENCODE_AGENTHUB_HR_HOME: hrHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Environment: HR Office");
		const configRoot = result.stdout.trim().split("\n").pop();
		if (!configRoot) throw new Error("Expected config root output from hr recruiter-team --assemble-only");
		const lock = parseGeneratedJson(
			await readFile(path.join(configRoot, "agenthub-lock.json"), "utf8"),
		);
		expect(lock.libraryRoot).toBe(hrHome);
		const opencodeConfig = parseGeneratedJson(
			await readFile(path.join(configRoot, "opencode.jsonc"), "utf8"),
		);
		expect(opencodeConfig.default_agent).toBe("hr");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("hr custom-profile bootstraps HR Office on first run before resolving profile", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-hr-custom-first-run-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const personalHome = path.join(tempRoot, "personal-home");
		const hrHome = path.join(tempRoot, "hr-home");
		const workspace = path.join(tempRoot, "workspace");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
		]);

		const result = await runCli({
			args: ["hr", "recruiter-team", "--assemble-only"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				OPENCODE_AGENTHUB_HR_HOME: hrHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});

		expect(result.code).not.toBe(0);
		expect(result.stdout).toContain("initialised HR Office");
		expect(result.stderr).toContain("Profile 'recruiter-team' not found");
		const hrConfig = await readFile(path.join(hrHome, "hr-config.json"), "utf8");
		expect(hrConfig).toContain("schema_version");
		expect(hrConfig).toContain("garrytan/gstack");
		expect(hrConfig).toContain("anthropics/skills");
		expect(hrConfig).toContain("msitarzewski/agency-agents");
		expect(hrConfig).toContain("obra/superpowers");
		expect(hrConfig).toContain("K-Dense-AI/claude-scientific-skills");
		expect(hrConfig).toContain("https://models.dev/api.json");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("sync_sources refreshes a local model catalog into HR inventory", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-hr-model-catalog-"));
	const server = createServer((request, response) => {
		if (request.url !== "/api.json") {
			response.statusCode = 404;
			response.end("not found");
			return;
		}
		response.setHeader("content-type", "application/json");
		response.end(
			JSON.stringify({
				openai: {
					id: "openai",
					env: ["OPENAI_API_KEY"],
					npm: "@ai-sdk/openai",
					name: "OpenAI",
					doc: "https://example.test/openai",
					models: {
						"gpt-5": { id: "gpt-5", name: "GPT-5" },
						"gpt-5-mini": { id: "gpt-5-mini", name: "GPT-5 Mini" },
					},
				},
				openrouter: {
					id: "openrouter",
					env: ["OPENROUTER_API_KEY"],
					npm: "@openrouter/ai-sdk-provider",
					name: "OpenRouter",
					doc: "https://example.test/openrouter",
					models: {
						"openai/gpt-5": { id: "openai/gpt-5", name: "GPT-5 Routed" },
					},
				},
			}),
		);
	});

	try {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected TCP server address");
		const hrHome = path.join(tempRoot, "hr-home");
		await installHrOfficeHomeWithOptions({ hrRoot: hrHome });

		await writeFile(
			path.join(hrHome, "hr-config.json"),
			`${JSON.stringify(
				{
					schema_version: "1.1",
					sources: {
						github: [],
						models: [
							{
								source_id: "local-models",
								url: `http://127.0.0.1:${address.port}/api.json`,
								format: "models.dev",
							},
						],
					},
					settings: {
						auto_sync: false,
						sync_depth: 1,
					},
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		const scriptPath = path.join(hrHome, "bin", "sync_sources.py");
		const child = spawn(pythonCommand, [scriptPath], {
			...spawnOptions(windows),
			cwd: hrHome,
			env: {
				...process.env,
				OPENCODE_AGENTHUB_HR_HOME: hrHome,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		const code = await new Promise<number>((resolve, reject) => {
			child.on("error", reject);
			child.on("close", (exitCode) => resolve(exitCode ?? 1));
		});

		expect(code).toBe(0);
		expect(stderr).toBe("");
		expect(stdout).toContain("local-models");
		expect(stdout).toContain("3 models across 2 providers");

		const catalog = JSON.parse(
			await readFile(path.join(hrHome, "inventory", "models", "catalog.json"), "utf8"),
		);
		expect(catalog.source.source_id).toBe("local-models");
		expect(catalog.provider_count).toBe(2);
		expect(catalog.model_count).toBe(3);
		expect(catalog.models.map((entry: { id: string }) => entry.id)).toEqual([
			"openai/gpt-5",
			"openai/gpt-5-mini",
			"openrouter/openai/gpt-5",
		]);

		const validModelIds = await readFile(
			path.join(hrHome, "inventory", "models", "valid-model-ids.txt"),
			"utf8",
		);
		expect(splitLines(validModelIds.trim())).toEqual([
			"openai/gpt-5",
			"openai/gpt-5-mini",
			"openrouter/openai/gpt-5",
		]);

		const sourceStatus = JSON.parse(await readFile(path.join(hrHome, "source-status.json"), "utf8"));
		expect(sourceStatus.model_catalogs["local-models"].model_count).toBe(3);
		expect(sourceStatus.model_catalogs["local-models"].provider_count).toBe(2);
		expect(path.normalize(sourceStatus.model_catalogs["local-models"].catalog_path)).toBe(
			path.join("inventory", "models", "catalog.json"),
		);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("hr staged profile resolves from staging package before promote", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-hr-staged-profile-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const personalHome = path.join(tempRoot, "personal-home");
		const hrHome = path.join(tempRoot, "hr-home");
		const workspace = path.join(tempRoot, "workspace");
		const packageRoot = path.join(hrHome, "staging", "candidate-one");
		const stagedHome = path.join(packageRoot, "agenthub-home");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			installAgentHubHome({ targetRoot: personalHome, mode: "auto" }),
			installHrOfficeHome(hrHome),
			mkdir(path.join(stagedHome, "profiles"), { recursive: true }),
			mkdir(path.join(stagedHome, "bundles"), { recursive: true }),
			mkdir(path.join(stagedHome, "souls"), { recursive: true }),
		]);
		await writeFile(path.join(stagedHome, "souls", "coding-lead.md"), "# coding lead\n", "utf8");
		await writeFile(
			path.join(stagedHome, "bundles", "coding-lead.json"),
			`${JSON.stringify({
				name: "coding-lead",
				runtime: "native",
				soul: "coding-lead",
				skills: [],
				agent: {
					name: "coding-lead",
					mode: "primary",
					model: "test-model",
					description: "Staged coding lead",
				},
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(stagedHome, "profiles", "coding-team.json"),
			`${JSON.stringify({
				name: "coding-team",
				bundles: ["coding-lead"],
				defaultAgent: "coding-lead",
				plugins: ["opencode-agenthub"],
			}, null, 2)}\n`,
			"utf8",
		);

		const result = await runCli({
			args: ["hr", "coding-team", "--assemble-only"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				OPENCODE_AGENTHUB_HR_HOME: hrHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});

		expect(result.code).toBe(0);
		expect(result.stderr).toContain("Staging test -> using profile 'coding-team' from staged package 'candidate-one'");
		const configRoot = result.stdout.trim().split("\n").pop();
		if (!configRoot) throw new Error("Expected config root output from hr coding-team --assemble-only");
		const lock = parseGeneratedJson(await readFile(path.join(configRoot, "agenthub-lock.json"), "utf8"));
		expect(lock.profile).toBe("coding-team");
		expect(lock.libraryRoot).toBe(stagedHome);
		expect(lock.settingsRoot).toBe(hrHome);
		const opencodeConfig = parseGeneratedJson(await readFile(path.join(configRoot, "opencode.jsonc"), "utf8"));
		expect(opencodeConfig.default_agent).toBe("coding-lead");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("hr primary prompt includes protocol instruction and runtime blocks write tools", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-hr-protocol-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const personalHome = path.join(tempRoot, "personal-home");
		const hrHome = path.join(tempRoot, "hr-home");
		const workspace = path.join(tempRoot, "workspace");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			installAgentHubHome({ targetRoot: personalHome, mode: "auto" }),
			installHrOfficeHome(hrHome),
		]);

		const result = await runCli({
			args: ["hr", "--assemble-only"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				OPENCODE_AGENTHUB_HR_HOME: hrHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});

		expect(result.code).toBe(0);
		const configRoot = result.stdout.trim().split("\n").pop();
		if (!configRoot) throw new Error("Expected config root output from hr --assemble-only");
		const prompt = await readFile(path.join(configRoot, "agents", "hr.md"), "utf8");
		expect(prompt).toContain("## Attached Instruction: hr-protocol");
		expect(prompt).toContain("primary use cases or scenarios");
		expect(prompt).toContain("Before staging begins, explicitly confirm the AI model choice");
		expect(prompt).not.toContain("AI model preferences");
		const opencodeConfig = parseGeneratedJson(
			await readFile(path.join(configRoot, "opencode.jsonc"), "utf8"),
		);
		expect(opencodeConfig.agent.hr.skills).toBeUndefined();
		expect(opencodeConfig.agent.hr.steps).toBe(3);
		expect(opencodeConfig.agent.hr.permission.edit).toBe("deny");
		expect(opencodeConfig.agent.hr.permission.write).toBe("deny");
		expect(opencodeConfig.agent.hr.permission.bash).toBe("deny");
		expect(opencodeConfig.agent.hr.permission.task["hr-planner"]).toBe("allow");
		expect(opencodeConfig.agent.hr.permission.task["*"]).toBe("deny");
		const runtimeConfig = parseGeneratedJson(
			await readFile(path.join(configRoot, "agenthub-runtime.json"), "utf8"),
		);
		expect(runtimeConfig.agents.hr.blockedTools).toEqual(
			expect.arrayContaining(["call_omo_agent"]),
		);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("hr staged profile warns and prefers newest package when duplicated", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-hr-staged-duplicate-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const personalHome = path.join(tempRoot, "personal-home");
		const hrHome = path.join(tempRoot, "hr-home");
		const workspace = path.join(tempRoot, "workspace");
		const olderRoot = path.join(hrHome, "staging", "candidate-old", "agenthub-home");
		const newerRoot = path.join(hrHome, "staging", "candidate-new", "agenthub-home");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			installAgentHubHome({ targetRoot: personalHome, mode: "auto" }),
			installHrOfficeHome(hrHome),
			mkdir(path.join(olderRoot, "profiles"), { recursive: true }),
			mkdir(path.join(olderRoot, "bundles"), { recursive: true }),
			mkdir(path.join(olderRoot, "souls"), { recursive: true }),
			mkdir(path.join(newerRoot, "profiles"), { recursive: true }),
			mkdir(path.join(newerRoot, "bundles"), { recursive: true }),
			mkdir(path.join(newerRoot, "souls"), { recursive: true }),
		]);

		for (const [root, label] of [[olderRoot, "old"], [newerRoot, "new"]] as const) {
			await writeFile(path.join(root, "souls", `coding-${label}.md`), `# ${label}\n`, "utf8");
			await writeFile(
				path.join(root, "bundles", `coding-${label}.json`),
				`${JSON.stringify({
					name: `coding-${label}`,
					runtime: "native",
					soul: `coding-${label}`,
					skills: [],
					agent: { name: `coding-${label}`, mode: "primary", model: "test-model" },
				}, null, 2)}\n`,
				"utf8",
			);
			await writeFile(
				path.join(root, "profiles", "coding-team.json"),
				`${JSON.stringify({
					name: "coding-team",
					bundles: [`coding-${label}`],
					defaultAgent: `coding-${label}`,
					plugins: ["opencode-agenthub"],
				}, null, 2)}\n`,
				"utf8",
			);
		}

		await new Promise((resolve) => setTimeout(resolve, 20));
		await writeFile(
			path.join(newerRoot, "profiles", "coding-team.json"),
			`${JSON.stringify({
				name: "coding-team",
				bundles: ["coding-new"],
				defaultAgent: "coding-new",
				plugins: ["opencode-agenthub"],
			}, null, 2)}\n`,
			"utf8",
		);

		const result = await runCli({
			args: ["hr", "coding-team", "--assemble-only"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				OPENCODE_AGENTHUB_HR_HOME: hrHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});

		expect(result.code).toBe(0);
		expect(result.stderr).toContain("candidate-new");
		expect(result.stderr).toContain("also exists in other staged packages: candidate-old");
		const configRoot = result.stdout.trim().split("\n").pop();
		if (!configRoot) throw new Error("Expected config root output from duplicate staged hr profile test");
		const lock = parseGeneratedJson(await readFile(path.join(configRoot, "agenthub-lock.json"), "utf8"));
		expect(lock.libraryRoot).toBe(newerRoot);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("promote can set the promoted profile as default and keep native defaults hidden", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-promote-default-profile-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const personalHome = path.join(tempRoot, "personal-home");
		const hrHome = path.join(tempRoot, "hr-home");
		const workspace = path.join(tempRoot, "workspace");
		const packageRoot = path.join(hrHome, "staging", "candidate-one");
		const stagedHome = path.join(packageRoot, "agenthub-home");
		const nativeConfigPath = path.join(tempRoot, "native-opencode.json");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			installAgentHubHome({ targetRoot: personalHome, mode: "auto" }),
			installHrOfficeHome(hrHome),
			mkdir(path.join(stagedHome, "profiles"), { recursive: true }),
			mkdir(path.join(stagedHome, "bundles"), { recursive: true }),
			mkdir(path.join(stagedHome, "souls"), { recursive: true }),
		]);

		await writeFile(
			nativeConfigPath,
			`${JSON.stringify({
				agent: {
					general: { model: "test-general" },
					explore: { model: "test-explore" },
					plan: { model: "test-plan" },
					build: { model: "test-build" },
				},
			}, null, 2)}\n`,
			"utf8",
		);

		await writeFile(path.join(stagedHome, "souls", "coding-lead.md"), "# coding lead\n", "utf8");
		await writeFile(
			path.join(stagedHome, "bundles", "coding-lead.json"),
			`${JSON.stringify({
				name: "coding-lead",
				runtime: "native",
				soul: "coding-lead",
				skills: [],
				agent: {
					name: "coding-lead",
					mode: "primary",
					model: "team-model",
					description: "Coding lead",
				},
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(stagedHome, "profiles", "coding-team.json"),
			`${JSON.stringify({
				name: "coding-team",
				bundles: ["coding-lead"],
				defaultAgent: "coding-lead",
				plugins: ["opencode-agenthub"],
				nativeAgentPolicy: "team-only",
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(packageRoot, "handoff.json"),
			`${JSON.stringify({
				package_id: "candidate-one",
				target_profile: "coding-team",
				promotion_preferences: {
					set_default_profile: true,
				},
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(packageRoot, "final-checklist.md"),
			"READY FOR HUMAN CONFIRMATION\n",
			"utf8",
		);

		const promoteResult = await runCli({
			args: ["promote", "candidate-one"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				OPENCODE_AGENTHUB_HR_HOME: hrHome,
				OPENCODE_AGENTHUB_NATIVE_CONFIG: nativeConfigPath,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});

		expect(promoteResult.code).toBe(0);
		expect(promoteResult.stdout).toContain("default profile updated: coding-team");

		const startResult = await runCli({
			args: ["start", "--assemble-only"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				OPENCODE_AGENTHUB_HR_HOME: hrHome,
				OPENCODE_AGENTHUB_NATIVE_CONFIG: nativeConfigPath,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});

		expect(startResult.code).toBe(0);
		expect(startResult.stderr).toContain("using personal default profile 'coding-team'");
		const configRoot = startResult.stdout.trim().split("\n").pop();
		if (!configRoot) throw new Error("Expected config root output from start --assemble-only");
		const opencodeConfig = parseGeneratedJson(
			await readFile(path.join(configRoot, "opencode.jsonc"), "utf8"),
		);

		expect(opencodeConfig.default_agent).toBe("coding-lead");
		expect(opencodeConfig.agent["coding-lead"].model).toBe("team-model");
		expect(opencodeConfig.agent.general).toEqual({ disable: true });
		expect(opencodeConfig.agent.explore.mode).toBe("subagent");
		expect(opencodeConfig.agent.explore.hidden).toBe(true);
		expect(opencodeConfig.agent.plan).toEqual({ disable: true });
		expect(opencodeConfig.agent.build).toEqual({ disable: true });
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("bare start defaults to personal auto profile", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-bare-start-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const personalHome = path.join(tempRoot, "personal-home");
		const workspace = path.join(tempRoot, "workspace");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
		]);

		const result = await runCli({
			args: ["start", "--assemble-only"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("initialised coding system");
		expect(result.stdout).toContain("Environment: My Team");
		const configRoot = result.stdout.trim().split("\n").pop();
		if (!configRoot) throw new Error("Expected config root output from start --assemble-only");
		const opencodeConfig = parseGeneratedJson(
			await readFile(path.join(configRoot, "opencode.jsonc"), "utf8"),
		);
		expect(opencodeConfig.default_agent).toBe("auto");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("setup minimal creates a truly minimal blank home by default", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-setup-none-minimal-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const workspace = path.join(tempRoot, "workspace");
		const targetRoot = path.join(tempRoot, "agenthub-home");
		const nativeConfigPath = path.join(tempRoot, "native-opencode.json");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			writeFile(
				nativeConfigPath,
				`${JSON.stringify({
					provider: { openai: { npm: "demo" } },
					model: "gpt-5",
					small_model: "gpt-5-mini",
				}, null, 2)}\n`,
				"utf8",
			),
		]);

		const result = await runCli({
			args: ["setup", "minimal", "--target-root", targetRoot],
			cwd: workspace,
			env: {
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
				OPENCODE_AGENTHUB_NATIVE_CONFIG: nativeConfigPath,
			},
		});

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Minimal Agent Hub structure ready");

		const settings = JSON.parse(await readFile(path.join(targetRoot, "settings.json"), "utf8"));
		expect(settings.meta.onboarding.mode).toBe("minimal");
		expect(settings.meta.onboarding.importedNativeBasics).toBe(false);
		expect(settings.meta.onboarding.importedNativeAgents).toBe(false);
		expect(settings.opencode).toBeUndefined();
		await expect(readFile(path.join(targetRoot, "profiles", "auto.json"), "utf8")).rejects.toThrow();
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("start set stores the default personal profile and bare start uses it", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-start-set-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const personalHome = path.join(tempRoot, "personal-home");
		const workspace = path.join(tempRoot, "workspace");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			installAgentHubHome({ targetRoot: personalHome, mode: "auto" }),
		]);

		await writeFile(
			path.join(personalHome, "profiles", "reviewer-team.json"),
			`${JSON.stringify({
				name: "reviewer-team",
				bundles: ["auto"],
				defaultAgent: "auto",
				plugins: ["opencode-agenthub"],
			}, null, 2)}\n`,
			"utf8",
		);

		const setResult = await runCli({
			args: ["start", "set", "reviewer-team"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});
		expect(setResult.code).toBe(0);
		expect(setResult.stdout).toContain("Set default start profile to 'reviewer-team'");

		const settings = JSON.parse(await readFile(path.join(personalHome, "settings.json"), "utf8"));
		expect(settings.preferences.defaultProfile).toBe("reviewer-team");

		const startResult = await runCli({
			args: ["start", "--assemble-only"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});
		expect(startResult.code).toBe(0);
		expect(startResult.stderr).toContain("using personal default profile 'reviewer-team'");
		const configRoot = startResult.stdout.trim().split("\n").pop();
		if (!configRoot) throw new Error("Expected config root output from start --assemble-only");
		const lock = parseGeneratedJson(
			await readFile(path.join(configRoot, "agenthub-lock.json"), "utf8"),
		);
		expect(lock.profile).toBe("reviewer-team");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("start last reuses the last successful personal profile", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-start-last-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const personalHome = path.join(tempRoot, "personal-home");
		const workspace = path.join(tempRoot, "workspace");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			installAgentHubHome({ targetRoot: personalHome, mode: "auto" }),
		]);

		await writeFile(
			path.join(personalHome, "profiles", "reviewer-team.json"),
			`${JSON.stringify({
				name: "reviewer-team",
				bundles: ["auto"],
				defaultAgent: "auto",
				plugins: ["opencode-agenthub"],
			}, null, 2)}\n`,
			"utf8",
		);

		await runCli({
			args: ["start", "reviewer-team", "--assemble-only"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});

		const result = await runCli({
			args: ["start", "last", "--assemble-only"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});
		expect(result.code).toBe(0);
		expect(result.stderr).toContain("using last profile 'reviewer-team'");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("start last falls back to auto when no previous profile exists", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-start-last-fallback-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const personalHome = path.join(tempRoot, "personal-home");
		const workspace = path.join(tempRoot, "workspace");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
		]);

		const result = await runCli({
			args: ["start", "last", "--assemble-only"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});
		expect(result.code).toBe(0);
		expect(result.stderr).toContain("using 'auto'");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("hr last reuses the last tested HR profile in the workspace", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-hr-last-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const personalHome = path.join(tempRoot, "personal-home");
		const hrHome = path.join(tempRoot, "hr-home");
		const workspace = path.join(tempRoot, "workspace");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			installAgentHubHome({ targetRoot: personalHome, mode: "auto" }),
			installHrOfficeHome(hrHome),
		]);

		await writeFile(
			path.join(hrHome, "profiles", "recruiter-team.json"),
			`${JSON.stringify({
				name: "recruiter-team",
				bundles: ["hr", "auto"],
				defaultAgent: "hr",
				plugins: ["opencode-agenthub"],
			}, null, 2)}\n`,
			"utf8",
		);

		await runCli({
			args: ["hr", "recruiter-team", "--assemble-only"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				OPENCODE_AGENTHUB_HR_HOME: hrHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});

		const result = await runCli({
			args: ["hr", "last", "--assemble-only"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				OPENCODE_AGENTHUB_HR_HOME: hrHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});
		expect(result.code).toBe(0);
		expect(result.stderr).toContain("using last profile 'recruiter-team'");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("hr last fails clearly when no previous HR profile exists", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-hr-last-missing-"));
	try {
		const workspace = path.join(tempRoot, "workspace");
		await mkdir(workspace, { recursive: true });
		const result = await runCli({
			args: ["hr", "last", "--assemble-only"],
			cwd: workspace,
		});
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("No previous HR workspace profile for this folder");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("hr set is rejected clearly", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-hr-set-invalid-"));
	try {
		const workspace = path.join(tempRoot, "workspace");
		await mkdir(workspace, { recursive: true });
		const result = await runCli({
			args: ["hr", "set", "recruiter-team"],
			cwd: workspace,
		});
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("'hr set <profile>' is not supported");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("run last mirrors start last semantics", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-run-last-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const personalHome = path.join(tempRoot, "personal-home");
		const workspace = path.join(tempRoot, "workspace");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			installAgentHubHome({ targetRoot: personalHome, mode: "auto" }),
		]);

		await runCli({
			args: ["start", "auto", "--assemble-only"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});

		const result = await runCli({
			args: ["run", "last", "--assemble-only"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});
		expect(result.code).toBe(0);
		expect(result.stderr).toContain("using last profile 'auto'");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("backup and restore operate on personal home only", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-backup-restore-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const personalHome = path.join(tempRoot, "personal-home");
		const workspace = path.join(tempRoot, "workspace");
		const backupDir = path.join(tempRoot, "backup");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
		]);
		await installAgentHubHome({ targetRoot: personalHome, mode: "auto" });
		await mkdir(path.join(personalHome, "instructions"), { recursive: true });
		await writeFile(path.join(personalHome, "instructions", "restore-marker.md"), "RESTORE ME\n", "utf8");

		const backupResult = await runCli({
			args: ["backup", "--output", backupDir],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});
		expect(backupResult.code).toBe(0);
		expect(backupResult.stdout).toContain("Backup complete");

		await rm(path.join(personalHome, "instructions", "restore-marker.md"), { force: true });

		const restoreResult = await runCli({
			args: ["restore", "--source", backupDir],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});
		expect(restoreResult.code).toBe(0);
		expect(restoreResult.stdout).toContain("Restore complete");
		expect(
			await readFile(path.join(personalHome, "instructions", "restore-marker.md"), "utf8"),
		).toContain("RESTORE ME");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("promote imports staged HR package into personal home with safe defaults", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-promote-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const personalHome = path.join(tempRoot, "personal-home");
		const hrHome = path.join(tempRoot, "hr-home");
		const workspace = path.join(tempRoot, "workspace");
		const packageRoot = path.join(hrHome, "staging", "candidate-one");
		const stagedHome = path.join(packageRoot, "agenthub-home");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			installAgentHubHome({ targetRoot: personalHome, mode: "auto" }),
			installHrOfficeHome(hrHome),
			mkdir(path.join(stagedHome, "profiles"), { recursive: true }),
			mkdir(path.join(stagedHome, "bundles"), { recursive: true }),
			mkdir(path.join(stagedHome, "souls"), { recursive: true }),
		]);
		await writeFile(path.join(packageRoot, "final-checklist.md"), "READY FOR HUMAN CONFIRMATION\n", "utf8");
		await writeFile(path.join(packageRoot, "handoff.json"), "{}\n", "utf8");
		await writeFile(path.join(stagedHome, "souls", "reviewer.md"), "# reviewer\n", "utf8");
		await writeFile(
			path.join(stagedHome, "bundles", "reviewer.json"),
			`${JSON.stringify({
				name: "reviewer",
				runtime: "native",
				soul: "reviewer",
				skills: [],
				agent: { name: "reviewer", mode: "primary", model: "test-model" },
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(stagedHome, "profiles", "reviewer-team.json"),
			`${JSON.stringify({
				name: "reviewer-team",
				bundles: ["reviewer"],
				defaultAgent: "reviewer",
				plugins: ["opencode-agenthub"],
			}, null, 2)}\n`,
			"utf8",
		);

		const result = await runCli({
			args: ["promote", "candidate-one"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				OPENCODE_AGENTHUB_HR_HOME: hrHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Promote complete");
		expect(await readFile(path.join(personalHome, "profiles", "reviewer-team.json"), "utf8")).toContain("reviewer-team");
		expect(await readFile(path.join(personalHome, "souls", "reviewer.md"), "utf8")).toContain("# reviewer");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("promote fails clearly when staged MCP package declares missing server artifacts", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-promote-mcp-missing-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const personalHome = path.join(tempRoot, "personal-home");
		const hrHome = path.join(tempRoot, "hr-home");
		const workspace = path.join(tempRoot, "workspace");
		const packageRoot = path.join(hrHome, "staging", "candidate-mcp");
		const stagedHome = path.join(packageRoot, "agenthub-home");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			installAgentHubHome({ targetRoot: personalHome, mode: "auto" }),
			installHrOfficeHome(hrHome),
			mkdir(path.join(stagedHome, "profiles"), { recursive: true }),
			mkdir(path.join(stagedHome, "bundles"), { recursive: true }),
			mkdir(path.join(stagedHome, "souls"), { recursive: true }),
			mkdir(path.join(stagedHome, "mcp"), { recursive: true }),
		]);
		await writeFile(path.join(packageRoot, "final-checklist.md"), "READY FOR HUMAN CONFIRMATION\n", "utf8");
		await writeFile(
			path.join(packageRoot, "handoff.json"),
			`${JSON.stringify({
				promotion_id: "candidate-mcp",
				target_profile: "mcp-team",
				operator_instructions: {
					test_current_workspace: "agenthub hr mcp-team",
					use_in_another_workspace: "agenthub hr mcp-team",
					promote: "agenthub promote candidate-mcp",
					advanced_import: `agenthub hub-import --source ${stagedHome}`,
				},
				host_requirements: {
					mcp_servers_bundled: false,
					missing: ["mcp-servers/pubmed-mcp-server.ts"],
				},
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(path.join(stagedHome, "souls", "mcp-lead.md"), "# mcp lead\n", "utf8");
		await writeFile(
			path.join(stagedHome, "bundles", "mcp-lead.json"),
			`${JSON.stringify({
				name: "mcp-lead",
				runtime: "native",
				soul: "mcp-lead",
				skills: [],
				mcp: ["pubmed_search"],
				agent: { name: "mcp-lead", mode: "primary", model: "test-model" },
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(stagedHome, "profiles", "mcp-team.json"),
			`${JSON.stringify({
				name: "mcp-team",
				bundles: ["mcp-lead"],
				defaultAgent: "mcp-lead",
				plugins: ["opencode-agenthub"],
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(stagedHome, "mcp", "pubmed_search.json"),
			`${JSON.stringify({
				type: "local",
				command: ["bun", "${LIBRARY_ROOT}/mcp-servers/pubmed-mcp-server.ts"],
				timeout: 30000,
			}, null, 2)}\n`,
			"utf8",
		);

		const result = await runCli({
			args: ["promote", "candidate-mcp"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				OPENCODE_AGENTHUB_HR_HOME: hrHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("required MCP server artifacts are missing");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("start warns when legacy HR assets remain in personal home", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-legacy-hr-warning-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const personalHome = path.join(tempRoot, "personal-home");
		const workspace = path.join(tempRoot, "workspace");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
		]);
		await installAgentHubHome({ targetRoot: personalHome, mode: "auto" });
		await writeFile(
			path.join(personalHome, "bundles", "hr.json"),
			`${JSON.stringify({ soul: "hr" }, null, 2)}\n`,
			"utf8",
		);

		const result = await runCli({
			args: ["start", "--assemble-only"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});

		expect(result.code).toBe(0);
		expect(result.stderr).toContain("legacy HR assets were found in your personal home");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("composeWorkspace merges attached bundle instructions into generated agent prompt", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-instructions-compose-"));
	const originalHome = process.env.HOME;
	const originalXdgHome = process.env.XDG_CONFIG_HOME;
	const originalAgentHubHome = process.env.OPENCODE_AGENTHUB_HOME;
	const originalNativeConfig = process.env.OPENCODE_AGENTHUB_NATIVE_CONFIG;

	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const agentHubHome = path.join(tempRoot, "agenthub-home");
		const workspace = path.join(tempRoot, "workspace");

		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
		]);

		process.env.HOME = homeDir;
		process.env.XDG_CONFIG_HOME = xdgHomeDir;
		process.env.OPENCODE_AGENTHUB_HOME = agentHubHome;
		delete process.env.OPENCODE_AGENTHUB_NATIVE_CONFIG;

		await installAgentHubHome({
			targetRoot: agentHubHome,
			mode: "auto",
		});
		await mkdir(path.join(agentHubHome, "instructions"), { recursive: true });

		await writeFile(
			path.join(agentHubHome, "instructions", "repo-rules.md"),
			"Always inspect multiple files before deciding.\nReference GitHub state when relevant.\n",
			"utf8",
		);

		const autoBundlePath = path.join(agentHubHome, "bundles", "auto.json");
		const autoBundle = JSON.parse(await readFile(autoBundlePath, "utf8"));
		autoBundle.instructions = ["repo-rules"];
		await writeFile(autoBundlePath, `${JSON.stringify(autoBundle, null, 2)}\n`, "utf8");

		const result = await composeWorkspace(workspace, "auto");
		const agentPrompt = await readFile(
			path.join(result.configRoot, "agents", "auto.md"),
			"utf8",
		);
		const lock = parseGeneratedJson(
			await readFile(path.join(result.configRoot, "agenthub-lock.json"), "utf8"),
		);

		expect(agentPrompt).toContain("You are Auto");
		expect(agentPrompt).toContain("## Attached Instruction: repo-rules");
		expect(agentPrompt).toContain("Always inspect multiple files before deciding.");
		expect(lock.bundles.find((bundle: { name: string }) => bundle.name === "auto")?.instructions).toEqual([
			"repo-rules",
		]);
	} finally {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;

		if (originalXdgHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXdgHome;

		if (originalAgentHubHome === undefined) delete process.env.OPENCODE_AGENTHUB_HOME;
		else process.env.OPENCODE_AGENTHUB_HOME = originalAgentHubHome;

		if (originalNativeConfig === undefined) delete process.env.OPENCODE_AGENTHUB_NATIVE_CONFIG;
		else process.env.OPENCODE_AGENTHUB_NATIVE_CONFIG = originalNativeConfig;

		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("status reports personal workspace runtime details", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-status-personal-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const personalHome = path.join(tempRoot, "personal-home");
		const workspace = path.join(tempRoot, "workspace");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
		]);

		const startResult = await runCli({
			args: ["start", "auto", "--assemble-only"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});
		expect(startResult.code).toBe(0);

		const result = await runCli({
			args: ["status"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Agent Hub runtime status");
		expect(result.stdout).toContain("profile: auto");
		expect(result.stdout).toContain("source: Personal Home");
		expect(result.stdout).toContain("default agent: auto");
		expect(result.stdout).toContain("health:");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("status --json reports staged HR runtime metadata", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-status-hr-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const hrHome = path.join(tempRoot, "hr-home");
		const workspace = path.join(tempRoot, "workspace");
		const stagedHome = path.join(
			hrHome,
			"staging",
			"candidate-one",
			"agenthub-home",
		);
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
		]);
		await installHrOfficeHomeWithOptions({ hrRoot: hrHome });
		await mkdir(path.join(stagedHome, "bundles"), { recursive: true });
		await mkdir(path.join(stagedHome, "profiles"), { recursive: true });
		await mkdir(path.join(stagedHome, "souls"), { recursive: true });
		await writeFile(
			path.join(stagedHome, "bundles", "coding-lead.json"),
			`${JSON.stringify({
				name: "coding-lead",
				runtime: "native",
				soul: "coding-lead",
				skills: [],
				agent: {
					name: "coding-lead",
					mode: "primary",
					model: "team-model",
					description: "team lead",
				},
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(stagedHome, "souls", "coding-lead.md"),
			"# coding-lead\n",
			"utf8",
		);
		await writeFile(
			path.join(stagedHome, "profiles", "coding-team.json"),
			`${JSON.stringify({
				name: "coding-team",
				bundles: ["coding-lead"],
				defaultAgent: "coding-lead",
				plugins: ["opencode-agenthub"],
			}, null, 2)}\n`,
			"utf8",
		);

		const composeResult = await runCli({
			args: ["hr", "coding-team", "--assemble-only"],
			cwd: workspace,
			env: {
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
				OPENCODE_AGENTHUB_HR_HOME: hrHome,
			},
		});
		expect(composeResult.code).toBe(0);

		const result = await runCli({
			args: ["status", "--json"],
			cwd: workspace,
			env: {
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
				OPENCODE_AGENTHUB_HR_HOME: hrHome,
			},
		});

		expect(result.code).toBe(0);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.profile).toBe("coding-team");
		expect(parsed.source.kind).toBe("hr-staged-package");
		expect(parsed.source.packageId).toBeTruthy();
		expect(Array.isArray(parsed.plugins.effective)).toBe(true);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("status --short prints compact runtime summary", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-status-short-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const personalHome = path.join(tempRoot, "personal-home");
		const workspace = path.join(tempRoot, "workspace");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
		]);

		const startResult = await runCli({
			args: ["start", "auto", "--assemble-only"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});
		expect(startResult.code).toBe(0);

		const result = await runCli({
			args: ["status", "--short"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("auto · Personal Home");
		expect(result.stdout).toContain("default: auto");
		expect(result.stdout).toContain("agents:");
		expect(result.stdout).toContain("health:");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("status --workspace inspects another workspace runtime", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-status-workspace-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const personalHome = path.join(tempRoot, "personal-home");
		const workspace = path.join(tempRoot, "workspace");
		const inspector = path.join(tempRoot, "inspector");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			mkdir(inspector, { recursive: true }),
		]);

		const startResult = await runCli({
			args: ["start", "auto", "--assemble-only"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});
		expect(startResult.code).toBe(0);

		const result = await runCli({
			args: ["status", "--workspace", workspace],
			cwd: inspector,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});

		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`workspace: ${workspace}`);
		expect(result.stdout).toContain("profile: auto");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("status reports a useful error when no runtime exists", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-status-missing-"));
	try {
		const workspace = path.join(tempRoot, "workspace");
		await mkdir(workspace, { recursive: true });

		const result = await runCli({ args: ["status"], cwd: workspace });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("No Agent Hub runtime found");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("start --assemble-only prints composed runtime summary", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-start-summary-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const personalHome = path.join(tempRoot, "personal-home");
		const workspace = path.join(tempRoot, "workspace");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
		]);

		const result = await runCli({
			args: ["start", "auto", "--assemble-only"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Composed workspace runtime");
		expect(result.stdout).toContain("profile: auto");
		expect(result.stdout).toContain("source: Personal Home");
		expect(result.stdout).toContain("default agent: auto");
		expect(result.stdout).toContain("Run 'agenthub status' for full details.");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("hr --assemble-only prints composed runtime summary for staged profile", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-hr-summary-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const hrHome = path.join(tempRoot, "hr-home");
		const workspace = path.join(tempRoot, "workspace");
		const stagedHome = path.join(
			hrHome,
			"staging",
			"candidate-one",
			"agenthub-home",
		);
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
		]);
		await installHrOfficeHomeWithOptions({ hrRoot: hrHome });
		await mkdir(path.join(stagedHome, "bundles"), { recursive: true });
		await mkdir(path.join(stagedHome, "profiles"), { recursive: true });
		await mkdir(path.join(stagedHome, "souls"), { recursive: true });
		await writeFile(
			path.join(stagedHome, "bundles", "coding-lead.json"),
			`${JSON.stringify({
				name: "coding-lead",
				runtime: "native",
				soul: "coding-lead",
				skills: [],
				agent: {
					name: "coding-lead",
					mode: "primary",
					model: "team-model",
					description: "team lead",
				},
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(stagedHome, "souls", "coding-lead.md"),
			"# coding-lead\n",
			"utf8",
		);
		await writeFile(
			path.join(stagedHome, "profiles", "coding-team.json"),
			`${JSON.stringify({
				name: "coding-team",
				bundles: ["coding-lead"],
				defaultAgent: "coding-lead",
				plugins: ["opencode-agenthub"],
			}, null, 2)}\n`,
			"utf8",
		);

		const result = await runCli({
			args: ["hr", "coding-team", "--assemble-only"],
			cwd: workspace,
			env: {
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
				OPENCODE_AGENTHUB_HR_HOME: hrHome,
			},
		});

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Composed workspace runtime");
		expect(result.stdout).toContain("profile: coding-team");
		expect(result.stdout).toContain("source: HR staged package");
		expect(result.stdout).toContain("Run 'agenthub status' for full details.");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("status handles tool-injection runtimes", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-status-tools-only-"));
	const originalHome = process.env.HOME;
	const originalXdgHome = process.env.XDG_CONFIG_HOME;
	const originalAgentHubHome = process.env.OPENCODE_AGENTHUB_HOME;
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const personalHome = path.join(tempRoot, "personal-home");
		const workspace = path.join(tempRoot, "workspace");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
		]);
		process.env.HOME = homeDir;
		process.env.XDG_CONFIG_HOME = xdgHomeDir;
		process.env.OPENCODE_AGENTHUB_HOME = personalHome;
		await installAgentHubHome({ targetRoot: personalHome, mode: "auto" });
		await composeToolInjection(workspace, undefined, { homeRoot: personalHome });

		const result = await runCli({
			args: ["status"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("source: Tool injection mode");
	} finally {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalXdgHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXdgHome;
		if (originalAgentHubHome === undefined) delete process.env.OPENCODE_AGENTHUB_HOME;
		else process.env.OPENCODE_AGENTHUB_HOME = originalAgentHubHome;
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("status handles customized-agent runtimes", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-status-customized-"));
	const originalHome = process.env.HOME;
	const originalXdgHome = process.env.XDG_CONFIG_HOME;
	const originalAgentHubHome = process.env.OPENCODE_AGENTHUB_HOME;
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const personalHome = path.join(tempRoot, "personal-home");
		const workspace = path.join(tempRoot, "workspace");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
		]);
		process.env.HOME = homeDir;
		process.env.XDG_CONFIG_HOME = xdgHomeDir;
		process.env.OPENCODE_AGENTHUB_HOME = personalHome;
		await installAgentHubHome({ targetRoot: personalHome, mode: "auto" });
		await composeCustomizedAgent(workspace, undefined, { homeRoot: personalHome });

		const result = await runCli({
			args: ["status"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("source: Customized agent mode");
	} finally {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalXdgHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXdgHome;
		if (originalAgentHubHome === undefined) delete process.env.OPENCODE_AGENTHUB_HOME;
		else process.env.OPENCODE_AGENTHUB_HOME = originalAgentHubHome;
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("local plugin copy bridge copies filesystem plugins into runtime and status reports them", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-local-plugin-bridge-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const personalHome = path.join(tempRoot, "personal-home");
		const workspace = path.join(tempRoot, "workspace");
		const globalPluginDir = path.join(homeDir, ".config", "opencode", "plugins");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			mkdir(globalPluginDir, { recursive: true }),
		]);
		await writeFile(
			path.join(globalPluginDir, "rtk-local.ts"),
			"export const LocalPlugin = async () => ({})\n",
			"utf8",
		);

		const startResult = await runCli({
			args: ["start", "auto", "--assemble-only"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});
		expect(startResult.code).toBe(0);
		const configRoot = startResult.stdout.trim().split("\n").pop();
		if (!configRoot) throw new Error("Expected config root output from start --assemble-only");

		expect(await pathExists(path.join(configRoot, "xdg", "opencode", "plugins", "rtk-local.ts"))).toBe(true);

		const statusResult = await runCli({
			args: ["status", "--json"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});
		expect(statusResult.code).toBe(0);
		const parsed = JSON.parse(statusResult.stdout);
		expect(parsed.localPlugins.bridged).toContain("rtk-local.ts");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("status reports inherited OMO baseline source when global baseline is active", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-omo-inherit-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const personalHome = path.join(tempRoot, "personal-home");
		const workspace = path.join(tempRoot, "workspace");
		const globalOmoDir = path.join(homeDir, ".config", "opencode");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			mkdir(globalOmoDir, { recursive: true }),
		]);
		await installAgentHubHome({ targetRoot: personalHome, mode: "auto" });
		await writeFile(
			path.join(globalOmoDir, "oh-my-opencode.json"),
			`${JSON.stringify({ categories: { "code-review": { model: "github-copilot/gpt-5.4" } } }, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(personalHome, "bundles", "omo-review.json"),
			`${JSON.stringify({
				name: "omo-review",
				runtime: "omo",
				soul: "auto",
				skills: [],
				categories: {
					"code-review": "github-copilot/claude-opus-4.6",
				},
				agent: {
					name: "omo-review",
					mode: "primary",
					model: "github-copilot/claude-opus-4.6",
					description: "OMO review",
				},
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(personalHome, "profiles", "omo-review.json"),
			`${JSON.stringify({
				name: "omo-review",
				bundles: ["omo-review"],
				defaultAgent: "omo-review",
				plugins: ["opencode-agenthub"],
			}, null, 2)}\n`,
			"utf8",
		);

		const startResult = await runCli({
			args: ["start", "omo-review", "--assemble-only"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});
		expect(startResult.code).toBe(0);

		const statusResult = await runCli({
			args: ["status", "--json"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});
		expect(statusResult.code).toBe(0);
		const parsed = JSON.parse(statusResult.stdout);
		expect(parsed.omoBaseline.mode).toBe("inherit");
		expect(parsed.omoBaseline.sourceFile).toContain("oh-my-opencode.json");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("omoBaseline ignore prevents global OMO baseline inheritance", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-omo-ignore-"));
	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const personalHome = path.join(tempRoot, "personal-home");
		const workspace = path.join(tempRoot, "workspace");
		const globalOmoDir = path.join(homeDir, ".config", "opencode");
		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspace, { recursive: true }),
			mkdir(globalOmoDir, { recursive: true }),
		]);
		await installAgentHubHome({ targetRoot: personalHome, mode: "auto" });
		await writeFile(
			path.join(globalOmoDir, "oh-my-opencode.json"),
			`${JSON.stringify({ categories: { "code-review": { model: "github-copilot/gpt-5.4" } } }, null, 2)}\n`,
			"utf8",
		);
		const settings = JSON.parse(await readFile(path.join(personalHome, "settings.json"), "utf8"));
		settings.omoBaseline = "ignore";
		await writeFile(path.join(personalHome, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
		await writeFile(
			path.join(personalHome, "bundles", "omo-review.json"),
			`${JSON.stringify({
				name: "omo-review",
				runtime: "omo",
				soul: "auto",
				skills: [],
				categories: {
					"code-review": "github-copilot/claude-opus-4.6",
				},
				agent: {
					name: "omo-review",
					mode: "primary",
					model: "github-copilot/claude-opus-4.6",
					description: "OMO review",
				},
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(personalHome, "profiles", "omo-review.json"),
			`${JSON.stringify({
				name: "omo-review",
				bundles: ["omo-review"],
				defaultAgent: "omo-review",
				plugins: ["opencode-agenthub"],
			}, null, 2)}\n`,
			"utf8",
		);

		const startResult = await runCli({
			args: ["start", "omo-review", "--assemble-only"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});
		expect(startResult.code).toBe(0);

		const statusResult = await runCli({
			args: ["status", "--json"],
			cwd: workspace,
			env: {
				OPENCODE_AGENTHUB_HOME: personalHome,
				HOME: homeDir,
				XDG_CONFIG_HOME: xdgHomeDir,
			},
		});
		expect(statusResult.code).toBe(0);
		const parsed = JSON.parse(statusResult.stdout);
		expect(parsed.omoBaseline.mode).toBe("ignore");
		expect(parsed.omoBaseline.sourceFile).toBeNull();
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("help mentions local plugin bridging and OMO ignore setting", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-phaseb-help-"));
	try {
		const workspace = path.join(tempRoot, "workspace");
		await mkdir(workspace, { recursive: true });
		const result = await runCli({ args: ["--help"], cwd: workspace });
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Config-declared plugins already inherit automatically");
		expect(result.stdout).toContain("Local filesystem plugins from ~/.config/opencode/plugins/");
		expect(result.stdout).toContain('omoBaseline = "ignore"');
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});
