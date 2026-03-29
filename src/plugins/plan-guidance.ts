import type {
	PlanDetectionConfig,
	WorkflowInjectionConfidence,
	WorkflowInjectionConfig,
	WorkflowInjectionRule,
	WorkflowInjectionTrigger,
} from "../types.js";

export type WorkflowSignalConfidence = WorkflowInjectionConfidence | "none";

export type WorkflowSignal = {
	detected: boolean;
	confidence: WorkflowSignalConfidence;
	ruleId: string | null;
	matchOffset: number;
};

export type PlanSignal = {
	detected: boolean;
	confidence: "high" | "medium" | "none";
	marker: "classification" | "i-detect" | null;
	matchOffset: number;
};

const defaultPlanReminderLines = (confidence: PlanSignal["confidence"] = "high"): string[] => [
	"PLAN_INJECTION_TEST_ACTIVE",
	"Keep the user's current task, constraints, and repo context as the source of truth.",
	"Do not restart the task or replace the answer format.",
	"Include exactly one short line: workflow-received",
	...(confidence === "medium"
		? ["- If this was not intended as a planning turn, ignore this reminder."]
		: []),
];

const DEFAULT_SCAN_LINE_LIMIT = 5;
const DEFAULT_SCAN_CHAR_LIMIT = 800;
const CLASSIFICATION_PLAN_RE = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?Classification(?:\s*:|:)(?:\*\*)?\s*(?:\[\s*Plan\s*\]|Plan)(?=[\s:;,.!?-]|$)/mi;
const I_DETECT_PLAN_RE = /(?:^|\n)\s*I\s+detect\s+(?:\[\s*Plan\s*\]|Plan)(?=[\s:;,.!?-]|$)/i;

const buildScanWindow = (
	text: string,
	lineLimit = DEFAULT_SCAN_LINE_LIMIT,
	charLimit = DEFAULT_SCAN_CHAR_LIMIT,
): string => {
	const lines = text.split("\n");
	const selected: string[] = [];
	let inFence = false;

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("```")) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		selected.push(line);
		if (selected.length >= lineLimit) break;
	}

	return selected.join("\n").slice(0, charLimit);
};

const confidenceRank: Record<WorkflowSignalConfidence, number> = {
	none: 0,
	medium: 1,
	high: 2,
};

const getTriggerConfidence = (
	trigger: WorkflowInjectionTrigger,
): WorkflowInjectionConfidence => trigger.confidence ?? "high";

const matchTrigger = (
	scanWindow: string,
	trigger: WorkflowInjectionTrigger,
): number => {
	if (!trigger.value) return -1;
	if (trigger.type === "regex") {
		try {
			const flags = trigger.caseSensitive ? "m" : "im";
			const regex = new RegExp(trigger.value, flags);
			const match = regex.exec(scanWindow);
			return match?.index ?? -1;
		} catch {
			return -1;
		}
	}

	const haystack = trigger.caseSensitive ? scanWindow : scanWindow.toLowerCase();
	const needle = trigger.caseSensitive ? trigger.value : trigger.value.toLowerCase();
	return haystack.indexOf(needle);
};

const findBestRuleMatch = (
	scanWindow: string,
	rule: WorkflowInjectionRule,
): WorkflowSignal => {
	const activeTriggers = rule.triggers.filter(
		(trigger) => typeof trigger.value === "string" && trigger.value.trim().length > 0,
	);
	if (activeTriggers.length === 0) {
		return { detected: false, confidence: "none", ruleId: null, matchOffset: -1 };
	}

	const strategy = rule.match ?? "any";
	const matches = activeTriggers.map((trigger) => ({
		trigger,
		index: matchTrigger(scanWindow, trigger),
	}));

	if (strategy === "all" && matches.some((match) => match.index === -1)) {
		return { detected: false, confidence: "none", ruleId: null, matchOffset: -1 };
	}

	const matched = matches.filter((match) => match.index !== -1);
	if (matched.length === 0) {
		return { detected: false, confidence: "none", ruleId: null, matchOffset: -1 };
	}

	const strongest = matched.reduce((best, current) => {
		const currentConfidence = getTriggerConfidence(current.trigger);
		const bestConfidence = getTriggerConfidence(best.trigger);
		if (confidenceRank[currentConfidence] > confidenceRank[bestConfidence]) {
			return current;
		}
		if (
			confidenceRank[currentConfidence] === confidenceRank[bestConfidence] &&
			current.index < best.index
		) {
			return current;
		}
		return best;
	});

	const firstOffset = matched.reduce(
		(offset, current) => Math.min(offset, current.index),
		matched[0]?.index ?? -1,
	);

	return {
		detected: true,
		confidence: getTriggerConfidence(strongest.trigger),
		ruleId: rule.id,
		matchOffset: firstOffset,
	};
};

