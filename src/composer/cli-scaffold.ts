import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";

import { expandProfileAddSelections, listProfileAddCapabilityNames } from "./capabilities.js";
import {
	listBuiltInAssetNames,
	type BuiltInAssetKind,
} from "./builtin-assets.js";
import { readJsonIfExists } from "./cli-home.js";
import {
	askPrompt,
	createPromptInterface,
	promptBoolean,
	promptChoice,
	promptCsv,
	promptOptional,
	promptOptionalCsvSelection,
	promptRequired,
} from "./cli-prompts.js";

type AgentMode = "primary" | "subagent";
type Runtime = "native" | "omo";

type AgentConfig = {
	name: string;
	mode: AgentMode;
	hidden?: boolean;
	model: string;
	variant?: string;
	description?: string;
};

type BundleSpawnSpec = {
	strategy: "category-family";
	source: "categories";
	shared: {
		soul: string;
		skills: string[];
	};
};

export type BundleSpec = {
	name: string;
	runtime: Runtime;
	soul: string;
	instructions?: string[];
	skills: string[];
	mcp?: string[];
	guards?: string[];
	categories?: Record<string, string>;
	spawn?: BundleSpawnSpec;
	agent: AgentConfig;
};

export type ProfileSpec = {
	name: string;
	description?: string;
	bundles: string[];
	defaultAgent?: string;
	plugins: string[];
	nativeAgentPolicy?: "inherit" | "team-only" | "override";
	/** @deprecated Use nativeAgentPolicy instead. */
	inheritNativeAgents?: boolean;
};

export type ProfileCreateOptions = {
	fromProfile?: string;
	addBundles: string[];
	reservedOk: boolean;
};

export type FailFn = (message: string) => never;

export const normalizeCsv = (value: string): string[] =>
	value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);

export const uniqueValues = (values: string[]): string[] => [...new Set(values)];

export const normalizeOptional = (value: string): string | undefined => {
	const trimmed = value.trim();
	return trimmed || undefined;
};

export const toJsonFile = (root: string, directory: string, name: string): string =>
	path.join(root, directory, `${name}.json`);

export const listNamesByExt = async (dirPath: string, ext: string): Promise<string[]> => {
	try {
		const entries = await readdir(dirPath, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(ext))
			.map((entry) => entry.name.slice(0, -ext.length))
			.sort();
	} catch {
		return [];
	}
};

export const writeJsonFile = async <T>(filePath: string, payload: T) => {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
};

export const listSkillNames = async (skillsDir: string): Promise<string[]> => {
	try {
		const entries = await readdir(skillsDir, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
};

export const assertNameNotReserved = async (
	kind: BuiltInAssetKind,
	name: string,
	reservedOk: boolean,
	fail: FailFn,
) => {
	if (reservedOk) return;
	const builtIns = await listBuiltInAssetNames(kind);
	if (!builtIns.has(name)) return;
	fail(
		`'${name}' is a reserved built-in ${kind} name. Use a different name or pass '--reserved-ok' to override.`,
	);
};

const promptRecord = async (
	rl: readline.Interface,
	question: string,
	fail: FailFn,
): Promise<Record<string, string> | undefined> => {
	const answer = await askPrompt(
		rl,
		`${question} (comma-separated key=value, blank to skip): `,
	);
	const entries = normalizeCsv(answer);
	if (entries.length === 0) return undefined;

	const record: Record<string, string> = {};
	for (const entry of entries) {
		const separator = entry.indexOf("=");
		if (separator === -1) {
			fail(`Invalid entry '${entry}'. Use key=value format.`);
		}
		const key = entry.slice(0, separator).trim();
		const value = entry.slice(separator + 1).trim();
		if (!key || !value) {
			fail(`Invalid entry '${entry}'. Use key=value format.`);
		}
		record[key] = value;
	}
	return Object.keys(record).length > 0 ? record : undefined;
};

const maybeOverwrite = async (
	rl: readline.Interface,
	filePath: string,
	fail: FailFn,
): Promise<void> => {
	try {
		await readFile(filePath, "utf-8");
	} catch {
		return;
	}
	const overwrite = await promptBoolean(
		rl,
		`${path.basename(filePath)} already exists. Overwrite it?`,
		false,
	);
	if (!overwrite) {
		fail(`Aborted without changing ${filePath}`);
	}
};

export const createSoulDefinition = async (
	root: string,
	name: string,
	reservedOk = false,
	fail: FailFn,
): Promise<string> => {
	await assertNameNotReserved("soul", name, reservedOk, fail);
	const filePath = path.join(root, "souls", `${name}.md`);
	const rl = createPromptInterface();
	try {
		await maybeOverwrite(rl, filePath, fail);
		const content = [
			`# ${name}`,
			"",
			"## Description",
			"Describe this soul's purpose and when to use it.",
			"",
			"## Behavior",
			"- Primary goals",
			"- Constraints",
			"- Expected output style",
			"",
		].join("\n");
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, content, "utf-8");
		return filePath;
	} finally {
		rl.close();
	}
};

export const createInstructionDefinition = async (
	root: string,
	name: string,
	reservedOk = false,
	fail: FailFn,
): Promise<string> => {
	await assertNameNotReserved("instruction", name, reservedOk, fail);
	const filePath = path.join(root, "instructions", `${name}.md`);
	const rl = createPromptInterface();
	try {
		await maybeOverwrite(rl, filePath, fail);
		const content = [
			`# ${name}`,
			"",
			"## Purpose",
			"State the instruction this file adds to an agent.",
			"",
			"## Rules",
			"- Add concrete rules here",
			"",
		].join("\n");
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, content, "utf-8");
		return filePath;
	} finally {
		rl.close();
	}
};

