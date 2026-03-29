import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { detectPackageManagerForRoot } from "../src/composer/package-manager.js";

test("detectPackageManagerForRoot respects supported packageManager field", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-pm-supported-"));
	try {
		await writeFile(
			path.join(tempRoot, "package.json"),
			`${JSON.stringify({ packageManager: "npm@11.0.0" }, null, 2)}\n`,
			"utf8",
		);

		await expect(detectPackageManagerForRoot(tempRoot)).resolves.toBe("npm");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("detectPackageManagerForRoot rejects unsupported packageManager field", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-pm-unsupported-"));
	try {
		await writeFile(
			path.join(tempRoot, "package.json"),
			`${JSON.stringify({ packageManager: "pnpm@9.0.0" }, null, 2)}\n`,
			"utf8",
		);

		await expect(detectPackageManagerForRoot(tempRoot)).rejects.toThrow(
			"Unsupported package manager 'pnpm'",
		);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("detectPackageManagerForRoot falls back to package-lock npm detection", async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenthub-pm-lockfile-"));
	try {
		await writeFile(path.join(tempRoot, "package-lock.json"), "{}\n", "utf8");

		await expect(detectPackageManagerForRoot(tempRoot)).resolves.toBe("npm");
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});
