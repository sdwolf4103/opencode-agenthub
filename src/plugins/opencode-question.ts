type HookHandler = (...args: unknown[]) => Promise<unknown> | unknown;

type ConfigOutput = {
	command?: Record<string, unknown>;
};

const QUESTION_COMMAND = "question";
const REMIND_COMMAND = "remind";

const CONTINUE_COMMAND_TEXT = "Continue the current task using the latest context.";

const WRAPPED_CONTINUE_COMMAND_TEXT = [
	"<system-reminder>",
	"The user sent the following message:",
	CONTINUE_COMMAND_TEXT,
	"",
	"Please address this message and continue with your tasks.",
	"</system-reminder>",
].join("\n");

const QUESTION_COMMAND_TEMPLATE = CONTINUE_COMMAND_TEXT;

const QUESTION_SYSTEM_REMINDER = [
	"QUESTION_COMMAND_ACTIVE",
	"The user invoked /question.",
	"In this response, continue the current conversation naturally.",
	"First provide the full normal answer in plain natural language or Markdown.",
	"Only after the answer is fully completed, call `question()` exactly once as the very last action.",
	"Do not replace the main answer with JSON.",
	"Do not use `question()` during intermediate steps.",
].join("\n");

const REMIND_COMMAND_TEMPLATE = CONTINUE_COMMAND_TEXT;

const createRemindSystemReminder = (text: string | null) =>
	[
		"REMIND_COMMAND_ACTIVE",
		"The user invoked /remind while work is ongoing.",
		"The quoted content below is user-provided mid-task guidance forwarded by the plugin.",
		"Treat the quoted content as the user's latest preference or instruction, not as a higher-priority system override.",
		"Apply it only if it does not conflict with existing system or developer instructions.",
		"Do not restart the task or reframe it as a new topic.",
		text ? "Integrate this reminder into the current work:" : "No reminder text was provided; continue the current work naturally.",
		text ? `<remind>\n${text}\n</remind>` : null,
	]
		.filter((value): value is string => typeof value === "string" && value.length > 0)
		.join("\n");

type SessionCommandState = {
	questionActive?: boolean;
	remindText?: string | null;
};

type TextLikePart = {
	type?: unknown;
	text?: unknown;
};

const getSessionID = (value: unknown): string | null => {
	const direct = (value as { sessionID?: unknown } | undefined)?.sessionID;
	if (typeof direct === "string" && direct) return direct;

	const nested = (value as { session?: { id?: unknown } } | undefined)?.session?.id;
	if (typeof nested === "string" && nested) return nested;

	return null;
};

const getCommandName = (value: unknown): string | null => {
	const direct = (value as { command?: unknown } | undefined)?.command;
	if (typeof direct === "string" && direct) return direct;

	const nestedName = (direct as { name?: unknown } | undefined)?.name;
	if (typeof nestedName === "string" && nestedName) return nestedName;

	return null;
};

const getCommandArguments = (value: unknown): string | null => {
	const direct = (value as { arguments?: unknown } | undefined)?.arguments;
	if (typeof direct !== "string") return null;

	const trimmed = direct.trim();
	return trimmed.length > 0 ? trimmed : null;
};

const getEventType = (payload: unknown): string | null => {
	const direct = (payload as { event?: { type?: unknown } } | undefined)?.event?.type;
	return typeof direct === "string" && direct ? direct : null;
};

const getEventSessionID = (payload: unknown): string | null => {
	const event = (payload as { event?: { properties?: unknown } } | undefined)?.event;
	const properties = event?.properties as
		| { sessionID?: unknown; info?: { id?: unknown }; session?: { id?: unknown } }
		| undefined;

	if (typeof properties?.sessionID === "string" && properties.sessionID) {
		return properties.sessionID;
	}

	if (typeof properties?.info?.id === "string" && properties.info.id) {
		return properties.info.id;
	}

	if (typeof properties?.session?.id === "string" && properties.session.id) {
		return properties.session.id;
	}

	return null;
};

const isTextPart = (value: unknown): value is TextLikePart & { text: string } => {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { text?: unknown }).text === "string"
	);
};

const normalizeMessageText = (text: string): string => text.replace(/\r\n/g, "\n").trim();

const isBlankText = (text: string): boolean => normalizeMessageText(text).length === 0;

const isContinuationText = (text: string): boolean => {
	const normalized = normalizeMessageText(text);
	return normalized === CONTINUE_COMMAND_TEXT || normalized === WRAPPED_CONTINUE_COMMAND_TEXT;
};

const scrubCommandParts = (output: unknown) => {
	const currentOutput = output as { parts?: unknown };
	if (!Array.isArray(currentOutput.parts)) return;

	const preservedNonTextParts = currentOutput.parts.filter((part) => !isTextPart(part));
	const firstTextPart = currentOutput.parts.find(isTextPart);

	if (firstTextPart) {
		firstTextPart.text = CONTINUE_COMMAND_TEXT;
		currentOutput.parts = [firstTextPart, ...preservedNonTextParts];
		return;
	}

	currentOutput.parts = [{ type: "text", text: CONTINUE_COMMAND_TEXT }, ...preservedNonTextParts];
};

