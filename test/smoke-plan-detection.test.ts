import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installAgentHubHome } from "../src/composer/bootstrap.js";
import { composeWorkspace } from "../src/composer/compose.js";
import { readWorkflowInjectionConfig } from "../src/composer/settings.js";
import {
	buildQueuedPlanNotice,
	detectPlanIntent,
	detectWorkflowIntent,
	INTERNAL_INITIATOR_MARKER,
	shouldInjectPlanGuidance,
} from "../src/plugins/plan-guidance.js";

const parseGeneratedJson = (contents: string) => {
	const normalized = contents
		.split("\n")
		.filter((line) => !line.startsWith("//"))
		.join("\n")
		.trim();
	return JSON.parse(normalized);
};

describe("plan marker detection", () => {
	test("detects Classification header as high confidence", () => {
		const signal = detectPlanIntent("Classification: Plan\nI detect Plan — user wants a multi-step approach.");
		expect(signal).toMatchObject({ detected: true, confidence: "high", marker: "classification" });
	});

	test("detects bracketed Classification header as high confidence", () => {
		const signal = detectPlanIntent("Classification: [Plan]\nI detect [Plan] — user wants a multi-step approach.");
		expect(signal).toMatchObject({ detected: true, confidence: "high", marker: "classification" });
	});

	test("detects punctuation-adjacent bracketed classification header", () => {
		const signal = detectPlanIntent("Classification: [Plan].\nI detect [Plan]: staged work.");
		expect(signal).toMatchObject({ detected: true, confidence: "high", marker: "classification" });
	});

	test("detects i-detect fallback as medium confidence", () => {
		const signal = detectPlanIntent("I detect plan — needs structured approach");
		expect(signal).toMatchObject({ detected: true, confidence: "medium", marker: "i-detect" });
	});

	test("detects bracketed i-detect fallback as medium confidence", () => {
		const signal = detectPlanIntent("I detect [Plan] — needs structured approach");
		expect(signal).toMatchObject({ detected: true, confidence: "medium", marker: "i-detect" });
	});

	test("does not match partial word 'Planning' in i-detect fallback", () => {
		expect(detectPlanIntent("I detect Planning issues").detected).toBe(false);
	});

	test("does not match partial word 'Planning'", () => {
		expect(detectPlanIntent("I detect Planning issues").detected).toBe(false);
	});

	test("supports markdown-decorated Classification header", () => {
		const signal = detectPlanIntent("**Classification:** Plan\nI detect Plan — staged work.");
		expect(signal).toMatchObject({ detected: true, confidence: "high", marker: "classification" });
	});

	test("ignores code fence markers near the top", () => {
		const text = "```md\nClassification: Plan\n```\nImplementation starts now.";
		expect(detectPlanIntent(text).detected).toBe(false);
	});

	test("rejects text without any plan marker", () => {
		expect(detectPlanIntent("I will build the feature now and test it thoroughly.").detected).toBe(false);
	});

	test("rejects empty or short text", () => {
		expect(detectPlanIntent("").detected).toBe(false);
		expect(detectPlanIntent("short").detected).toBe(false);
	});

	test("detects markers in Chinese surrounding prose", () => {
		const signal = detectPlanIntent("好的，先判斷一下。\nClassification: Plan\nI detect Plan — 這需要分階段規劃。\n後面我會用中文說明。");
		expect(signal).toMatchObject({ detected: true, confidence: "high", marker: "classification" });
	});

	test("does not scan markers that appear too deep in the text", () => {
		const filler = "a".repeat(900);
		expect(detectPlanIntent(`${filler}\nClassification: Plan`).detected).toBe(false);
	});

	test("respects high threshold over i-detect fallback", () => {
		const signal = detectPlanIntent("I detect Plan — this should remain fallback only.");
		expect(shouldInjectPlanGuidance(signal, { enabled: true, threshold: "high" })).toBe(false);
		expect(shouldInjectPlanGuidance(signal, { enabled: true, threshold: "medium" })).toBe(true);
	});

	test("buildQueuedPlanNotice wraps body in system-reminder and appends internal marker", () => {
		const notice = buildQueuedPlanNotice();
		expect(notice).toContain("<system-reminder>");
		expect(notice).toContain("</system-reminder>");
		expect(notice).toContain(INTERNAL_INITIATOR_MARKER);
	});

	test("buildQueuedPlanNotice uses custom template when provided", () => {
		const notice = buildQueuedPlanNotice({ enabled: true, queueVisibleReminderTemplate: "Custom reminder text." });
		expect(notice).toContain("PLAN_INJECTION_TEST_ACTIVE");
		expect(notice).toContain(INTERNAL_INITIATOR_MARKER);
	});

	test("INTERNAL_INITIATOR_MARKER does not contain plan detection patterns", () => {
		expect(INTERNAL_INITIATOR_MARKER).not.toMatch(/Classification.*Plan/i);
		expect(INTERNAL_INITIATOR_MARKER).not.toMatch(/I detect Plan/i);
	});
});

