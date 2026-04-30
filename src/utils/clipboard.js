// utils/clipboard.js
import { execSync } from "child_process";

export function copyToClipboard(text) {
	try {
		// Для Wayland (wl-clipboard)
		execSync("wl-copy", { input: text });
	} catch (err) {
		// fallback на X11 если wl-copy нет
		try {
			execSync("xclip -selection clipboard", { input: text });
		} catch {
			// игнорируем ошибки
		}
	}
}

export function readClipboard() {
	try {
		// сначала пробуем wl-paste (Wayland)
		return execSync("wl-paste", { encoding: "utf-8" }).trim();
	} catch {
		try {
			// fallback на xclip
			return execSync("xclip -selection clipboard -o", {
				encoding: "utf-8",
			}).trim();
		} catch {
			return "";
		}
	}
}
