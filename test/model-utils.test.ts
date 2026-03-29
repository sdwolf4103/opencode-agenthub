import { expect, test } from "bun:test";
import { normalizeModelSelection, parseModelString, pickModelSelection } from "../src/composer/model-utils.js";

test("parseModelString keeps plain models unchanged", () => {
	expect(parseModelString("github-copilot/gpt-5.4")).toEqual({ model: "github-copilot/gpt-5.4" });
});

test("parseModelString splits model and variant on whitespace", () => {
	expect(parseModelString("github-copilot/gpt-5.4 xhigh")).toEqual({
		model: "github-copilot/gpt-5.4",
		variant: "xhigh",
	});
});

test("parseModelString supports multi-word variants", () => {
	expect(parseModelString("github-copilot/claude-opus-4.6 very high")).toEqual({
		model: "github-copilot/claude-opus-4.6",
		variant: "very high",
	});
});

test("normalizeModelSelection prefers explicit variant over parsed variant", () => {
	expect(normalizeModelSelection("github-copilot/gpt-5.4 xhigh", "high")).toEqual({
		model: "github-copilot/gpt-5.4",
		variant: "high",
	});
});

test("pickModelSelection chooses first model and first variant across sources", () => {
	expect(
		pickModelSelection(
			{ model: "github-copilot/gpt-5.4", variant: "xhigh" },
			{ model: "openai/gpt-5.4", variant: "high" },
		),
	).toEqual({
		model: "github-copilot/gpt-5.4",
		variant: "xhigh",
	});
});