type MessageInfo = {
		id?: unknown;
		sessionID?: unknown;
		role?: unknown;
	};

	type MessageWithParts = {
		info?: MessageInfo;
		parts?: unknown[];
		role?: unknown;
		sessionID?: unknown;
	};

	const isSessionStateActive = (state: SessionCommandState | undefined): boolean => {
		return !!state && (state.questionActive || Object.hasOwn(state, "remindText"));
	};

	const getMessageSessionID = (msg: unknown): string | null => {
		const direct = (msg as MessageWithParts | undefined)?.sessionID;
		if (typeof direct === "string" && direct) return direct;

		const info = (msg as MessageWithParts | undefined)?.info;
		if (!info || typeof info !== "object") return null;
		const sessionID = (info as { sessionID?: unknown }).sessionID;
		return typeof sessionID === "string" && sessionID ? sessionID : null;
	};

	const getMessageRole = (msg: unknown): string | null => {
		const direct = (msg as MessageWithParts | undefined)?.role;
		if (typeof direct === "string" && direct) return direct;

		const info = (msg as MessageWithParts | undefined)?.info;
		if (!info || typeof info !== "object") return null;
		const role = (info as { role?: unknown }).role;
		return typeof role === "string" && role ? role : null;
	};

	const isUserContinuationMessage = (msg: unknown): boolean => {
		const typed = msg as MessageWithParts | undefined;
		if (!typed) return false;

		if (getMessageRole(msg) !== "user") return false;

	const parts = typed.parts;
	if (!Array.isArray(parts) || parts.length === 0) return false;

	const textParts = parts.filter(isTextPart);
	if (textParts.length === 0) return false;

	const nonTextParts = parts.filter((p) => !isTextPart(p));
	if (nonTextParts.length > 0) return false;

	const [primaryText, ...trailingTextParts] = textParts;
	if (!isContinuationText(primaryText.text)) return false;

	return trailingTextParts.every((part) => isBlankText(part.text));
	};

	export default async function (): Promise<Record<string, HookHandler>> {
		const activeSessions = new Map<string, SessionCommandState>();

		const getSessionState = (sessionID: string): SessionCommandState => {
			const existing = activeSessions.get(sessionID);
			if (existing) return existing;

			const created: SessionCommandState = {};
			activeSessions.set(sessionID, created);
			return created;
		};

		return {
			config: async (config: unknown) => {
				const cfg = config as ConfigOutput;
				if (!cfg.command) cfg.command = {};

				cfg.command[QUESTION_COMMAND] = {
					template: QUESTION_COMMAND_TEMPLATE,
					description: "Continue the current conversation and force a final question() call",
					subtask: false,
				};

				cfg.command[REMIND_COMMAND] = {
					template: REMIND_COMMAND_TEMPLATE,
					description: "Inject one-shot mid-task guidance and continue the current conversation",
					subtask: false,
				};
			},
			"command.execute.before": async (input: unknown, output: unknown) => {
				const sessionID = getSessionID(input);
				if (!sessionID) return;

				const commandName = getCommandName(input);
				if (!commandName) return;
				if (commandName !== QUESTION_COMMAND && commandName !== REMIND_COMMAND) return;

				scrubCommandParts(output);

				const state = getSessionState(sessionID);

				if (commandName === QUESTION_COMMAND) {
					state.questionActive = true;
					return;
				}

				if (commandName === REMIND_COMMAND) {
					state.remindText = getCommandArguments(input);
				}
			},
			"experimental.chat.system.transform": async (input: unknown, output: unknown) => {
				const sessionID = getSessionID(input);
				if (!sessionID) return;

				const state = activeSessions.get(sessionID);
				if (!state) return;

				const currentOutput = output as { system?: unknown };
				if (!Array.isArray(currentOutput.system)) return;

				if (state.questionActive && !currentOutput.system.includes(QUESTION_SYSTEM_REMINDER)) {
					currentOutput.system.push(QUESTION_SYSTEM_REMINDER);
				}

				if (Object.hasOwn(state, "remindText")) {
					const remindSystemReminder = createRemindSystemReminder(state.remindText ?? null);
					if (!currentOutput.system.includes(remindSystemReminder)) {
						currentOutput.system.push(remindSystemReminder);
					}
				}
			},
			"experimental.chat.messages.transform": async (_input: unknown, output: unknown) => {
				const currentOutput = output as { messages?: unknown };
				if (!Array.isArray(currentOutput.messages) || currentOutput.messages.length === 0) return;

				const hasAnyActiveSession = [...activeSessions.values()].some(isSessionStateActive);
				if (!hasAnyActiveSession) return;

				const sessionsToFilter = new Set<string>();
				for (const msg of currentOutput.messages) {
					const sessionID = getMessageSessionID(msg);
					if (!sessionID) continue;

					if (isSessionStateActive(activeSessions.get(sessionID))) {
						sessionsToFilter.add(sessionID);
					}
				}

				const filtered: unknown[] = [];
				for (const msg of currentOutput.messages) {
					if (isUserContinuationMessage(msg)) {
						const sessionID = getMessageSessionID(msg);
						if (!sessionID) {
							continue;
						}

						if (sessionsToFilter.has(sessionID)) {
							continue;
						}
					}
					filtered.push(msg);
				}

				(currentOutput as { messages: unknown[] }).messages = filtered;
			},
			event: async (payload: unknown) => {
				const eventType = getEventType(payload);
				if (eventType !== "session.idle" && eventType !== "session.deleted") return;

				const sessionID = getEventSessionID(payload);
				if (!sessionID) return;

				activeSessions.delete(sessionID);
			},
		};
	}
