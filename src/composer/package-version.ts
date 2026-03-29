import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const readPackageVersion = (): string => {
	try {
		const pkgPath = path.join(
			path.dirname(fileURLToPath(import.meta.url)),
			"..",
			"..",
			"package.json",
		);
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
		if (pkg.version) return pkg.version;
	} catch {
		// ignore — fallback below
	}
	return process.env.npm_package_version ?? "0.0.0";
};
