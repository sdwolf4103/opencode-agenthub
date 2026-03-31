import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";

import {
	defaultHrHome,
	hrHomeInitialized,
	installHrOfficeHomeWithOptions,
} from "./bootstrap.js";
import {
	createPromptInterface,
	promptBoolean,
	promptChoice,
	promptIndexedChoice,
	promptRequired,
} from "./cli-prompts.js";
import {
	validateModelAgainstCatalog,
	validateModelIdentifier,
} from "./model-utils.js";
import { resolvePythonCommand, spawnOptions } from "./platform.js";
import {
	hrAgentNames,
	listAvailableOpencodeModels,
	loadNativeOpenCodePreferences,
	mergeAgentHubSettingsDefaults,
	probeOpencodeModelAvailability,
	readAgentHubSettings,
	readHrKnownModelIds,
	recommendedHrBootstrapModel,
	resolveHrBootstrapAgentModels,
	validateHrAgentModelConfiguration,
	writeAgentHubSettings,
	type HrBootstrapModelSelection,
} from "./settings.js";

type FailFn = (message: string) => never;

export type HrModelCheckResult =
	| { ok: true; selection: HrBootstrapModelSelection }
	| {
			ok: false;
			selection: HrBootstrapModelSelection;
			stage: "syntax" | "catalog" | "availability" | "probe_failed";
			message: string;
	  };

export type HrBootstrapResourceAssessment = {
	configuredGithubSources: number | null;
	configuredModelCatalogSources: number | null;
	knownModels?: Set<string>;
	availableModels?: string[];
	freeModels: string[];
	nativeModel?: string;
	recommendedAvailability: Awaited<ReturnType<typeof probeOpencodeModelAvailability>>;
};

export type HrBootstrapRecommendation = {
	strategy: "recommended" | "free" | "custom" | "native";
	summary: string;
	reason: string;
};

const shouldUseInteractivePrompts = () =>
	process.env.OPENCODE_AGENTHUB_FORCE_INTERACTIVE_PROMPTS === "1" ||
	Boolean(process.stdin.isTTY && process.stdout.isTTY);

const listOpencodeFreeModels = async (): Promise<string[]> =>
	new Promise((resolve) => {
		const child = spawn("opencode", ["models", "opencode"], {
			stdio: ["ignore", "pipe", "ignore"],
			...spawnOptions(),
		});
		let stdout = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.on("error", () => resolve([]));
		child.on("close", () => {
			const models = stdout
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.startsWith("opencode/") && line.includes("free"));
			resolve([...new Set(models)].sort());
		});
	});

export const formatCountLabel = (
	count: number | null,
	singular: string,
	plural = `${singular}s`,
) => {
	if (count === null) return `unknown ${plural}`;
	return `${count} ${count === 1 ? singular : plural}`;
};

export const inspectHrBootstrapResources = async (
	hrRoot: string,
): Promise<HrBootstrapResourceAssessment> => {
	const [configuredGithubSources, configuredModelCatalogSources, knownModels, availableModels, freeModels, native] =
		await Promise.all([
			countConfiguredHrGithubSources(hrRoot),
			countConfiguredHrModelCatalogSources(hrRoot),
			readHrKnownModelIds(hrRoot),
			listAvailableOpencodeModels(),
			listOpencodeFreeModels(),
			loadNativeOpenCodePreferences(),
		]);
	const recommendedAvailability = await probeOpencodeModelAvailability(
		recommendedHrBootstrapModel,
		{ listModels: async () => availableModels },
	);
	return {
		configuredGithubSources,
		configuredModelCatalogSources,
		knownModels,
		availableModels,
		freeModels,
		nativeModel: native?.model,
		recommendedAvailability,
	};
};

export const recommendHrBootstrapSelection = (
	resources: HrBootstrapResourceAssessment,
): HrBootstrapRecommendation => {
	if (resources.recommendedAvailability.available) {
		return {
			strategy: "recommended",
			summary: `I recommend starting with the recommended HR model (${recommendedHrBootstrapModel}).`,
			reason: "It is available in this opencode environment and matches the built-in HR default.",
		};
	}
	if (resources.freeModels.length > 0) {
		return {
			strategy: "free",
			summary: "I recommend starting with the best available free HR model.",
			reason: `${resources.recommendedAvailability.message} A free fallback is available right now.`,
		};
	}
	const nativeModelSyntax = resources.nativeModel
		? validateModelIdentifier(resources.nativeModel)
		: undefined;
	if (resources.nativeModel && nativeModelSyntax?.ok) {
		return {
			strategy: "native",
			summary: `I recommend reusing your native default model (${resources.nativeModel}).`,
			reason: "No verified free fallback is visible, but your native opencode default looks usable.",
		};
	}
	return {
		strategy: "custom",
		summary: "I recommend entering a custom HR model now.",
		reason: "The recommended preset is not currently verified and no safer automatic fallback was found.",
	};
};

