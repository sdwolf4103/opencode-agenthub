import { execFile as execFileCallback } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { spawnOptions } from "./platform.js";

const execFile = promisify(execFileCallback);

type SupportedPackageManager = "npm" | "bun";

const pathExists = async (target: string): Promise<boolean> => {
	try {
		await access(target);
		return true;
	} catch {
		return false;
	}
};

const commandAvailable = async (command: string): Promise<boolean> => {
	try {
		await execFile(command, ["--version"], spawnOptions());
		return true;
	} catch {
		return false;
	}
};

export const detectPackageManagerForRoot = async (
	targetRoot: string,
): Promise<SupportedPackageManager> => {
	const packageJsonPath = path.join(targetRoot, "package.json");
	if (await pathExists(packageJsonPath)) {
		const pkg = JSON.parse(await readFile(packageJsonPath, "utf-8")) as {
			packageManager?: string;
		};
		const packageManager = pkg.packageManager?.split("@")[0];
		if (packageManager) {
			if (packageManager === "npm" || packageManager === "bun") {
				if (await commandAvailable(packageManager)) return packageManager;
				throw new Error(
					`Package manager '${packageManager}' is declared in ${packageJsonPath} but is not available on PATH.`,
				);
			}
			throw new Error(
				`Unsupported package manager '${packageManager}' declared in ${packageJsonPath}. Supported package managers: npm, bun.`,
			);
		}
	}

	if (await pathExists(path.join(targetRoot, "pnpm-lock.yaml"))) {
		throw new Error(
			`Detected pnpm-lock.yaml in ${targetRoot}, but pnpm is not supported for MCP dependency installation.`,
		);
	}

	if (await pathExists(path.join(targetRoot, "yarn.lock"))) {
		throw new Error(
			`Detected yarn.lock in ${targetRoot}, but yarn is not supported for MCP dependency installation.`,
		);
	}

	if (await pathExists(path.join(targetRoot, "bun.lock"))) {
		if (await commandAvailable("bun")) return "bun";
		throw new Error(`Detected bun.lock in ${targetRoot} but 'bun' is not available on PATH.`);
	}

	if (await pathExists(path.join(targetRoot, "package-lock.json"))) {
		if (await commandAvailable("npm")) return "npm";
		throw new Error(`Detected package-lock.json in ${targetRoot} but 'npm' is not available on PATH.`);
	}

	if (await commandAvailable("npm")) return "npm";
	throw new Error(
		`No supported package manager found for ${targetRoot}. Tried packageManager field, lockfiles, and npm fallback.`,
	);
};

export const installPackageDependencies = async (targetRoot: string) => {
	const packageManager = await detectPackageManagerForRoot(targetRoot);
	if (packageManager === "bun") {
		await execFile("bun", ["install"], { cwd: targetRoot, ...spawnOptions() });
		return packageManager;
	}
	await execFile("npm", ["install"], { cwd: targetRoot, ...spawnOptions() });
	return packageManager;
};