describe("compose planDetection propagation", () => {
	test("workflow auto-mode config from workflow folder flows to agenthub-runtime.json", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-workflow-injection-"));
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

			await mkdir(path.join(agentHubHome, "workflow"), { recursive: true });
			const workflowPath = path.join(agentHubHome, "workflow", "auto-mode.json");
			const workflowConfig = await readWorkflowInjectionConfig(path.join(process.cwd(), "src", "composer", "library"));
			if (!workflowConfig) throw new Error("Expected built-in workflow config");
			workflowConfig.bundles = ["auto"];
			workflowConfig.queueVisibleReminderTemplate = "[agenthub] workflow config active";
			const planRule = workflowConfig.rules.find((rule) => rule.id === "plan");
			if (planRule) {
				planRule.queueVisibleReminderTemplate = "[agenthub] plan workflow config active";
			}
			await writeFile(workflowPath, `${JSON.stringify(workflowConfig, null, 2)}\n`, "utf8");

			const result = await composeWorkspace(workspace, "auto");
			const runtimeConfigPath = path.join(result.configRoot, "agenthub-runtime.json");
			const runtimeConfig = parseGeneratedJson(await readFile(runtimeConfigPath, "utf8"));
			const normalizedWorkflowConfig = await readWorkflowInjectionConfig(agentHubHome);

			expect(runtimeConfig.workflowInjection).toEqual(normalizedWorkflowConfig);
			expect(runtimeConfig.planDetection).toEqual({
				enabled: true,
				queueVisibleReminder: true,
				queueVisibleReminderTemplate: "[agenthub] Plan reminder injected for this turn.",
			});
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

	test("workflow auto-mode config is skipped when bundle is not bound", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-workflow-bundle-skip-"));
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

			await installAgentHubHome({ targetRoot: agentHubHome, mode: "auto" });

			await mkdir(path.join(agentHubHome, "workflow"), { recursive: true });
			const workflowPath = path.join(agentHubHome, "workflow", "auto-mode.json");
			const workflowConfig = await readWorkflowInjectionConfig(path.join(process.cwd(), "src", "composer", "library"));
			if (!workflowConfig) throw new Error("Expected built-in workflow config");
			workflowConfig.bundles = ["does-not-match"];
			await writeFile(workflowPath, `${JSON.stringify(workflowConfig, null, 2)}\n`, "utf8");

			const result = await composeWorkspace(workspace, "auto");
			const runtimeConfigPath = path.join(result.configRoot, "agenthub-runtime.json");
			const runtimeConfig = parseGeneratedJson(await readFile(runtimeConfigPath, "utf8"));

			expect(runtimeConfig.workflowInjection).toBeUndefined();
			expect(runtimeConfig.planDetection).toBeUndefined();
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

	test("workflow authoring config normalizes modes into runtime rules", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-workflow-normalize-"));

		try {
			const workflowDir = path.join(tempRoot, "workflow");
			await mkdir(workflowDir, { recursive: true });
			await writeFile(
				path.join(workflowDir, "auto-mode.json"),
				`${JSON.stringify(
					{
						enabled: true,
						bundles: ["auto"],
						defaults: {
							match: "any",
							useIDetectFallback: true,
							reminderPrefix: ["Keep repo context."],
							reminderSuffix: ["workflow-received"],
						},
						modes: {
							debug: {
								description: "Debug mode",
								reminderPrefix: ["DEBUG_ACTIVE"],
								reminder: ["Prove root cause before proposing fixes."],
								queueVisibleReminderTemplate: "[agenthub] Debug active",
							},
						},
					},
					null,
					2,
				)}\n`,
				"utf8",
			);

			const normalized = await readWorkflowInjectionConfig(tempRoot);

			expect(normalized).toEqual({
				enabled: true,
				bundles: ["auto"],
				rules: [
					{
						id: "debug",
						description: "Debug mode",
						match: "any",
						triggers: [
							{
								type: "regex",
								value: "(?:^|\\n)\\s*(?:#{1,6}\\s*)?(?:\\*\\*)?Classification(?:\\s*:|:)(?:\\*\\*)?\\s*(?:\\[\\s*Debug\\s*\\]|Debug)(?=[\\s:;,.!?-]|$)",
								confidence: "high",
							},
							{
								type: "regex",
								value: "(?:^|\\n)\\s*I\\s+detect\\s+(?:\\[\\s*Debug\\s*\\]|Debug)(?=[\\s:;,.!?-]|$)",
								confidence: "medium",
							},
						],
						reminderTemplate: [
							"DEBUG_ACTIVE",
							"Keep repo context.",
							"Prove root cause before proposing fixes.",
							"workflow-received",
						].join("\n"),
						queueVisibleReminderTemplate: "[agenthub] Debug active",
					},
				],
			});
		} finally {
			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("built-in workflow config matches Classification: Implementation", async () => {
		const workflowConfig = await readWorkflowInjectionConfig(
			path.join(process.cwd(), "src", "composer", "library"),
		);
		const signal = detectWorkflowIntent(
			"Classification: Implementation\nI detect Implementation - change requested.",
			workflowConfig ?? undefined,
		);

		expect(signal).toMatchObject({
			detected: true,
			confidence: "high",
			ruleId: "implement",
		});
	});

	test("built-in workflow config matches bracketed markers", async () => {
		const workflowConfig = await readWorkflowInjectionConfig(
			path.join(process.cwd(), "src", "composer", "library"),
		);
		const signal = detectWorkflowIntent(
			"Classification: [Implementation]\nI detect [Implementation] - change requested.",
			workflowConfig ?? undefined,
		);

		expect(signal).toMatchObject({
			detected: true,
			confidence: "high",
			ruleId: "implement",
		});
	});

	test("built-in workflow config accepts punctuation-adjacent bracketed markers", async () => {
		const workflowConfig = await readWorkflowInjectionConfig(
			path.join(process.cwd(), "src", "composer", "library"),
		);
		const signal = detectWorkflowIntent(
			"Classification: [Implementation].\nI detect [Implementation]: change requested.",
			workflowConfig ?? undefined,
		);

		expect(signal).toMatchObject({
			detected: true,
			confidence: "high",
			ruleId: "implement",
		});
	});

	test("built-in workflow config does not match partial i-detect labels", async () => {
		const workflowConfig = await readWorkflowInjectionConfig(
			path.join(process.cwd(), "src", "composer", "library"),
		);
		const signal = detectWorkflowIntent(
			"I detect ImplementationPlan - change requested.",
			workflowConfig ?? undefined,
		);

		expect(signal.detected).toBe(false);
	});

	test("workflow authoring config can disable i-detect fallback generation", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-workflow-no-idetect-"));

		try {
			const workflowDir = path.join(tempRoot, "workflow");
			await mkdir(workflowDir, { recursive: true });
			await writeFile(
				path.join(workflowDir, "auto-mode.json"),
				`${JSON.stringify(
					{
						enabled: true,
						defaults: { useIDetectFallback: false },
						modes: {
							plan: {
								reminder: ["Plan only."],
							},
						},
					},
					null,
					2,
				)}\n`,
				"utf8",
			);

			const normalized = await readWorkflowInjectionConfig(tempRoot);
			expect(normalized?.rules[0]?.triggers).toEqual([
				{
					type: "regex",
					value: "(?:^|\\n)\\s*(?:#{1,6}\\s*)?(?:\\*\\*)?Classification(?:\\s*:|:)(?:\\*\\*)?\\s*(?:\\[\\s*Plan\\s*\\]|Plan)(?=[\\s:;,.!?-]|$)",
					confidence: "high",
				},
			]);
		} finally {
			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("workflow authoring config escapes regex metacharacters in labels", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-workflow-escape-label-"));

		try {
			const workflowDir = path.join(tempRoot, "workflow");
			await mkdir(workflowDir, { recursive: true });
			await writeFile(
				path.join(workflowDir, "auto-mode.json"),
				`${JSON.stringify(
					{
						enabled: true,
						modes: {
							debug: {
								label: "Debug (Triage)+",
								reminder: ["Debug only."],
							},
						},
					},
					null,
					2,
				)}\n`,
				"utf8",
			);

			const normalized = await readWorkflowInjectionConfig(tempRoot);
			expect(normalized?.rules[0]?.triggers).toEqual([
				{
					type: "regex",
					value: "(?:^|\\n)\\s*(?:#{1,6}\\s*)?(?:\\*\\*)?Classification(?:\\s*:|:)(?:\\*\\*)?\\s*(?:\\[\\s*Debug \\(Triage\\)\\+\\s*\\]|Debug \\(Triage\\)\\+)(?=[\\s:;,.!?-]|$)",
					confidence: "high",
				},
				{
					type: "regex",
					value: "(?:^|\\n)\\s*I\\s+detect\\s+(?:\\[\\s*Debug \\(Triage\\)\\+\\s*\\]|Debug \\(Triage\\)\\+)(?=[\\s:;,.!?-]|$)",
					confidence: "medium",
				},
			]);
		} finally {
			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("legacy workflow rules config passes through unchanged", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-workflow-legacy-rules-"));

		try {
			const workflowDir = path.join(tempRoot, "workflow");
			await mkdir(workflowDir, { recursive: true });
			const legacyConfig = {
				enabled: true,
				rules: [
					{
						id: "plan",
						match: "any",
						triggers: [{ type: "keyword", value: "I detect Plan", confidence: "medium" }],
						reminderTemplate: "legacy",
					},
				],
			};
			await writeFile(
				path.join(workflowDir, "auto-mode.json"),
				`${JSON.stringify(legacyConfig, null, 2)}\n`,
				"utf8",
			);

			const normalized = await readWorkflowInjectionConfig(tempRoot);
			expect(normalized).toEqual(legacyConfig);
		} finally {
			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("workflow authoring config joins reminder lines in documented order", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-workflow-join-order-"));

		try {
			const workflowDir = path.join(tempRoot, "workflow");
			await mkdir(workflowDir, { recursive: true });
			await writeFile(
				path.join(workflowDir, "auto-mode.json"),
				`${JSON.stringify(
					{
						enabled: true,
						defaults: {
							reminderPrefix: ["default-prefix"],
							reminderSuffix: ["default-suffix"],
						},
						modes: {
							assess: {
								reminderPrefix: ["mode-prefix"],
								reminder: ["body"],
								reminderSuffix: ["mode-suffix"],
							},
						},
					},
					null,
					2,
				)}\n`,
				"utf8",
			);

			const normalized = await readWorkflowInjectionConfig(tempRoot);
			expect(normalized?.rules[0]?.reminderTemplate).toBe(
				["mode-prefix", "default-prefix", "body", "default-suffix", "mode-suffix"].join("\n"),
			);
		} finally {
			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("planDetection from settings flows to agenthub-runtime.json", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-plan-"));
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

			const settingsPath = path.join(agentHubHome, "settings.json");
			const settings = JSON.parse(await readFile(settingsPath, "utf8"));
			settings.planDetection = {
				enabled: true,
				threshold: "high",
				scanLineLimit: 4,
				scanCharLimit: 300,
				maxInjectionsPerSession: 2,
				queueVisibleReminder: true,
				queueVisibleReminderTemplate: "[agenthub] injected",
				reminderTemplate: "Continue your plan.",
			};
			await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");

			const result = await composeWorkspace(workspace, "auto");
			const runtimeConfigPath = path.join(result.configRoot, "agenthub-runtime.json");
			const runtimeConfig = parseGeneratedJson(await readFile(runtimeConfigPath, "utf8"));

			expect(runtimeConfig.planDetection).toEqual({
				enabled: true,
				threshold: "high",
				scanLineLimit: 4,
				scanCharLimit: 300,
				maxInjectionsPerSession: 2,
				queueVisibleReminder: true,
				queueVisibleReminderTemplate: "[agenthub] injected",
				reminderTemplate: "Continue your plan.",
			});
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

	test("planDetection omitted from runtime config when disabled", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-plan-disabled-"));
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
			const settingsPath = path.join(agentHubHome, "settings.json");
			const settings = JSON.parse(await readFile(settingsPath, "utf8"));
			settings.planDetection = { enabled: false };
			await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

			const result = await composeWorkspace(workspace, "auto");
			const runtimeConfigPath = path.join(result.configRoot, "agenthub-runtime.json");
			const runtimeConfig = parseGeneratedJson(await readFile(runtimeConfigPath, "utf8"));

			expect(runtimeConfig.planDetection).toBeUndefined();
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

	test("queues visible reminder and injects it into the next string tool output", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-hook-queue-"));
		const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;

		try {
			const configDir = path.join(tempRoot, "config");
			await mkdir(configDir, { recursive: true });

			const runtimeConfig = {
				generated: new Date().toISOString(),
				agents: { auto: { runtime: "native", blockedTools: [] } },
				planDetection: {
					enabled: true,
					queueVisibleReminder: true,
					queueVisibleReminderTemplate: "[agenthub] Plan reminder queued.",
				},
			};
			await writeFile(
				path.join(configDir, "agenthub-runtime.json"),
				JSON.stringify(runtimeConfig, null, 2),
				"utf8",
			);

			process.env.OPENCODE_CONFIG_DIR = configDir;

			const pluginModule = await import("../src/plugins/opencode-agenthub.js?queue-test");
			const toastCalls: Array<{ body: { title: string; message: string; variant: string; duration: number } }> = [];
			const hooks = await pluginModule.default({
				client: {
					tui: {
						showToast: async (request) => {
							toastCalls.push(request as { body: { title: string; message: string; variant: string; duration: number } });
						},
					},
				},
			});

			const textCompleteHook = hooks["experimental.text.complete"] as (
				hookInput: unknown,
				output: unknown,
			) => Promise<unknown>;
			const textOutput = { text: "Classification: Plan\nI detect Plan - staged work." };
			await textCompleteHook({ sessionID: "sess-queue", messageID: "msg-1" }, textOutput);
			expect(textOutput.text).toBe("Classification: Plan\nI detect Plan - staged work.");

			const toolAfterHook = hooks["tool.execute.after"] as (
				hookInput: unknown,
				hookOutput: unknown,
			) => Promise<unknown>;
			const toolOutput = { output: "Tool result." };
			await toolAfterHook({ sessionID: "sess-queue", tool: { name: "bash" } }, toolOutput);

			expect(toastCalls).toHaveLength(1);
			expect(toastCalls[0].body.title).toBe("Agent Hub");
			expect(toastCalls[0].body.message).toContain("[agenthub] Plan reminder queued.");
			expect(toastCalls[0].body.message).toContain(
				"Follow a structured plan for the current task before continuing.",
			);
			expect(toolOutput.output).toContain("<system-reminder>");
			expect(toolOutput.output).toContain("PLAN_INJECTION_TEST_ACTIVE");
			expect(toolOutput.output).toContain(
				"Include exactly one short line: workflow-received",
			);
			expect(toolOutput.output).toContain(INTERNAL_INITIATOR_MARKER);
			expect(toolOutput.output).toContain("Tool result.");
		} finally {
			if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
			else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;

			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("delivers same-turn after-tool reminder through visible tool output only", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-hook-after-tool-only-"));
		const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;

		try {
			const configDir = path.join(tempRoot, "config");
			await mkdir(configDir, { recursive: true });

			const runtimeConfig = {
				generated: new Date().toISOString(),
				agents: { auto: { runtime: "native", blockedTools: [] } },
				planDetection: {
					enabled: true,
					debugLog: true,
					queueVisibleReminder: true,
					queueVisibleReminderTemplate: "[agenthub] Plan reminder queued.",
				},
			};
			await writeFile(
				path.join(configDir, "agenthub-runtime.json"),
				JSON.stringify(runtimeConfig, null, 2),
				"utf8",
			);

			process.env.OPENCODE_CONFIG_DIR = configDir;

			const pluginModule = await import("../src/plugins/opencode-agenthub.js?after-tool-only-test");
			const hooks = await pluginModule.default({ client: {} });

			const textCompleteHook = hooks["experimental.text.complete"] as (
				hookInput: unknown,
				output: unknown,
			) => Promise<unknown>;
			const toolAfterHook = hooks["tool.execute.after"] as (
				hookInput: unknown,
				hookOutput: unknown,
			) => Promise<unknown>;

			const textOutput = { text: "Classification: Plan\nI detect Plan - staged work." };
			await textCompleteHook({ sessionID: "sess-dual", messageID: "msg-1" }, textOutput);

			const toolOutput = { output: "Tool result." };
			await toolAfterHook({ sessionID: "sess-dual", tool: { name: "bash" } }, toolOutput);

			expect(textOutput.text).toBe("Classification: Plan\nI detect Plan - staged work.");
			expect(toolOutput.output).toContain("<system-reminder>");
			expect(toolOutput.output).toContain("PLAN_INJECTION_TEST_ACTIVE");
			expect(toolOutput.output).toContain("workflow-received");
			expect(toolOutput.output).toContain(INTERNAL_INITIATOR_MARKER);
			expect(toolOutput.output).toContain("\n\n---\n\nTool result.");

			const debugLog = await readFile(path.join(configDir, "plan-detection-debug.log"), "utf8");
			expect(debugLog).toContain(
				"After-tool-only plan reminder active for session sess-dual: visible reminder goes to tool.execute.after output.",
			);
			expect(debugLog).toContain("Injected visible plan reminder into tool.execute.after output for session sess-dual.");
		} finally {
			if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
			else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;

			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("legacy high-threshold planDetection does not inject on i-detect fallback alone", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-hook-high-threshold-"));
		const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;

		try {
			const configDir = path.join(tempRoot, "config");
			await mkdir(configDir, { recursive: true });

			const runtimeConfig = {
				generated: new Date().toISOString(),
				agents: { auto: { runtime: "native", blockedTools: [] } },
				planDetection: {
					enabled: true,
					threshold: "high",
				},
			};
			await writeFile(
				path.join(configDir, "agenthub-runtime.json"),
				JSON.stringify(runtimeConfig, null, 2),
				"utf8",
			);

			process.env.OPENCODE_CONFIG_DIR = configDir;

			const pluginModule = await import("../src/plugins/opencode-agenthub.js?high-threshold");
			const hooks = await pluginModule.default();

			const textCompleteHook = hooks["experimental.text.complete"] as (
				hookInput: unknown,
				output: unknown,
			) => Promise<unknown>;

			await textCompleteHook(
				{ sessionID: "sess-high-threshold", messageID: "msg-1" },
				{ text: "I detect Plan - this should stay below the high threshold." },
			);

			const toolAfterHook = hooks["tool.execute.after"] as (
				hookInput: unknown,
				hookOutput: unknown,
			) => Promise<unknown>;
			const toolOutput = { output: "Tool result." };
			await toolAfterHook({ sessionID: "sess-high-threshold", tool: { name: "bash" } }, toolOutput);

			expect(toolOutput.output).toBe("Tool result.");
		} finally {
			if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
			else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;

			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("calls tui.showToast with binding intact", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-hook-toast-bound-"));
		const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;

		try {
			const configDir = path.join(tempRoot, "config");
			await mkdir(configDir, { recursive: true });

			const runtimeConfig = {
				generated: new Date().toISOString(),
				agents: { auto: { runtime: "native", blockedTools: [] } },
				planDetection: {
					enabled: true,
					queueVisibleReminder: true,
				},
			};
			await writeFile(
				path.join(configDir, "agenthub-runtime.json"),
				JSON.stringify(runtimeConfig, null, 2),
				"utf8",
			);

			process.env.OPENCODE_CONFIG_DIR = configDir;

			const toastCalls: Array<{ body: { title: string; message: string; variant: string; duration: number } }> = [];
			const tui = {
				calls: toastCalls,
				async showToast(
					this: { calls: Array<{ body: { title: string; message: string; variant: string; duration: number } }> },
					request: { body: { title: string; message: string; variant: string; duration: number } },
				) {
					this.calls.push(request);
				},
			};

			const pluginModule = await import("../src/plugins/opencode-agenthub.js?toast-bound");
			const hooks = await pluginModule.default({ client: { tui } });

			const textCompleteHook = hooks["experimental.text.complete"] as (
				hookInput: unknown,
				output: unknown,
			) => Promise<unknown>;
			await textCompleteHook(
				{ sessionID: "sess-toast-bound", messageID: "msg-1" },
				{ text: "Classification: Plan\nI detect Plan - staged work." },
			);

			expect(toastCalls).toHaveLength(1);
			expect(toastCalls[0].body.title).toBe("Agent Hub");
		} finally {
			if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
			else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;

			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("injects visible reminder into next string tool output when tui.showToast is unavailable", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-hook-chat-no-text-"));
		const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;

		try {
			const configDir = path.join(tempRoot, "config");
			await mkdir(configDir, { recursive: true });

			const runtimeConfig = {
				generated: new Date().toISOString(),
				agents: { auto: { runtime: "native", blockedTools: [] } },
				planDetection: {
					enabled: true,
					queueVisibleReminder: true,
				},
			};
			await writeFile(
				path.join(configDir, "agenthub-runtime.json"),
				JSON.stringify(runtimeConfig, null, 2),
				"utf8",
			);

			process.env.OPENCODE_CONFIG_DIR = configDir;

			const pluginModule = await import("../src/plugins/opencode-agenthub.js?chat-no-text-test");
			const hooks = await pluginModule.default({ client: {} });

			const textCompleteHook = hooks["experimental.text.complete"] as (
				hookInput: unknown,
				output: unknown,
			) => Promise<unknown>;
			const textOutput = { text: "Classification: Plan\nI detect Plan - staged work." };
			await textCompleteHook({ sessionID: "sess-chat-no-text", messageID: "msg-1" }, textOutput);
			const toolAfterHook = hooks["tool.execute.after"] as (
				hookInput: unknown,
				hookOutput: unknown,
			) => Promise<unknown>;
			const toolOutput = { output: "Tool result." };
			await toolAfterHook({ sessionID: "sess-chat-no-text", tool: { name: "read" } }, toolOutput);

			expect(textOutput.text).toBe("Classification: Plan\nI detect Plan - staged work.");
			expect(toolOutput.output).toContain(
				"<system-reminder>\nPLAN_INJECTION_TEST_ACTIVE\nKeep the user's current task, constraints, and repo context as the source of truth.\nDo not restart the task or replace the answer format.\nInclude exactly one short line: workflow-received\n</system-reminder>\n<!-- OMO_INTERNAL_INITIATOR -->",
			);
		} finally {
			if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
			else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;

			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("tool-after visible injection is skipped when queueVisibleReminder is false", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-hook-no-queue-"));
		const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;

		try {
			const configDir = path.join(tempRoot, "config");
			await mkdir(configDir, { recursive: true });

			const runtimeConfig = {
				generated: new Date().toISOString(),
				agents: { auto: { runtime: "native", blockedTools: [] } },
				planDetection: { enabled: true, queueVisibleReminder: false },
			};
			await writeFile(
				path.join(configDir, "agenthub-runtime.json"),
				JSON.stringify(runtimeConfig, null, 2),
				"utf8",
			);

			process.env.OPENCODE_CONFIG_DIR = configDir;

			const pluginModule = await import("../src/plugins/opencode-agenthub.js?no-queue-test");
			const hooks = await pluginModule.default({ client: {} });

			const textCompleteHook = hooks["experimental.text.complete"] as (
				hookInput: unknown,
				output: unknown,
			) => Promise<unknown>;
			const textOutput = { text: "Classification: Plan\nI detect Plan - staged work." };
			await textCompleteHook({ sessionID: "sess-no-queue", messageID: "msg-1" }, textOutput);
			const toolAfterHook = hooks["tool.execute.after"] as (
				hookInput: unknown,
				hookOutput: unknown,
			) => Promise<unknown>;
			const toolOutput = { output: "Tool result." };
			await toolAfterHook({ sessionID: "sess-no-queue", tool: { name: "bash" } }, toolOutput);

			expect(textOutput.text).toBe("Classification: Plan\nI detect Plan - staged work.");
			expect(toolOutput.output).toBe("Tool result.");
		} finally {
			if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
			else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;

			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("new chat.message boundary clears stale visible reminders before the next run", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-chat-boundary-clear-"));
		const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;

		try {
			const configDir = path.join(tempRoot, "config");
			await mkdir(configDir, { recursive: true });

			const runtimeConfig = {
				generated: new Date().toISOString(),
				agents: { auto: { runtime: "native", blockedTools: [] } },
				planDetection: {
					enabled: true,
					debugLog: true,
					queueVisibleReminder: true,
				},
			};
			await writeFile(
				path.join(configDir, "agenthub-runtime.json"),
				JSON.stringify(runtimeConfig, null, 2),
				"utf8",
			);

			process.env.OPENCODE_CONFIG_DIR = configDir;

			const pluginModule = await import("../src/plugins/opencode-agenthub.js?chat-boundary-clear");
			const hooks = await pluginModule.default({ client: {} });

			const textCompleteHook = hooks["experimental.text.complete"] as (
				hookInput: unknown,
				output: unknown,
			) => Promise<unknown>;
			const chatMessageHook = hooks["chat.message"] as (hookInput: unknown) => Promise<unknown>;
			const toolAfterHook = hooks["tool.execute.after"] as (
				hookInput: unknown,
				hookOutput: unknown,
			) => Promise<unknown>;

			await textCompleteHook(
				{ sessionID: "sess-boundary", messageID: "msg-1" },
				{ text: "Classification: Plan\nI detect Plan - staged work." },
			);

			await chatMessageHook({ sessionID: "sess-boundary", messageID: "msg-2" });

			const toolOutput = { output: "Tool result." };
			await toolAfterHook({ sessionID: "sess-boundary", tool: { name: "bash" } }, toolOutput);

			expect(toolOutput.output).toBe("Tool result.");

			const debugLog = await readFile(path.join(configDir, "plan-detection-debug.log"), "utf8");
			expect(debugLog).toContain(
				"Cleared stale pending visible reminder for session sess-boundary (new chat.message boundary). visible=true",
			);
		} finally {
			if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
			else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;

			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("internal initiator messages skip plan detection (anti-recursion)", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-anti-recursion-"));
		const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;

		try {
			const configDir = path.join(tempRoot, "config");
			await mkdir(configDir, { recursive: true });

			const runtimeConfig = {
				generated: new Date().toISOString(),
				agents: { auto: { runtime: "native", blockedTools: [] } },
				planDetection: { enabled: true, queueVisibleReminder: true },
			};
			await writeFile(
				path.join(configDir, "agenthub-runtime.json"),
				JSON.stringify(runtimeConfig, null, 2),
				"utf8",
			);

			process.env.OPENCODE_CONFIG_DIR = configDir;

			const pluginModule = await import("../src/plugins/opencode-agenthub.js?anti-recursion");
			const hooks = await pluginModule.default({ client: {} });

			const textCompleteHook = hooks["experimental.text.complete"] as (
				hookInput: unknown,
				output: unknown,
			) => Promise<unknown>;

			const internalMessage = `<system-reminder>\n[agenthub] Plan reminder injected.\n</system-reminder>\n${INTERNAL_INITIATOR_MARKER}`;
			await textCompleteHook(
				{ sessionID: "sess-recursion", messageID: "msg-internal" },
				{ text: internalMessage },
			);

			const toolAfterHook = hooks["tool.execute.after"] as (
				hookInput: unknown,
				hookOutput: unknown,
			) => Promise<unknown>;
			const toolOutput = { output: "Tool result." };
			await toolAfterHook({ sessionID: "sess-recursion", tool: { name: "bash" } }, toolOutput);

			expect(toolOutput.output).toBe("Tool result.");
		} finally {
			if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
			else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;

			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("logs toast display when tui.showToast succeeds", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-hook-chat-debug-"));
		const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;

		try {
			const configDir = path.join(tempRoot, "config");
			await mkdir(configDir, { recursive: true });

			const runtimeConfig = {
				generated: new Date().toISOString(),
				agents: { auto: { runtime: "native", blockedTools: [] } },
				planDetection: {
					enabled: true,
					debugLog: true,
					queueVisibleReminder: true,
				},
			};
			await writeFile(
				path.join(configDir, "agenthub-runtime.json"),
				JSON.stringify(runtimeConfig, null, 2),
				"utf8",
			);

			process.env.OPENCODE_CONFIG_DIR = configDir;

			const pluginModule = await import("../src/plugins/opencode-agenthub.js?chat-debug");
			const hooks = await pluginModule.default({
				client: {
					tui: {
						showToast: async () => undefined,
					},
				},
			});

			const textCompleteHook = hooks["experimental.text.complete"] as (
				hookInput: unknown,
				output: unknown,
			) => Promise<unknown>;
			const textOutput = { text: "Classification: Plan\nI detect Plan - staged work." };
			await textCompleteHook({ sessionID: "sess-chat-debug", messageID: "msg-1" }, textOutput);

			const toolAfterHook = hooks["tool.execute.after"] as (
				hookInput: unknown,
				hookOutput: unknown,
			) => Promise<unknown>;
			await toolAfterHook({ sessionID: "sess-chat-debug", tool: { name: "bash" } }, { output: "Tool result." });

			const debugLog = await readFile(path.join(configDir, "plan-detection-debug.log"), "utf8");
			expect(debugLog).toContain("Displayed visible plan reminder via tui.showToast");
			expect(debugLog).toContain("Queued visible plan reminder for tool.execute.after injection");
			expect(debugLog).toContain("Injected visible plan reminder into tool.execute.after output");
		} finally {
			if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
			else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;

			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("keeps queued visible reminder until next string tool output when tui.showToast throws", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-hook-toast-fallback-"));
		const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;

		try {
			const configDir = path.join(tempRoot, "config");
			await mkdir(configDir, { recursive: true });

			const runtimeConfig = {
				generated: new Date().toISOString(),
				agents: { auto: { runtime: "native", blockedTools: [] } },
				planDetection: {
					enabled: true,
					debugLog: true,
					queueVisibleReminder: true,
				},
			};
			await writeFile(
				path.join(configDir, "agenthub-runtime.json"),
				JSON.stringify(runtimeConfig, null, 2),
				"utf8",
			);

			process.env.OPENCODE_CONFIG_DIR = configDir;

			const pluginModule = await import("../src/plugins/opencode-agenthub.js?toast-fallback");
			const hooks = await pluginModule.default({
				client: {
					tui: {
						showToast: async () => {
							throw new Error("toast unavailable");
						},
					},
				},
			});

			const textCompleteHook = hooks["experimental.text.complete"] as (
				hookInput: unknown,
				output: unknown,
			) => Promise<unknown>;
			const textOutput = { text: "Classification: Plan\nI detect Plan - staged work." };
			await textCompleteHook({ sessionID: "sess-toast-fallback", messageID: "msg-1" }, textOutput);
			const toolAfterHook = hooks["tool.execute.after"] as (
				hookInput: unknown,
				hookOutput: unknown,
			) => Promise<unknown>;
			const toolOutput = { output: "Tool result." };
			await toolAfterHook({ sessionID: "sess-toast-fallback", tool: { name: "bash" } }, toolOutput);

			expect(textOutput.text).toBe("Classification: Plan\nI detect Plan - staged work.");
			expect(toolOutput.output).toContain("PLAN_INJECTION_TEST_ACTIVE");
			const debugLog = await readFile(path.join(configDir, "plan-detection-debug.log"), "utf8");
			expect(debugLog).toContain("Failed to show visible plan reminder via tui.showToast");
			expect(debugLog).toContain("Queued visible plan reminder for tool.execute.after injection");
		} finally {
			if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
			else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;

			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("queued visible reminder only affects the next string tool output once", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-hook-chat-once-"));
		const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;

		try {
			const configDir = path.join(tempRoot, "config");
			await mkdir(configDir, { recursive: true });

			const runtimeConfig = {
				generated: new Date().toISOString(),
				agents: { auto: { runtime: "native", blockedTools: [] } },
				planDetection: {
					enabled: true,
					debugLog: true,
					queueVisibleReminder: true,
				},
			};
			await writeFile(
				path.join(configDir, "agenthub-runtime.json"),
				JSON.stringify(runtimeConfig, null, 2),
				"utf8",
			);

			process.env.OPENCODE_CONFIG_DIR = configDir;

			const pluginModule = await import("../src/plugins/opencode-agenthub.js?chat-once");
			const hooks = await pluginModule.default();

			const textCompleteHook = hooks["experimental.text.complete"] as (
				hookInput: unknown,
				output: unknown,
			) => Promise<unknown>;
			const firstOutput = { text: "Classification: Plan\nI detect Plan - staged work." };
			await textCompleteHook({ sessionID: "sess-chat-once", messageID: "msg-1" }, firstOutput);
			const toolAfterHook = hooks["tool.execute.after"] as (
				hookInput: unknown,
				hookOutput: unknown,
			) => Promise<unknown>;
			const firstToolOutput = { output: "Tool result." };
			await toolAfterHook({ sessionID: "sess-chat-once", tool: { name: "bash" } }, firstToolOutput);

			const secondOutput = { text: "Second reply." };
			await textCompleteHook({ sessionID: "sess-chat-once", messageID: "msg-2" }, secondOutput);
			const secondToolOutput = { output: "Second tool result." };
			await toolAfterHook({ sessionID: "sess-chat-once", tool: { name: "read" } }, secondToolOutput);

			expect(firstOutput.text).toBe("Classification: Plan\nI detect Plan - staged work.");
			expect(firstToolOutput.output).toContain("PLAN_INJECTION_TEST_ACTIVE");
			expect(firstToolOutput.output).toContain(
				"Include exactly one short line: workflow-received",
			);
			expect(firstToolOutput.output).toContain("<system-reminder>");
			expect(firstToolOutput.output).toContain(INTERNAL_INITIATOR_MARKER);
			expect(secondOutput.text).toBe("Second reply.");
			expect(secondToolOutput.output).toBe("Second tool result.");
		} finally {
			if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
			else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;

			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("concurrent tool.execute.after completions inject a queued reminder only once", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-hook-concurrent-once-"));
		const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;

		try {
			const configDir = path.join(tempRoot, "config");
			await mkdir(configDir, { recursive: true });

			const runtimeConfig = {
				generated: new Date().toISOString(),
				agents: { auto: { runtime: "native", blockedTools: [] } },
				workflowInjection: {
					enabled: true,
					debugLog: true,
					queueVisibleReminder: true,
					rules: [
						{
							id: "assess",
							match: "any",
							triggers: [
								{
									type: "regex",
									value:
										"(?:^|\\n)\\s*(?:#{1,6}\\s*)?(?:\\*\\*)?Classification(?:\\s*:|:)(?:\\*\\*)?\\s*(?:\\[\\s*Assess\\s*\\]|Assess)(?=[\\s:;,.!?-]|$)",
									confidence: "high",
								},
							],
							reminderTemplate:
								"WORKFLOW_INJECTION_TEST_ACTIVE\nKeep the user's current task, constraints, and repo context as the source of truth.\n--- Workflow ---\n0. Report: [Assess Workflow Received]\n1. Research: assess the current project state, dependencies, and users true intent.\nCan fire 1-2 explore subagents to help with research.\n2. Analysis: Evaluate the problem against project standards, performance metrics, and user requirements.\n3. Verdict: Deliver a clear assessment with confidence level and reasoning.\n4. Recommendations: Propose specific, actionable improvements or fixes.\n--- Core Rules ---\nEvidence-Based: Base all conclusions on concrete data from the codebase, not assumptions.\nNo Speculation: If information is insufficient, state 'Insufficient Data' rather than guessing.\nActionable Insights: Recommendations must be specific enough for an agent to implement directly.\nBalanced View: Acknowledge both risks and benefits of any proposed changes.\nDo not restart the task or replace the answer format.\nInclude exactly one short line: workflow-received",
						},
					],
				},
			};
			await writeFile(
				path.join(configDir, "agenthub-runtime.json"),
				JSON.stringify(runtimeConfig, null, 2),
				"utf8",
			);

			process.env.OPENCODE_CONFIG_DIR = configDir;

			const pluginModule = await import("../src/plugins/opencode-agenthub.js?concurrent-tool-after");
			const hooks = await pluginModule.default({ client: {} });

			const textCompleteHook = hooks["experimental.text.complete"] as (
				hookInput: unknown,
				output: unknown,
			) => Promise<unknown>;
			const toolAfterHook = hooks["tool.execute.after"] as (
				hookInput: unknown,
				hookOutput: unknown,
			) => Promise<unknown>;

			await textCompleteHook(
				{ sessionID: "sess-concurrent", messageID: "msg-1" },
				{ text: "Classification: Assess\nI detect Assess - inspect repo state." },
			);

			const branchOutput = { output: "git branch\n* main\n" };
			const logOutput = { output: "git log -n 5\n5fd1b82 feat: keep reminder injection after tool only\n" };

			await Promise.all([
				toolAfterHook({ sessionID: "sess-concurrent", tool: { name: "bash" } }, branchOutput),
				toolAfterHook({ sessionID: "sess-concurrent", tool: { name: "bash" } }, logOutput),
			]);

			const outputs = [branchOutput.output, logOutput.output];
			const injectedOutputs = outputs.filter((value) => value.includes("WORKFLOW_INJECTION_TEST_ACTIVE"));
			const plainOutputs = outputs.filter((value) => !value.includes("WORKFLOW_INJECTION_TEST_ACTIVE"));

			expect(injectedOutputs).toHaveLength(1);
			expect(plainOutputs).toHaveLength(1);
			expect(injectedOutputs[0]).toContain("<system-reminder>");
			expect(injectedOutputs[0]).toContain(INTERNAL_INITIATOR_MARKER);
			expect(injectedOutputs[0]).toContain("---\n\n");
			expect(plainOutputs[0]).toMatch(/^(git branch\n\* main\n|git log -n 5\n5fd1b82 feat: keep reminder injection after tool only\n)$/);

			const debugLog = await readFile(path.join(configDir, "plan-detection-debug.log"), "utf8");
			const injectionMatches = debugLog.match(/Injected visible workflow reminder into tool\.execute\.after output for session sess-concurrent\./g) ?? [];
			expect(injectionMatches).toHaveLength(1);
		} finally {
			if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
			else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;

			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("workflow visible reminder is injected into the next string tool output even when toast succeeds", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-workflow-visible-"));
		const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;

		try {
			const configDir = path.join(tempRoot, "config");
			await mkdir(configDir, { recursive: true });

			const runtimeConfig = {
				generated: new Date().toISOString(),
				agents: { auto: { runtime: "native", blockedTools: [] } },
				workflowInjection: {
					enabled: true,
					queueVisibleReminder: true,
					queueVisibleReminderTemplate: "[agenthub] Auto workflow reminder injected.",
						rules: [
							{
								id: "debug",
								match: "any",
								triggers: [
									{
										type: "regex",
										value:
											"(?:^|\\n)\\s*I\\s+detect\\s+(?:\\[\\s*Debug\\s*\\]|Debug)(?=[\\s:;,.!?-]|$)",
										confidence: "medium",
									},
								],
							queueVisibleReminderTemplate: "[agenthub] Debug workflow reminder injected.",
							reminderTemplate:
								"DEBUG_WORKFLOW_ACTIVE\n0. Report: [Debug Workflow Received]\n1. Triage: Reproduce the bug and trace the execution path.\nworkflow-received",
						},
					],
				},
			};
			await writeFile(
				path.join(configDir, "agenthub-runtime.json"),
				JSON.stringify(runtimeConfig, null, 2),
				"utf8",
			);

			process.env.OPENCODE_CONFIG_DIR = configDir;

			const toastCalls: Array<{ body: { message: string } }> = [];
			const pluginModule = await import("../src/plugins/opencode-agenthub.js?workflow-visible");
			const hooks = await pluginModule.default({
				client: {
					tui: {
						showToast: async (request) => {
							toastCalls.push(request as { body: { message: string } });
						},
					},
				},
			});

			const textCompleteHook = hooks["experimental.text.complete"] as (
				hookInput: unknown,
				output: unknown,
			) => Promise<unknown>;
			const textOutput = { text: "Classification: [Debug]\nI detect [Debug] - root cause needed." };
			await textCompleteHook({ sessionID: "sess-workflow-visible", messageID: "msg-1" }, textOutput);
			const toolAfterHook = hooks["tool.execute.after"] as (
				hookInput: unknown,
				hookOutput: unknown,
			) => Promise<unknown>;
			const toolOutput = { output: "Tool result." };
			await toolAfterHook({ sessionID: "sess-workflow-visible", tool: { name: "bash" } }, toolOutput);

			expect(toastCalls).toHaveLength(1);
			expect(toastCalls[0]?.body.message).toContain("[agenthub] Debug workflow reminder injected.");
			expect(toastCalls[0]?.body.message).toContain("0. Report: [Debug Workflow Received]");
			expect(textOutput.text).toBe("Classification: [Debug]\nI detect [Debug] - root cause needed.");
			expect(toolOutput.output).toBe(
				"<system-reminder>\nDEBUG_WORKFLOW_ACTIVE\n0. Report: [Debug Workflow Received]\n1. Triage: Reproduce the bug and trace the execution path.\nworkflow-received\n</system-reminder>\n<!-- OMO_INTERNAL_INITIATOR -->\n\n---\n\nTool result.",
			);
		} finally {
			if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
			else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;

			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("emits debug log when debugLog is enabled", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-hook-debuglog-"));
		const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;

		try {
			const configDir = path.join(tempRoot, "config");
			await mkdir(configDir, { recursive: true });

			const runtimeConfig = {
				generated: new Date().toISOString(),
				agents: { auto: { runtime: "native", blockedTools: [] } },
				planDetection: {
					enabled: true,
					debugLog: true,
				},
			};
			await writeFile(
				path.join(configDir, "agenthub-runtime.json"),
				JSON.stringify(runtimeConfig, null, 2),
				"utf8",
			);

			process.env.OPENCODE_CONFIG_DIR = configDir;

			const pluginModule = await import("../src/plugins/opencode-agenthub.js?debuglog");
			const hooks = await pluginModule.default();

			const textCompleteHook = hooks["experimental.text.complete"] as (
				hookInput: unknown,
				output: unknown,
			) => Promise<unknown>;
			await textCompleteHook(
				{ sessionID: "sess-debuglog", messageID: "msg-1" },
				{ text: "Classification: Plan\nI detect Plan - staged work." },
			);

			const toolAfterHook = hooks["tool.execute.after"] as (
				hookInput: unknown,
				hookOutput: unknown,
			) => Promise<unknown>;
			await toolAfterHook({ sessionID: "sess-debuglog", tool: { name: "bash" } }, { output: "Tool result." });

			const debugLog = await readFile(path.join(configDir, "plan-detection-debug.log"), "utf8");
			expect(debugLog).toContain("Detected legacy plan marker for session sess-debuglog; queued visible reminder.");
			expect(debugLog).toContain("Injected visible plan reminder into tool.execute.after output for session sess-debuglog.");
		} finally {
			if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
			else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;

			await rm(tempRoot, { recursive: true, force: true });
		}
	});
});

	describe("plugin hook one-shot semantics", () => {
		test("workflowInjection rules trigger rule-specific after-tool reminder", async () => {
			const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-workflow-rule-"));
			const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;

		try {
			const configDir = path.join(tempRoot, "config");
			await mkdir(configDir, { recursive: true });

			const runtimeConfig = {
				generated: new Date().toISOString(),
				agents: { auto: { runtime: "native", blockedTools: [] } },
				workflowInjection: {
					enabled: true,
					queueVisibleReminder: true,
					rules: [
						{
							id: "debug",
							match: "any",
							triggers: [
								{ type: "keyword", value: "I detect Debug", confidence: "medium" },
							],
							reminderTemplate: "DEBUG_WORKFLOW_ACTIVE\nFocus on root cause.\nworkflow-received",
						},
					],
				},
			};
			await writeFile(
				path.join(configDir, "agenthub-runtime.json"),
				JSON.stringify(runtimeConfig, null, 2),
				"utf8",
			);

			process.env.OPENCODE_CONFIG_DIR = configDir;

			const pluginModule = await import("../src/plugins/opencode-agenthub.js?workflow-rule");
			const hooks = await pluginModule.default();

			const textCompleteHook = hooks["experimental.text.complete"] as (
				hookInput: unknown,
				output: unknown,
			) => Promise<unknown>;
			const toolAfterHook = hooks["tool.execute.after"] as (
				hookInput: unknown,
				hookOutput: unknown,
			) => Promise<unknown>;

			await textCompleteHook(
				{ sessionID: "sess-workflow", messageID: "msg-1" },
				{ text: "Classification: Debug\nI detect Debug - root cause needed." },
			);

			const toolOutput = { output: "Tool result." };
			await toolAfterHook({ sessionID: "sess-workflow", tool: { name: "bash" } }, toolOutput);

			expect(toolOutput.output).toContain("<system-reminder>");
			expect(toolOutput.output).toContain("DEBUG_WORKFLOW_ACTIVE");
			expect(toolOutput.output).toContain("workflow-received");
		} finally {
			if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
			else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;

			await rm(tempRoot, { recursive: true, force: true });
		}
	});

		test("workflowInjection takes precedence over legacy planDetection when both exist", async () => {
			const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-workflow-precedence-"));
			const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;

		try {
			const configDir = path.join(tempRoot, "config");
			await mkdir(configDir, { recursive: true });

			const runtimeConfig = {
				generated: new Date().toISOString(),
				agents: { auto: { runtime: "native", blockedTools: [] } },
				planDetection: {
					enabled: true,
					reminderTemplate: "LEGACY_PLAN_ONLY",
				},
				workflowInjection: {
					enabled: true,
					queueVisibleReminder: true,
					rules: [
						{
							id: "plan",
							match: "any",
							triggers: [
								{ type: "regex", value: "(?:^|\\n)\\s*Classification:\\s*Plan\\b", confidence: "high" },
							],
							reminderTemplate: "WORKFLOW_WINS",
						},
					],
				},
			};
			await writeFile(
				path.join(configDir, "agenthub-runtime.json"),
				JSON.stringify(runtimeConfig, null, 2),
				"utf8",
			);

			process.env.OPENCODE_CONFIG_DIR = configDir;

			const pluginModule = await import("../src/plugins/opencode-agenthub.js?workflow-precedence");
			const hooks = await pluginModule.default();

			const textCompleteHook = hooks["experimental.text.complete"] as (
				hookInput: unknown,
				output: unknown,
			) => Promise<unknown>;
			const toolAfterHook = hooks["tool.execute.after"] as (
				hookInput: unknown,
				hookOutput: unknown,
			) => Promise<unknown>;

			await textCompleteHook(
				{ sessionID: "sess-workflow-precedence", messageID: "msg-1" },
				{ text: "Classification: Plan\nI detect Plan - staged work." },
			);

			const toolOutput = { output: "Tool result." };
			await toolAfterHook({ sessionID: "sess-workflow-precedence", tool: { name: "bash" } }, toolOutput);

			expect(toolOutput.output).toContain("WORKFLOW_WINS");
			expect(toolOutput.output).not.toContain("LEGACY_PLAN_ONLY");
		} finally {
			if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
			else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;

			await rm(tempRoot, { recursive: true, force: true });
		}
	});

		test("legacy planDetection still injects when workflowInjection is present but no workflow rule matches", async () => {
			const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-workflow-plan-fallback-"));
			const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;

		try {
			const configDir = path.join(tempRoot, "config");
			await mkdir(configDir, { recursive: true });

			const runtimeConfig = {
				generated: new Date().toISOString(),
				agents: { auto: { runtime: "native", blockedTools: [] } },
				planDetection: {
					enabled: true,
					reminderTemplate: "LEGACY_PLAN_ONLY",
				},
				workflowInjection: {
					enabled: true,
					queueVisibleReminder: true,
					rules: [
						{
							id: "debug",
							match: "any",
							triggers: [
								{ type: "regex", value: "(?:^|\\n)\\s*Classification:\\s*Debug\\b", confidence: "high" },
							],
							reminderTemplate: "WORKFLOW_DEBUG_ONLY",
						},
					],
				},
			};
			await writeFile(
				path.join(configDir, "agenthub-runtime.json"),
				JSON.stringify(runtimeConfig, null, 2),
				"utf8",
			);

			process.env.OPENCODE_CONFIG_DIR = configDir;

			const pluginModule = await import("../src/plugins/opencode-agenthub.js?workflow-plan-fallback");
			const hooks = await pluginModule.default();

			const textCompleteHook = hooks["experimental.text.complete"] as (
				hookInput: unknown,
				output: unknown,
			) => Promise<unknown>;
			const toolAfterHook = hooks["tool.execute.after"] as (
				hookInput: unknown,
				hookOutput: unknown,
			) => Promise<unknown>;

			await textCompleteHook(
				{ sessionID: "sess-workflow-plan-fallback", messageID: "msg-1" },
				{ text: "Classification: Plan\nI detect Plan - staged work." },
			);

			const toolOutput = { output: "Tool result." };
			await toolAfterHook({ sessionID: "sess-workflow-plan-fallback", tool: { name: "bash" } }, toolOutput);

			expect(toolOutput.output).toContain("LEGACY_PLAN_ONLY");
			expect(toolOutput.output).not.toContain("WORKFLOW_DEBUG_ONLY");
		} finally {
			if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
			else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;

			await rm(tempRoot, { recursive: true, force: true });
		}
	});

		test("plan detection queues visible state and after-tool injection clears it", async () => {
			const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-hook-"));
			const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;

		try {
			const configDir = path.join(tempRoot, "config");
			await mkdir(configDir, { recursive: true });

			const runtimeConfig = {
				generated: new Date().toISOString(),
				agents: { auto: { runtime: "native", blockedTools: [] } },
				planDetection: { enabled: true },
			};
			await writeFile(
				path.join(configDir, "agenthub-runtime.json"),
				JSON.stringify(runtimeConfig, null, 2),
				"utf8",
			);

			process.env.OPENCODE_CONFIG_DIR = configDir;

			const pluginModule = await import("../src/plugins/opencode-agenthub.js");
			const hooks = await pluginModule.default();

			const textCompleteHook = hooks["experimental.text.complete"] as (
				hookInput: unknown,
				output: unknown,
			) => Promise<unknown>;
			const toolAfterHook = hooks["tool.execute.after"] as (
				hookInput: unknown,
				hookOutput: unknown,
			) => Promise<unknown>;

			await textCompleteHook(
				{ sessionID: "sess-1", messageID: "msg-1" },
				{ text: "Classification: Plan\nI detect Plan — user wants multi-step. I will outline." },
			);

			const firstToolOutput = { output: "Tool result." };
			await toolAfterHook({ sessionID: "sess-1", tool: { name: "bash" } }, firstToolOutput);
			expect(firstToolOutput.output).toContain("<system-reminder>");
			expect(firstToolOutput.output).toContain("PLAN_INJECTION_TEST_ACTIVE");
			expect(firstToolOutput.output).toContain(
				"Include exactly one short line: workflow-received",
			);

			const secondToolOutput = { output: "Second tool result." };
			await toolAfterHook({ sessionID: "sess-1", tool: { name: "read" } }, secondToolOutput);
			expect(secondToolOutput.output).toBe("Second tool result.");
		} finally {
			if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
			else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;

			await rm(tempRoot, { recursive: true, force: true });
		}
	});

		test("session.deleted clears plan state", async () => {
			const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-session-"));
			const originalConfigDir = process.env.OPENCODE_CONFIG_DIR;

		try {
			const configDir = path.join(tempRoot, "config");
			await mkdir(configDir, { recursive: true });

			const runtimeConfig = {
				generated: new Date().toISOString(),
				agents: { auto: { runtime: "native", blockedTools: [] } },
				planDetection: { enabled: true },
			};
			await writeFile(
				path.join(configDir, "agenthub-runtime.json"),
				JSON.stringify(runtimeConfig, null, 2),
				"utf8",
			);

			process.env.OPENCODE_CONFIG_DIR = configDir;

			const pluginModule = await import("../src/plugins/opencode-agenthub.js");
			const hooks = await pluginModule.default();

			const textCompleteHook = hooks["experimental.text.complete"] as (
				hookInput: unknown,
				output: unknown,
			) => Promise<unknown>;
			const eventHook = hooks.event as (payload: unknown) => Promise<unknown>;
			const toolAfterHook = hooks["tool.execute.after"] as (
				hookInput: unknown,
				hookOutput: unknown,
			) => Promise<unknown>;

			await textCompleteHook(
				{ sessionID: "sess-2", messageID: "msg-1" },
				{ text: "Classification: Plan\nI detect Plan — approach needed." },
			);

			await eventHook({ event: { type: "session.deleted", sessionID: "sess-2" } });

			const toolOutput = { output: "Tool result." };
			await toolAfterHook({ sessionID: "sess-2", tool: { name: "bash" } }, toolOutput);
			expect(toolOutput.output).toBe("Tool result.");
		} finally {
			if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
			else process.env.OPENCODE_CONFIG_DIR = originalConfigDir;

			await rm(tempRoot, { recursive: true, force: true });
		}
	});
});
