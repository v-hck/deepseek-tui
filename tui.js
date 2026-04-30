#!/usr/bin/env node
import blessed from "blessed";
import * as core from "./core.js";
import { mdToBlessed } from "./md.js";
import { copyToClipboard, extractFilePaths, readClipboard, logToFile } from "./utils.js";
import fs from "fs";

const TOKEN = process.env.DEEPSEEK_TOKEN;
if (!TOKEN) {
	logToFile("❌ DEEPSEEK_TOKEN environment variable not set.");
	process.exit(1);
}

// ---------- Глобальное состояние ----------
let screen;
let currentSessionId = null;
let messages = [];
let lastAssistantMessageId = null;
let streamCtrl = null;
let regenLock = false;
let ignoreResponses = false;
let thinkingEnabled = false;
let searchEnabled = true;
let attachedFileIds = [];
let sessionTitle = "";

// --- кеш ---
const cache = {
	sessions: null, // список сессий
	messages: {}, // sessionId -> массив messages
};

// ---------- Элементы UI ----------
let sessionList, chatLog, inputBox, thinkingBox, statusBar;

// ---------- Вспомогательные функции ----------
function showError(msg) {
	logToFile(`${msg}`);
	const errBox = blessed.message({
		parent: screen,
		top: "center",
		left: "center",
		width: "50%",
		height: "20%",
		border: { type: "line" },
		style: { border: { fg: "red" } },
		label: " Error ",
		content: msg,
	});
	setTimeout(() => {
		errBox.destroy();
		screen.render();
	}, 3000);
	screen.render();
}

async function initCore() {
	try {
		// Тестовая инициализация wasm
		await core.solvePow("test", "0", Date.now() + 10000, 0);
	} catch (e) {
		throw e;
	}
}

// ---------- Селектор сессий ----------
async function showSessionSelector() {
	// Уничтожаем все дочерние элементы
	screen.children.forEach((c) => c.destroy());

	sessionList = blessed.list({
		parent: screen,
		top: 2,
		left: 2,
		width: "96%",
		height: "90%",
		border: { type: "line" },
		style: { selected: { bg: "red" }, border: { fg: "red" } },
		keys: true,
		vi: true,
		label:
			" Chat sessions (arrows, Enter/Space select, e rename, d delete, D delete no confirm) ",
	});

	let sessions = [];

	function refreshList() {
		// Синхронизация с кешем на случай, если sessions была изменена извне
		sessions = cache.sessions || sessions;
		sessionList.setItems(
			sessions.map((s) => `[${s.title || "untitled"}]`).concat([
				"[+] New chat",
			]),
		);
		screen.render();
	}

	async function loadSessions() {
		if (cache.sessions) {
			sessions = cache.sessions;
			refreshList();
			return;
		}
		const data = await core.fetchAllChatSessions(TOKEN);
		sessions = data?.data?.biz_data?.chat_sessions || [];
		cache.sessions = sessions;
		refreshList();
	}

	sessionList.on("select", async (item, index) => {
		if (index === sessions.length) {
			const newChat = await core.createChatSession(TOKEN);
			const id = newChat?.data?.biz_data?.chat_session?.id;
			if (!id) {
				showError("Не удалось создать чат: " + JSON.stringify(newChat));
				return;
			}
			currentSessionId = id;
			sessionTitle = "Новый чат";
			messages = [];
			cache.messages[currentSessionId] = messages;
			// Добавляем в список сессий
			sessions.push({ id, title: sessionTitle });
			cache.sessions = sessions;
			screen.children.forEach((c) => c.destroy());
			showChat();
		} else {
			currentSessionId = sessions[index].id;
			sessionTitle = sessions[index].title || "Untitled";
			if (cache.messages[currentSessionId]) {
				messages = cache.messages[currentSessionId]; // <-- из кеша
			} else {
				const hist = await core.fetchHistoryMessages(
					TOKEN,
					currentSessionId,
				);
				messages = hist?.data?.biz_data?.chat_messages || [];
				cache.messages[currentSessionId] = messages; // <-- кеш
			}
			screen.children.forEach((c) => c.destroy());
			showChat();
		}
	});

	// Клавиши для селектора
	sessionList.key("e", async () => {
		const idx = sessionList.selected;
		if (idx >= sessions.length) return;
		const prompt = blessed.prompt({
			parent: screen,
			top: "center",
			left: "center",
			width: "40%",
			height: 5,
			border: { type: "line" },
			style: { border: { fg: "red" } },
		});
		const newName = await prompt.input(
			"New name",
			sessions[idx].title || "",
		);
		if (newName) {
			await core.updateChatTitle(TOKEN, sessions[idx].id, newName);
			sessions[idx].title = newName;
			refreshList();
		}
		sessionList.focus();
		screen.render();
	});

	sessionList.key("d", async () => {
		const idx = sessionList.selected;
		if (idx >= sessions.length) return;
		const prompt = blessed.prompt({
			parent: screen,
			top: "center",
			left: "center",
			width: "40%",
			height: 5,
			border: { type: "line" },
			style: { border: { fg: "red" } },
		});
		const confirm = await prompt.input('Type "yes" to delete', "");
		if (confirm?.toLowerCase() === "yes") {
			// Сохраняем историю перед удалением
			const hist = await core.fetchHistoryMessages(
				TOKEN,
				sessions[idx].id,
			);
			if (hist?.data?.biz_data?.chat_messages) {
				core.saveHistoryToFile(
					hist.data.biz_data.chat_messages,
					sessions[idx].title,
				);
			}
			await core.deleteChatSession(TOKEN, sessions[idx].id);
			sessions.splice(idx, 1);
			refreshList();
		}
		sessionList.focus();
		screen.render();
	});

	sessionList.key("D", async () => {
		const idx = sessionList.selected;
		if (idx >= sessions.length) return;
		// Сохраняем историю
		const hist = await core.fetchHistoryMessages(TOKEN, sessions[idx].id);
		if (hist?.data?.biz_data?.chat_messages) {
			core.saveHistoryToFile(
				hist.data.biz_data.chat_messages,
				sessions[idx].title,
			);
		}
		await core.deleteChatSession(TOKEN, sessions[idx].id);
		sessions.splice(idx, 1);
		refreshList();
		sessionList.focus();
		screen.render();
	});

	sessionList.key("a", async () => {
		const newChat = await core.createChatSession(TOKEN);
		const id = newChat?.data?.biz_data?.chat_session?.id;
		if (!id) {
			showError(
				"Создание чата не удалось (a): " + JSON.stringify(newChat),
			);
			return;
		}
		currentSessionId = id;
		sessionTitle = "Новый чат";
		messages = [];
		cache.messages[currentSessionId] = messages;
		sessions.push({ id, title: sessionTitle });
		cache.sessions = sessions;
		screen.children.forEach((c) => c.destroy());
		showChat();
	});

	sessionList.key("escape", () => process.exit(0));
	sessionList.focus();
	screen.render();
	await loadSessions();
}