export const printHrBootstrapAssessment = (
	resources: HrBootstrapResourceAssessment,
	recommendation: HrBootstrapRecommendation,
) => {
	void resources;
	process.stdout.write(`\nRecommended setup:\n${recommendation.summary}\n\n`);
};

export const buildHrModelSelection = async (
	rl: readline.Interface,
	hrRoot: string,
	strategy: "recommended" | "free" | "custom" | "native",
): Promise<HrBootstrapModelSelection> => {
	if (strategy === "recommended") {
		process.stdout.write(
			`[agenthub] Recommended HR preset requires OpenAI model access in your opencode environment.\n`,
		);
		return {
			consoleModel: recommendedHrBootstrapModel,
			subagentStrategy: "recommended",
			sharedSubagentModel: recommendedHrBootstrapModel,
		};
	}
	if (strategy === "native") {
		const native = await loadNativeOpenCodePreferences();
		if (!native?.model) {
			process.stdout.write("[agenthub] No native default model is configured. Choose another fallback.\n");
			return buildHrModelSelection(rl, hrRoot, "free");
		}
		return {
			consoleModel: native.model,
			subagentStrategy: "native",
			sharedSubagentModel: native.model,
		};
	}
	if (strategy === "free") {
		const freeModels = await listOpencodeFreeModels();
		const fallbackFreeModel = freeModels.includes("opencode/minimax-m2.5-free")
			? "opencode/minimax-m2.5-free"
			: (freeModels[0] || "opencode/minimax-m2.5-free");
		const choices = freeModels.length > 0 ? freeModels : [fallbackFreeModel];
		process.stdout.write("Current opencode free models:\n");
		const selected =
			choices.length === 1
				? (process.stdout.write(`  1. ${choices[0]}\n`), choices[0])
				: await promptIndexedChoice(
						rl,
						"Choose a free model for HR",
						choices,
						fallbackFreeModel,
					);
		return {
			consoleModel: selected,
			subagentStrategy: "free",
			sharedSubagentModel: selected,
		};
	}
	const custom = await promptRequired(rl, "Custom HR model", recommendedHrBootstrapModel);
	return {
		consoleModel: custom,
		subagentStrategy: "custom",
		sharedSubagentModel: custom,
	};
};

export const checkHrBootstrapSelection = async (
	hrRoot: string,
	selection: HrBootstrapModelSelection,
): Promise<HrModelCheckResult> => {
	const model = selection.sharedSubagentModel || selection.consoleModel;
	if (!model) {
		return {
			ok: false,
			selection,
			stage: "syntax",
			message: "Model id cannot be blank.",
		};
	}
	const syntax = validateModelIdentifier(model);
	if (!syntax.ok) {
		return { ok: false, selection, stage: "syntax", message: syntax.message };
	}
	const knownModels = await readHrKnownModelIds(hrRoot);
	const catalog = validateModelAgainstCatalog(model, knownModels);
	if (!catalog.ok) {
		return { ok: false, selection, stage: "catalog", message: catalog.message };
	}
	const availability = await probeOpencodeModelAvailability(model, {
		listModels: listAvailableOpencodeModels,
	});
	if (!availability.available) {
		return {
			ok: false,
			selection,
			stage: availability.reason === "probe_failed" ? "probe_failed" : "availability",
			message: availability.message,
		};
	}
	return { ok: true, selection };
};

export const promptValidatedHrModelSelection = async (
	rl: readline.Interface,
	hrRoot: string,
	strategy: "recommended" | "free" | "custom" | "native",
): Promise<HrBootstrapModelSelection> => {
	let selection = await buildHrModelSelection(rl, hrRoot, strategy);
	while (true) {
		const check = await checkHrBootstrapSelection(hrRoot, selection);
		if (check.ok) return check.selection;
		process.stdout.write(`${check.message}\n`);
		if (check.stage === "syntax" && selection.subagentStrategy === "custom") {
			selection = await buildHrModelSelection(rl, hrRoot, "custom");
			continue;
		}
		const action = await promptChoice(
			rl,
			check.stage === "probe_failed"
				? "Model verification failed — continue or choose a fallback"
				: "Choose a fallback",
			(["continue", "free", "native", "custom", "retry recommended"] as const),
			check.stage === "probe_failed" ? "continue" : "free",
		);
		if (action === "continue") return selection;
		selection = await buildHrModelSelection(
			rl,
			hrRoot,
			action === "retry recommended" ? "recommended" : action,
		);
	}
};

