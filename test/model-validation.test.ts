import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
	hrPrimaryAgentName,
	hrSubagentNames,
	probeOpencodeModelAvailability,
	readHrKnownModelIds,
	validateHrAgentModelConfiguration,
	writeAgentHubSettings,
} from "../src/composer/settings.js";
import { runDiagnostics } from "../src/skills/agenthub-doctor/diagnose.js";
import { updateAgentModelOverride } from "../src/skills/agenthub-doctor/interactive.js";

test("readHrKnownModelIds loads synced HR model ids when present", async () => {
	const hrRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-model-catalog-"));
	try {
		await mkdir(path.join(hrRoot, "inventory", "models"), { recursive: true });
		await writeFile(
			path.join(hrRoot, "inventory", "models", "valid-model-ids.txt"),
			"openai/gpt-5.4-mini\nopencode/minimax-m2.5-free\n",
			"utf8",
		);
		const known = await readHrKnownModelIds(hrRoot);
		expect(known?.has("openai/gpt-5.4-mini")).toBe(true);
		expect(known?.has("opencode/minimax-m2.5-free")).toBe(true);
	} finally {
		await rm(hrRoot, { recursive: true, force: true });
	}
});

test("probeOpencodeModelAvailability distinguishes listed and missing models", async () => {
	const available = await probeOpencodeModelAvailability("openai/gpt-5.4-mini", {
		listModels: async () => ["openai/gpt-5.4-mini", "opencode/minimax-m2.5-free"],
	});
	expect(available).toEqual({ available: true });

	const missing = await probeOpencodeModelAvailability("openai/gpt-5.4-mini", {
		listModels: async () => ["opencode/minimax-m2.5-free"],
	});
	expect(missing).toEqual({
		available: false,
		reason: "unavailable",
		message: "Model 'openai/gpt-5.4-mini' is not available in the current opencode environment.",
	});

	const unknown = await probeOpencodeModelAvailability("openai/gpt-5.4-mini", {
		listModels: async () => undefined,
	});
	expect(unknown).toEqual({
		available: false,
		reason: "probe_failed",
		message:
			"Unable to verify model availability from opencode. Continue only if you know this model works in your environment.",
	});
});

test("doctor model updates reject invalid HR custom model ids", async () => {
	const hrRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-doctor-invalid-model-"));
	try {
		await mkdir(path.join(hrRoot, "profiles"), { recursive: true });
		await mkdir(path.join(hrRoot, "bundles"), { recursive: true });
		await writeFile(path.join(hrRoot, "hr-config.json"), "{}\n", "utf8");
		await writeAgentHubSettings(hrRoot, {
			agents: {
				[hrPrimaryAgentName]: { model: "openai/gpt-5.4-mini" },
				...Object.fromEntries(hrSubagentNames.map((name) => [name, { model: "openai/gpt-5.4-mini" }])),
			},
			meta: {
				onboarding: {
					mode: "hr-office",
					modelStrategy: "recommended",
					importedNativeBasics: true,
					importedNativeAgents: true,
					createdAt: new Date().toISOString(),
				},
			},
		});

		const message = await updateAgentModelOverride(hrRoot, "hr", "badmodel");
		expect(message).toContain("Model id must use provider/model format.");

		const settings = JSON.parse(await readFile(path.join(hrRoot, "settings.json"), "utf8"));
		expect(settings.agents.hr.model).toBe("openai/gpt-5.4-mini");
	} finally {
		await rm(hrRoot, { recursive: true, force: true });
	}
});

test("diagnostics report invalid model syntax in settings overrides", async () => {
	const hrRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-model-diagnostic-"));
	try {
		await mkdir(path.join(hrRoot, "profiles"), { recursive: true });
		await mkdir(path.join(hrRoot, "bundles"), { recursive: true });
		await writeAgentHubSettings(hrRoot, {
			agents: { hr: { model: "badmodel" } },
			meta: {
				onboarding: {
					mode: "hr-office",
					modelStrategy: "custom",
					importedNativeBasics: true,
					importedNativeAgents: true,
					createdAt: new Date().toISOString(),
				},
			},
		});

		const report = await runDiagnostics(hrRoot);
		expect(report.issues.some((issue) => issue.type === "model_invalid_syntax")).toBe(true);
	} finally {
		await rm(hrRoot, { recursive: true, force: true });
	}
});

