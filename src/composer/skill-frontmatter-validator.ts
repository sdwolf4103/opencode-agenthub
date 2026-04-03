export type SkillFrontmatter = Record<string, unknown> & {
	name?: string;
	description?: string;
};

export type SkillFrontmatterValidationResult = {
	valid: boolean;
	errors: string[];
	warnings: string[];
	parsed: SkillFrontmatter | null;
};

const allowedTopLevelKeys = new Set([
	"name",
	"description",
	"when_to_use",
	"allowed-tools",
	"paths",
	"context",
	"model",
	"agent",
	"effort",
	"hooks",
	"shell",
	"arguments",
	"argument-hint",
	"version",
	"audience",
	"license",
	"compatibility",
	"metadata",
]);

const frontmatterPattern = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;
const headingPattern = /^#{1,6}\s+\S/m;
const numericPattern = /^-?\d+(?:\.\d+)?$/;

const parseScalar = (value: string): unknown => {
	const trimmed = value.trim();
	if (trimmed === "") return "";
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	if (trimmed === "null") return null;
	if (trimmed.startsWith("[")) {
		if (!trimmed.endsWith("]")) {
			throw new Error(`Invalid YAML array syntax: ${trimmed}`);
		}
		const inner = trimmed.slice(1, -1).trim();
		if (!inner) return [];
		return inner.split(",").map((item) => parseScalar(item.trim()));
	}
	if (numericPattern.test(trimmed)) {
		return Number(trimmed);
	}
	return trimmed;
};

const nextMeaningfulLine = (lines: string[], start: number) => {
	for (let index = start; index < lines.length; index += 1) {
		const candidate = lines[index];
		if (candidate.trim() === "" || candidate.trimStart().startsWith("#")) continue;
		return candidate;
	}
	return null;
};

const parseYamlFrontmatter = (raw: string): SkillFrontmatter => {
	const root: SkillFrontmatter = {};
	const stack: Array<{ indent: number; object: Record<string, unknown> }> = [
		{ indent: -1, object: root },
	];
	const lines = raw.split(/\r?\n/);

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
		if (line.includes("\t")) {
			throw new Error(`Invalid YAML indentation on line ${index + 1}: tabs are not supported`);
		}

		const indent = line.match(/^\s*/)?.[0].length ?? 0;
		if (indent % 2 !== 0) {
			throw new Error(`Invalid YAML indentation on line ${index + 1}`);
		}

		while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
			stack.pop();
		}

		const current = stack[stack.length - 1];
		if (indent > current.indent + 2) {
			throw new Error(`Invalid YAML indentation jump on line ${index + 1}`);
		}

		const trimmed = line.trim();
		const separatorIndex = trimmed.indexOf(":");
		if (separatorIndex <= 0) {
			throw new Error(`Invalid YAML entry on line ${index + 1}: ${trimmed}`);
		}

		const key = trimmed.slice(0, separatorIndex).trim();
		const remainder = trimmed.slice(separatorIndex + 1).trim();
		if (!key) {
			throw new Error(`Invalid YAML key on line ${index + 1}`);
		}

		if (remainder) {
			current.object[key] = parseScalar(remainder);
			continue;
		}

		const nextLine = nextMeaningfulLine(lines, index + 1);
		const nextIndent = nextLine?.match(/^\s*/)?.[0].length ?? -1;
		if (!nextLine || nextIndent <= indent) {
			current.object[key] = null;
			continue;
		}

		const nested: Record<string, unknown> = {};
		current.object[key] = nested;
		stack.push({ indent, object: nested });
	}

	return root;
};

export const validateSkillFrontmatter = (
	contents: string,
): SkillFrontmatterValidationResult => {
	const errors: string[] = [];
	const warnings: string[] = [];
	const match = contents.match(frontmatterPattern);

	if (!match) {
		return {
			valid: false,
			errors: ["Missing YAML frontmatter block at start of SKILL.md."],
			warnings,
			parsed: null,
		};
	}

	let parsed: SkillFrontmatter;
	try {
		parsed = parseYamlFrontmatter(match[1]);
	} catch (error) {
		return {
			valid: false,
			errors: [error instanceof Error ? error.message : "Invalid YAML frontmatter."],
			warnings,
			parsed: null,
		};
	}

	for (const key of Object.keys(parsed)) {
		if (!allowedTopLevelKeys.has(key)) {
			warnings.push(`Unknown frontmatter key: ${key}`);
		}
	}

	if (parsed.name === undefined || parsed.name === null || String(parsed.name).trim() === "") {
		errors.push("Missing required frontmatter key: name");
	} else {
		parsed.name = String(parsed.name).trim();
	}

	if (
		parsed.description === undefined ||
		parsed.description === null ||
		String(parsed.description).trim() === ""
	) {
		errors.push("Missing required frontmatter key: description");
	} else {
		parsed.description = String(parsed.description).trim();
	}

	const body = match[2].trim();
	if (!headingPattern.test(body)) {
		warnings.push("Skill body should include at least one markdown heading.");
	}

	return {
		valid: errors.length === 0,
		errors,
		warnings,
		parsed,
	};
};