export const workflowInjectionFromPlanDetection = (
	config?: PlanDetectionConfig,
): WorkflowInjectionConfig | undefined => {
	if (!config?.enabled) return undefined;
	return {
		enabled: true,
		debugLog: config.debugLog,
		queueVisibleReminder:
			config.queueVisibleReminder ?? config.userVisibleTrace ?? false,
		queueVisibleReminderTemplate:
			config.queueVisibleReminderTemplate ?? config.userVisibleTraceTemplate,
		scanLineLimit: config.scanLineLimit,
		scanCharLimit: config.scanCharLimit,
		maxInjectionsPerSession: config.maxInjectionsPerSession,
		rules: [
			{
				id: "plan",
				match: "any",
				triggers: [
					{
						type: "regex",
						value:
							"(?:^|\\n)\\s*(?:#{1,6}\\s*)?(?:\\*\\*)?Classification(?:\\s*:|:)(?:\\*\\*)?\\s*(?:\\[\\s*Plan\\s*\\]|Plan)(?=[\\s:;,.!?-]|$)",
						confidence: "high",
					},
					{
						type: "regex",
						value: "(?:^|\\n)\\s*I\\s+detect\\s+(?:\\[\\s*Plan\\s*\\]|Plan)(?=[\\s:;,.!?-]|$)",
						confidence: "medium",
					},
				],
				reminderTemplate:
					config.reminderTemplate?.trim() ||
					[
						"PLAN_INJECTION_TEST_ACTIVE",
						"Keep the user's current task, constraints, and repo context as the source of truth.",
						"Do not restart the task or replace the answer format.",
						"Include exactly one short line: workflow-received",
					].join("\n"),
				queueVisibleReminderTemplate:
					config.queueVisibleReminderTemplate ?? config.userVisibleTraceTemplate,
			},
		],
	};
};

const getRule = (
	config: WorkflowInjectionConfig | undefined,
	ruleId: string | null,
): WorkflowInjectionRule | undefined =>
	config?.rules.find((rule) => rule.id === ruleId);

const extractReminderLine = (
	reminderTemplate: string | undefined,
	prefix: RegExp,
): string | null => {
	if (!reminderTemplate?.trim()) return null;
	for (const line of reminderTemplate.split("\n")) {
		const trimmed = line.trim();
		if (prefix.test(trimmed)) return trimmed;
	}
	return null;
};

export const detectWorkflowIntent = (
	text: string,
	config?: WorkflowInjectionConfig,
): WorkflowSignal => {
	if (!config?.enabled || !text || text.length < 10) {
		return { detected: false, confidence: "none", ruleId: null, matchOffset: -1 };
	}

	const scanWindow = buildScanWindow(
		text,
		config.scanLineLimit,
		config.scanCharLimit,
	);

	let best: WorkflowSignal = {
		detected: false,
		confidence: "none",
		ruleId: null,
		matchOffset: -1,
	};

	for (const rule of config.rules) {
		if (rule.enabled === false) continue;
		const signal = findBestRuleMatch(scanWindow, rule);
		if (!signal.detected) continue;
		if (confidenceRank[signal.confidence] > confidenceRank[best.confidence]) {
			best = signal;
			continue;
		}
		if (
			confidenceRank[signal.confidence] === confidenceRank[best.confidence] &&
			(best.matchOffset === -1 || signal.matchOffset < best.matchOffset)
		) {
			best = signal;
		}
	}

	return best;
};

export const shouldInjectWorkflowGuidance = (
	signal: WorkflowSignal,
	config?: WorkflowInjectionConfig,
): boolean => signal.detected && !!config?.enabled;

