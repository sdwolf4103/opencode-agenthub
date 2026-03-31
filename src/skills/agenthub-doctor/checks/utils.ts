import { access, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

export const pathExists = async (p: string): Promise<boolean> => {
	try {
		await access(p, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
};

const pathExecutable = async (p: string): Promise<boolean> => {
	try {
		await access(p, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
};

export const readJson = async <T>(filePath: string): Promise<T> => {
	const content = await readFile(filePath, "utf-8");
	return JSON.parse(content) as T;
};

export const writeJson = async (filePath: string, data: unknown): Promise<void> => {
	await writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
};

export const resolveOnPath = async (binaryName: string): Promise<string | null> => {
	const pathValue = process.env.PATH;
	if (!pathValue) return null;
	for (const segment of pathValue.split(path.delimiter)) {
		const trimmed = segment.trim();
		if (!trimmed) continue;
		const candidate = path.join(trimmed, binaryName);
		if (await pathExecutable(candidate)) {
			return candidate;
		}
	}
	return null;
};

export const readBinaryVersion = async (
	binaryPath: string,
	args: string[] = ["--version"],
): Promise<string | null> =>
	new Promise((resolve) => {
		execFile(binaryPath, args, { timeout: 3000 }, (error, stdout, stderr) => {
			if (error) {
				resolve(null);
				return;
			}
			const output = `${stdout || stderr}`.trim();
			resolve(output.length > 0 ? output : null);
		});
	});
