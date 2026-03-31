import readline from "node:readline/promises";

import {
	interactivePromptResetSequence,
	shouldUseReadlineTerminal,
	stripTerminalControlInput,
} from "./platform.js";

const normalizeOptional = (value: string): string | undefined => {
	const trimmed = value.trim();
	return trimmed || undefined;
};

const normalizeCsv = (value: string): string[] =>
	value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);

export const createPromptInterface = () => {
	const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
	const terminal = interactive && shouldUseReadlineTerminal();
	if (terminal) {
		const resetSequence = interactivePromptResetSequence();
		if (resetSequence) process.stdout.write(resetSequence);
	}
	return readline.createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal,
	});
};

const scriptedPromptAnswers = (() => {
	const raw = process.env.OPENCODE_AGENTHUB_SCRIPTED_ANSWERS;
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed)
			? parsed.map((value) => (typeof value === "string" ? value : String(value)))
			: undefined;
	} catch {
		return raw.split("\n");
	}
})();

let scriptedPromptIndex = 0;

export const askPrompt = async (rl: readline.Interface, question: string): Promise<string> => {
	if (scriptedPromptAnswers && scriptedPromptIndex < scriptedPromptAnswers.length) {
		const answer = scriptedPromptAnswers[scriptedPromptIndex++] || "";
		const sanitized = stripTerminalControlInput(answer);
		process.stdout.write(`${question}${sanitized}\n`);
		return sanitized;
	}
	return stripTerminalControlInput(await rl.question(question));
};

export const promptRequired = async (
	rl: readline.Interface,
	question: string,
	defaultValue?: string,
): Promise<string> => {
	while (true) {
		const answer = await askPrompt(
			rl,
			defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `,
		);
		const value = normalizeOptional(answer) || defaultValue;
		if (value) return value;
		process.stdout.write("This field is required.\n");
	}
};

export const promptOptional = async (
	rl: readline.Interface,
	question: string,
	defaultValue?: string,
): Promise<string | undefined> => {
	const answer = await askPrompt(
		rl,
		defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `,
	);
	return normalizeOptional(answer) || defaultValue;
};

export const promptCsv = async (
	rl: readline.Interface,
	question: string,
	defaultValues: string[] = [],
): Promise<string[]> => {
	const defaultValue = defaultValues.join(", ");
	const answer = await askPrompt(
		rl,
		defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `,
	);
	return normalizeCsv(answer || defaultValue);
};

export const promptBoolean = async (
	rl: readline.Interface,
	question: string,
	defaultValue: boolean,
): Promise<boolean> => {
	const suffix = defaultValue ? "[Y/n]" : "[y/N]";
	while (true) {
		const answer = (await askPrompt(rl, `${question} ${suffix}: `))
			.trim()
			.toLowerCase();
		if (!answer) return defaultValue;
		if (answer === "y" || answer === "yes") return true;
		if (answer === "n" || answer === "no") return false;
		process.stdout.write("Please answer y or n.\n");
	}
};

export const promptChoice = async <T extends string>(
	rl: readline.Interface,
	question: string,
	choices: readonly T[],
	defaultValue: T,
): Promise<T> => {
	const label = `${question} [${choices.join("/")}] (${defaultValue})`;
	while (true) {
		const answer = (await askPrompt(rl, `${label}: `)).trim().toLowerCase();
		if (!answer) return defaultValue;
		const match = choices.find((choice) => choice === answer);
		if (match) return match;
		process.stdout.write(`Choose one of: ${choices.join(", ")}\n`);
	}
};

export const promptIndexedChoice = async (
	rl: readline.Interface,
	question: string,
	choices: string[],
	defaultValue: string,
): Promise<string> => {
	choices.forEach((choice, index) => {
		process.stdout.write(`  ${index + 1}. ${choice}\n`);
	});
	const defaultIndex = Math.max(choices.indexOf(defaultValue), 0) + 1;
	while (true) {
		const answer = (await askPrompt(
			rl,
			`${question} [1-${choices.length}] (${defaultIndex}): `,
		))
			.trim()
			.toLowerCase();
		if (!answer) return defaultValue;
		const numeric = Number(answer);
		if (Number.isInteger(numeric) && numeric >= 1 && numeric <= choices.length) {
			return choices[numeric - 1] || defaultValue;
		}
		const exactMatch = choices.find((choice) => choice.toLowerCase() === answer);
		if (exactMatch) return exactMatch;
		process.stdout.write("Choose a listed number or exact model id.\n");
	}
};

export const promptOptionalCsvSelection = async (
	rl: readline.Interface,
	question: string,
	available: string[],
	defaultValues: string[] = [],
): Promise<string[]> => {
	const include = await promptBoolean(rl, question, false);
	if (!include) return [];
	if (available.length > 0) {
		process.stdout.write(`Available: ${available.join(", ")}\n`);
	}
	return promptCsv(rl, "Enter names (comma-separated)", defaultValues);
};