export const promptHrBootstrapModelSelection = async (
	hrRoot: string,
): Promise<HrBootstrapModelSelection> => {
	const rl = createPromptInterface();
	try {
		process.stdout.write("\nFirst-time HR Office setup\n");
		const resources = await inspectHrBootstrapResources(hrRoot);
		const recommendation = recommendHrBootstrapSelection(resources);
		printHrBootstrapAssessment(resources, recommendation);
		while (true) {
			const action = await promptChoice(
				rl,
				"Apply this recommendation now",
				["accept", "recommended", "free", "native", "custom"] as const,
				"accept",
			);
			const strategy = action === "accept" ? recommendation.strategy : action;
			const validated = await promptValidatedHrModelSelection(rl, hrRoot, strategy);
			const finalModel = validated.sharedSubagentModel || validated.consoleModel;
			if (!finalModel) continue;
			const finalSyntax = validateModelIdentifier(finalModel);
			if (finalSyntax.ok) {
				return validated;
			}
		}
	} finally {
		rl.close();
	}
};

export const applyHrModelSelection = async (
	targetRoot: string,
	selection: HrBootstrapModelSelection,
) => {
	await installHrOfficeHomeWithOptions({
		hrRoot: targetRoot,
		hrModelSelection: selection,
	});
};

export const repairHrModelConfigurationIfNeeded = async (
	targetRoot: string,
	options: { fail: FailFn },
) => {
	const settings = await readAgentHubSettings(targetRoot);
	if (!shouldUseInteractivePrompts()) {
		for (const agentName of hrAgentNames) {
			const model = settings?.agents?.[agentName]?.model;
			if (typeof model !== "string" || model.trim().length === 0) continue;
			const syntax = validateModelIdentifier(model);
			if (!syntax.ok) {
				options.fail(
					`HR model configuration needs attention. Agent '${agentName}' model '${model}' is invalid: ${syntax.message}`,
				);
			}
		}
		return;
	}
	const status = await validateHrAgentModelConfiguration(targetRoot, settings);
	if (status.valid) return;
	const rl = createPromptInterface();
	try {
		process.stdout.write("[agenthub] HR model configuration needs attention.\n");
		if (status.message) process.stdout.write(`${status.message}\n`);
		const repair = await promptBoolean(rl, "Reconfigure HR models now?", true);
		if (!repair) {
			options.fail("Aborted before repairing invalid HR model configuration.");
		}
		const fallback = await promptChoice(
			rl,
			"Choose a fallback",
			["free", "native", "custom", "retry recommended"] as const,
			"free",
		);
		const validated = await promptValidatedHrModelSelection(
			rl,
			targetRoot,
			fallback === "retry recommended" ? "recommended" : fallback,
		);
		const resolved = await resolveHrBootstrapAgentModels({
			targetRoot,
			selection: validated,
		});
		const merged = mergeAgentHubSettingsDefaults(settings || {});
		merged.agents = merged.agents || {};
		for (const agentName of hrAgentNames) {
			const resolvedSelection = resolved.agentModels[agentName];
			merged.agents[agentName] = {
				...(merged.agents[agentName] || {}),
				model: resolvedSelection.model,
				...(resolvedSelection.variant ? { variant: resolvedSelection.variant } : {}),
			};
			if (!resolvedSelection.variant) delete merged.agents[agentName].variant;
		}
		merged.meta = {
			...merged.meta,
			onboarding: {
				...merged.meta?.onboarding,
				modelStrategy: resolved.strategy,
				mode: merged.meta?.onboarding?.mode || "hr-office",
				importedNativeBasics: merged.meta?.onboarding?.importedNativeBasics ?? true,
				importedNativeAgents: merged.meta?.onboarding?.importedNativeAgents ?? true,
				createdAt: merged.meta?.onboarding?.createdAt || new Date().toISOString(),
			},
		};
		await writeAgentHubSettings(targetRoot, merged);
		process.stdout.write("[agenthub] Updated HR model configuration.\n");
	} finally {
		rl.close();
	}
};

export const printHrModelOverrideHint = (cliCommand: string) => {
	process.stdout.write(`Tip: change HR models later with '${cliCommand} doctor'.\n`);
};

export const countConfiguredHrGithubSources = async (
	targetRoot: string,
): Promise<number | null> => {
	try {
		const raw = JSON.parse(
			await readFile(path.join(targetRoot, "hr-config.json"), "utf-8"),
		) as { sources?: unknown; github?: unknown };
		const githubSources: unknown[] = [];

		if (Array.isArray(raw.sources)) {
			githubSources.push(...raw.sources);
		} else if (raw.sources && typeof raw.sources === "object") {
			const nestedGithub = (raw.sources as { github?: unknown }).github;
			if (Array.isArray(nestedGithub)) githubSources.push(...nestedGithub);
		}

		if (Array.isArray(raw.github)) githubSources.push(...raw.github);
		return githubSources.length;
	} catch {
		return null;
	}
};

