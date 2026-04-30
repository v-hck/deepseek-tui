import blessed from "blessed";
import * as core from "../api/core.js";
import { state, updateState } from "../state.js";
import { logToFile } from "../utils/logger.js";
import { copyToClipboard, readClipboard } from "../utils/clipboard.js";
import { extractFilePaths } from "../utils/file.js";
import { mdToBlessed } from "../utils/markdown.js";
import { showSessionSelector } from "./sessionSelector.js";
import fs from "fs";

let chatLog, inputBox, thinkingBox, statusBar;

function updateStatusBar() {
	const parts = [];
	if (state.ignoreResponses) parts.push("NO-RESP");
	if (state.thinkingEnabled) parts.push("THINK");
	if (state.searchEnabled) parts.push("SEARCH");
	if (state.attachedFileIds.length) {
		parts.push(`FILES:${state.attachedFileIds.length}`);
	}
	statusBar.setContent(
		parts.join(" | ") +
			" | Ctrl+Q sessions | Ctrl+R regen | Ctrl+S stop | Alt+S ignore | Ctrl+C copy block | Alt+C copy msg | Ctrl+T think | Alt+T search | Tab focus | ↑↓ scroll ",
	);
	state.screen.render();
}

function formatMessage(msg, idx) {
	const num = idx + 1;
	const role = msg.role === "USER" ? "USER" : "ASSISTANT";
	const id = msg.message_id ?? "?";
	const parent = msg.parent_id ?? "null";
	let raw = "";
	if (Array.isArray(msg.fragments)) {
		raw = msg.fragments.filter((f) =>
			f.content && (f.type === "REQUEST" || f.type === "RESPONSE")
		).map((f) => f.content).join("\n");
	} else if (typeof msg.content === "string") raw = msg.content;
	let body = "";
	if (msg.thinking_content) {
		const elapsed = msg.thinking_elapsed_secs?.toFixed(2) || "?";
		body += `{yellow-fg}[Thought ${elapsed}s]{/yellow-fg}\n`;
	}
	body += mdToBlessed(raw);
	const width = (chatLog.width || state.screen.width) - 2;
	const lineChar = "─";
	const roleText = `${role} №${num} #${id} @${parent}`;
	const fillerLen = Math.max(0, width - roleText.length);
	const left = lineChar.repeat(Math.floor(fillerLen / 2));
	const right = lineChar.repeat(Math.ceil(fillerLen / 2));
	return `${left}${roleText}${right}\n${body}\n`;
}

function updateChatLog() {
	chatLog.setContent(
		state.messages.map((m, i) => formatMessage(m, i)).join(""),
	);
	chatLog.setScrollPerc(100);
	state.screen.render();
}

async function sendMessage(prompt, parentMsgId = null) {
	if (!state.currentSessionId) return;
	// Добавляем сообщение пользователя
	const userMsg = {
		role: "USER",
		content: prompt,
		message_id: null,
		parent_id: parentMsgId,
	};
	updateState({ messages: [...state.messages, userMsg] });
	state.cache.messages[state.currentSessionId] = state.messages;
	updateChatLog();

	if (state.ignoreResponses) return; // не добавляем ассистента

	const fileIds = [...state.attachedFileIds];
	updateState({ attachedFileIds: [] });
	updateStatusBar();

	const assistantMsg = {
		role: "ASSISTANT",
		content: "",
		message_id: null,
		thinking_content: "",
		draft: true,
	};
	updateState({ messages: [...state.messages, assistantMsg] });
	const assistantIdx = state.messages.length - 1;
	state.cache.messages[state.currentSessionId] = state.messages;

	thinkingBox.show();
	state.screen.render();

	let abort = false;
	updateState({ streamCtrl: { abort: () => abort = true } });
	let thinkingText = "", answerText = "", newMessageId = null;

	try {
		const generator = core.completion(
			process.env.DEEPSEEK_TOKEN,
			prompt,
			state.currentSessionId,
			parentMsgId,
			{
				search: state.searchEnabled,
				thinking: state.thinkingEnabled,
				file_ids: fileIds,
			},
		);
		for await (const chunk of generator) {
			if (abort) break;
			if (chunk.type === "thinking") {
				thinkingText += chunk.content;
				thinkingBox.setContent(thinkingText);
				state.messages[assistantIdx].thinking_content = thinkingText;
				updateChatLog();
			} else if (chunk.type === "text") {
				answerText += chunk.content;
				state.messages[assistantIdx].content = answerText;
				if (chunk.message_id) newMessageId = chunk.message_id;
				updateChatLog();
			} else if (chunk.type === "searching") {
				state.messages[assistantIdx].content = "🔍 Searching...";
				updateChatLog();
			}
		}
	} catch (err) {
		logToFile("sendMessage error:", err);
		state.messages[assistantIdx].content = `❌ Error: ${err.message}`;
	}

	updateState({ streamCtrl: null });
	if (newMessageId) state.messages[assistantIdx].message_id = newMessageId;
	delete state.messages[assistantIdx].draft;
	updateState({ lastAssistantMessageId: newMessageId });
	thinkingBox.hide();
	updateChatLog();
	state.screen.render();
}

