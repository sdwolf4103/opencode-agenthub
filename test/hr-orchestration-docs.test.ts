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

test("HR protocol moves default-profile choice to final staging and forbids model hallucination without catalog", async () => {
	const [hrSoul, hrProtocol, hrAdapter, hrBoundaries] = await Promise.all([
		readRepoFile("src/composer/library/souls/hr.md"),
		readRepoFile("src/composer/library/instructions/hr-protocol.md"),
		readRepoFile("src/composer/library/souls/hr-adapter.md"),
		readRepoFile("src/composer/library/instructions/hr-boundaries.md"),
	]);

	expect(hrSoul).not.toContain(
		"Also ask whether the promoted profile should become the default profile for future bare `agenthub start` runs.",
	);
	expect(hrSoul).toContain("whether the promoted profile will become the default personal profile");
	expect(hrProtocol).not.toContain("whether promote should set the new profile as the default personal profile");
	expect(hrProtocol).toContain("If the synced model catalog is empty or missing, do not invent model names");
	expect(hrAdapter).toContain("If the synced model catalog is empty or missing, do not write any `agent.model` value.");
	expect(hrBoundaries).toContain("no HR agent may propose, fill in, or confirm a concrete `provider/model` id");
});