export const createSkillDefinition = async (
	root: string,
	name: string,
	reservedOk = false,
	fail: FailFn,
): Promise<string> => {
	await assertNameNotReserved("skill", name, reservedOk, fail);
	const filePath = path.join(root, "skills", name, "SKILL.md");
	const rl = createPromptInterface();
	try {
		await maybeOverwrite(rl, filePath, fail);
		const content = [
			`# ${name}`,
			"",
			"## When to use",
			"Describe when this skill should be loaded.",
			"",
			"## Instructions",
			"- Add the concrete workflow here",
			"",
		].join("\n");
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, content, "utf-8");
		return filePath;
	} finally {
		rl.close();
	}
};

export const readProfileDefinition = async (
	root: string,
	name: string,
): Promise<ProfileSpec | undefined> =>
	readJsonIfExists<ProfileSpec>(path.join(root, "profiles", `${name}.json`));

export const createProfileDefinition = async (
	root: string,
	name: string,
	options: ProfileCreateOptions = { addBundles: [], reservedOk: false },
	fail: FailFn,
): Promise<string> => {
	await assertNameNotReserved("profile", name, options.reservedOk, fail);
	const filePath = toJsonFile(root, "profiles", name);
	const availableBundles = await listNamesByExt(path.join(root, "bundles"), ".json");
	const addCapabilities = listProfileAddCapabilityNames();
	const seededProfile = options.fromProfile
		? await readProfileDefinition(root, options.fromProfile)
		: undefined;
	if (options.fromProfile && !seededProfile) {
		const availableProfiles = await listNamesByExt(path.join(root, "profiles"), ".json");
		fail(
			`Profile '${options.fromProfile}' was not found. Available profiles: ${availableProfiles.join(", ") || "(none)"}`,
		);
	}
	const expandedAdds = expandProfileAddSelections(options.addBundles.filter(Boolean));
	const seededBundles = uniqueValues([
		...(seededProfile?.bundles || []),
		...expandedAdds,
	]);
	const invalidBundles = seededBundles.filter((bundle) => !availableBundles.includes(bundle));
	if (invalidBundles.length > 0) {
		fail(
			`Unknown bundle(s): ${invalidBundles.join(", ")}. Available bundles: ${availableBundles.join(", ") || "(none)"}. Capability shorthands: ${addCapabilities.join(", ") || "(none)"}`,
		);
	}
	const rl = createPromptInterface();
	try {
		await maybeOverwrite(rl, filePath, fail);
		if (availableBundles.length > 0) {
			process.stdout.write(`Available bundles: ${availableBundles.join(", ")}\n`);
		}
		if (addCapabilities.length > 0) {
			process.stdout.write(`Capability shorthands for --add: ${addCapabilities.join(", ")}\n`);
		}
		const description = await promptOptional(rl, "Profile description");
		const bundles = await promptCsv(rl, "Bundles to include", seededBundles);
		const defaultAgent = await promptOptional(
			rl,
			"Default agent (leave blank to let runtime decide)",
		);
		const plugins = await promptCsv(
			rl,
			"Plugins to enable (comma-separated package names or paths)",
			seededProfile?.plugins || [],
		);

		const payload: ProfileSpec = {
			name,
			bundles,
			plugins,
		};
		if (description) payload.description = description;
		if (defaultAgent) payload.defaultAgent = defaultAgent;

		await writeJsonFile(filePath, payload);
		return filePath;
	} finally {
		rl.close();
	}
};

