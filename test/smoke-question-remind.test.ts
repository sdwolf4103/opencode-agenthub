import { expect, test } from "bun:test";
import createQuestionPlugin from "../src/plugins/opencode-question.js";

const WRAPPED_CONTINUATION_TEXT = [
	"<system-reminder>",
	"The user sent the following message:",
	"Continue the current task using the latest context.",
	"",
	"Please address this message and continue with your tasks.",
	"</system-reminder>",
].join("\n");

test("question plugin registers commands and injects one-shot reminders", async () => {
	const hooks = await createQuestionPlugin();

	const config = {} as { command?: Record<string, unknown> };
	await hooks.config?.(config);

	expect(config.command).toBeDefined();
	expect(config.command).toHaveProperty("question");
	expect(config.command).toHaveProperty("remind");

	const sessionID = "session-1";
	const controlLeakTexts = [
		"Follow the current system instruction about ending with question().",
		"A plugin may provide a one-shot reminder for this command; if present, integrate it into the ongoing work and continue.",
	];

	const questionCommandOutput = {
		parts: [
			{
				type: "text",
				text: "Continue the current conversation directly from the latest context. Do not restart the task or reframe it as a new topic. Follow the current system instruction about ending with question().",
			},
		],
	};

	await hooks["command.execute.before"]?.(
		{ command: "question", sessionID, arguments: "" },
		questionCommandOutput,
	);

	expect(questionCommandOutput.parts).toHaveLength(1);
	expect(questionCommandOutput.parts[0]).toMatchObject({
		type: "text",
		text: "Continue the current task using the latest context.",
	});
	for (const leakText of controlLeakTexts) {
		expect(JSON.stringify(questionCommandOutput.parts)).not.toContain(leakText);
	}

	const questionSystem = { system: ["base-system"] };
	await hooks["experimental.chat.system.transform"]?.(
		{ sessionID, model: {} as never },
		questionSystem,
	);

	expect(questionSystem.system.some((entry) => entry.includes("QUESTION_COMMAND_ACTIVE"))).toBe(true);

	const remindCommandOutput = {
		parts: [
			{
				type: "text",
				text: "Continue the current conversation directly from the latest context. Do not restart the task or reframe it as a new topic. A plugin may provide a one-shot reminder for this command; if present, integrate it into the ongoing work and continue.",
			},
		],
	};

	await hooks["command.execute.before"]?.(
		{ command: "remind", sessionID, arguments: "keep question and continue current task" },
		remindCommandOutput,
	);

	expect(remindCommandOutput.parts).toHaveLength(1);
	expect(remindCommandOutput.parts[0]).toMatchObject({
		type: "text",
		text: "Continue the current task using the latest context.",
	});
	for (const leakText of controlLeakTexts) {
		expect(JSON.stringify(remindCommandOutput.parts)).not.toContain(leakText);
	}

	const remindSystem = { system: ["base-system"] };
	await hooks["experimental.chat.system.transform"]?.(
		{ sessionID, model: {} as never },
		remindSystem,
	);

	expect(remindSystem.system.some((entry) => entry.includes("QUESTION_COMMAND_ACTIVE"))).toBe(true);
	expect(remindSystem.system.some((entry) => entry.includes("REMIND_COMMAND_ACTIVE"))).toBe(true);
	expect(remindSystem.system.some((entry) => entry.includes("keep question and continue current task"))).toBe(true);

	await hooks.event?.({ event: { type: "session.idle", properties: { sessionID } } } as never);

	const clearedSystem = { system: ["base-system"] };
	await hooks["experimental.chat.system.transform"]?.(
		{ sessionID, model: {} as never },
		clearedSystem,
	);

	expect(clearedSystem.system).toEqual(["base-system"]);
});

test("messages.transform filters continuation message when question is active", async () => {
	const hooks = await createQuestionPlugin();

	await hooks.config?.({} as { command?: Record<string, unknown> });

	const sessionID = "session-filter-test";

	await hooks["command.execute.before"]?.(
		{ command: "question", sessionID, arguments: "" },
		{ parts: [{ type: "text", text: "original question template" }] },
	);

	const messages = [
		{
			info: { sessionID, role: "user", id: "msg-1" },
			parts: [{ type: "text", text: "Original user question" }],
		},
		{
			info: { sessionID, role: "assistant", id: "msg-2" },
			parts: [{ type: "text", text: "Assistant response" }],
		},
		{
			info: { sessionID, role: "user", id: "msg-3" },
			parts: [{ type: "text", text: "Continue the current task using the latest context." }],
		},
		{
			info: { sessionID, role: "assistant", id: "msg-4" },
			parts: [{ type: "text", text: "Final answer" }],
		},
	];

	const output = { messages: [...messages] };
	await hooks["experimental.chat.messages.transform"]?.({}, output);

	expect(output.messages).toHaveLength(3);
	expect(output.messages.some((m: { parts: { text: string }[] }) => m.parts.some((p) => p.text === "Original user question"))).toBe(true);
	expect(output.messages.some((m: { parts: { text: string }[] }) => m.parts.some((p) => p.text === "Continue the current task using the latest context."))).toBe(false);
});

