import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
	PlanDetectionConfig,
	WorkflowInjectionConfig,
} from "../types.js";
import {
	buildPlanTraceNotice,
	buildQueuedPlanNotice,
	buildQueuedWorkflowNotice,
	buildWorkflowTraceNotice,
	detectPlanIntent,
	detectWorkflowIntent,
	INTERNAL_INITIATOR_MARKER,
	shouldInjectPlanGuidance,
	shouldInjectWorkflowGuidance,
} from "./plan-guidance.js";
import {
	inspectRuntimeConfig,
	resolvePluginConfigRoot,
	summarizeRuntimeFeatureState,
} from "./runtime-config.js";

type ToastRequest = {
	body: {
		title: string;
		message: string;
		variant: "info" | "warning" | "error" | "success";
		duration: number;
	};
};

type PluginContext = {
	client?: {
		tui?: {
			showToast?: (request: ToastRequest) => Promise<unknown>;
		};
	};
};

type PlanState = {
	pendingVisibleNotice: string | null;
	pendingVisibleSource: "workflow" | "plan" | null;
	detectedAtMessageID: string | null;
	injectionCount: number;
};

type HookHandler = (...args: unknown[]) => Promise<unknown> | unknown;

const loadRuntimeConfig = async (): Promise<{
	blockedTools: Set<string>;
	planDetection?: PlanDetectionConfig;
	workflowInjection?: WorkflowInjectionConfig;
}> => {
	const inspection = await inspectRuntimeConfig(resolvePluginConfigRoot());
	if (!inspection.ok) {
		process.stderr.write(
			"[opencode-agenthub] Warning: failed to load hub runtime config — " +
			"running in degraded mode (tool blocking disabled, workflow injection disabled). " +
			"Run 'agenthub setup' to initialize your Agent Hub home.\n",
		);
		return { blockedTools: new Set(["call_omo_agent"]) };
	}

	return summarizeRuntimeFeatureState(inspection.config);
};

const DEFAULT_PLAN_STATE: PlanState = {
	pendingVisibleNotice: null,
	pendingVisibleSource: null,
	detectedAtMessageID: null,
	injectionCount: 0,
};

