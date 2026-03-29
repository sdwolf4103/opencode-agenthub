export const PROFILE_ADD_CAPABILITY_REGISTRY = {
	"hr-suite": [
		"hr",
		"hr-planner",
		"hr-sourcer",
		"hr-evaluator",
		"hr-cto",
		"hr-adapter",
		"hr-verifier",
	],
} as const;

export const expandProfileAddSelections = (selections: string[]): string[] =>
	selections.flatMap(
		(selection) =>
			PROFILE_ADD_CAPABILITY_REGISTRY[
				selection as keyof typeof PROFILE_ADD_CAPABILITY_REGISTRY
			] ?? [selection],
	);

export const listProfileAddCapabilityNames = (): string[] =>
	Object.keys(PROFILE_ADD_CAPABILITY_REGISTRY).sort();