test("messages.transform filters continuation message when remind is active", async () => {
	const hooks = await createQuestionPlugin();

	await hooks.config?.({} as { command?: Record<string, unknown> });

	const sessionID = "session-remind-filter";

	await hooks["command.execute.before"]?.(
		{ command: "remind", sessionID, arguments: "test reminder" },
		{ parts: [{ type: "text", text: "original remind template" }] },
	);

	const messages = [
		{
			info: { sessionID, role: "user", id: "msg-1" },
			parts: [{ type: "text", text: "Continue the current task using the latest context." }],
		},
		{
			info: { sessionID, role: "assistant", id: "msg-2" },
			parts: [{ type: "text", text: "Assistant response" }],
		},
	];

	const output = { messages: [...messages] };
	await hooks["experimental.chat.messages.transform"]?.({}, output);

	expect(output.messages).toHaveLength(1);
	expect(output.messages[0].info.role).toBe("assistant");
});

test("messages.transform filters wrapped continuation message from real host shape", async () => {
	const hooks = await createQuestionPlugin();

	await hooks.config?.({} as { command?: Record<string, unknown> });

	const sessionID = "session-wrapped-filter";

	await hooks["command.execute.before"]?.(
		{ command: "question", sessionID, arguments: "" },
		{ parts: [{ type: "text", text: "original question template" }] },
	);

	const messages = [
		{
			info: { sessionID, role: "user", id: "msg-1" },
			parts: [{ type: "text", text: WRAPPED_CONTINUATION_TEXT }],
		},
		{
			info: { sessionID, role: "assistant", id: "msg-2" },
			parts: [{ type: "text", text: "Assistant response" }],
		},
	];

	const output = { messages: [...messages] };
	await hooks["experimental.chat.messages.transform"]?.({}, output);

	expect(output.messages).toHaveLength(1);
	expect(output.messages[0].info.role).toBe("assistant");
	expect(output.messages[0].parts[0].text).toBe("Assistant response");
});

test("messages.transform filters continuation message with trailing newline text part", async () => {
	const hooks = await createQuestionPlugin();

	await hooks.config?.({} as { command?: Record<string, unknown> });

	const sessionID = "session-trailing-newline";

	await hooks["command.execute.before"]?.(
		{ command: "question", sessionID, arguments: "" },
		{ parts: [{ type: "text", text: "original question template" }] },
	);

	const messages = [
		{
			info: { sessionID, role: "user", id: "msg-1" },
			parts: [
				{ text: "Continue the current task using the latest context." },
				{ text: "\n" },
			],
		},
		{
			info: { sessionID, role: "assistant", id: "msg-2" },
			parts: [{ type: "text", text: "Assistant response" }],
		},
	];

	const output = { messages: [...messages] };
	await hooks["experimental.chat.messages.transform"]?.({}, output);

	expect(output.messages).toHaveLength(1);
	expect(output.messages[0].info.role).toBe("assistant");
});

test("messages.transform filters wrapped continuation message with trailing newline text part", async () => {
	const hooks = await createQuestionPlugin();

	await hooks.config?.({} as { command?: Record<string, unknown> });

	const sessionID = "session-wrapped-trailing-newline";

	await hooks["command.execute.before"]?.(
		{ command: "remind", sessionID, arguments: "test reminder" },
		{ parts: [{ type: "text", text: "original remind template" }] },
	);

	const messages = [
		{
			info: { sessionID, role: "user", id: "msg-1" },
			parts: [
				{ text: WRAPPED_CONTINUATION_TEXT },
				{ text: "\n" },
			],
		},
		{
			info: { sessionID, role: "assistant", id: "msg-2" },
			parts: [{ type: "text", text: "Assistant response" }],
		},
	];

	const output = { messages: [...messages] };
	await hooks["experimental.chat.messages.transform"]?.({}, output);

	expect(output.messages).toHaveLength(1);
	expect(output.messages[0].info.role).toBe("assistant");
});

test("messages.transform filters flat provider-visible continuation message without session metadata", async () => {
	const hooks = await createQuestionPlugin();

	await hooks.config?.({} as { command?: Record<string, unknown> });

	const sessionID = "session-flat-provider-shape";

	await hooks["command.execute.before"]?.(
		{ command: "remind", sessionID, arguments: "github" },
		{ parts: [{ type: "text", text: "original remind template" }] },
	);

	const output = {
		messages: [
			{
				role: "user",
				parts: [
					{ text: "Continue the current task using the latest context." },
					{ text: "\n" },
				],
			},
			{
				role: "model",
				parts: [{ text: "Assistant response" }],
			},
		],
	};

	await hooks["experimental.chat.messages.transform"]?.({}, output);

	expect(output.messages).toHaveLength(1);
	expect(output.messages[0].role).toBe("model");
	expect(output.messages[0].parts[0].text).toBe("Assistant response");
});

