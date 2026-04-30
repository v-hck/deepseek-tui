import fs from "fs";

export function extractFilePaths(str) {
	const matches = str.match(/(?:\/[\w./-]+|[A-Za-z]:\\[\w.\\-]+)/g) || [];
	return [...new Set(matches)].filter((p) => {
		try {
			return fs.existsSync(p);
		} catch {
			return false;
		}
	});
}
