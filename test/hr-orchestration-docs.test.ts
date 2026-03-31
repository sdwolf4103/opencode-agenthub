import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const readRepoFile = (relativePath: string) =>
	readFile(path.join(process.cwd(), relativePath), "utf8");

test("HR bootstrap defaults and README include K-Dense scientific skills", async () => {
	const [bootstrap, readme] = await Promise.all([
		readRepoFile("src/composer/bootstrap.ts"),
		readRepoFile("README.md"),
	]);

	expect(bootstrap).toContain('"K-Dense-AI/claude-scientific-skills"');
	expect(readme).toContain("`K-Dense-AI/claude-scientific-skills`");
	expect(readme).toContain("One good repo to add yourself if it matches your needs:");
	expect(readme).not.toContain("Two good repos to add yourself if they match your needs:");
});

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

test("HR prompt docs do not proactively ask about default-profile and use opencode environment for model confirmation", async () => {
	const [hrSoul, hrProtocol, hrAdapter, hrBoundaries] = await Promise.all([
		readRepoFile("src/composer/library/souls/hr.md"),
		readRepoFile("src/composer/library/instructions/hr-protocol.md"),
		readRepoFile("src/composer/library/souls/hr-adapter.md"),
		readRepoFile("src/composer/library/instructions/hr-boundaries.md"),
	]);

	// HR must not ask about default-profile
	expect(hrSoul).not.toContain(
		"Also ask whether the promoted profile should become the default personal profile",
	);
	expect(hrSoul).not.toContain("whether the promoted profile will become the default personal profile");

	// Model confirmation uses opencode environment, not synced catalog
	expect(hrSoul).not.toContain("Read the synced catalog at");
	expect(hrSoul).toContain("opencode environment");
	expect(hrProtocol).not.toContain("synced catalog contains verified entries");
	expect(hrProtocol).toContain("opencode environment");
	expect(hrAdapter).not.toContain("synced catalog at `$HR_HOME/inventory/models/catalog.json`");
	expect(hrAdapter).toContain("opencode environment");
	expect(hrBoundaries).toContain("opencode environment availability probing");
	expect(hrBoundaries).not.toContain("<pending-catalog-sync>");
});

test("HR composition rules require a visible primary agent and prefer pure soul plus skill hosts", async () => {
	const [hrSoul, hrCto, hrAssembly, hrFinalCheck, hrStaffing] = await Promise.all([
		readRepoFile("src/composer/library/souls/hr.md"),
		readRepoFile("src/composer/library/souls/hr-cto.md"),
		readRepoFile("src/skills/hr-assembly/SKILL.md"),
		readRepoFile("src/skills/hr-final-check/SKILL.md"),
		readRepoFile("src/skills/hr-staffing/SKILL.md"),
	]);

	expect(hrSoul).toContain("Every assembled team must include at least one agent with `deployment_role: primary-capable`");
	expect(hrCto).toContain("Does the team have at least one primary-capable agent?");
	expect(hrAssembly).toContain("MUST verify the staged bundle set includes at least one `agent.mode: \"primary\"` agent that is not hidden");
	expect(hrFinalCheck).toContain("team includes at least one primary, non-hidden agent");
	expect(hrStaffing).toContain("At least one staffing-plan entry must have `deployment_role: primary-capable`.");
	expect(hrStaffing).toContain("prefer a pure-soul agent with attached skills over a mixed soul+skill agent");
});

test("HR large-team guidance recommends one to two primary agents with subagents", async () => {
	const [hrSoul, hrCto, hrStaffing] = await Promise.all([
		readRepoFile("src/composer/library/souls/hr.md"),
		readRepoFile("src/composer/library/souls/hr-cto.md"),
		readRepoFile("src/skills/hr-staffing/SKILL.md"),
	]);

	expect(hrStaffing).toContain("team_size_advisory");
	expect(hrStaffing).toContain("one to two primary agents");
	expect(hrSoul).toContain("If the staffing plan recommends more than four agents");
	expect(hrSoul).toContain("one to two primary agents with the rest deployed as subagents");
	expect(hrCto).toContain("If more than four agents are recommended");
	expect(hrCto).toContain("one to two primary agents with the rest as subagents");
});

