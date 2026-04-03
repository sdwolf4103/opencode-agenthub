import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const readRepoFile = (relativePath: string) =>
	readFile(path.join(process.cwd(), relativePath), "utf8");

test("HR bootstrap defaults and HR Office guide include K-Dense scientific skills", async () => {
	const [bootstrap, hrOfficeGuide] = await Promise.all([
		readRepoFile("src/composer/bootstrap.ts"),
		readRepoFile("docs/hr-office.md"),
	]);

	expect(bootstrap).toContain('"K-Dense-AI/claude-scientific-skills"');
	expect(hrOfficeGuide).toContain("`K-Dense-AI/claude-scientific-skills`");
	expect(hrOfficeGuide).toContain("One good repo to add yourself if it matches your needs:");
	expect(hrOfficeGuide).not.toContain("Two good repos to add yourself if they match your needs:");
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

test("HR Office guide documents HR upgrade flow and staging-safe behavior", async () => {
	const hrOfficeGuide = await readRepoFile("docs/hr-office.md");

	expect(hrOfficeGuide).toContain("agenthub upgrade --target-root ~/.config/opencode-agenthub-hr");
	expect(hrOfficeGuide).toContain("staging/");
	expect(hrOfficeGuide).toContain("agenthub hr <profile>");
	expect(hrOfficeGuide).toContain("agenthub promote <package-id>");
});

test("README and runtime reference document runtime visibility and doctor guidance", async () => {
	const [readme, runtimeReference, changelog] = await Promise.all([
		readRepoFile("README.md"),
		readRepoFile("docs/runtime-reference.md"),
		readRepoFile("CHANGELOG.md"),
	]);

	expect(readme).toContain("agenthub status");
	expect(readme).toContain("agenthub doctor");
	expect(readme).toContain("doctor --category");
	expect(readme).toContain("docs/runtime-reference.md");
	expect(readme).not.toContain("localPlugins.bridge");
	expect(readme).not.toContain("omoBaseline");
	expect(runtimeReference).toContain("localPlugins.bridge");
	expect(runtimeReference).toContain("omoBaseline");
	expect(runtimeReference).toContain("docs/troubleshooting/");
	expect(changelog).toContain("runtime status visibility");
	expect(changelog).toContain("plugin and OMO runtime boundaries");
	expect(changelog).toContain("doctor troubleshooting guidance");
});

test("README command table and doctor skill guidance match current diagnostics workflow", async () => {
	const [readme, troubleshootingIndex, doctorSkill] = await Promise.all([
		readRepoFile("README.md"),
		readRepoFile("docs/troubleshooting/README.md"),
		readRepoFile("src/skills/agenthub-doctor/SKILL.md"),
	]);

	expect(readme).toContain("| `agenthub status` |");
	expect(readme).toContain("| `agenthub doctor --fix-all` |");
	expect(troubleshootingIndex).not.toContain("intentionally replaces a separate");
	expect(doctorSkill).toContain("agenthub start");
	expect(doctorSkill).not.toContain("opencode-agenthub run");
	expect(doctorSkill).toContain('"model": ""');
	expect(doctorSkill).not.toContain('"model": "github-copilot/claude-sonnet-4.5"');
});

test("README keeps HR prominent but moves detailed HR operations into a dedicated guide", async () => {
	const [readme, hrOfficeGuide] = await Promise.all([
		readRepoFile("README.md"),
		readRepoFile("docs/hr-office.md"),
	]);

	expect(readme).toContain("agenthub setup auto");
	expect(readme).toContain("agenthub start");
	expect(readme).toContain("agenthub status");
	expect(readme).toContain("agenthub doctor");
	expect(readme).toContain("docs/hr-office.md");
	expect(readme).not.toContain("control plane and CLI");
	expect(readme).not.toContain("## Two concepts to learn later");
	expect(readme).toContain("A *profile* is a team");
	expect(readme).not.toContain("### HR runtime details");
	expect(readme).not.toContain("### Default HR sources");
	expect(hrOfficeGuide).toContain("# HR Office");
	expect(hrOfficeGuide).toContain("## HR commands");
	expect(hrOfficeGuide).toContain("agenthub promote <package-id>");
});

test("README and HR Office guide present a runnable showcase HR team", async () => {
	const [readme, hrOfficeGuide, hrHomeReadme] = await Promise.all([
		readRepoFile("README.md"),
		readRepoFile("docs/hr-office.md"),
		readRepoFile("src/composer/library/hr-home/README.md"),
	]);

	expect(readme).toContain("agenthub hr demo-coding-team");
	expect(readme).toContain("demo-coding-team");
	expect(readme).toContain("agency-agents");
	expect(readme).toContain("obra/superpowers");
	expect(readme).toContain("lightweight vendored skill subset");
	expect(readme).toContain("anthropics/skills");
	expect(readme).toContain("agenthub promote demo-coding-team");
	expect(readme).toContain("promote the same demo into your Personal Home");
	expect(readme).not.toContain("garrytan/gstack");
	expect(hrOfficeGuide).toContain("## Try the demo team");
	expect(hrOfficeGuide).toContain("agenthub hr demo-coding-team");
	expect(hrOfficeGuide).toContain("agenthub promote demo-coding-team");
	expect(hrOfficeGuide).toContain("agency-agents");
	expect(hrOfficeGuide).toContain("obra/superpowers");
	expect(hrOfficeGuide).toContain("anthropics/skills");
	expect(hrOfficeGuide).toContain("lightweight vendored skill subset");
	expect(hrOfficeGuide).toContain("Try it in a repo, inspect it, then promote it");
	expect(hrHomeReadme).toContain("demo-coding-team");
	expect(hrHomeReadme).toContain("promote it with 'agenthub promote demo-coding-team'");
});

test("HR orchestration docs require synthesis and file-backed verifier handoff", async () => {
	const [hrSoul, hrProtocol, hrPlanner, hrCto, hrAdapter, hrVerifier] = await Promise.all([
		readRepoFile("src/composer/library/souls/hr.md"),
		readRepoFile("src/composer/library/instructions/hr-protocol.md"),
		readRepoFile("src/composer/library/souls/hr-planner.md"),
		readRepoFile("src/composer/library/souls/hr-cto.md"),
		readRepoFile("src/composer/library/souls/hr-adapter.md"),
		readRepoFile("src/composer/library/souls/hr-verifier.md"),
	]);

	expect(hrProtocol).toContain("Synthesize before dispatch");
	expect(hrProtocol).toContain('Never write "based on your findings"');
	expect(hrSoul).toContain("Before you ask `hr-verifier`");
	expect(hrSoul).toContain("concrete file artifact");
	expect(hrPlanner).toContain("deliverable is not complete until both `latest.json` and `latest.md` exist on disk");
	expect(hrCto).toContain("persist them to the declared output file before the parent seeks verification");
	expect(hrAdapter).toContain("If reviewable output exists only in chat, write it to a file first");
	expect(hrVerifier).toContain("refuse purely conversational verification requests");
});

test("demo coding team docs encode synthesis, file-artifact gating, and adversarial verification", async () => {
	const [deliveryLead, phaseVerifier, workerCard, promotionMemo, finalChecklist] =
		await Promise.all([
			readRepoFile(
				"src/composer/library/showcase/demo-coding-team/agenthub-home/souls/demo-coding-team-coding-delivery-lead.md",
			),
			readRepoFile(
				"src/composer/library/showcase/demo-coding-team/agenthub-home/souls/demo-coding-team-phase-verifier.md",
			),
			readRepoFile("src/composer/library/showcase/demo-coding-team/worker-card.json"),
			readRepoFile("src/composer/library/showcase/demo-coding-team/promotion-memo.md"),
			readRepoFile("src/composer/library/showcase/demo-coding-team/final-checklist.md"),
		]);

	expect(deliveryLead).toContain("## Orchestration Protocol");
	expect(deliveryLead).toContain("Synthesize before delegate");
	expect(deliveryLead).toContain(
		"Before dispatching `phase-verifier`, confirm there is a concrete file artifact",
	);
	expect(deliveryLead).toContain("Continue vs. spawn decision table");
	expect(phaseVerifier).toContain("reading is not verification");
	expect(phaseVerifier).toContain("at least one adversarial probe");
	expect(phaseVerifier).toContain("VERDICT: PASS");
	expect(workerCard).toContain("synthesize findings before delegating follow-up work");
	expect(promotionMemo).toContain("file-backed artifact");
	expect(finalChecklist).toContain(
		"Verifier handoff only happens after a concrete file artifact exists",
	);
});

test("demo coding team docs define subagent continuity and clear subagent bundle descriptions", async () => {
	const [deliveryLead, profile, architectBundle, frontendBundle, planBundle, exploreBundle, reviewerBundle, verifierBundle] =
		await Promise.all([
			readRepoFile(
				"src/composer/library/showcase/demo-coding-team/agenthub-home/souls/demo-coding-team-coding-delivery-lead.md",
			),
			readRepoFile(
				"src/composer/library/showcase/demo-coding-team/agenthub-home/profiles/demo-coding-team.json",
			),
			readRepoFile(
				"src/composer/library/showcase/demo-coding-team/agenthub-home/bundles/demo-coding-team-systems-architect.json",
			),
			readRepoFile(
				"src/composer/library/showcase/demo-coding-team/agenthub-home/bundles/demo-coding-team-frontend-consultant.json",
			),
			readRepoFile(
				"src/composer/library/showcase/demo-coding-team/agenthub-home/bundles/demo-coding-team-plan.json",
			),
			readRepoFile(
				"src/composer/library/showcase/demo-coding-team/agenthub-home/bundles/demo-coding-team-explore.json",
			),
			readRepoFile(
				"src/composer/library/showcase/demo-coding-team/agenthub-home/bundles/demo-coding-team-comprehensive-code-reviewer.json",
			),
			readRepoFile(
				"src/composer/library/showcase/demo-coding-team/agenthub-home/bundles/demo-coding-team-phase-verifier.json",
			),
		]);

	expect(deliveryLead).toContain("## Subagent Continuity Policy");
	expect(deliveryLead).toContain("Resume the existing session");
	expect(deliveryLead).toContain("Use whatever runtime primitive continues an existing subagent conversation");
	expect(profile).toContain('"demo-coding-team-plan"');
	expect(profile).not.toContain('"demo-coding-team-mcp-tooling-consultant"');
	expect(profile).toContain('"demo-coding-team-explore"');
	expect(profile).not.toContain('"demo-coding-team-explore-evidence-operator"');
	expect(architectBundle).toContain("Review architecture, ADRs, and tradeoffs");
	expect(architectBundle).toContain('"edit": "deny"');
	expect(architectBundle).toContain('"write": "deny"');
	expect(architectBundle).toContain('"bash": "deny"');
	expect(frontendBundle).toContain("Use this specialist for Next.js UI, frontend flows, and plugin interface design");
	expect(planBundle).toContain('"name": "demo-coding-team-plan"');
	expect(planBundle).toContain('"name": "plan"');
	expect(planBundle).toContain('"edit": "deny"');
	expect(planBundle).toContain('"write": "deny"');
	expect(planBundle).toContain('"bash": "deny"');
	expect(exploreBundle).toContain('"name": "demo-coding-team-explore"');
	expect(exploreBundle).toContain('"name": "explore"');
	expect(exploreBundle).toContain('"edit": "deny"');
	expect(exploreBundle).toContain('"write": "deny"');
	expect(exploreBundle).toContain('"bash": "deny"');
	expect(reviewerBundle).toContain("Use this reviewer before implementation for a second opinion or after implementation for an independent final review");
	expect(reviewerBundle).toContain('"edit": "deny"');
	expect(reviewerBundle).toContain('"write": "deny"');
	expect(reviewerBundle).toContain('"bash": "deny"');
	expect(verifierBundle).toContain("Use this verifier only after a concrete file-backed phase artifact exists");
	expect(verifierBundle).toContain('"edit": "deny"');
	expect(verifierBundle).toContain('"write": "deny"');
});

test("demo coding team inventory docs reflect the hardened role set", async () => {
	const [workerCard, promotionMemo, finalChecklist] = await Promise.all([
		readRepoFile("src/composer/library/showcase/demo-coding-team/worker-card.json"),
		readRepoFile("src/composer/library/showcase/demo-coding-team/promotion-memo.md"),
		readRepoFile("src/composer/library/showcase/demo-coding-team/final-checklist.md"),
	]);

	expect(workerCard).toContain('"id": "plan"');
	expect(workerCard).not.toContain('"id": "mcp-tooling-consultant"');
	expect(workerCard).toContain('"id": "explore"');
	expect(workerCard).not.toContain('"id": "explore-evidence-operator"');
	expect(promotionMemo).toContain("one primary delivery lead plus six subagents: plan");
	expect(promotionMemo).not.toContain("mcp-tooling-consultant");
	expect(finalChecklist).toContain("No MCP consultant bundle references remain.");
	expect(finalChecklist).toContain("Canonical explore naming is used throughout the package.");
});
