import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
	buildBuiltinVersionManifest,
	getManagedCodingHrHubAssetSpecs,
} from "../src/composer/builtin-assets.js";
import { validateSkillFrontmatter } from "../src/composer/skill-frontmatter-validator.js";

const readRepoFile = (relativePath: string) =>
	readFile(path.join(process.cwd(), relativePath), "utf8");

const expectValidSkill = async (relativePath: string) => {
	const content = await readRepoFile(relativePath);
	const result = validateSkillFrontmatter(content);
	expect(result.valid).toBe(true);
	expect(result.errors).toEqual([]);
	return content;
};

describe("write-skill skill", () => {
	const skillPath = "src/skills/write-skill/SKILL.md";

	test("exists, validates, and documents frontmatter authoring", async () => {
		const content = await expectValidSkill(skillPath);
		expect(content).toContain("name: write-skill");
		expect(content).toContain("## Purpose");
		expect(content).toContain("## Workflow");
		expect(content).toContain("validateSkillFrontmatter");
		expect(content).toContain("when_to_use");
		expect(content).not.toContain("registerBundledSkill");
		expect(content).not.toContain("USER_TYPE");
	});
});

describe("write-agent skill", () => {
	const skillPath = "src/skills/write-agent/SKILL.md";

	test("exists, validates, and covers soul bundle profile authoring", async () => {
		const content = await expectValidSkill(skillPath);
		expect(content).toContain("name: write-agent");
		expect(content).toContain("## Purpose");
		expect(content).toContain("## Workflow");
		expect(content).toContain("soul");
		expect(content).toContain("bundle");
		expect(content).toContain("profile");
		expect(content).toContain("agenthub new soul");
		expect(content).toContain("agenthub new bundle");
		expect(content).toContain("agenthub new profile");
		expect(content).toContain("not itself a soul, agent class, or HR worker");
	});
});

describe("refine-hub-asset skill", () => {
	const skillPath = "src/skills/refine-hub-asset/SKILL.md";

	test("exists, validates, and explicitly asks for asset type", async () => {
		const content = await expectValidSkill(skillPath);
		expect(content).toContain("name: refine-hub-asset");
		expect(content).toContain("## Purpose");
		expect(content).toContain("## Workflow");
		expect(content).toContain("Which asset type are you editing?");
		expect(content).toContain("Soul");
		expect(content).toContain("Bundle");
		expect(content).toContain("Profile");
		expect(content).toContain("Instruction");
		expect(content).toContain("Skill");
		expect(content).toContain("validateSkillFrontmatter");
		expect(content).toContain("Create a backup");
		expect(content).toContain("destructive risk");
	});
});

describe("authoring lane built-ins", () => {
	test("authoring-lane guide exists and distinguishes HR from direct authoring", async () => {
		const content = await readRepoFile("src/composer/library/instructions/authoring-lane-guide.md");
		expect(content).toContain("write-skill");
		expect(content).toContain("write-agent");
		expect(content).toContain("refine-hub-asset");
		expect(content).toContain("HR");
		expect(content).toContain("authoring lane");
	});

	test("auto manifest includes authoring lane skills and guide", () => {
		const manifest = buildBuiltinVersionManifest("auto", "test-version");
		expect(manifest["skills/write-skill"]).toBe("test-version");
		expect(manifest["skills/write-agent"]).toBe("test-version");
		expect(manifest["skills/refine-hub-asset"]).toBe("test-version");
		expect(manifest["instructions/authoring-lane-guide.md"]).toBe("test-version");
	});

	test("hr-office manifest excludes authoring lane skills", () => {
		const manifest = buildBuiltinVersionManifest("hr-office", "test-version");
		expect(manifest["skills/write-skill"]).toBeUndefined();
		expect(manifest["skills/write-agent"]).toBeUndefined();
		expect(manifest["skills/refine-hub-asset"]).toBeUndefined();
	});

	test("auto managed asset specs include authoring lane skill directories", () => {
		const specs = getManagedCodingHrHubAssetSpecs("/tmp/agenthub-home", "auto");
		const manifestKeys = specs.map((spec) => spec.manifestKey);
		expect(manifestKeys).toContain("skills/write-skill");
		expect(manifestKeys).toContain("skills/write-agent");
		expect(manifestKeys).toContain("skills/refine-hub-asset");
		expect(manifestKeys).toContain("instructions/authoring-lane-guide.md");
	});
});
