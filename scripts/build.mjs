#!/usr/bin/env node

import { mkdir, readdir, rm, cp, chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const srcRoot = path.join(repoRoot, "src");
const distRoot = path.join(repoRoot, "dist");

const collectTsFiles = async (root) => {
	const entries = await readdir(root, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const filePath = path.join(root, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "mcp-servers" || entry.name === "node_modules") continue;
			files.push(...(await collectTsFiles(filePath)));
			continue;
		}
		if (entry.isFile() && filePath.endsWith(".ts")) {
			files.push(filePath);
		}
	}
	return files;
};

const copyNonTsFiles = async (sourceRoot, targetRoot) => {
	const entries = await readdir(sourceRoot, { withFileTypes: true });
	await mkdir(targetRoot, { recursive: true });
	for (const entry of entries) {
		const source = path.join(sourceRoot, entry.name);
		const target = path.join(targetRoot, entry.name);
		if (entry.isDirectory()) {
			await copyNonTsFiles(source, target);
			continue;
		}
		if (entry.name.endsWith('.ts')) continue;
		await cp(source, target, { force: true });
	}
};

await rm(distRoot, { recursive: true, force: true });
await mkdir(distRoot, { recursive: true });

const entryPoints = await collectTsFiles(srcRoot);

await esbuild.build({
	entryPoints,
	outdir: distRoot,
	outbase: srcRoot,
	platform: "node",
	format: "esm",
	target: "node18",
	bundle: false,
	packages: "external",
	logLevel: "info",
});

await cp(path.join(srcRoot, "composer", "library"), path.join(distRoot, "composer", "library"), {
	recursive: true,
});
await copyNonTsFiles(path.join(srcRoot, "skills"), path.join(distRoot, "skills"));

// Normalize layout: with outbase=src, files land under dist/<subdir>/... already.
// No extra path rewriting is needed; this block simply verifies the expected
// directories exist before chmod.
await mkdir(path.join(distRoot, "composer"), { recursive: true });
await mkdir(path.join(distRoot, "plugins"), { recursive: true });

await chmod(path.join(distRoot, "composer", "opencode-profile.js"), 0o755);
await chmod(path.join(distRoot, "composer", "install-home.js"), 0o755);
