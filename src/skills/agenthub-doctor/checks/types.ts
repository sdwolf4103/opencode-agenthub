import type { AgentHubSettings } from "../../../types.js";
import type { DiagnosticIssue } from "../diagnose.js";
import type { FixResult } from "../fix.js";

export type CheckCategory = "environment" | "home" | "workspace" | "plugin";

export type DiagnosticContext = {
	targetRoot: string;
	configRoot?: string;
	workspace?: string;
	strict?: boolean;
	category?: CheckCategory;
	settings: AgentHubSettings | null;
};

export type DiagnosticCheckResult = {
	healthy?: string[];
	issues?: DiagnosticIssue[];
};

export interface DiagnosticCheck {
	id: string;
	category: CheckCategory;
	run(ctx: DiagnosticContext): Promise<DiagnosticCheckResult>;
	fix?: (ctx: DiagnosticContext, issue: DiagnosticIssue) => Promise<FixResult>;
}