export const buildWorkflowReminder = (
	signal: WorkflowSignal,
	config?: WorkflowInjectionConfig,
): string => {
	const rule = getRule(config, signal.ruleId);
	const reminderBody = rule?.reminderTemplate?.trim()
		? rule.reminderTemplate.trim()
		: [
			"WORKFLOW_INJECTION_TEST_ACTIVE",
			"Keep the user's current task, constraints, and repo context as the source of truth.",
			"Do not restart the task or replace the answer format.",
			"Include exactly one short line: workflow-received",
		].join("\n");

	return `<system-reminder>\n${reminderBody}\n</system-reminder>`;
};

export const buildWorkflowTraceNotice = (
	signal: WorkflowSignal,
	config?: WorkflowInjectionConfig,
): string => {
	const rule = getRule(config, signal.ruleId);
	const traceBody =
		rule?.queueVisibleReminderTemplate?.trim() ||
		rule?.reminderTemplate?.trim() ||
		config?.queueVisibleReminderTemplate?.trim() ||
		"[agenthub] Workflow reminder injected.";
	const reportLine = extractReminderLine(rule?.reminderTemplate, /^0\.\s*Report:/i);
	const firstStep = extractReminderLine(rule?.reminderTemplate, /^1\./i);

	return [traceBody, reportLine, firstStep].filter((value): value is string => !!value).join("\n");
};

export const INTERNAL_INITIATOR_MARKER = "<!-- OMO_INTERNAL_INITIATOR -->";

export const buildQueuedWorkflowNotice = (
	signal: WorkflowSignal,
	config?: WorkflowInjectionConfig,
): string => {
	return `${buildWorkflowReminder(signal, config)}\n${INTERNAL_INITIATOR_MARKER}`;
};

export const detectPlanIntent = (
	text: string,
	config?: PlanDetectionConfig,
): PlanSignal => {
	if (!text || text.length < 10) {
		return { detected: false, confidence: "none", marker: null, matchOffset: -1 };
	}

	const scanWindow = buildScanWindow(
		text,
		config?.scanLineLimit,
		config?.scanCharLimit,
	);

	const classificationMatch = CLASSIFICATION_PLAN_RE.exec(scanWindow);
	if (classificationMatch) {
		return {
			detected: true,
			confidence: "high",
			marker: "classification",
			matchOffset: classificationMatch.index,
		};
	}

	const detectMatch = I_DETECT_PLAN_RE.exec(scanWindow);
	if (detectMatch) {
		return {
			detected: true,
			confidence: "medium",
			marker: "i-detect",
			matchOffset: detectMatch.index,
		};
	}

	return { detected: false, confidence: "none", marker: null, matchOffset: -1 };
};

export const shouldInjectPlanGuidance = (
	signal: PlanSignal,
	config?: PlanDetectionConfig,
): boolean => {
	if (!signal.detected) return false;
	const threshold = config?.threshold ?? "medium";
	if (threshold === "high") return signal.confidence === "high";
	return signal.confidence === "high" || signal.confidence === "medium";
};

export const buildPlanReminder = (
	signal: PlanSignal,
	config?: PlanDetectionConfig,
): string => {
	const reminderBody = config?.reminderTemplate?.trim()
		? config.reminderTemplate.trim()
		: defaultPlanReminderLines(signal.confidence).join("\n");

	return `<system-reminder>\n${reminderBody}\n</system-reminder>`;
};

export const buildPlanTraceNotice = (
	config?: PlanDetectionConfig,
): string => {
	const traceTemplate =
		config?.queueVisibleReminderTemplate ?? config?.userVisibleTraceTemplate;
	const traceBody = traceTemplate?.trim()
		? traceTemplate.trim()
		: config?.reminderTemplate?.trim()
			? config.reminderTemplate.trim()
			: "[agenthub] Plan reminder injected.";
	const reportLine = extractReminderLine(config?.reminderTemplate, /^0\.\s*Report:/i);
	const firstStep = extractReminderLine(config?.reminderTemplate, /^1\./i);

	return [
		traceBody,
		reportLine,
		firstStep ?? "Follow a structured plan for the current task before continuing.",
	]
		.filter((value): value is string => !!value)
		.join("\n");
};

export const buildQueuedPlanNotice = (
	config?: PlanDetectionConfig,
	signal?: PlanSignal,
): string => {
	return `${buildPlanReminder(
		signal ?? { detected: true, confidence: "high", marker: "classification", matchOffset: 0 },
		config,
	)}\n${INTERNAL_INITIATOR_MARKER}`;
};
