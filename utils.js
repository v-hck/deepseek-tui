import clipboard from "clipboardy";
import fs from 'fs';
import { join } from 'path';
const LOG_PATH = join(process.cwd(), 'debug.log');

export function copyToClipboard(text) {
	try {
		clipboard.writeSync(text);
	} catch { }
}

export function readClipboard() {
	try {
		return clipboard.readSync();
	} catch {
		return "";
	}
}

export function extractFilePaths(str) {
	const matches = str.match(/(?:\/[\w./-]+|[A-Za-z]:\\[\w.\\-]+)/g) || [];
	return [...new Set(matches)];
}

export function logToFile(...args) {
	const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n';
	fs.appendFileSync(LOG_PATH, line, 'utf-8');
}