async function regenerateLast() {
	// найти последнее сообщение USER
	const lastUserIdx = [...state.messages].reverse().findIndex((m) =>
		m.role === "USER"
	);
	if (lastUserIdx === -1) return;
	const realIdx = state.messages.length - 1 - lastUserIdx;
	const lastUser = state.messages[realIdx];
	const parent = lastUser.parent_id ||
		(realIdx > 0 ? state.messages[realIdx - 1]?.message_id : null);
	// удалить всё после этого USER (включая его самого? нет, удаляем ассистента после него, а самого юзера оставляем? Нужно удалить последний ответ и сгенерировать заново)
	// Удаляем все сообщения начиная с realIdx+1 (последний ассистент и дальше)
	const newMessages = state.messages.slice(0, realIdx + 1);
	updateState({ messages: newMessages });
	state.cache.messages[state.currentSessionId] = newMessages;
	updateChatLog();
	// Отправляем тот же текст с тем же parent (родитель юзера)
	await sendMessage(lastUser.content, parent);
}

async function stopCurrentStream() {
	if (state.streamCtrl) {
		state.streamCtrl.abort();
		if (state.lastAssistantMessageId && state.currentSessionId) {
			await core.stopStream(
				process.env.DEEPSEEK_TOKEN,
				state.currentSessionId,
				state.lastAssistantMessageId,
			);
		}
		updateState({ streamCtrl: null });
	}
}

