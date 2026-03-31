import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("cli-home helpers parse commented json and derive workspace paths", async () => {
	const { readJsonIfExists, workspacePreferencesPath, toWorkspaceEnvrc } = await import(
		"../src/composer/cli-home.js"
	);
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-cli-home-"));
	try {
		const workspace = path.join(tempRoot, "workspace");
		const settingsPath = path.join(tempRoot, "settings.jsonc");
		await writeFile(
			settingsPath,
			`// comment\n{\n  "start": { "lastProfile": "auto" }\n}\n`,
			"utf8",
		);

		const parsed = await readJsonIfExists<{ start?: { lastProfile?: string } }>(settingsPath);
		expect(parsed?.start?.lastProfile).toBe("auto");
		expect(workspacePreferencesPath(workspace)).toBe(path.join(workspace, ".opencode-agenthub.user.json"));
		expect(toWorkspaceEnvrc(workspace, path.join(workspace, ".opencode-agenthub", "current"))).toContain(
			'export OPENCODE_CONFIG_DIR=',
		);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("cli-scaffold helpers write newline-terminated json files", async () => {
	const { toJsonFile, writeJsonFile } = await import("../src/composer/cli-scaffold.js");
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-cli-scaffold-"));
	try {
		const filePath = toJsonFile(tempRoot, "profiles", "review-team");
		await writeJsonFile(filePath, { name: "review-team", bundles: ["auto"] });
		const contents = await readFile(filePath, "utf8");
		expect(contents).toContain('"name": "review-team"');
		expect(contents.endsWith("\n")).toBe(true);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("cli-hr-bootstrap helpers count configured HR sources", async () => {
	const { countConfiguredHrGithubSources, countConfiguredHrModelCatalogSources } = await import(
		"../src/composer/cli-hr-bootstrap.js"
	);
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-cli-hr-"));
	try {
		await writeFile(
			path.join(tempRoot, "hr-config.json"),
			`${JSON.stringify({
				sources: {
					github: [{ repo: "foo/bar" }, { repo: "baz/qux" }],
					models: [{ url: "https://example.test/api.json" }],
				},
			}, null, 2)}\n`,
			"utf8",
		);

		expect(await countConfiguredHrGithubSources(tempRoot)).toBe(2);
		expect(await countConfiguredHrModelCatalogSources(tempRoot)).toBe(1);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});
