import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const readRepoFile = (relativePath: string) =>
	readFile(path.join(process.cwd(), relativePath), "utf8");

test("HR requirements guidance focuses on use cases and defers AI model collection", async () => {
	const [hrSoul, hrProtocol] = await Promise.all([
		readRepoFile("src/composer/library/souls/hr.md"),
		readRepoFile("src/composer/library/instructions/hr-protocol.md"),
	]);

	expect(hrSoul).toContain("primary use cases or scenarios");
	expect(hrSoul).not.toContain("`model-prefs:`");
	expect(hrProtocol).not.toContain("AI model preferences");
	expect(hrProtocol).toContain("Do not turn Stage 1 into a fixed intake questionnaire.");
	expect(hrProtocol).toContain("Before staging begins, you must explicitly confirm the AI model choice");
});

test("HR planner and assembly guidance defer model decisions until assembly", async () => {
	const [plannerSoul, ctoSoul, staffingSkill, assemblySkill, finalCheckSkill] =
		await Promise.all([
			readRepoFile("src/composer/library/souls/hr-planner.md"),
			readRepoFile("src/composer/library/souls/hr-cto.md"),
			readRepoFile("src/skills/hr-staffing/SKILL.md"),
			readRepoFile("src/skills/hr-assembly/SKILL.md"),
			readRepoFile("src/skills/hr-final-check/SKILL.md"),
		]);

	expect(plannerSoul).not.toContain("model preferences already confirmed by the user");
	expect(ctoSoul).not.toContain("any model preferences supplied by the user");
	expect(staffingSkill).not.toContain("suggested_model_provider");
	expect(staffingSkill).not.toContain("proposed_agent_models");
	expect(assemblySkill).toContain(
		"If AI models are still unresolved when final assembly begins",
	);
	expect(finalCheckSkill).toContain("model preferences were confirmed before assembly");
});