test("HR model confirmation docs consistently reference opencode environment probing", async () => {
	const [hrCto, assemblySkill, finalCheckSkill, staffingSkill] = await Promise.all([
		readRepoFile("src/composer/library/souls/hr-cto.md"),
		readRepoFile("src/skills/hr-assembly/SKILL.md"),
		readRepoFile("src/skills/hr-final-check/SKILL.md"),
		readRepoFile("src/skills/hr-staffing/SKILL.md"),
	]);

	expect(hrCto).not.toContain("synced model catalog if present at");
	expect(hrCto).toContain("opencode environment");
	expect(assemblySkill).toContain("opencode environment availability probing");
	expect(finalCheckSkill).toContain("opencode environment");
	expect(finalCheckSkill).not.toContain("validated against synced catalog");
	expect(staffingSkill).not.toContain("checked against `$HR_HOME/inventory/models/catalog.json`");
	expect(staffingSkill).toContain("Model confirmation happens during staging");
});

test("HR prompt docs do not proactively ask about promote or default-profile preferences", async () => {
	const [hrSoul, assemblySkill] = await Promise.all([
		readRepoFile("src/composer/library/souls/hr.md"),
		readRepoFile("src/skills/hr-assembly/SKILL.md"),
	]);

	expect(hrSoul).not.toContain("Also ask whether the promoted profile should become");
	expect(assemblySkill).not.toContain(
		"confirm whether the promoted profile should become the default personal profile",
	);
	expect(hrSoul).toContain("PROMOTE");
	expect(hrSoul).toContain("agenthub promote");
});

test("HR model fallback docs use non-argumentative blank-model approach", async () => {
	const [hrSoul, hrProtocol, hrAdapter] = await Promise.all([
		readRepoFile("src/composer/library/souls/hr.md"),
		readRepoFile("src/composer/library/instructions/hr-protocol.md"),
		readRepoFile("src/composer/library/souls/hr-adapter.md"),
	]);

	for (const doc of [hrSoul, hrProtocol, hrAdapter]) {
		expect(doc).not.toContain("model assembly is blocked");
		expect(doc).not.toContain("Ask the user to provide an exact verified");
	}

	expect(hrAdapter).toContain("do not argue");
	expect(hrAdapter).toContain("agenthub doctor");
	expect(hrSoul).toContain("do not argue");
	expect(hrProtocol).toContain("do not argue");
	expect(hrProtocol).toContain("agenthub doctor");
});

test("HR hide/team-only guidance auto-adds hidden explore coverage without another user prompt", async () => {
	const [hrSoul, hrAssembly] = await Promise.all([
		readRepoFile("src/composer/library/souls/hr.md"),
		readRepoFile("src/skills/hr-assembly/SKILL.md"),
	]);

	expect(hrSoul).toContain("If the user wants to hide native agents and no explore-like coverage exists, automatically add a hidden explore subagent");
	expect(hrAssembly).toContain("If `nativeAgentPolicy` is `team-only` and the staged bundle set does not already provide `explore`, automatically include the built-in hidden `explore` subagent");
});

test("README documents HR upgrade flow and staging-safe behavior", async () => {
	const readme = await readRepoFile("README.md");

	expect(readme).toContain("agenthub upgrade --target-root ~/.config/opencode-agenthub-hr");
	expect(readme).toContain("staging/");
	expect(readme).toContain("agenthub hr <profile>");
	expect(readme).toContain("agenthub promote <package-id>");
});

test("README and changelog document runtime visibility and doctor guidance", async () => {
	const [readme, changelog] = await Promise.all([
		readRepoFile("README.md"),
		readRepoFile("CHANGELOG.md"),
	]);

	expect(readme).toContain("agenthub status");
	expect(readme).toContain("agenthub doctor");
	expect(readme).toContain("doctor --category");
	expect(readme).toContain("localPlugins.bridge");
	expect(readme).toContain("omoBaseline");
	expect(readme).toContain("docs/troubleshooting/");
	expect(changelog).toContain("runtime status visibility");
	expect(changelog).toContain("plugin and OMO runtime boundaries");
	expect(changelog).toContain("doctor troubleshooting guidance");
});