export const createBundleDefinition = async (
	root: string,
	name: string,
	reservedOk = false,
	fail: FailFn,
): Promise<string> => {
	await assertNameNotReserved("bundle", name, reservedOk, fail);
	const filePath = toJsonFile(root, "bundles", name);
	const availableSouls = await listNamesByExt(path.join(root, "souls"), ".md");
	const availableInstructions = await listNamesByExt(path.join(root, "instructions"), ".md");
	const availableSkills = await listSkillNames(path.join(root, "skills"));
	const availableMcp = await listNamesByExt(path.join(root, "mcp"), ".json");
	const rl = createPromptInterface();
	try {
		await maybeOverwrite(rl, filePath, fail);
		if (availableSouls.length > 0) {
			process.stdout.write(`Available souls: ${availableSouls.join(", ")}\n`);
		}
		if (availableInstructions.length > 0) {
			process.stdout.write(`Available instructions: ${availableInstructions.join(", ")}\n`);
		}
		if (availableSkills.length > 0) {
			process.stdout.write(`Available skills: ${availableSkills.join(", ")}\n`);
		}
		const runtime = await promptChoice(rl, "Runtime", ["native", "omo"], "native");
		const readOnly =
			runtime === "native"
				? await promptBoolean(
						rl,
						"Read-only agent? (Y = plan-like, N = build-like)",
						true,
					)
				: false;
		const soul = await promptRequired(rl, "Soul name", availableSouls[0]);
		const instructions = await promptOptionalCsvSelection(
			rl,
			"Attach instructions from instructions/?",
			availableInstructions,
		);
		const skills = await promptOptionalCsvSelection(
			rl,
			"Attach skills from skills/?",
			availableSkills,
		);
		const mcp = await promptOptionalCsvSelection(
			rl,
			"Attach custom MCP tools? (basic opencode tools stay available)",
			availableMcp,
		);
		const guards = await promptCsv(rl, "Extra guards (comma-separated)");
		const categories =
			runtime === "omo"
				? await promptRecord(rl, "Category model mapping", fail)
				: undefined;
		const agentName = await promptRequired(rl, "Agent name", name);
		const agentMode = await promptChoice(rl, "Agent mode", ["primary", "subagent"], "primary");
		const hidden = await promptBoolean(rl, "Hide this agent from normal listings?", false);
		const model = await promptRequired(rl, "Agent model");
		const description = await promptOptional(rl, "Agent description");

		const payload: BundleSpec = {
			name,
			runtime,
			soul,
			...(instructions.length > 0 ? { instructions } : {}),
			skills,
			agent: {
				name: agentName,
				mode: agentMode,
				hidden,
				model,
			},
		};
		if (readOnly) {
			payload.guards = uniqueValues([...(payload.guards || []), "no_task"]);
		}
		if (mcp.length > 0) payload.mcp = mcp;
		if (guards.length > 0) {
			payload.guards = uniqueValues([...(payload.guards || []), ...guards]);
		}
		if (description) payload.agent.description = description;
		if (categories && Object.keys(categories).length > 0) {
			payload.categories = categories;
			const enableSpawn = await promptBoolean(
				rl,
				"Generate category-family spawn config from those categories?",
				true,
			);
			if (enableSpawn) {
				payload.spawn = {
					strategy: "category-family",
					source: "categories",
					shared: {
						soul,
						skills,
					},
				};
			}
		}

		await writeJsonFile(filePath, payload);
		return filePath;
	} finally {
		rl.close();
	}
};
