import { access, readFile, writeFile } from "node:fs/promises";

export const pathExists = async (p: string): Promise<boolean> => {
	try {
		await access(p);
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