// ---------- Чат ----------
function showChat() {
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
		label: ` ${sessionTitle} `,
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
		content:
			" Ctrl+Q quit | Ctrl+E regen | Ctrl+S stop | Alt+S ignore | Ctrl+C copy block | Alt+C copy message | Ctrl+T thinking | Alt+T search | Tab focus input | ↑↓ scroll ",
	});

	// Перемещение фокуса по Tab
	screen.key("tab", () => {
		if (screen.focused === chatLog) inputBox.focus();
		else chatLog.focus();
		screen.render();
	});

	// Клик мыши на поле ввода
	inputBox.on("click", () => {
		inputBox.focus();
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

	// Стрелки вверх/вниз скроллят чат (когда в фокусе)
	chatLog.key("up", () => {
		chatLog.scroll(-1);
		screen.render();
	});
	chatLog.key("down", () => {
		chatLog.scroll(1);
		screen.render();
	});

	// Глобальные хоткеи
	screen.key(["C-q"], () => {
		showSessionSelector();
	});

	screen.key("C-e", () => {
		regenLock = !regenLock;
		updateStatus();
	});

	screen.key("M-e", async () => {
		// Редактирование сообщения
		const prompt = blessed.prompt({
			parent: screen,
			top: "center",
			left: "center",
			width: "30%",
			height: 5,
			border: { type: "line" },
		});
		const numStr = await prompt.input("message_id to edit", "");
		if (!numStr) return;
		const msgId = parseInt(numStr);
		const msg = messages.find((m) =>
			m.message_id === msgId && m.role === "USER"
		);
		if (!msg) return;
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
		editBox.setValue(msg.content);
		editBox.focus();
		screen.render();
		editBox.key("enter", () => {
			const newText = editBox.getValue().trim();
			editBox.destroy();
			const idx = messages.indexOf(msg);
			if (idx >= 0) {
				messages.splice(idx + 1);
				messages[idx].content = newText;
				updateChatLog();
				const parent = msg.parent_id ||
					(idx > 0 ? messages[idx - 1]?.message_id : null);
				sendMessage(newText, parent);
			}
		});
		editBox.key("escape", () => {
			editBox.destroy();
			screen.render();
		});
	});

	screen.key("C-s", async () => {
		await stopCurrentStream();
	});

	screen.key("M-s", () => {
		ignoreResponses = !ignoreResponses;
		updateStatus();
	});

	screen.key("C-c", () => {
		// Копировать блок
		const lastMsg = [...messages].reverse().find((m) =>
			m.role === "ASSISTANT"
		);
		if (!lastMsg) return;
		const blocks = [...lastMsg.content.matchAll(/```([\s\S]*?)```/g)].map(
			(m) => m[1],
		);
		if (blocks.length === 0) {
			copyToClipboard(lastMsg.content);
			return;
		}
		if (blocks.length === 1) {
			copyToClipboard(blocks[0]);
			return;
		}
		// Показать выбор
		const choices = blessed.list({
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
		choices.focus();
		choices.on("select", (_, i) => {
			copyToClipboard(blocks[i]);
			choices.destroy();
			screen.render();
		});
		choices.key("escape", () => {
			choices.destroy();
			screen.render();
		});
		screen.render();
	});

	screen.key("M-c", () => {
		const prompt = blessed.prompt({
			parent: screen,
			top: "center",
			left: "center",
			width: "30%",
			height: 5,
			border: { type: "line" },
		});
		prompt.input(
			"message_id или Enter для последнего",
			"",
			(err, value) => {
				const num = parseInt(value?.trim());
				let msg;
				if (isNaN(num)) msg = messages[messages.length - 1];
				else msg = messages.find((m) => m.message_id === num);
				if (msg) copyToClipboard(msg.content);
				screen.render();
			},
		);
	});

	screen.key("C-t", () => {
		thinkingEnabled = !thinkingEnabled;
		updateStatus();
	});

	screen.key("M-t", () => {
		searchEnabled = !searchEnabled;
		updateStatus();
	});

	screen.key("C-v", async () => {
		const clip = readClipboard();
		const paths = extractFilePaths(clip).filter((p) => {
			try {
				return fs.existsSync(p);
			} catch {
				return false;
			}
		});
		if (paths.length) {
			const ids = [];
			for (const p of paths) {
				const res = await core.uploadFile(TOKEN, currentSessionId, p);
				const id = res?.data?.biz_data?.id;
				if (id) ids.push(id);
			}
			attachedFileIds.push(...ids);
			inputBox.setValue(
				`(прикреплено ${attachedFileIds.length} файлов) ` +
					inputBox.getValue(),
			);
			updateStatus();
		}
		screen.render();
	});

	screen.key("M-v", () => {
		const clip = readClipboard();
		inputBox.setValue(clip);
		screen.render();
	});

	// Отправка сообщения
	inputBox.key("enter", async () => {
		const text = inputBox.getValue().trim();
		if (!text) return;
		inputBox.clearValue();
		let parent = null;
		if (regenLock) {
			// Перегенерация последнего ответа
			const lastAsIdx = messages.map((m) => m.role).lastIndexOf(
				"ASSISTANT",
			);
			if (lastAsIdx >= 0) {
				messages.splice(lastAsIdx, 1);
				const lastUserIdx = messages.map((m) => m.role).lastIndexOf(
					"USER",
				);
				if (lastUserIdx >= 0) {
					parent = messages[lastUserIdx].message_id || null;
				}
			}
			messages.push({
				role: "USER",
				content: text,
				message_id: null,
				parent_id: parent,
			});
			updateChatLog();
			await sendMessage(text, parent);
		} else {
			await sendMessage(text, null);
		}
		inputBox.focus();
	});

	// Начальная отрисовка истории
	updateChatLog();
	inputBox.focus();
	screen.render();
}

// ---------- Обновление UI ----------
function formatMessage(msg, idx, totalMessages) {
	// idx – порядковый номер начиная с 0, делаем № от 1
	const num = idx + 1;
	const role = msg.role === "USER" ? "USER" : "ASSISTANT";
	const id = msg.message_id ?? "?";
	const parent = msg.parent_id ?? "null";

	// Извлекаем текст из fragments / content
	let raw = "";
	if (Array.isArray(msg.fragments)) {
		raw = msg.fragments
			.filter((f) =>
				f.content && (f.type === "REQUEST" || f.type === "RESPONSE")
			)
			.map((f) => f.content)
			.join("\n");
	} else if (typeof msg.content === "string") {
		raw = msg.content;
	}

	let body = "";
	if (msg.thinking_content) {
		const elapsed = msg.thinking_elapsed_secs?.toFixed(2) || "?";
		body += `{yellow-fg}[Думал ${elapsed}с]{/yellow-fg}\n`;
	}
	body += mdToBlessed(raw);

	// Ширина контента: минус границы (2 символа)
	const width = (chatLog.width || screen.width) - 2;
	const lineChar = "─";
	const roleText = `${role} №${num} #${id} @${parent}`;
	const fillerLen = Math.max(0, width - roleText.length);
	const left = lineChar.repeat(Math.floor(fillerLen / 2));
	const right = lineChar.repeat(Math.ceil(fillerLen / 2));
	const header = left + roleText + right;

	return `${header}\n${body}\n`;
}

function updateChatLog() {
	chatLog.setContent(
		messages.map((m, i) => formatMessage(m, i, messages.length)).join(""),
	);
	chatLog.setScrollPerc(100);
	screen.render();
}

function updateStatus() {
	const parts = [];
	if (regenLock) parts.push("REGEN");
	if (ignoreResponses) parts.push("NO-RESP");
	if (thinkingEnabled) parts.push("THINK");
	if (searchEnabled) parts.push("SEARCH");
	if (attachedFileIds.length) parts.push(`FILES:${attachedFileIds.length}`);
	statusBar.setContent(
		parts.join(" | ") +
			" | Ctrl+Q quit | Ctrl+E regen | Ctrl+S stop | Alt+S ignore | Ctrl+C copy block | Alt+C copy message | Ctrl+T thinking | Alt+T search | Tab focus input | ↑↓ scroll ",
	);
	screen.render();
}

async function sendMessage(prompt, parentMsgId = null) {
	if (!currentSessionId) return;
	const userMsg = {
		role: "USER",
		content: prompt,
		message_id: null,
		parent_id: parentMsgId,
	};
	messages.push(userMsg);
	updateChatLog();

	if (ignoreResponses) return;

	const fileIds = [...attachedFileIds];
	attachedFileIds = [];
	updateStatus();

	const assistantMsg = {
		role: "ASSISTANT",
		content: "",
		message_id: null,
		thinking_content: "",
		draft: true,
	};
	messages.push(assistantMsg);
	const assistantIdx = messages.length - 1;

	thinkingBox.show();
	screen.render();

	streamCtrl = { abort: false };
	let thinkingText = "";
	let answerText = "";
	let newMessageId = null;

	try {
		const generator = core.completion(
			TOKEN,
			prompt,
			currentSessionId,
			parentMsgId,
			{
				search: searchEnabled,
				thinking: thinkingEnabled,
				file_ids: fileIds,
			},
		);

		for await (const chunk of generator) {
			if (streamCtrl.abort) break;
			if (chunk.type === "thinking") {
				thinkingText += chunk.content;
				thinkingBox.setContent(thinkingText);
				messages[assistantIdx].thinking_content = thinkingText;
				updateChatLog();
			} else if (chunk.type === "text") {
				answerText += chunk.content;
				messages[assistantIdx].content = answerText;
				if (chunk.message_id) newMessageId = chunk.message_id;
				updateChatLog();
			} else if (chunk.type === "searching") {
				messages[assistantIdx].content = "🔍 Searching...";
				updateChatLog();
			}
		}
	} catch (e) {
		logToFile(`${e.message}`);
		messages[assistantIdx].content = `❌ Error: ${e.message}`;
	}

	streamCtrl = null;
	messages[assistantIdx].draft = false;
	if (newMessageId) messages[assistantIdx].message_id = newMessageId;
	lastAssistantMessageId = newMessageId;
	thinkingBox.hide();
	updateChatLog();
	screen.render();
}

async function stopCurrentStream() {
	if (streamCtrl) {
		streamCtrl.abort = true;
		if (lastAssistantMessageId && currentSessionId) {
			await core.stopStream(
				TOKEN,
				currentSessionId,
				lastAssistantMessageId,
			);
		}
	}
}

// ---------- Entry point ----------
screen = blessed.screen({ smartCSR: true, title: "DeepTerm" });

(async () => {
	try {
		await initCore();
		await showSessionSelector();
	} catch (e) {
		logToFile(`${e.message}`);
		process.exit(1);
	}
})();
