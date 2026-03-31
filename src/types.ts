/**
 * Type definitions for opencode-agenthub configuration system
 * Guard and runtime detection types
 */

// ============================================================================
// Guard System Types
// ============================================================================

/**
 * Guard definition with inheritance support
 */
export type GuardDef = {
	/** Human-readable description of what this guard does */
	description: string;
	
	/** Parent guard(s) to inherit from - supports multiple inheritance */
	extends?: string[];
	
	/** Permission rules to apply (merged with bundle permission) */
	permission?: Record<string, unknown>;
	
	/** Tools to block for agents using this guard */
	blockedTools?: string[];
};

/**
 * Collection of guard definitions in settings.json
 */
export type GuardRegistry = Record<string, GuardDef>;

/**
 * Resolved guard after inheritance processing
 */
export type ResolvedGuard = {
	/** Merged permission rules from all inherited guards */
	permission: Record<string, unknown>;
	
	/** Merged blocked tools from all inherited guards */
	blockedTools: string[];
};

// ============================================================================
// Runtime Detection Types
// ============================================================================

export type Runtime = "native" | "omo";

/**
 * Plan detection configuration for cross-turn plan continuation
 * When enabled, the plugin detects plan intent markers in assistant output
 * and injects one-shot guidance into the system prompt on the next turn.
 */
export type PlanDetectionConfig = {
	/** Whether plan detection is enabled (default: false, opt-in) */
	enabled: boolean;
	threshold?: "high" | "medium";
	scanLineLimit?: number;
	scanCharLimit?: number;
	maxInjectionsPerSession?: number;
	/** @deprecated Use queueVisibleReminder instead */
	debugLog?: boolean;
	/** @deprecated Use queueVisibleReminder instead */
	userVisibleTrace?: boolean;
	/** @deprecated Use queueVisibleReminderTemplate instead */
	userVisibleTraceTemplate?: string;
	queueVisibleReminder?: boolean;
	queueVisibleReminderTemplate?: string;
	reminderTemplate?: string;
};

export type WorkflowInjectionConfidence = "high" | "medium";

export type WorkflowInjectionTrigger = {
	type?: "keyword" | "regex";
	value: string;
	confidence?: WorkflowInjectionConfidence;
	caseSensitive?: boolean;
};

export type WorkflowInjectionRule = {
	id: string;
	description?: string;
	enabled?: boolean;
	match?: "any" | "all";
	triggers: WorkflowInjectionTrigger[];
	reminderTemplate: string;
	queueVisibleReminderTemplate?: string;
};

export type WorkflowInjectionModeConfig = {
	description?: string;
	enabled?: boolean;
	label?: string;
	match?: "any" | "all";
	triggers?: WorkflowInjectionTrigger[];
	reminderPrefix?: string[];
	reminder?: string[];
	reminderSuffix?: string[];
	queueVisibleReminderTemplate?: string;
};

export type WorkflowInjectionDefaults = {
	match?: "any" | "all";
	useIDetectFallback?: boolean;
	reminderPrefix?: string[];
	reminderSuffix?: string[];
};

export type WorkflowInjectionAuthoringConfig = Omit<
	WorkflowInjectionConfig,
	"rules"
> & {
	defaults?: WorkflowInjectionDefaults;
	modes: Record<string, WorkflowInjectionModeConfig>;
	rules?: never;
};

export type WorkflowInjectionSourceConfig =
	| WorkflowInjectionConfig
	| WorkflowInjectionAuthoringConfig;

export type WorkflowInjectionConfig = {
	enabled: boolean;
	bundles?: string[];
	debugLog?: boolean;
	queueVisibleReminder?: boolean;
	queueVisibleReminderTemplate?: string;
	scanLineLimit?: number;
	scanCharLimit?: number;
	maxInjectionsPerSession?: number;
	rules: WorkflowInjectionRule[];
};

/**
 * Runtime configuration generated during compose
 * This file is read by the plugin to determine blocked tools per agent
 */
export type RuntimeConfig = {
	/** Generated timestamp */
	generated: string;
	
	/** Per-agent runtime information */
	agents: Record<string, AgentRuntimeInfo>;
	
	/** Global blocked tools (blocked for all agents) */
	globalBlockedTools?: string[];

	/** Cross-turn plan detection settings (opt-in) */
	planDetection?: PlanDetectionConfig;

	workflowInjection?: WorkflowInjectionConfig;
};

/**
 * Runtime information for a single agent
 */
export type AgentRuntimeInfo = {
	/** Runtime type for this agent */
	runtime: Runtime;
	
	/** Tools blocked for this specific agent */
	blockedTools: string[];
	
	/** Guards applied to this agent (for debugging) */
	guards?: string[];
	
	/** Final resolved skills for this agent */
	skills?: string[];
};

// ============================================================================
// Enhanced Settings Types
// ============================================================================

/**
 * Extended agent settings with guard support
 */
export type AgentSettings = {
	/** Model override for this agent */
	model?: string;

	/** Variant override for this agent */
	variant?: string;

	/** Prompt override for this agent */
	prompt?: string;
	
	/** Permission override for this agent */
	permission?: Record<string, unknown>;
	
	/** Guard names to apply to this agent */
	guards?: string[];
};

/**
 * OMO-specific settings
 */
export type OmoSettings = {
	/** Additional tools to block in OMO runtime */
	blockedTools?: string[];
	
	/** Default category configuration */
	defaultCategoryModel?: string;
};

export type OmoBaselineMode = "inherit" | "ignore";

export type LocalPluginSettings = {
	bridge: boolean;
};

/**
 * Extended AgentHub settings
 */
export type AgentHubSettings = {
	$schema?: string;

	preferences?: {
		defaultProfile?: string;
	};

	/** Agent Hub metadata */
		meta?: {
			onboarding?: {
				mode?: "minimal" | "auto" | "hr-office";
				starter?: "none" | "auto" | "coding-hr" | "framework" | "hr-office";
				modelStrategy?: "native" | "recommended" | "free" | "custom";
				importedNativeBasics: boolean;
				importedNativeAgents: boolean;
				createdAt: string;
		};
		builtinVersion?: Record<string, string>;
	};
	
	/** OpenCode native configuration */
	opencode?: {
		provider?: Record<string, unknown>;
		model?: string;
		small_model?: string;
	};
	
	/** Guard definitions registry */
	guards?: GuardRegistry;
	
	/** OMO-specific settings */
	omo?: OmoSettings;

	/** How Agent Hub should treat the user's global oh-my-opencode baseline */
	omoBaseline?: OmoBaselineMode;

	/** Local filesystem plugin bridge settings */
	localPlugins?: LocalPluginSettings;

	/** Cross-turn plan detection (opt-in) */
	planDetection?: PlanDetectionConfig;
	
	/** Per-agent configuration overrides */
	agents?: Record<string, AgentSettings>;
};

// ============================================================================
// Error Types
// ============================================================================

/**
 * Error thrown during guard resolution
 */
export class GuardResolutionError extends Error {
	constructor(
		message: string,
		public readonly guardName: string,
		public readonly chain: string[],
	) {
		super(message);
		this.name = "GuardResolutionError";
	}
}
