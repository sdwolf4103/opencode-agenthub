import { describe, expect, test } from "bun:test";

import { validateSkillFrontmatter } from "../src/composer/skill-frontmatter-validator.js";

const withFrontmatter = (frontmatter: string, body = "# Test Skill\n\nUseful content.") =>
	`---\n${frontmatter}\n---\n\n${body}`;

describe("validateSkillFrontmatter", () => {
	test("accepts a well-formed minimal skill", () => {
		const result = validateSkillFrontmatter(
			withFrontmatter('name: test-skill\ndescription: "Use when testing the validator"'),
		);

		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([]);
		expect(result.parsed?.name).toBe("test-skill");
		expect(result.parsed?.description).toBe("Use when testing the validator");
	});

	test("fails when frontmatter is missing", () => {
		const result = validateSkillFrontmatter("# No Frontmatter\n\nJust body content.");

		expect(result.valid).toBe(false);
		expect(result.errors.some((error) => error.toLowerCase().includes("frontmatter"))).toBe(true);
		expect(result.parsed).toBeNull();
	});

	test("fails on invalid array-like yaml syntax", () => {
		const result = validateSkillFrontmatter(
			withFrontmatter('name: broken-skill\ndescription: "Broken"\nallowed-tools: ["read",'),
		);

		expect(result.valid).toBe(false);
		expect(result.errors.some((error) => error.toLowerCase().includes("yaml") || error.toLowerCase().includes("array"))).toBe(true);
	});

	test("warns on unknown top-level keys", () => {
		const result = validateSkillFrontmatter(
			withFrontmatter(
				'name: test-skill\ndescription: "Use when checking unknown keys"\nstrange_key: true',
			),
		);

		expect(result.valid).toBe(true);
		expect(result.warnings.some((warning) => warning.includes("strange_key"))).toBe(true);
	});

	test("fails when name is missing", () => {
		const result = validateSkillFrontmatter(
			withFrontmatter('description: "Use when name is missing"'),
		);

		expect(result.valid).toBe(false);
		expect(result.errors.some((error) => error.includes("name"))).toBe(true);
	});

	test("fails when description is missing", () => {
		const result = validateSkillFrontmatter(withFrontmatter("name: missing-description"));

		expect(result.valid).toBe(false);
		expect(result.errors.some((error) => error.includes("description"))).toBe(true);
	});

	test("accepts known hub-local keys including nested metadata", () => {
		const result = validateSkillFrontmatter(
			withFrontmatter(
				[
					"name: full-skill",
					'description: "Use when exercising supported keys"',
					'when_to_use: "When building authoring skills"',
					'allowed-tools: ["read", "glob"]',
					'paths: "src/**/*.{ts,tsx}"',
					"context: fork",
					"model: github-copilot/gpt-5",
					"agent: plan",
					"effort: high",
					'version: "1.0"',
					'audience: "operators"',
					"license: MIT",
					'compatibility: "opencode >= 0.1"',
					"metadata:",
					"  domain: authoring",
					'  tier: "core"',
				].join("\n"),
			),
		);

		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	test("warns when the body has no markdown heading", () => {
		const result = validateSkillFrontmatter(
			withFrontmatter('name: no-heading\ndescription: "Use when checking body warnings"', "Just text, no heading."),
		);

		expect(result.valid).toBe(true);
		expect(result.warnings.some((warning) => warning.toLowerCase().includes("heading"))).toBe(true);
	});

	test("coerces numeric description to string", () => {
		const result = validateSkillFrontmatter(withFrontmatter("name: numeric-description\ndescription: 42"));

		expect(result.valid).toBe(true);
		expect(result.parsed?.description).toBe("42");
	});
});
