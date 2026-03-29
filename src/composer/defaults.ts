export const DEFAULT_PROFILE_PLUGINS = [
	"opencode-agenthub",
] as const;

export const getDefaultProfilePlugins = (): string[] => [
	...DEFAULT_PROFILE_PLUGINS,
];
