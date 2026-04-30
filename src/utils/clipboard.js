import clipboard from "clipboardy";

export function copyToClipboard(text) {
	try {
		clipboard.writeSync(text);
	} catch {
		// ignore
	}
}

export function readClipboard() {
	try {
		return clipboard.readSync();
	} catch {
		return "";
	}
}
