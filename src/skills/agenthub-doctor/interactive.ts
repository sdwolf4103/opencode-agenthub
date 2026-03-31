import readline from "node:readline/promises";
import { readdir } from "node:fs/promises";
import path from "node:path";
import {
	loadNativeOpenCodeConfig,
	probeOpencodeModelAvailability,
	readHrKnownModelIds,
	readAgentHubSettings,
	writeAgentHubSettings,
} from "../../composer/settings.js";
import {
	validateModelAgainstCatalog,
	validateModelIdentifier,
} from "../../composer/model-utils.js";
import {
	fixMissingGuards,
	createBundleForSoul,
	createProfile,
	resolveDefaultAgentForBundles,
} from "./fix.js";
import type { DiagnosticReport } from "./diagnose.js";
import { pathExists, readJson, writeJson } from "./checks/utils.js";

// ============================================================================
// MAIN MENU
// ============================================================================

export async function interactiveDoctor(
	targetRoot: string,
	report?: DiagnosticReport,
): Promise<void> {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	try {
		while (true) {
			process.stdout.write("\n");
			process.stdout.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
			process.stdout.write("  Agent Hub Doctor - Main Menu\n");
			process.stdout.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n");

			process.stdout.write("What do you want to do?\n\n");
			process.stdout.write("  1. Create a bundle\n");
			process.stdout.write("  2. Create a profile\n");
			process.stdout.write("  3. Assign skills to a bundle\n");
			process.stdout.write("  4. Add bundle(s) to a profile\n");
			process.stdout.write("  5. Apply/modify guards\n");
			process.stdout.write("  6. Fix setup issues\n");
			process.stdout.write("  7. Show current structure\n");
			process.stdout.write("  8. Manage agent models\n");
			process.stdout.write("  9. Exit\n\n");

			const choice = await rl.question("Select [1-9]: ");
			const choiceNum = parseInt(choice.trim(), 10);

			switch (choiceNum) {
				case 1:
					await createBundleFlow(rl, targetRoot);
					break;
				case 2:
					await createProfileFlow(rl, targetRoot);
					break;
				case 3:
					await assignSkillsFlow(rl, targetRoot);
					break;
				case 4:
					await addBundleToProfileFlow(rl, targetRoot);
					break;
				case 5:
					await applyGuardsFlow(rl, targetRoot);
					break;
				case 6:
					await fixIssuesFlow(rl, targetRoot, report);
					break;
				case 7:
					await showStructure(targetRoot);
					break;
				case 8:
					await manageAgentModelsFlow(rl, targetRoot);
					break;
				case 9:
					process.stdout.write("\nGoodbye!\n");
					return;
				default:
					process.stdout.write("\nInvalid choice. Please select 1-9.\n");
			}
		}
	} finally {
		rl.close();
	}
}

// ============================================================================
// FLOW 1: CREATE BUNDLE
// ============================================================================

