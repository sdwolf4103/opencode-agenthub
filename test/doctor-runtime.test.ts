import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { spawn } from "node:child_process";

const cliEntry = path.resolve("src/composer/opencode-profile.ts");

const runCli = async ({
	args,
	cwd,
	env,
}: {
	args: string[];
	cwd: string;
	env?: Record<string, string | undefined>;
}) =>
	new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
		const child = spawn("bun", [cliEntry, ...args], {
			cwd,
			env: {
				...process.env,
				...env,
			},
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
		child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
	});

test("doctor --json returns structured report with verdict and remediation", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-doctor-json-"));
	try {
		const targetRoot = path.join(tempRoot, "agenthub-home");
		await mkdir(targetRoot, { recursive: true });
		const result = await runCli({
			args: ["doctor", "--target-root", targetRoot, "--json"],
			cwd: tempRoot,
		});
		expect(result.code).toBe(1);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.verdict).toBeTruthy();
		expect(Array.isArray(parsed.issues)).toBe(true);
		expect(parsed.issues[0].checkId).toBeTruthy();
		expect(parsed.issues[0].remediation).toBeTruthy();
		expect(typeof parsed.issues[0].autoFixable).toBe("boolean");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("doctor --quiet and --strict use verdict-based exit codes", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-doctor-quiet-"));
	try {
		const targetRoot = path.join(tempRoot, "agenthub-home");
		const homeDir = path.join(tempRoot, "home");
		const globalOmoDir = path.join(homeDir, ".config", "opencode");
		await mkdir(path.join(targetRoot, "profiles"), { recursive: true });
		await mkdir(path.join(targetRoot, "bundles"), { recursive: true });
		await mkdir(path.join(targetRoot, "souls"), { recursive: true });
		await mkdir(path.join(targetRoot, "skills", "unused-skill"), { recursive: true });
		await mkdir(globalOmoDir, { recursive: true });
		await writeFile(
			path.join(targetRoot, "settings.json"),
			`${JSON.stringify({
				guards: {
					read_only: { description: "ro" },
					no_task: { description: "nt" },
				},
				omo: { defaultCategoryModel: "github-copilot/gpt-5.4" },
			}, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(globalOmoDir, "oh-my-opencode.json"),
			`${JSON.stringify({ categories: { review: { model: "github-copilot/gpt-5.4" } } }, null, 2)}\n`,
			"utf8",
		);
		await writeFile(path.join(targetRoot, "souls", "auto.md"), "# auto\n", "utf8");
		await writeFile(path.join(targetRoot, "skills", "unused-skill", "SKILL.md"), "# unused\n", "utf8");
		await writeFile(
			path.join(targetRoot, "bundles", "auto.json"),
			`${JSON.stringify({ name: "auto", runtime: "native", soul: "auto", skills: [], agent: { name: "auto", mode: "primary" } }, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(targetRoot, "profiles", "auto.json"),
			`${JSON.stringify({ name: "auto", bundles: ["auto"], defaultAgent: "auto", plugins: ["opencode-agenthub"] }, null, 2)}\n`,
			"utf8",
		);

		const normal = await runCli({
			args: ["doctor", "--target-root", targetRoot, "--quiet"],
			cwd: tempRoot,
			env: {
				HOME: homeDir,
			},
		});
		expect(normal.code).toBe(0);
		expect(normal.stdout).toContain("warnings");

		const strict = await runCli({
			args: ["doctor", "--target-root", targetRoot, "--quiet", "--strict"],
			cwd: tempRoot,
			env: {
				HOME: homeDir,
			},
		});
		expect(strict.code).toBe(1);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("plugin doctor warns about deprecation and routes through doctor", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-plugin-doctor-alias-"));
	try {
		const workspace = path.join(tempRoot, "workspace");
		await mkdir(workspace, { recursive: true });
		const result = await runCli({
			args: ["plugin", "doctor", "--config-root", path.join(tempRoot, "missing-config")],
			cwd: workspace,
		});
		expect(result.stderr).toContain("deprecated");
		expect(result.stdout).toContain("Doctor:");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("doctor --category=plugin only runs plugin/runtime diagnostics", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-doctor-plugin-category-"));
	try {
		const targetRoot = path.join(tempRoot, "agenthub-home");
		const configRoot = path.join(tempRoot, "missing-config");
		await mkdir(targetRoot, { recursive: true });
		const result = await runCli({
			args: ["doctor", "--target-root", targetRoot, "--config-root", configRoot, "--json", "--category", "plugin"],
			cwd: tempRoot,
		});
		expect(result.code).toBe(0);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.issues.some((issue: { checkId?: string }) => issue.checkId === "plugin/runtime-config")).toBe(true);
		expect(parsed.issues.some((issue: { type?: string }) => issue.type === "missing_guards")).toBe(false);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("doctor --category=workspace requires config root", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-doctor-workspace-category-"));
	try {
		const targetRoot = path.join(tempRoot, "agenthub-home");
		await mkdir(targetRoot, { recursive: true });
		const result = await runCli({
			args: ["doctor", "--target-root", targetRoot, "--json", "--category", "workspace"],
			cwd: tempRoot,
		});
		expect(result.code).toBe(1);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.issues.some((issue: { checkId?: string }) => issue.checkId === "workspace/runtime-root")).toBe(true);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("doctor --category=environment reports toolchain health", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-doctor-environment-category-"));
	try {
		const targetRoot = path.join(tempRoot, "agenthub-home");
		await mkdir(targetRoot, { recursive: true });
		const result = await runCli({
			args: ["doctor", "--target-root", targetRoot, "--json", "--category", "environment"],
			cwd: tempRoot,
		});
		expect(result.code).toBe(0);
		const parsed = JSON.parse(result.stdout);
		expect(Array.isArray(parsed.healthy)).toBe(true);
		expect(parsed.healthy.some((item: string) => item.includes("Node.js available"))).toBe(true);
		expect(parsed.healthy.some((item: string) => item.includes("Python available") || item.includes("opencode available"))).toBe(true);
		expect(parsed.issues.some((issue: { checkId?: string }) => issue.checkId === "missing_guards")).toBe(false);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});
