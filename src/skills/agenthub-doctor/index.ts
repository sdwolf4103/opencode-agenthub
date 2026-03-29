/**
 * Agent Hub Doctor Skill
 * 
 * Diagnoses and fixes common Agent Hub setup issues:
 * - Missing guards in settings.json
 * - Orphaned souls and skills (not referenced by bundles)
 * - Missing profiles
 * - Missing bundles
 * 
 * Provides interactive assembly for imported souls/skills.
 */

export { runDiagnostics } from "./diagnose.js";
export type { DiagnosticReport, DiagnosticIssue } from "./diagnose.js";

export {
	fixMissingGuards,
	createBundleForSoul,
	createBundlesForSouls,
	createProfile,
	validateAndFix,
	fixOmoMixedProfile,
} from "./fix.js";
export type { FixResult } from "./fix.js";

export {
	interactiveAssembly,
	interactiveDoctor,
	updateAgentModelOverride,
	updateAgentPromptOverride,
} from "./interactive.js";
export { getAvailableBundles } from "./interactive.js";