async function createBundleFlow(
	rl: readline.Interface,
	targetRoot: string,
): Promise<void> {
	process.stdout.write("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
	process.stdout.write("  Create Bundle\n");
	process.stdout.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n");

	// Get available souls
	const souls = await getAvailableSouls(targetRoot);
	if (souls.length === 0) {
		process.stdout.write("No souls found. Import or create souls first.\n");
		return;
	}

	process.stdout.write("Available souls:\n");
	for (const soul of souls) {
		process.stdout.write(`  - ${soul}\n`);
	}
	process.stdout.write("\n");

	// Select soul
	const soulName = await rl.question("Select soul: ");
	if (!soulName.trim() || !souls.includes(soulName.trim())) {
		process.stdout.write("Invalid soul selection. Cancelled.\n");
		return;
	}

	// Direct skills
	process.stdout.write(
		"\n⚠️  Note: Skills are globally mounted, not exclusive to this bundle.\n",
	);
	const skillsInput = await rl.question(
		"Skills (comma-separated, or press Enter to skip): ",
	);
	const additionalSkills = skillsInput
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	// MCP servers
	const mcps = await getAvailableMcps(targetRoot);
	let selectedMcps: string[] = [];

	if (mcps.length > 0) {
		process.stdout.write("\nAvailable MCP servers:\n");
		for (const mcp of mcps) {
			process.stdout.write(`  - ${mcp}\n`);
		}
		process.stdout.write("\n");

		const mcpsInput = await rl.question(
			"Select MCP servers (comma-separated, or press Enter to skip): ",
		);
		selectedMcps = mcpsInput
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
	}

	// Guards
	process.stdout.write(
		"\n✅ Guards are per-agent and will actually restrict this agent's permissions.\n",
	);
	process.stdout.write("Available guards:\n");
	process.stdout.write("  - read_only: Block edit, write, bash\n");
	process.stdout.write("  - no_task: Block task tool\n");
	process.stdout.write("  - no_subagent: Legacy alias for no_task\n");
	process.stdout.write("  - no_omo: Block OMO multi-agent calls\n\n");

	const guardsInput = await rl.question(
		"Select guards (comma-separated, or press Enter for none): ",
	);
	const selectedGuards = guardsInput
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	// Agent config
	process.stdout.write("\n────────────────────────────────────────────────\n");
	process.stdout.write("Agent Configuration\n");
	process.stdout.write("────────────────────────────────────────────────\n\n");

	const agentName = await rl.question(
		`Agent name [default: ${soulName.trim()}]: `,
	);
	const finalAgentName = agentName.trim() || soulName.trim();

	const modeInput = await rl.question("Mode [primary/subagent, default: primary]: ");
	const mode = modeInput.trim() === "subagent" ? "subagent" : "primary";

	const modelInput = await rl.question(
		"Model [default: none]: ",
	);
	const model = modelInput.trim();

	// Create bundle
	const result = await createBundleForSoul(targetRoot, soulName.trim(), {
		agentName: finalAgentName,
		mode,
		skills: additionalSkills,
		mcp: selectedMcps,
		guards: selectedGuards,
		model,
	});

	process.stdout.write(`\n${result.success ? "✓" : "✗"} ${result.message}\n`);

	if (!result.success) return;

	// Ask if user wants to add to profile
	const addToProfile = await promptBoolean(
		rl,
		"\nAdd this bundle to a profile?",
		true,
	);

	if (addToProfile) {
		await addBundleToProfileFlow(rl, targetRoot, soulName.trim());
	}
}

// ============================================================================
// FLOW 2: CREATE PROFILE
// ============================================================================

async function createProfileFlow(
	rl: readline.Interface,
	targetRoot: string,
): Promise<void> {
	process.stdout.write("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
	process.stdout.write("  Create Profile\n");
	process.stdout.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n");

	// Get available bundles
	const bundles = await getAvailableBundles(targetRoot);
	if (bundles.length === 0) {
		process.stdout.write("No bundles found. Create bundles first.\n");
		return;
	}

	process.stdout.write("Available bundles:\n");
	for (const bundle of bundles) {
		process.stdout.write(`  - ${bundle}\n`);
	}
	process.stdout.write("\n");

	// Select bundles
	const bundlesInput = await rl.question(
		"Select bundles (comma-separated): ",
	);
	const selectedBundles = bundlesInput
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	if (selectedBundles.length === 0) {
		process.stdout.write("No bundles selected. Cancelled.\n");
		return;
	}

	// Profile name
	const name = await rl.question("Profile name [default: imported]: ");
	const profileName = name.trim() || "imported";

	// Description
	const description = await rl.question(
		"Description (optional, press Enter to skip): ",
	);

	// Default agent
	process.stdout.write(`\nSelected bundles: ${selectedBundles.join(", ")}\n`);
	const suggestedDefaultAgent = await resolveDefaultAgentForBundles(
		targetRoot,
		selectedBundles,
	);
	const defaultAgentInput = await rl.question(
		`Default agent [default: ${suggestedDefaultAgent}]: `,
	);
	const defaultAgent = defaultAgentInput.trim() || suggestedDefaultAgent;

	// Create profile
	const result = await createProfile(targetRoot, profileName, {
		bundleNames: selectedBundles,
		description: description.trim() || "Auto-generated profile",
		defaultAgent,
	});

	process.stdout.write(`\n${result.success ? "✓" : "✗"} ${result.message}\n`);
}

// ============================================================================
// FLOW 3: ASSIGN SKILLS TO BUNDLE
// ============================================================================

async function assignSkillsFlow(
	rl: readline.Interface,
	targetRoot: string,
): Promise<void> {
	process.stdout.write("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
	process.stdout.write("  Assign Skills to Bundle\n");
	process.stdout.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n");

	process.stdout.write("⚠️  Important:\n");
	process.stdout.write("  Skills are globally mounted to .opencode-agenthub/current/skills/\n");
	process.stdout.write("  This is NOT 'exclusive' or 'isolated' per-agent.\n");
	process.stdout.write("  Assignment only writes to the agent's config for organization.\n\n");

	// Get profiles
	const profiles = await getAvailableProfiles(targetRoot);
	if (profiles.length === 0) {
		process.stdout.write("No profiles found. Create a profile first.\n");
		return;
	}

	process.stdout.write("Available profiles:\n");
	for (const profile of profiles) {
		process.stdout.write(`  - ${profile}\n`);
	}
	process.stdout.write("\n");

	const profileName = await rl.question("Select profile: ");
	if (!profileName.trim() || !profiles.includes(profileName.trim())) {
		process.stdout.write("Invalid profile. Cancelled.\n");
		return;
	}

	// Get agents in profile
	const profilePath = path.join(targetRoot, "profiles", `${profileName.trim()}.json`);
	const profile = await readJson<{ bundles?: string[] }>(profilePath);
	const agents = profile.bundles || [];

	if (agents.length === 0) {
		process.stdout.write("No agents in this profile. Cancelled.\n");
		return;
	}

	process.stdout.write("\nAgents in this profile:\n");
	for (const agent of agents) {
		process.stdout.write(`  - ${agent}\n`);
	}
	process.stdout.write("\n");

	const agentName = await rl.question("Select agent: ");
	if (!agentName.trim() || !agents.includes(agentName.trim())) {
		process.stdout.write("Invalid agent. Cancelled.\n");
		return;
	}

	const skills = await getAvailableSkills(targetRoot);
	if (skills.length === 0) {
		process.stdout.write("No skills found. Import skills first.\n");
		return;
	}

	process.stdout.write("\nAvailable skills:\n");
	for (const skill of skills) {
		process.stdout.write(`  - ${skill}\n`);
	}
	process.stdout.write("\n");

	const skillsInput = await rl.question(
		"Select skills to add (comma-separated): ",
	);
	const selectedSkills = skillsInput
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	if (selectedSkills.length === 0) {
		process.stdout.write("No skills selected. Cancelled.\n");
		return;
	}

	const bundlePath = path.join(
		targetRoot,
		"bundles",
		`${agentName.trim()}.json`,
	);
	const bundle = await readJson<{
		skills?: string[];
	}>(bundlePath);

	bundle.skills = unique([...(bundle.skills || []), ...selectedSkills]);

	await writeJson(bundlePath, bundle);
	process.stdout.write(`\n✓ Updated bundle skills: ${agentName.trim()}\n`);
}

// ============================================================================
// FLOW 4: ADD BUNDLE TO PROFILE
// ============================================================================

async function addBundleToProfileFlow(
	rl: readline.Interface,
	targetRoot: string,
	preselectedBundle?: string,
): Promise<void> {
	process.stdout.write("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
	process.stdout.write("  Add Bundle(s) to Profile\n");
	process.stdout.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n");

	// Get profiles
	const profiles = await getAvailableProfiles(targetRoot);
	if (profiles.length === 0) {
		process.stdout.write("No profiles found. Create a profile first.\n");
		return;
	}

	process.stdout.write("Available profiles:\n");
	for (const profile of profiles) {
		process.stdout.write(`  - ${profile}\n`);
	}
	process.stdout.write("\n");

	const profileName = await rl.question("Select profile: ");
	if (!profileName.trim() || !profiles.includes(profileName.trim())) {
		process.stdout.write("Invalid profile. Cancelled.\n");
		return;
	}

	// Get bundles
	const bundles = await getAvailableBundles(targetRoot);
	const profilePath = path.join(targetRoot, "profiles", `${profileName.trim()}.json`);
	const profile = await readJson<{ bundles?: string[] }>(profilePath);
	const existingBundles = profile.bundles || [];

	const availableBundles = bundles.filter((b) => !existingBundles.includes(b));

	if (availableBundles.length === 0) {
		process.stdout.write("No new bundles to add.\n");
		return;
	}

	process.stdout.write("\nAvailable bundles (not in profile):\n");
	for (const bundle of availableBundles) {
		process.stdout.write(`  - ${bundle}\n`);
	}
	process.stdout.write("\n");

	// Select bundles
	let selectedBundles: string[];
	if (preselectedBundle) {
		selectedBundles = [preselectedBundle];
	} else {
		const bundlesInput = await rl.question(
			"Select bundles (comma-separated): ",
		);
		selectedBundles = bundlesInput
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
	}

	if (selectedBundles.length === 0) {
		process.stdout.write("No bundles selected. Cancelled.\n");
		return;
	}

	// Update profile
	profile.bundles = unique([...existingBundles, ...selectedBundles]);
	await writeJson(profilePath, profile);

	process.stdout.write(
		`\n✓ Added ${selectedBundles.length} bundle(s) to profile: ${profileName.trim()}\n`,
	);
}

// ============================================================================
// FLOW 5: APPLY GUARDS
// ============================================================================

async function applyGuardsFlow(
	rl: readline.Interface,
	targetRoot: string,
): Promise<void> {
	process.stdout.write("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
	process.stdout.write("  Apply / Modify Guards\n");
	process.stdout.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n");

	process.stdout.write("✅ Guards are per-agent permission controls.\n");
	process.stdout.write("They will actually restrict what this agent can do.\n\n");

	// Get bundles
	const bundles = await getAvailableBundles(targetRoot);
	if (bundles.length === 0) {
		process.stdout.write("No bundles found. Create bundles first.\n");
		return;
	}

	process.stdout.write("Available bundles:\n");
	for (const bundle of bundles) {
		process.stdout.write(`  - ${bundle}\n`);
	}
	process.stdout.write("\n");

	const bundleName = await rl.question("Select bundle: ");
	if (!bundleName.trim() || !bundles.includes(bundleName.trim())) {
		process.stdout.write("Invalid bundle. Cancelled.\n");
		return;
	}

	// Show current guards
	const bundlePath = path.join(targetRoot, "bundles", `${bundleName.trim()}.json`);
	const bundle = await readJson<{ guards?: string[] }>(bundlePath);
	const currentGuards = bundle.guards || [];

	process.stdout.write(`\nCurrent guards: ${currentGuards.length > 0 ? currentGuards.join(", ") : "none"}\n\n`);

	// Show available guards
	process.stdout.write("Available guards:\n");
	process.stdout.write("  - read_only: Block edit, write, bash\n");
	process.stdout.write("  - no_task: Block task tool\n");
	process.stdout.write("  - no_subagent: Legacy alias for no_task\n");
	process.stdout.write("  - no_omo: Block OMO multi-agent calls\n\n");

	process.stdout.write("⚠️  blockedTools limitation:\n");
	process.stdout.write("  Currently uses 'union blocking' strategy.\n");
	process.stdout.write("  If ANY agent blocks a tool, it's blocked for ALL agents.\n");
	process.stdout.write("  This is because the plugin cannot determine current agent in hooks.\n\n");

	// Select guards
	const guardsInput = await rl.question(
		"Select guards (comma-separated, or press Enter for none): ",
	);
	const selectedGuards = guardsInput
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	// Update bundle
	bundle.guards = selectedGuards.length > 0 ? selectedGuards : undefined;
	await writeJson(bundlePath, bundle);

	process.stdout.write(
		`\n✓ Updated guards for bundle: ${bundleName.trim()}\n`,
	);
}

// ============================================================================
// FLOW 6: FIX ISSUES
// ============================================================================

async function fixIssuesFlow(
	rl: readline.Interface,
	targetRoot: string,
	report?: DiagnosticReport,
): Promise<void> {
	process.stdout.write("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
	process.stdout.write("  Fix Setup Issues\n");
	process.stdout.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n");

	// Run diagnostics if not provided
	if (!report) {
		const { runDiagnostics } = await import("./diagnose.js");
		process.stdout.write("Scanning...\n\n");
		report = await runDiagnostics(targetRoot);
	}

	if (report.issues.length === 0) {
		process.stdout.write("✅ No issues found!\n");
		return;
	}

	process.stdout.write("Issues found:\n");
	for (const issue of report.issues) {
		const icon =
			issue.severity === "error"
				? "❌"
				: issue.severity === "warning"
					? "⚠️ "
					: "ℹ️ ";
		process.stdout.write(`  ${icon} ${issue.message}\n`);
	}
	process.stdout.write("\n");

	const shouldFix = await promptBoolean(rl, "Fix these issues?", true);
	if (!shouldFix) {
		process.stdout.write("No fixes applied.\n");
		return;
	}

	process.stdout.write("\n");

	// Fix missing guards
	const missingGuardsIssue = report.issues.find(
		(i) => i.type === "missing_guards",
	);
	if (missingGuardsIssue) {
		const guards = (missingGuardsIssue.details as { guards: string[] })
			.guards;
		const result = await fixMissingGuards(targetRoot, guards);
		process.stdout.write(`${result.success ? "✓" : "✗"} ${result.message}\n`);
	}

	// Create bundles for orphaned souls
	const orphanedSoulsIssue = report.issues.find(
		(i) => i.type === "orphaned_souls",
	);
	if (orphanedSoulsIssue) {
		const souls = (orphanedSoulsIssue.details as { souls: string[] }).souls;
		for (const soul of souls) {
			const result = await createBundleForSoul(targetRoot, soul);
			process.stdout.write(`${result.success ? "✓" : "✗"} ${result.message}\n`);
		}
	}

	// Create profile if missing
	const noProfilesIssue = report.issues.find((i) => i.type === "no_profiles");
	if (noProfilesIssue) {
		const bundles = await getAvailableBundles(targetRoot);
		if (bundles.length > 0) {
			const result = await createProfile(targetRoot, "imported", {
				bundleNames: bundles,
			});
			process.stdout.write(
				`${result.success ? "✓" : "✗"} ${result.message}\n`,
			);
		}
	}

	process.stdout.write("\n✅ Fixes applied!\n");
}

// ============================================================================
// FLOW 7: SHOW STRUCTURE
// ============================================================================

async function showStructure(targetRoot: string): Promise<void> {
	process.stdout.write("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
	process.stdout.write("  Current Structure\n");
	process.stdout.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n");

	// Souls
	const souls = await getAvailableSouls(targetRoot);
	process.stdout.write(`📁 Souls (${souls.length}):\n`);
	for (const soul of souls) {
		process.stdout.write(`   - ${soul}.md\n`);
	}
	process.stdout.write("\n");

	// Skills
	const skills = await getAvailableSkills(targetRoot);
	process.stdout.write(
		`📁 Skills (${skills.length}) [globally mounted, no per-agent isolation]:\n`,
	);
	process.stdout.write(`   - ${skills.join(", ")}\n\n`);

	// Bundles
	const bundles = await getAvailableBundles(targetRoot);
	process.stdout.write(`📁 Bundles (${bundles.length}):\n`);
	for (const bundleName of bundles) {
		const bundlePath = path.join(targetRoot, "bundles", `${bundleName}.json`);
		try {
			const bundle = await readJson<{
				soul?: string;
				skills?: string[];
				guards?: string[];
				runtime?: string;
			}>(bundlePath);
			const soul = bundle.soul || "none";
			const skills = bundle.skills?.join(", ") || "none";
			const guards = bundle.guards?.join(", ") || "none";
			const runtime = bundle.runtime || "native";
			process.stdout.write(
				`   - ${bundleName}: soul=${soul}, skills=${skills}, guards=${guards}, runtime=${runtime}\n`,
			);
		} catch {
			process.stdout.write(`   - ${bundleName}: (error reading)\n`);
		}
	}
	process.stdout.write("\n");

	// Profiles
	const profiles = await getAvailableProfiles(targetRoot);
	process.stdout.write(`📁 Profiles (${profiles.length}):\n`);
	for (const profileName of profiles) {
		const profilePath = path.join(
			targetRoot,
			"profiles",
			`${profileName}.json`,
		);
		try {
			const profile = await readJson<{
				bundles?: string[];
				defaultAgent?: string;
			}>(profilePath);
			const bundles = profile.bundles?.join(", ") || "none";
			const defaultAgent = profile.defaultAgent || "none";
			process.stdout.write(
				`   - ${profileName}: [${bundles}], default=${defaultAgent}\n`,
			);
		} catch {
			process.stdout.write(`   - ${profileName}: (error reading)\n`);
		}
	}
	process.stdout.write("\n");

	const nativeAgents = await getNativeAgentMap(targetRoot);
	const unmanagedNativeAgents = Object.entries(nativeAgents).filter(
		([name, details]) => !details.managedByBundle,
	);
	process.stdout.write(
		`📁 Native Agents (${unmanagedNativeAgents.length}) [available via native OpenCode config]:\n`,
	);
	if (unmanagedNativeAgents.length === 0) {
		process.stdout.write("   - none\n\n");
	} else {
		for (const [name, details] of unmanagedNativeAgents) {
			const override = details.overrideModel ? `, overrideModel=${details.overrideModel}` : "";
			const model = details.model || "none";
			process.stdout.write(`   - ${name}: model=${model}${override}\n`);
		}
		process.stdout.write("\n");
	}

	// Guards
	process.stdout.write("📁 Guards (per-agent permission controls):\n");
	process.stdout.write("   - read_only: Block edit, write, bash\n");
	process.stdout.write("   - no_task: Block task tool\n");
	process.stdout.write("   - no_subagent: Legacy alias for no_task\n");
	process.stdout.write("   - no_omo: Block OMO multi-agent calls\n\n");

	// Warnings
	process.stdout.write("⚠️  Important Notes:\n");
	process.stdout.write("   - Skills are globally mounted, not per-agent exclusive\n");
	process.stdout.write("   - blockedTools uses union blocking (any block = all blocked)\n");
	process.stdout.write("   - Guards/Permission are true per-agent controls\n");
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function promptBoolean(
	rl: readline.Interface,
	question: string,
	defaultValue: boolean,
): Promise<boolean> {
	const suffix = defaultValue ? "[Y/n]" : "[y/N]";
	while (true) {
		const answer = (await rl.question(`${question} ${suffix}: `))
			.trim()
			.toLowerCase();
		if (!answer) return defaultValue;
		if (answer === "y" || answer === "yes") return true;
		if (answer === "n" || answer === "no") return false;
		process.stdout.write("Please answer y or n.\n");
	}
}

function unique<T>(arr: T[]): T[] {
	return [...new Set(arr)];
}

async function getAvailableSouls(targetRoot: string): Promise<string[]> {
	const soulsDir = path.join(targetRoot, "souls");
	if (!(await pathExists(soulsDir))) return [];

	const entries = await readdir(soulsDir, { withFileTypes: true });
	return entries
		.filter((e) => e.isFile() && e.name.endsWith(".md"))
		.map((e) => e.name.replace(/\.md$/, ""));
}

async function getAvailableSkills(targetRoot: string): Promise<string[]> {
	const skillsDir = path.join(targetRoot, "skills");
	if (!(await pathExists(skillsDir))) return [];

	const entries = await readdir(skillsDir, { withFileTypes: true });
	return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function getAvailableBundles(targetRoot: string): Promise<string[]> {
	const bundlesDir = path.join(targetRoot, "bundles");
	if (!(await pathExists(bundlesDir))) return [];

	const entries = await readdir(bundlesDir, { withFileTypes: true });
	return entries
		.filter((e) => e.isFile() && e.name.endsWith(".json"))
		.map((e) => e.name.replace(/\.json$/, ""));
}

export { getAvailableBundles };

async function getAvailableProfiles(targetRoot: string): Promise<string[]> {
	const profilesDir = path.join(targetRoot, "profiles");
	if (!(await pathExists(profilesDir))) return [];

	const entries = await readdir(profilesDir, { withFileTypes: true });
	return entries
		.filter((e) => e.isFile() && e.name.endsWith(".json"))
		.map((e) => e.name.replace(/\.json$/, ""));
}

async function getAvailableMcps(targetRoot: string): Promise<string[]> {
	const mcpDir = path.join(targetRoot, "mcp");
	if (!(await pathExists(mcpDir))) return [];

	const entries = await readdir(mcpDir, { withFileTypes: true });
	return entries
		.filter((e) => e.isFile() && e.name.endsWith(".json"))
		.map((e) => e.name.replace(/\.json$/, ""));
}

async function getBundleAgentNames(targetRoot: string): Promise<string[]> {
	const bundles = await getAvailableBundles(targetRoot);
	const names: string[] = [];
	for (const bundleName of bundles) {
		const bundlePath = path.join(targetRoot, "bundles", `${bundleName}.json`);
		try {
			const bundle = await readJson<{ agent?: { name?: string } }>(bundlePath);
			if (bundle.agent?.name) names.push(bundle.agent.name);
		} catch {
			// ignore invalid bundle
		}
	}
	return unique(names);
}

async function getNativeAgentMap(targetRoot: string): Promise<
	Record<
		string,
		{
			model?: string;
			overrideModel?: string;
			managedByBundle: boolean;
		}
	>
> {
	const nativeConfig = await loadNativeOpenCodeConfig();
	const settings = await readAgentHubSettings(targetRoot);
	const bundleAgentNames = new Set(await getBundleAgentNames(targetRoot));
	const agentEntries = Object.entries(nativeConfig?.agent || {}).filter(
		([, agent]) => agent && typeof agent === "object",
	);

	return Object.fromEntries(
		agentEntries.map(([name, agent]) => [
			name,
			{
				model:
					typeof agent.model === "string" && agent.model.trim().length > 0
						? agent.model
						: undefined,
				overrideModel: settings?.agents?.[name]?.model,
				managedByBundle: bundleAgentNames.has(name),
			},
		]),
	);
}

async function manageAgentModelsFlow(
	rl: readline.Interface,
	targetRoot: string,
): Promise<void> {
	const settings = (await readAgentHubSettings(targetRoot)) || {};
	const nativeAgents = await getNativeAgentMap(targetRoot);
	const bundleAgentNames = await getBundleAgentNames(targetRoot);
	const allAgentNames = unique([
		...bundleAgentNames,
		...Object.keys(nativeAgents),
		...Object.keys(settings.agents || {}),
	]);

	if (allAgentNames.length === 0) {
		process.stdout.write("\nNo agents available to manage.\n");
		return;
	}

	process.stdout.write("\nAvailable agents:\n");
	for (const [index, name] of allAgentNames.entries()) {
		const native = nativeAgents[name];
		const source = bundleAgentNames.includes(name)
			? native
				? "managed + native"
				: "managed"
			: native
				? "native unmanaged"
				: "settings-only";
		const currentModel =
			settings.agents?.[name]?.model || native?.model || "none";
		process.stdout.write(
			`  ${index + 1}. ${name} (${source}, model=${currentModel})\n`,
		);
	}

	const answer = await rl.question(
		"\nSelect agent number to update model (or Enter to cancel): ",
	);
	if (!answer.trim()) return;

	const selectedIndex = Number.parseInt(answer.trim(), 10);
	if (!Number.isFinite(selectedIndex) || selectedIndex < 1 || selectedIndex > allAgentNames.length) {
		process.stdout.write("Invalid selection.\n");
		return;
	}

	const agentName = allAgentNames[selectedIndex - 1];
	const currentModel =
		settings.agents?.[agentName]?.model || nativeAgents[agentName]?.model || "";
	const nextModel = await rl.question(
		`New model for '${agentName}' (current: ${currentModel || "none"}; blank clears override): `,
	);
	process.stdout.write(`${await updateAgentModelOverride(targetRoot, agentName, nextModel)}\n`);
}


export async function updateAgentModelOverride(
	targetRoot: string,
	agentName: string,
	model: string,
): Promise<string> {
	const settings = (await readAgentHubSettings(targetRoot)) || {};
	const trimmed = model.trim();
	settings.agents = settings.agents || {};
	const existing = settings.agents[agentName] || {};
	if (!trimmed) {
		const { model: _ignored, ...rest } = existing;
		if (Object.keys(rest).length > 0) {
			settings.agents[agentName] = rest;
		} else {
			delete settings.agents[agentName];
		}
		if (Object.keys(settings.agents).length === 0) {
			delete settings.agents;
		}
		await writeAgentHubSettings(targetRoot, settings);
		return `Cleared model override for '${agentName}'.`;
	}

	const syntax = validateModelIdentifier(trimmed);
	if (!syntax.ok) {
		return `${syntax.message} Use provider/model format or leave blank to clear the override.`;
	}
	const knownModels = await readHrKnownModelIds(targetRoot);
	const catalog = validateModelAgainstCatalog(trimmed, knownModels);
	if (!catalog.ok) {
		return `${catalog.message} Sync HR sources or choose a listed model, then try again.`;
	}
	const availability = await probeOpencodeModelAvailability(trimmed);
	if (!availability.available) {
		return `${availability.message} Pick another model or clear the override.`;
	}

	settings.agents[agentName] = {
		...existing,
		model: trimmed,
	};
	await writeAgentHubSettings(targetRoot, settings);
	return `Updated model for '${agentName}' to '${trimmed}'.`;
}

export async function updateAgentPromptOverride(
	targetRoot: string,
	agentName: string,
	prompt: string,
): Promise<string> {
	const settings = (await readAgentHubSettings(targetRoot)) || {};
	const trimmed = prompt.trim();
	settings.agents = settings.agents || {};
	const existing = settings.agents[agentName] || {};
	if (!trimmed) {
		const { prompt: _ignored, ...rest } = existing;
		if (Object.keys(rest).length > 0) {
			settings.agents[agentName] = rest;
		} else {
			delete settings.agents[agentName];
		}
		if (Object.keys(settings.agents).length === 0) {
			delete settings.agents;
		}
		await writeAgentHubSettings(targetRoot, settings);
		return `Cleared prompt override for '${agentName}'.`;
	}

	settings.agents[agentName] = {
		...existing,
		prompt: trimmed,
	};
	await writeAgentHubSettings(targetRoot, settings);
	return `Updated prompt override for '${agentName}'.`;
}

// ============================================================================
// FIRST-TIME INIT FLOW
// ============================================================================

export async function interactiveAssembly(
	targetRoot: string,
	report: DiagnosticReport,
	options: {
		continueToMenu?: boolean;
	} = {},
): Promise<void> {
	// If no issues, just show main menu
	if (report.issues.length === 0) {
		if (options.continueToMenu === false) return;
		await interactiveDoctor(targetRoot, report);
		return;
	}

	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	try {
		// Show issues
		process.stdout.write("\n⚠️  Issues Found:\n");
		for (const issue of report.issues) {
			const icon =
				issue.severity === "error"
					? "❌"
					: issue.severity === "warning"
						? "⚠️ "
						: "ℹ️ ";
			process.stdout.write(`  ${icon} ${issue.message}\n`);
		}
		process.stdout.write("\n");

		await fixIssuesFlow(rl, targetRoot, report);

		// Ask if user wants to continue to main menu
		if (options.continueToMenu === false) return;

		const continueToMenu = await promptBoolean(rl, "\nContinue to main menu?", true);

		if (continueToMenu) {
			rl.close();
			await interactiveDoctor(targetRoot);
		}
	} finally {
		rl.close();
	}
}
