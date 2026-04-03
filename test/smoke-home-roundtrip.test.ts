import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installAgentHubHome } from "../src/composer/bootstrap.js";
import { composeWorkspace } from "../src/composer/compose.js";
import { exportAgentHubHome, importAgentHubHome } from "../src/composer/home-transfer.js";
import { readWorkflowInjectionConfig } from "../src/composer/settings.js";

const splitLines = (contents: string) => contents.split(/\r?\n/);

const parseGeneratedJson = (contents: string) => {
	const normalized = splitLines(contents)
		.filter((line) => !line.startsWith("//"))
		.join("\n")
		.trim();
	return JSON.parse(normalized);
};

test("exported Agent Hub home can round-trip into equivalent runtime config", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-roundtrip-"));
	const originalHome = process.env.HOME;
	const originalXdgHome = process.env.XDG_CONFIG_HOME;
	const originalAgentHubHome = process.env.OPENCODE_AGENTHUB_HOME;

	try {
		const homeDir = path.join(tempRoot, "home");
		const xdgHomeDir = path.join(tempRoot, "xdg-home");
		const sourceHome = path.join(tempRoot, "agenthub-home-a");
		const exportRoot = path.join(tempRoot, "agenthub-export");
		const importedHome = path.join(tempRoot, "agenthub-home-b");
		const workspaceA = path.join(tempRoot, "workspace-a");
		const workspaceB = path.join(tempRoot, "workspace-b");

		await Promise.all([
			mkdir(homeDir, { recursive: true }),
			mkdir(xdgHomeDir, { recursive: true }),
			mkdir(workspaceA, { recursive: true }),
			mkdir(workspaceB, { recursive: true }),
		]);

		process.env.HOME = homeDir;
		process.env.XDG_CONFIG_HOME = xdgHomeDir;
		process.env.OPENCODE_AGENTHUB_HOME = sourceHome;

		await installAgentHubHome({ targetRoot: sourceHome, mode: "auto" });
		await mkdir(path.join(sourceHome, "instructions"), { recursive: true });
		await mkdir(path.join(sourceHome, "mcp"), { recursive: true });
		await mkdir(path.join(sourceHome, "mcp-servers"), { recursive: true });
		await writeFile(
			path.join(sourceHome, "instructions", "repo-rules.md"),
			"Round-trip this instruction content.\n",
			"utf8",
		);
		await writeFile(
			path.join(sourceHome, "mcp", "demo.json"),
			`${JSON.stringify({
				type: "local",
				command: ["node", "${LIBRARY_ROOT}/mcp-servers/demo.js"],
				timeout: 30000,
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(sourceHome, "mcp-servers", "demo.js"),
			"console.log('demo mcp');\n",
			"utf8",
		);
		await writeFile(
			path.join(sourceHome, "mcp-servers", "package.json"),
			`${JSON.stringify({
				name: "demo-mcp-servers",
				version: "1.0.0",
				private: true,
				dependencies: {},
			}, null, 2)}\n`,
			"utf8",
		);
		const autoBundlePath = path.join(sourceHome, "bundles", "auto.json");
		const autoBundle = JSON.parse(await readFile(autoBundlePath, "utf8"));
		autoBundle.instructions = ["repo-rules"];
		autoBundle.mcp = ["demo"];
		await writeFile(autoBundlePath, `${JSON.stringify(autoBundle, null, 2)}\n`, "utf8");

		const exportReport = await exportAgentHubHome({
			sourceRoot: sourceHome,
			outputRoot: exportRoot,
			pluginVersion: "test",
		});
		expect(exportReport.copied).toContain("profiles");
		expect(exportReport.copied).toContain("bundles");
		expect(exportReport.copied).toContain("instructions");
		expect(exportReport.copied).toContain("mcp");
		expect(exportReport.copied).toContain("mcp-servers");

		const importReport = await importAgentHubHome({
			sourceRoot: exportRoot,
			targetRoot: importedHome,
			settingsMode: "replace",
		});
		expect(importReport.settingsAction).toBe("copied");
		expect(await Bun.file(path.join(importedHome, "mcp-servers", "package-lock.json")).exists()).toBe(
			false,
		);
		expect(await Bun.file(path.join(importedHome, "mcp-servers", "bun.lock")).exists()).toBe(
			false,
		);
		expect(await Bun.file(path.join(importedHome, "mcp-servers", "node_modules")).exists()).toBe(
			false,
		);

		process.env.OPENCODE_AGENTHUB_HOME = sourceHome;
		const sourceResult = await composeWorkspace(workspaceA, "auto");
		process.env.OPENCODE_AGENTHUB_HOME = importedHome;
		const importedResult = await composeWorkspace(workspaceB, "auto");

		const sourceConfig = parseGeneratedJson(
			await readFile(path.join(sourceResult.configRoot, "opencode.jsonc"), "utf8"),
		);
		const importedConfig = parseGeneratedJson(
			await readFile(path.join(importedResult.configRoot, "opencode.jsonc"), "utf8"),
		);
		const sourceRuntimeConfig = parseGeneratedJson(
			await readFile(path.join(sourceResult.configRoot, "agenthub-runtime.json"), "utf8"),
		);
		const importedRuntimeConfig = parseGeneratedJson(
			await readFile(path.join(importedResult.configRoot, "agenthub-runtime.json"), "utf8"),
		);

		expect(importedConfig.default_agent).toBe(sourceConfig.default_agent);
		expect(importedConfig.model).toBe(sourceConfig.model);
		expect(importedConfig.agent).toEqual(sourceConfig.agent);
		expect(importedConfig.mcp.demo.type).toBe(sourceConfig.mcp.demo.type);
		expect(importedConfig.mcp.demo.timeout).toBe(sourceConfig.mcp.demo.timeout);
		expect(importedConfig.mcp.demo.command[0]).toBe("node");
		expect(path.normalize(importedConfig.mcp.demo.command[1])).toBe(
			path.join(importedHome, "mcp-servers", "demo.js"),
		);
		expect(sourceRuntimeConfig.planDetection).toEqual({
			enabled: true,
			queueVisibleReminder: true,
			queueVisibleReminderTemplate: "[agenthub] Plan reminder injected for this turn.",
		});
		expect(sourceRuntimeConfig.workflowInjection).toEqual(
			await readWorkflowInjectionConfig(path.join(process.cwd(), "src", "composer", "library")),
		);
		expect(importedRuntimeConfig.planDetection).toEqual(sourceRuntimeConfig.planDetection);
		expect(importedRuntimeConfig.workflowInjection).toEqual(sourceRuntimeConfig.workflowInjection);
		expect(
			await readFile(path.join(importedHome, "instructions", "repo-rules.md"), "utf8"),
		).toContain("Round-trip this instruction content.");
		expect(
			await readFile(path.join(importedHome, "mcp", "demo.json"), "utf8"),
		).toContain("mcp-servers/demo.js");
		expect(
			await readFile(path.join(importedHome, "mcp-servers", "demo.js"), "utf8"),
		).toContain("demo mcp");
		expect(
			await readFile(path.join(importedResult.configRoot, "agents", "auto.md"), "utf8"),
		).toContain("## Attached Instruction: repo-rules");

		const manifest = JSON.parse(
			await readFile(path.join(exportRoot, "agenthub-export.json"), "utf8"),
		);
		expect(manifest.formatVersion).toBe(1);
		expect(manifest.contents.profiles).toBe(true);
		expect(manifest.contents.instructions).toBe(true);
		expect(manifest.contents.mcp).toBe(true);
		expect(manifest.contents["mcp-servers"]).toBe(true);
		expect(manifest.contents.workflow).toBe(false);
		expect(manifest.contents.settings).toBe(true);
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

test("installAgentHubHome backfills planDetection and default guards into existing settings", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-settings-upgrade-"));

	try {
		const targetRoot = path.join(tempRoot, "agenthub-home");
		await installAgentHubHome({ targetRoot, mode: "auto" });

		const settingsPath = path.join(targetRoot, "settings.json");
		const oldSettings = parseGeneratedJson(await readFile(settingsPath, "utf8"));
		delete oldSettings.planDetection;
		delete oldSettings.guards;
		delete oldSettings.meta?.builtinVersion;
		await writeFile(settingsPath, `${JSON.stringify(oldSettings, null, 2)}\n`, "utf8");

		await installAgentHubHome({ targetRoot, mode: "auto" });

		const upgradedSettings = parseGeneratedJson(await readFile(settingsPath, "utf8"));
		expect(upgradedSettings.planDetection).toEqual({
			enabled: true,
			queueVisibleReminder: true,
			queueVisibleReminderTemplate: "[agenthub] Plan reminder injected for this turn.",
		});
		expect(Object.keys(upgradedSettings.guards || {}).sort()).toEqual(
			expect.arrayContaining(["no_omo", "no_subagent", "no_task", "read_only"]),
		);
		expect(upgradedSettings.guards.no_omo).toEqual(
			expect.objectContaining({
				blockedTools: ["call_omo_agent"],
				permission: { call_omo_agent: "deny" },
			}),
		);
		expect(upgradedSettings.meta.builtinVersion).toEqual({
			"bundles/auto.json": expect.any(String),
			"bundles/explore.json": expect.any(String),
			"bundles/plan.json": expect.any(String),
			"bundles/build.json": expect.any(String),
			"instructions/authoring-lane-guide.md": expect.any(String),
			"profiles/auto.json": expect.any(String),
			"skills/refine-hub-asset": expect.any(String),
			"skills/write-agent": expect.any(String),
			"skills/write-skill": expect.any(String),
			"souls/auto.md": expect.any(String),
			"souls/explore.md": expect.any(String),
			"souls/plan.md": expect.any(String),
			"souls/build.md": expect.any(String),
		});
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});