export default async function (ctx?: PluginContext): Promise<Record<string, HookHandler>> {
	const { blockedTools, planDetection, workflowInjection } = await loadRuntimeConfig();
	const activeWorkflowInjection = workflowInjection?.enabled ? workflowInjection : undefined;
	const activePlanDetection = planDetection?.enabled ? planDetection : undefined;
	const workflowInjectionEnabled = !!activeWorkflowInjection;
	const planDetectionEnabled = !!activePlanDetection;
	const maxInjectionsPerSession =
		activeWorkflowInjection?.maxInjectionsPerSession ??
		activePlanDetection?.maxInjectionsPerSession ??
		3;
	const debugLogPath = join(resolvePluginConfigRoot(), "plan-detection-debug.log");

	const formatDebugError = (error: unknown): string | null => {
		if (error === undefined) return null;
		if (error instanceof Error) return error.stack ?? error.message;
		if (typeof error === "string") return error;
		try {
			return JSON.stringify(error);
		} catch {
			return String(error);
		}
	};

	const debugLog = async (message: string, error?: unknown) => {
		if (!activeWorkflowInjection?.debugLog && !activePlanDetection?.debugLog) return;
		const timestamp = new Date().toISOString();
		const formattedError = formatDebugError(error);
		const line = formattedError
			? `[${timestamp}] ${message}\n${formattedError}\n`
			: `[${timestamp}] ${message}\n`;
		try {
			await mkdir(resolvePluginConfigRoot(), { recursive: true });
			await appendFile(debugLogPath, line, "utf-8");
		} catch {}
	};

	const summarizeValue = (value: unknown): string => {
		if (Array.isArray(value)) return `array(len=${value.length})`;
		if (value === null) return "null";
		return typeof value;
	};

	const planState = new Map<string, PlanState>();

	const phases = ["CLARIFY", "GATHER", "ANALYZE", "SYNTHESIZE", "FORMAT", "DELIVER", "ANSWER", "QA_FORMAT"] as const;
	type PhaseName = (typeof phases)[number];
	let currentRunId: string | null = null;
	const knowledgeRoot = resolve(resolvePluginConfigRoot(), "knowledge");

	const getToolName = (payload: unknown): string | null => {
		const directName = (payload as { name?: unknown })?.name;
		if (typeof directName === "string") return directName;
		const nestedToolName = (payload as { tool?: { name?: unknown } })?.tool?.name;
		if (typeof nestedToolName === "string") return nestedToolName;
		const nestedName = (payload as { input?: { name?: unknown } })?.input?.name;
		if (typeof nestedName === "string") return nestedName;
		return null;
	};

	const generateRunId = (): string => {
		const now = new Date();
		return now.toISOString().slice(0, 19).replace(/:/g, "-");
	};

	const extractPhaseOutputs = (text: string): Array<{ phase: PhaseName; content: string }> => {
		if (!text || text.length < 50) return [];
		if (/<\/?[a-z][\s\S]*?>/i.test(text.slice(0, 500))) return [];
		const markerRegex = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?\s*(CLARIFY|GATHER|ANALYZE|SYNTHESIZE|FORMAT|DELIVER|ANSWER|QA_FORMAT)\s*:(?:\*\*)?/gi;
		const markers: Array<{ phase: PhaseName; start: number; contentStart: number }> = [];
		for (const match of text.matchAll(markerRegex)) {
			const phase = match[1]?.toUpperCase() as PhaseName;
			if (!phases.includes(phase)) continue;
			const start = match.index ?? 0;
			const markerText = match[0] ?? "";
			markers.push({ phase, start, contentStart: start + markerText.length });
		}
		if (markers.length === 0) return [];
		const outputs: Array<{ phase: PhaseName; content: string }> = [];
		for (let index = 0; index < markers.length; index += 1) {
			const current = markers[index];
			const next = markers[index + 1];
			const sliceEnd = next ? next.start : text.length;
			const content = text.slice(current.contentStart, sliceEnd).trim();
			if (content) outputs.push({ phase: current.phase, content });
		}
		return outputs;
	};

	const persistPhaseOutput = async (phase: string, content: string, runId: string) => {
		const normalizedPhase = phase.trim().toUpperCase();
		if (!phases.includes(normalizedPhase as PhaseName)) return;
		const phaseContent = content.trim();
		if (!phaseContent) return;
		const runDirectory = join(knowledgeRoot, runId);
		const phaseFilePath = join(runDirectory, `${normalizedPhase}.md`);
		try {
			await mkdir(runDirectory, { recursive: true });
			await writeFile(phaseFilePath, `${phaseContent}\n`, "utf-8");
		} catch {}
	};

	const persistFromText = async (text: string) => {
		const phaseOutputs = extractPhaseOutputs(text);
		if (phaseOutputs.length === 0) return;
		if (!currentRunId) currentRunId = generateRunId();
		for (const phaseOutput of phaseOutputs) {
			await persistPhaseOutput(phaseOutput.phase, phaseOutput.content, currentRunId);
		}
	};

	const showVisibleToast = async (message: string): Promise<boolean> => {
		const tuiClient = ctx?.client?.tui;
		if (!tuiClient || typeof tuiClient.showToast !== "function") return false;
		try {
			await tuiClient.showToast({
				body: {
					title: "Agent Hub",
					message,
					variant: "info",
					duration: 4000,
				},
			});
			return true;
		} catch (error) {
			await debugLog("Failed to show visible plan reminder via tui.showToast.", error);
			return false;
		}
	};

	const extractSessionID = (hookInput: unknown): string | undefined => {
		const input = hookInput as { sessionID?: unknown; session?: { id?: unknown } } | undefined;
		const direct = input?.sessionID;
		if (typeof direct === "string" && direct) return direct;
		const nested = input?.session?.id;
		if (typeof nested === "string" && nested) return nested;
		return undefined;
	};

	const getPlanState = (sessionID: string): PlanState => {
		const existing = planState.get(sessionID);
		if (existing) return existing;
		const created = { ...DEFAULT_PLAN_STATE };
		planState.set(sessionID, created);
		return created;
	};

	const clearPendingReminderState = async (
		state: PlanState,
		sessionID: string,
		reason: string,
	): Promise<void> => {
		const clearedVisibleReminder = !!state.pendingVisibleNotice;
		state.pendingVisibleNotice = null;
		state.pendingVisibleSource = null;
		state.detectedAtMessageID = null;
		if (!clearedVisibleReminder) return;
		await debugLog(
			`Cleared stale pending visible reminder for session ${sessionID} (${reason}). visible=${clearedVisibleReminder}`,
		);
	};

	const injectVisibleReminderIntoToolOutput = async (
		toolOutput: { output?: unknown },
		notice: string,
		reminderSource: "workflow" | "plan",
		sessionID: string,
	): Promise<void> => {
		const currentText = typeof toolOutput.output === "string" ? toolOutput.output : "";
		toolOutput.output = currentText ? `${notice}\n\n---\n\n${currentText}` : notice;
		await debugLog(
			`Injected visible ${reminderSource} reminder into tool.execute.after output for session ${sessionID}.`,
		);
	};

	const queueVisibleReminderForToolOutput = async (
		state: PlanState,
		notice: string,
		reminderSource: "workflow" | "plan",
		sessionID: string,
	): Promise<void> => {
		state.pendingVisibleNotice = notice;
		state.pendingVisibleSource = reminderSource;
		await debugLog(
			`Queued visible ${reminderSource} reminder for tool.execute.after injection in session ${sessionID}.`,
		);
	};

	const claimPendingVisibleReminder = (
		state: PlanState,
	): { notice: string; reminderSource: "workflow" | "plan" } | null => {
		if (!state.pendingVisibleNotice) return null;
		const claimed = {
			notice: state.pendingVisibleNotice,
			reminderSource: state.pendingVisibleSource ?? "plan",
		};
		state.pendingVisibleNotice = null;
		state.pendingVisibleSource = null;
		state.injectionCount += 1;
		return claimed;
	};

	return {
		"tool.execute.before": async (hookInput: unknown) => {
			const toolName = getToolName(hookInput);
			if (toolName && blockedTools.has(toolName)) {
				return {
					error: `Blocked tool: ${toolName}. This tool is restricted by guard configuration.`,
				};
			}
		},
		"experimental.text.complete": async (hookInput: unknown, output: unknown) => {
			const currentOutput = output as { text?: unknown };
			const originalText = typeof currentOutput?.text === "string" ? (currentOutput.text ?? "") : "";

			if (originalText.includes(INTERNAL_INITIATOR_MARKER)) {
				await debugLog("Skipped plan detection for internal initiator message.");
				return;
			}

			const sessionID = extractSessionID(hookInput);
			const state = sessionID ? getPlanState(sessionID) : undefined;
			const effectiveText = originalText;

			await persistFromText(effectiveText);

			if ((workflowInjectionEnabled || planDetectionEnabled) && effectiveText && sessionID) {
				const messageID = (hookInput as { messageID?: unknown })?.messageID;
				if (typeof messageID === "string" && state.detectedAtMessageID === messageID) return;

				if (state.pendingVisibleNotice || state.injectionCount >= maxInjectionsPerSession) return;

				const workflowSignal = activeWorkflowInjection
					? detectWorkflowIntent(effectiveText, activeWorkflowInjection)
					: undefined;
				const shouldInjectWorkflow = workflowSignal
					? shouldInjectWorkflowGuidance(workflowSignal, activeWorkflowInjection)
					: false;

				const planSignal = !shouldInjectWorkflow && activePlanDetection
					? detectPlanIntent(effectiveText, activePlanDetection)
					: undefined;
				const shouldInjectPlan = planSignal
					? shouldInjectPlanGuidance(planSignal, activePlanDetection)
					: false;

				if (!shouldInjectWorkflow && !shouldInjectPlan) return;

				const shouldInjectVisibleReminder = shouldInjectWorkflow
					? (activeWorkflowInjection?.queueVisibleReminder ?? false)
					: (activePlanDetection?.queueVisibleReminder ?? activePlanDetection?.userVisibleTrace ?? true);
				if (!shouldInjectVisibleReminder) return;

				const reminderSource = shouldInjectWorkflow ? "workflow" : "plan";
				const visibleNotice = shouldInjectWorkflow && workflowSignal
					? buildWorkflowTraceNotice(workflowSignal, activeWorkflowInjection)
					: buildPlanTraceNotice(activePlanDetection);
				const queuedNotice = shouldInjectWorkflow && workflowSignal
					? buildQueuedWorkflowNotice(workflowSignal, activeWorkflowInjection)
					: buildQueuedPlanNotice(activePlanDetection, planSignal);
				state.detectedAtMessageID = typeof messageID === "string" ? messageID : null;
				await queueVisibleReminderForToolOutput(
					state,
					queuedNotice,
					reminderSource,
					sessionID,
				);
				const toastShown = await showVisibleToast(visibleNotice);
				if (toastShown) {
					await debugLog(
						`Displayed visible ${reminderSource} reminder via tui.showToast for session ${sessionID}.`,
					);
				}
				await debugLog(
					`After-tool-only ${reminderSource} reminder active for session ${sessionID}: visible reminder goes to tool.execute.after output.`,
				);

				if (shouldInjectWorkflow) {
					await debugLog(
						`Detected workflow marker (${workflowSignal?.ruleId ?? "unknown"}) for session ${sessionID}; queued visible reminder.`,
					);
				} else {
					await debugLog(`Detected legacy plan marker for session ${sessionID}; queued visible reminder.`);
				}
			}
		},
		"experimental.chat.system.transform": async () => {
			return;
		},
		"chat.message": async (hookInput: unknown) => {
			const sessionID = extractSessionID(hookInput);
			if (!sessionID) return;
			const state = planState.get(sessionID);
			if (!state) return;
			await clearPendingReminderState(state, sessionID, "new chat.message boundary");
		},
		"tool.execute.after": async (hookInput: unknown, hookOutput: unknown) => {
			const sessionID = extractSessionID(hookInput);
			const state = sessionID ? planState.get(sessionID) : undefined;
			const candidateOutput = (hookOutput as { output?: unknown })?.output;
			const claimedReminder =
				state && typeof candidateOutput === "string" ? claimPendingVisibleReminder(state) : null;
			if (claimedReminder && sessionID) {
				await injectVisibleReminderIntoToolOutput(
					hookOutput as { output?: unknown },
					claimedReminder.notice,
					claimedReminder.reminderSource,
					sessionID,
				);
			} else if (state?.pendingVisibleNotice && sessionID && typeof candidateOutput !== "string") {
				await debugLog(
					`Deferred visible ${(state.pendingVisibleSource ?? "plan")} reminder for session ${sessionID} because tool.execute.after output was not a string. outputType=${summarizeValue(candidateOutput)}`,
				);
			}
			if (typeof candidateOutput === "string") {
				await persistFromText((hookOutput as { output?: unknown }).output as string);
			}
		},
			event: async (payload: unknown) => {
				const eventType = (payload as { event?: { type?: unknown } })?.event?.type;
				if (eventType === "session.deleted") {
					currentRunId = null;
					const sessionID = (payload as { event?: { sessionID?: string } })?.event?.sessionID;
					if (sessionID) {
						planState.delete(sessionID);
					}
				}
			},
	};
}
