import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { resolvePythonCommand, spawnOptions } from "../src/composer/platform.js";

const pythonCommand = resolvePythonCommand();

const runPython = async ({
	args,
	cwd,
	env,
}: {
	args: string[];
	cwd: string;
	env?: Record<string, string | undefined>;
}) => {
	const child = spawn(pythonCommand, args, {
		...spawnOptions(),
		cwd,
		env: { ...process.env, ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});

	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});

	const code = await new Promise<number>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (exitCode) => resolve(exitCode ?? 0));
	});

	return { code, stdout, stderr };
};

test("vendor_stage_mcps vendors MCP configs and server files from cached source repo", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-vendor-stage-mcps-"));
	try {
		const hrHome = path.join(tempRoot, "hr-home");
		const stageRoot = path.join(hrHome, "staging", "candidate-one", "agenthub-home");
		const workersRoot = path.join(hrHome, "inventory", "workers");
		const cachedRepo = path.join(hrHome, "sources", "github", "sdwo--pathology-vault");
		await Promise.all([
			mkdir(path.join(stageRoot, "bundles"), { recursive: true }),
			mkdir(path.join(stageRoot, "profiles"), { recursive: true }),
			mkdir(path.join(stageRoot, "souls"), { recursive: true }),
			mkdir(workersRoot, { recursive: true }),
			mkdir(path.join(cachedRepo, "mcp"), { recursive: true }),
			mkdir(path.join(cachedRepo, "mcp-servers"), { recursive: true }),
		]);

		await writeFile(
			path.join(stageRoot, "bundles", "pathology-specialist.json"),
			`${JSON.stringify({
				name: "pathology-specialist",
				runtime: "native",
				soul: "pathology-specialist",
				skills: [],
				mcp: ["pubmed_search"],
				agent: { name: "pathology-specialist", mode: "subagent", model: "test-model" },
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(cachedRepo, "mcp", "pubmed_search.json"),
			`${JSON.stringify({
				name: "pubmed_search",
				type: "local",
				command: [
					"node",
					"--import",
					"${LIBRARY_ROOT}/mcp-servers/node_modules/tsx/dist/loader.mjs",
					"${LIBRARY_ROOT}/mcp-servers/pubmed-mcp-server.ts",
				],
				timeout: 30000,
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(cachedRepo, "mcp-servers", "pubmed-mcp-server.ts"),
			"#!/usr/bin/env node\nconsole.log('pubmed server')\n",
			"utf8",
		);
		await writeFile(
			path.join(cachedRepo, "mcp-servers", "package.json"),
			`${JSON.stringify({
				name: "test-mcp-servers",
				version: "1.0.0",
				devDependencies: { tsx: "^4.21.0" },
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(workersRoot, "pathology-profile.json"),
			`${JSON.stringify({
				asset_kind: "profile",
				selected_mcps: ["pubmed_search"],
				artifacts: {
					cached_repo: "sources/github/sdwo--pathology-vault",
				},
			}, null, 2)}\n`,
			"utf8",
		);

		const scriptPath = path.join(process.cwd(), "src", "skills", "hr-support", "bin", "vendor_stage_mcps.py");
		const result = await runPython({
			args: [scriptPath, path.join(hrHome, "staging", "candidate-one")],
			cwd: process.cwd(),
			env: {
				OPENCODE_AGENTHUB_HR_HOME: hrHome,
			},
		});

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Vendored MCP configs:");
		expect(await readFile(path.join(stageRoot, "mcp", "pubmed_search.json"), "utf8")).toContain("pubmed-mcp-server.ts");
		expect(await readFile(path.join(stageRoot, "mcp-servers", "pubmed-mcp-server.ts"), "utf8")).toContain("pubmed server");
		expect(await readFile(path.join(stageRoot, "mcp-servers", "package.json"), "utf8")).toContain("test-mcp-servers");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
}, 15000);

test("validate_staged_package fails when MCP server artifacts are missing", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-validate-stage-mcps-"));
	try {
		const stageRoot = path.join(tempRoot, "stage", "agenthub-home");
		await Promise.all([
			mkdir(path.join(stageRoot, "bundles"), { recursive: true }),
			mkdir(path.join(stageRoot, "profiles"), { recursive: true }),
			mkdir(path.join(stageRoot, "souls"), { recursive: true }),
			mkdir(path.join(stageRoot, "mcp"), { recursive: true }),
		]);
		await writeFile(path.join(stageRoot, "souls", "mcp-lead.md"), "# mcp lead\n", "utf8");
		await writeFile(
			path.join(stageRoot, "bundles", "mcp-lead.json"),
			`${JSON.stringify({
				name: "mcp-lead",
				runtime: "native",
				soul: "mcp-lead",
				skills: [],
				mcp: ["pubmed_search"],
				agent: { name: "mcp-lead", mode: "primary", model: "test-model" },
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(stageRoot, "profiles", "mcp-team.json"),
			`${JSON.stringify({
				name: "mcp-team",
				bundles: ["mcp-lead"],
				defaultAgent: "mcp-lead",
				plugins: ["opencode-agenthub"],
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(stageRoot, "mcp", "pubmed_search.json"),
			`${JSON.stringify({
				name: "pubmed_search",
				type: "local",
				command: ["bun", "${LIBRARY_ROOT}/mcp-servers/pubmed-mcp-server.ts"],
				timeout: 30000,
			}, null, 2)}\n`,
			"utf8",
		);

		const scriptPath = path.join(process.cwd(), "src", "skills", "hr-support", "bin", "validate_staged_package.py");
		const result = await runPython({
			args: [scriptPath, path.join(tempRoot, "stage")],
			cwd: process.cwd(),
		});

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("Missing staged MCP server artifacts referenced by MCP configs");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("validate_staged_package fails when profile defaultAgent does not match bundle agent.name", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-validate-stage-default-agent-"));
	try {
		const stageRoot = path.join(tempRoot, "stage", "agenthub-home");
		await Promise.all([
			mkdir(path.join(stageRoot, "bundles"), { recursive: true }),
			mkdir(path.join(stageRoot, "profiles"), { recursive: true }),
			mkdir(path.join(stageRoot, "souls"), { recursive: true }),
		]);
		await writeFile(path.join(stageRoot, "souls", "coding-lead.md"), "# coding lead\n", "utf8");
		await writeFile(
			path.join(stageRoot, "bundles", "sdwo-coding-first-team-coding-delivery-lead.json"),
			`${JSON.stringify({
				name: "sdwo-coding-first-team-coding-delivery-lead",
				runtime: "native",
				soul: "coding-lead",
				skills: [],
				agent: {
					name: "coding-delivery-lead",
					mode: "primary",
					model: "test-model",
				},
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(stageRoot, "profiles", "coding-team.json"),
			`${JSON.stringify({
				name: "coding-team",
				bundles: ["sdwo-coding-first-team-coding-delivery-lead"],
				defaultAgent: "sdwo-coding-first-team-coding-delivery-lead",
				plugins: ["opencode-agenthub"],
				nativeAgentPolicy: "team-only",
			}, null, 2)}\n`,
			"utf8",
		);

		const scriptPath = path.join(process.cwd(), "src", "skills", "hr-support", "bin", "validate_staged_package.py");
		const result = await runPython({
			args: [scriptPath, path.join(tempRoot, "stage")],
			cwd: process.cwd(),
		});

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("defaultAgent 'sdwo-coding-first-team-coding-delivery-lead'");
		expect(result.stderr).toContain("bundle agent.name 'coding-delivery-lead'");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("validate_staged_package requires defaultAgent for team-only profiles", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-validate-stage-team-only-default-"));
	try {
		const stageRoot = path.join(tempRoot, "stage", "agenthub-home");
		await Promise.all([
			mkdir(path.join(stageRoot, "bundles"), { recursive: true }),
			mkdir(path.join(stageRoot, "profiles"), { recursive: true }),
			mkdir(path.join(stageRoot, "souls"), { recursive: true }),
		]);
		await writeFile(path.join(stageRoot, "souls", "coding-lead.md"), "# coding lead\n", "utf8");
		await writeFile(
			path.join(stageRoot, "bundles", "coding-lead.json"),
			`${JSON.stringify({
				name: "coding-lead",
				runtime: "native",
				soul: "coding-lead",
				skills: [],
				agent: {
					name: "coding-delivery-lead",
					mode: "primary",
					model: "test-model",
				},
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(stageRoot, "profiles", "coding-team.json"),
			`${JSON.stringify({
				name: "coding-team",
				bundles: ["coding-lead"],
				plugins: ["opencode-agenthub"],
				nativeAgentPolicy: "team-only",
			}, null, 2)}\n`,
			"utf8",
		);

		const scriptPath = path.join(process.cwd(), "src", "skills", "hr-support", "bin", "validate_staged_package.py");
		const result = await runPython({
			args: [scriptPath, path.join(tempRoot, "stage")],
			cwd: process.cwd(),
		});

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("team-only");
		expect(result.stderr).toContain("must set defaultAgent");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("validate_staged_package fails when team-only profile has only subagents", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-validate-stage-all-subagents-"));
	try {
		const stageRoot = path.join(tempRoot, "stage", "agenthub-home");
		await Promise.all([
			mkdir(path.join(stageRoot, "bundles"), { recursive: true }),
			mkdir(path.join(stageRoot, "profiles"), { recursive: true }),
			mkdir(path.join(stageRoot, "souls"), { recursive: true }),
		]);
		await writeFile(path.join(stageRoot, "souls", "reviewer.md"), "# reviewer\n", "utf8");
		await writeFile(
			path.join(stageRoot, "bundles", "reviewer.json"),
			`${JSON.stringify({
				name: "reviewer",
				runtime: "native",
				soul: "reviewer",
				skills: [],
				agent: {
					name: "reviewer",
					mode: "subagent",
					model: "test-model",
				},
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(stageRoot, "profiles", "review-team.json"),
			`${JSON.stringify({
				name: "review-team",
				bundles: ["reviewer"],
				defaultAgent: "reviewer",
				plugins: ["opencode-agenthub"],
				nativeAgentPolicy: "team-only",
			}, null, 2)}\n`,
			"utf8",
		);

		const scriptPath = path.join(process.cwd(), "src", "skills", "hr-support", "bin", "validate_staged_package.py");
		const result = await runPython({
			args: [scriptPath, path.join(tempRoot, "stage")],
			cwd: process.cwd(),
		});

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("at least one primary");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});