test("messages.transform filters flat wrapped continuation message without session metadata", async () => {
	const hooks = await createQuestionPlugin();

	await hooks.config?.({} as { command?: Record<string, unknown> });

	const sessionID = "session-flat-wrapped-provider-shape";

	await hooks["command.execute.before"]?.(
		{ command: "question", sessionID, arguments: "" },
		{ parts: [{ type: "text", text: "original question template" }] },
	);

	const output = {
		messages: [
			{
				role: "user",
				parts: [
					{ text: WRAPPED_CONTINUATION_TEXT },
					{ text: "\n" },
				],
			},
			{
				role: "model",
				parts: [{ text: "Assistant response" }],
			},
		],
	};

	await hooks["experimental.chat.messages.transform"]?.({}, output);

	expect(output.messages).toHaveLength(1);
	expect(output.messages[0].role).toBe("model");
	expect(output.messages[0].parts[0].text).toBe("Assistant response");
});

test("messages.transform does NOT filter normal user messages", async () => {
	const hooks = await createQuestionPlugin();

	await hooks.config?.({} as { command?: Record<string, unknown> });

	const sessionID = "session-no-filter";

	const messages = [
		{
			info: { sessionID, role: "user", id: "msg-1" },
			parts: [{ type: "text", text: "This is a normal user message" }],
		},
		{
			info: { sessionID, role: "assistant", id: "msg-2" },
			parts: [{ type: "text", text: "Normal assistant response" }],
		},
	];

	const output = { messages: [...messages] };
	await hooks["experimental.chat.messages.transform"]?.({}, output);

	expect(output.messages).toHaveLength(2);
	expect(output.messages[0].info.role).toBe("user");
	expect(output.messages[0].parts[0].text).toBe("This is a normal user message");
});

test("messages.transform does NOT filter continuation messages from other sessions", async () => {
	const hooks = await createQuestionPlugin();

	await hooks.config?.({} as { command?: Record<string, unknown> });

	const activeSession = "session-active";
	const otherSession = "session-other";

	await hooks["command.execute.before"]?.(
		{ command: "question", sessionID: activeSession, arguments: "" },
		{ parts: [{ type: "text", text: "question template" }] },
	);

	const messages = [
		{
			info: { sessionID: otherSession, role: "user", id: "msg-1" },
			parts: [{ type: "text", text: "Continue the current task using the latest context." }],
		},
		{
			info: { sessionID: activeSession, role: "user", id: "msg-2" },
			parts: [{ type: "text", text: "Continue the current task using the latest context." }],
		},
		{
			info: { sessionID: activeSession, role: "assistant", id: "msg-3" },
			parts: [{ type: "text", text: "Response" }],
		},
	];

	const output = { messages: [...messages] };
	await hooks["experimental.chat.messages.transform"]?.({}, output);

	expect(output.messages).toHaveLength(2);
	expect(output.messages[0].info.sessionID).toBe(otherSession);
	expect(output.messages[0].parts[0].text).toBe("Continue the current task using the latest context.");
	expect(output.messages[1].info.sessionID).toBe(activeSession);
	expect(output.messages[1].info.role).toBe("assistant");
});

test("messages.transform does NOT filter wrapped continuation messages from other sessions", async () => {
	const hooks = await createQuestionPlugin();

	await hooks.config?.({} as { command?: Record<string, unknown> });

	const activeSession = "session-active-wrapped";
	const otherSession = "session-other-wrapped";

	await hooks["command.execute.before"]?.(
		{ command: "remind", sessionID: activeSession, arguments: "test reminder" },
		{ parts: [{ type: "text", text: "remind template" }] },
	);

	const messages = [
		{
			info: { sessionID: otherSession, role: "user", id: "msg-1" },
			parts: [{ type: "text", text: WRAPPED_CONTINUATION_TEXT }],
		},
		{
			info: { sessionID: activeSession, role: "user", id: "msg-2" },
			parts: [{ type: "text", text: WRAPPED_CONTINUATION_TEXT }],
		},
		{
			info: { sessionID: activeSession, role: "assistant", id: "msg-3" },
			parts: [{ type: "text", text: "Response" }],
		},
	];

	const output = { messages: [...messages] };
	await hooks["experimental.chat.messages.transform"]?.({}, output);

	expect(output.messages).toHaveLength(2);
	expect(output.messages[0].info.sessionID).toBe(otherSession);
	expect(output.messages[0].parts[0].text).toBe(WRAPPED_CONTINUATION_TEXT);
	expect(output.messages[1].info.sessionID).toBe(activeSession);
	expect(output.messages[1].info.role).toBe("assistant");
});