test("validateHrAgentModelConfiguration does not fail valid models when availability probe is inconclusive", async () => {
	const hrRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-model-probe-failed-"));
	try {
		await mkdir(path.join(hrRoot, "profiles"), { recursive: true });
		await mkdir(path.join(hrRoot, "bundles"), { recursive: true });
		await writeAgentHubSettings(hrRoot, {
			agents: {
				[hrPrimaryAgentName]: { model: "openai/gpt-5.4-mini" },
				...Object.fromEntries(hrSubagentNames.map((name) => [name, { model: "openai/gpt-5.4-mini" }])),
			},
			meta: {
				onboarding: {
					mode: "hr-office",
					modelStrategy: "recommended",
					importedNativeBasics: true,
					importedNativeAgents: true,
					createdAt: new Date().toISOString(),
				},
			},
		});

		const status = await validateHrAgentModelConfiguration(hrRoot, undefined, {
			listModels: async () => undefined,
		});

		expect(status.valid).toBe(true);
	} finally {
		await rm(hrRoot, { recursive: true, force: true });
	}
});

test("diagnostics report active global OMO baseline and disabled local plugin bridge", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-phaseb-diagnostics-"));
	const originalHome = process.env.HOME;
	try {
		const homeDir = path.join(tempRoot, "home");
		const targetRoot = path.join(tempRoot, "agenthub-home");
		const globalOmoDir = path.join(homeDir, ".config", "opencode");
		const globalPluginDir = path.join(globalOmoDir, "plugins");
		await Promise.all([
			mkdir(path.join(targetRoot, "profiles"), { recursive: true }),
			mkdir(path.join(targetRoot, "bundles"), { recursive: true }),
			mkdir(path.join(targetRoot, "souls"), { recursive: true }),
			mkdir(globalPluginDir, { recursive: true }),
		]);
		process.env.HOME = homeDir;

		await writeAgentHubSettings(targetRoot, {
			localPlugins: { bridge: false },
			omoBaseline: "inherit",
			guards: {
				read_only: { description: "ro" },
				no_task: { description: "nt" },
				no_omo: { description: "no omo" },
			},
			meta: {
				onboarding: {
					mode: "auto",
					importedNativeBasics: true,
					importedNativeAgents: true,
					createdAt: new Date().toISOString(),
				},
			},
		});
		await writeFile(
			path.join(globalOmoDir, "oh-my-opencode.json"),
			`${JSON.stringify({ categories: { review: { model: "github-copilot/gpt-5.4" } } }, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(globalPluginDir, "sample.ts"),
			"export const Sample = async () => ({})\n",
			"utf8",
		);
		await writeFile(path.join(targetRoot, "souls", "auto.md"), "# auto\n", "utf8");
		await writeFile(
			path.join(targetRoot, "bundles", "auto.json"),
			`${JSON.stringify({
				name: "auto",
				runtime: "native",
				soul: "auto",
				skills: [],
				agent: {
					name: "auto",
					mode: "primary",
					model: "github-copilot/gpt-5.4",
				},
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(targetRoot, "profiles", "auto.json"),
			`${JSON.stringify({
				name: "auto",
				bundles: ["auto"],
				defaultAgent: "auto",
				plugins: ["opencode-agenthub"],
			}, null, 2)}\n`,
			"utf8",
		);

		const report = await runDiagnostics(targetRoot);
		expect(report.issues.some((issue) => issue.type === "local_plugins_not_bridged")).toBe(true);
		expect(report.issues.some((issue) => issue.type === "omo_baseline_active")).toBe(true);
	} finally {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		await rm(tempRoot, { recursive: true, force: true });
	}
});