export function showChat() {
	const { screen } = state;
	screen.children.forEach((c) => c.destroy());

	chatLog = blessed.box({
		parent: screen,
		top: 0,
		left: 0,
		width: "100%",
		height: "90%",
		tags: true,
		scrollable: true,
		scrollbar: { ch: " " },
		keys: true,
		mouse: true,
		border: { type: "line" },
		style: { border: { fg: "red" } },
		label: ` ${state.sessionTitle} `,
		content: "",
	});

	thinkingBox = blessed.box({
		parent: screen,
		top: 0,
		left: 0,
		width: "100%",
		height: "25%",
		hidden: true,
		border: { type: "line" },
		style: { border: { fg: "yellow" } },
		label: " 💭 Thinking ",
		content: "",
	});

	inputBox = blessed.textbox({
		parent: screen,
		bottom: 1,
		left: 0,
		width: "100%",
		height: "10%",
		inputOnFocus: true,
		border: { type: "line" },
		style: { border: { fg: "red" } },
		keys: true,
		label: " Input ",
	});

	statusBar = blessed.text({
		parent: screen,
		bottom: 0,
		left: 0,
		width: "100%",
		height: 1,
		tags: true,
		style: { bg: "red", fg: "black" },
		content: "",
	});

	// TAB focus
	screen.key("tab", () => {
		if (screen.focused === chatLog) inputBox.focus();
		else chatLog.focus();
		screen.render();
	});

	chatLog.on("wheelup", () => {
		chatLog.scroll(-1);
		screen.render();
	});
	chatLog.on("wheeldown", () => {
		chatLog.scroll(1);
		screen.render();
	});
	chatLog.key("up", () => {
		chatLog.scroll(-1);
		screen.render();
	});
	chatLog.key("down", () => {
		chatLog.scroll(1);
		screen.render();
	});

	// Глобальные хоткеи
	screen.key("C-q", () => showSessionSelector());
	screen.key("C-r", () => regenerateLast());
	screen.key("C-s", () => stopCurrentStream());
	screen.key("M-s", () => {
		updateState({ ignoreResponses: !state.ignoreResponses });
		updateStatusBar();
	});
	screen.key("C-t", () => {
		updateState({ thinkingEnabled: !state.thinkingEnabled });
		updateStatusBar();
	});
	screen.key("M-t", () => {
		updateState({ searchEnabled: !state.searchEnabled });
		updateStatusBar();
	});

	// Копирование блока кода из последнего сообщения
	screen.key("C-c", () => {
		const lastAssistant = [...state.messages].reverse().find((m) =>
			m.role === "ASSISTANT"
		);
		if (!lastAssistant) return;
		const blocks = [...lastAssistant.content.matchAll(/```([\s\S]*?)```/g)]
			.map((m) => m[1]);
		if (blocks.length === 0) copyToClipboard(lastAssistant.content);
		else if (blocks.length === 1) copyToClipboard(blocks[0]);
		else {
			const list = blessed.list({
				parent: screen,
				top: "center",
				left: "center",
				width: "50%",
				height: "30%",
				border: { type: "line" },
				items: blocks.map((b, i) =>
					`[${i + 1}] ${b.slice(0, 40).replace(/\n/g, " ")}...`
				),
				style: { selected: { bg: "red" } },
				keys: true,
			});
			list.focus();
			list.on("select", (_, i) => {
				copyToClipboard(blocks[i]);
				list.destroy();
				screen.render();
			});
			list.key("escape", () => {
				list.destroy();
				screen.render();
			});
			screen.render();
		}
	});

	screen.key("M-c", () => {
		const promptBox = blessed.prompt({
			parent: screen,
			top: "center",
			left: "center",
			width: "30%",
			height: 5,
			border: { type: "line" },
		});
		promptBox.input("message_id or Enter for last", "", (err, val) => {
			const num = parseInt(val?.trim());
			let msg;
			if (isNaN(num)) msg = state.messages[state.messages.length - 1];
			else msg = state.messages.find((m) => m.message_id === num);
			if (msg) copyToClipboard(msg.content);
			screen.render();
		});
	});

	screen.key("C-v", async () => {
		const clip = readClipboard();
		const paths = extractFilePaths(clip);
		if (paths.length) {
			const ids = [];
			for (const p of paths) {
				const res = await core.uploadFile(
					process.env.DEEPSEEK_TOKEN,
					state.currentSessionId,
					p,
				);
				const id = res?.data?.biz_data?.id;
				if (id) ids.push(id);
			}
			updateState({
				attachedFileIds: [...state.attachedFileIds, ...ids],
			});
			inputBox.setValue(
				`(attached ${state.attachedFileIds.length} files) ${inputBox.getValue()}`,
			);
			updateStatusBar();
		}
		screen.render();
	});

	screen.key("M-v", () => {
		inputBox.setValue(readClipboard());
		screen.render();
	});

	// Редактирование сообщения (исправлено)
	screen.key("M-e", async () => {
		const promptBox = blessed.prompt({
			parent: screen,
			top: "center",
			left: "center",
			width: "30%",
			height: 5,
			border: { type: "line" },
		});
		const numStr = await promptBox.input("message_id to edit", "");
		if (!numStr) return;
		const msgId = parseInt(numStr);
		const idx = state.messages.findIndex((m) =>
			m.message_id === msgId && m.role === "USER"
		);
		if (idx === -1) return;
		const editBox = blessed.textbox({
			parent: screen,
			top: "center",
			left: "center",
			width: "80%",
			height: 10,
			border: { type: "line" },
			inputOnFocus: true,
			label: " Edit (Enter submit, Esc cancel) ",
		});
		editBox.setValue(state.messages[idx].content);
		editBox.focus();
		screen.render();
		editBox.key("enter", () => {
			const newText = editBox.getValue().trim();
			editBox.destroy();
			// удаляем это сообщение и все последующие
			const newMessages = state.messages.slice(0, idx);
			updateState({ messages: newMessages });
			state.cache.messages[state.currentSessionId] = newMessages;
			updateChatLog();
			const parent = state.messages[idx]?.parent_id ||
				(idx > 0 ? state.messages[idx - 1]?.message_id : null);
			sendMessage(newText, parent);
		});
		editBox.key("escape", () => {
			editBox.destroy();
			screen.render();
		});
	});

	inputBox.key("enter", async () => {
		const text = inputBox.getValue().trim();
		if (!text) return;
		inputBox.clearValue();
		await sendMessage(text, null);
		inputBox.focus();
	});

	updateChatLog();
	updateStatusBar();
	inputBox.focus();
	screen.render();
}