export const countConfiguredHrModelCatalogSources = async (
	targetRoot: string,
): Promise<number | null> => {
	try {
		const raw = JSON.parse(
			await readFile(path.join(targetRoot, "hr-config.json"), "utf-8"),
		) as { sources?: unknown; models?: unknown };
		const modelSources: unknown[] = [];

		if (raw.sources && typeof raw.sources === "object") {
			const nestedModels = (raw.sources as { models?: unknown }).models;
			if (Array.isArray(nestedModels)) modelSources.push(...nestedModels);
		}

		if (Array.isArray(raw.models)) modelSources.push(...raw.models);
		return modelSources.length;
	} catch {
		return null;
	}
};

export const syncHrSourceInventoryOnFirstRun = async (targetRoot: string) => {
	const configuredSourceCount = await countConfiguredHrGithubSources(targetRoot);
	const configuredModelSourceCount = await countConfiguredHrModelCatalogSources(targetRoot);
	const sourceParts: string[] = [];
	if (configuredSourceCount && configuredSourceCount > 0) {
		sourceParts.push(`${configuredSourceCount} GitHub repo${configuredSourceCount === 1 ? "" : "s"}`);
	}
	if (configuredModelSourceCount && configuredModelSourceCount > 0) {
		sourceParts.push(
			`${configuredModelSourceCount} model catalog${configuredModelSourceCount === 1 ? "" : "s"}`,
		);
	}
	const sourceLabel = sourceParts.length > 0 ? sourceParts.join(" + ") : "configured HR sources";
	process.stdout.write(
		`\nStep 3/3 · Sync inventory\nSync the HR sourcer inventory from ${sourceLabel} — this may take a moment, please wait...\n`,
	);

	try {
		const pythonCommand = resolvePythonCommand();
		const scriptPath = path.join(targetRoot, "bin", "sync_sources.py");
		const child = spawn(pythonCommand, [scriptPath], {
			cwd: targetRoot,
			env: {
				...process.env,
				OPENCODE_AGENTHUB_HR_HOME: targetRoot,
			},
			stdio: ["ignore", "pipe", "pipe"],
			...spawnOptions(),
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

		const summary = stdout.trim();
		if (code === 0) {
			void summary;
			const repoSummary = configuredSourceCount && configuredSourceCount > 0
				? `${configuredSourceCount} repo${configuredSourceCount === 1 ? "" : "s"}`
				: "configured sources";
			process.stdout.write(`✓ HR sourcer inventory sync complete (${repoSummary}).\n`);
			return;
		}

		process.stderr.write(
			`[agenthub] Warning: first-run HR source sync did not complete. Continue using HR and retry later with '${pythonCommand} ${scriptPath}'.\n`,
		);
		if (stderr.trim()) process.stderr.write(`${stderr.trim()}\n`);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		const pythonCommand = resolvePythonCommand();
		process.stderr.write(
			`[agenthub] Warning: failed to launch first-run HR source sync (${reason}). Retry later with '${pythonCommand} ${path.join(targetRoot, "bin", "sync_sources.py")}'.\n`,
		);
	}
};

export const ensureHrOfficeReadyOrBootstrap = async (
	targetRoot = defaultHrHome(),
	options: { syncSourcesOnFirstRun?: boolean; cliCommand: string } = { cliCommand: "agenthub" },
): Promise<boolean> => {
	if (await hrHomeInitialized(targetRoot)) return false;
	const shouldPrompt = shouldUseInteractivePrompts();
	process.stdout.write("\nHR Office — first-time setup\n\n");
	process.stdout.write(
		"Heads up: a full HR assemble can take about 20–30 minutes because AI may need time to choose and evaluate the souls and skills your agents need.\n\n",
	);
	process.stdout.write("This will:\n");
	process.stdout.write("1. Choose an AI model for HR agents\n");
	process.stdout.write("2. Create the HR Office workspace\n");
	if (options.syncSourcesOnFirstRun ?? true) {
		process.stdout.write("3. Sync the HR sourcer inventory (this may take a little longer)\n\n");
	} else {
		process.stdout.write("3. Skip inventory sync for now because you are assembling only\n\n");
	}
	const hrModelSelection = shouldPrompt
		? await promptHrBootstrapModelSelection(targetRoot)
		: undefined;
	await applyHrModelSelection(targetRoot, hrModelSelection || {});
	process.stdout.write(`\nStep 2/3 · Create workspace\n✓ First run — initialised HR Office at ${targetRoot}\n`);
	printHrModelOverrideHint(options.cliCommand);
	if (options.syncSourcesOnFirstRun ?? true) {
		await syncHrSourceInventoryOnFirstRun(targetRoot);
	}
	process.stdout.write("\n✓ HR Office is ready.\n");
	return true;
};
