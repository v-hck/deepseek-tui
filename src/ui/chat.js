import blessed from "blessed";
import * as core from "../api/core.js";
import { state, updateState } from "../state.js";
import { copyToClipboard, readClipboard } from "../utils/clipboard.js";
import { extractFilePaths } from "../utils/file.js";
import { mdToBlessed } from "../utils/markdown.js";
import { showSessionSelector } from "./sessionSelector.js";

let chatLog, inputBox, statusBar;

function updateStatusBar() {
	const parts = [];
	if (state.ignoreResponses) parts.push("NO-RESP");
	if (state.thinkingEnabled) parts.push("THINK");
	if (state.searchEnabled) parts.push("SEARCH");
	if (state.attachedFileIds.length) {
		parts.push(`FILES:${state.attachedFileIds.length}`);
	}
	if (state.frozenParentId) parts.push(`PARENT:${state.frozenParentId}`);
	if (state.forcedParentId) parts.push(`NEXT:${state.forcedParentId}`);
	statusBar.setContent(
		parts.join(" | ") +
			" | Ctrl+Q sessions | Ctrl+R regen | Ctrl+S stop | Alt+S ignore | Ctrl+C copy block | Alt+C copy msg | Ctrl+T think | Alt+T search | Ctrl+E set next parent | Ctrl+X freeze parent | Tab focus | ↑↓ scroll",
	);
	state.screen.render();
}

// Вспомогательная функция: извлечение текста из сообщения
function getMessageText(msg) {
	// Если есть поле content (для новых или преобразованных) — используем
	if (typeof msg.content === "string") return msg.content;
	// Если есть fragments (из API истории)
	if (Array.isArray(msg.fragments)) {
		const textFragments = msg.fragments
			.filter((f) => f.type === "REQUEST" || f.type === "RESPONSE")
			.map((f) => f.content)
			.join("\n");
		if (textFragments) return textFragments;
	}
	return "";
}

// Форматирование времени из Unix timestamp (секунды)
function formatTimestamp(ts) {
	if (!ts) return "";
	const date = new Date(ts * 1000);
	return date.toLocaleString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		day: "2-digit",
		month: "2-digit",
		year: "numeric",
	});
}

function formatMessage(msg, idx) {
	const role = msg.role === "USER" ? "USER" : "ASSISTANT";

	// Для старых локальных сообщений без ID показываем #local, но по условию убираем #id из разделителя
	// Родитель: если parent_id есть — показываем, иначе "root"
	const parent = msg.parent_id ? msg.parent_id : "root";

	// Статус (сокращённо)
	let status = "";
	if (msg.status) {
		if (msg.status === "FINISHED") status = "✓";
		else if (msg.status === "IN_PROGRESS") status = "⏳";
		else status = msg.status.slice(0, 3);
	}
	// Токены
	let tokens = "";
	if (msg.accumulated_token_usage) tokens = `${msg.accumulated_token_usage}t`;

	// Время
	let timeStr = "";
	if (msg.inserted_at) timeStr = formatTimestamp(msg.inserted_at);

	// Сборка левого/правого разделителя
	const width = (chatLog.width || state.screen.width) - 2;
	// Основная метка: роль, номер, статус, токены, родитель. Без #id.
	let roleText = `${role} #${idx} [${tokens}]`;

	const fillerLen = Math.max(0, width - roleText.length);
	const left = "─".repeat(Math.floor(fillerLen / 2));
	const right = "─".repeat(Math.ceil(fillerLen / 2));

	// Тело сообщения
	let body = "";

	// Время — мелким серым в теле (над мыслями)
	if (timeStr) {
		body += `{gray-fg}${timeStr}{/gray-fg}\n`;
	}

	// Мысли (серым цветом) — только для новых сообщений (поле thinking_content)
	if (msg.thinking_content && msg.thinking_content.trim() !== "") {
		body += `{gray-fg}${mdToBlessed(msg.thinking_content)}{/gray-fg}\n`;
	}

	// Основной контент
	let content = getMessageText(msg);
	// Если после мыслей есть текст и нет переноса в начале — добавляем
	if (
		msg.thinking_content && content.length > 0 && !content.startsWith("\n")
	) {
		content = "\n" + content;
	}
	body += mdToBlessed(content);

	// Если совсем пустое тело — placeholder
	if (
		body.trim() === "" ||
		(body.replace(/\n/g, "").trim() === "" && !timeStr)
	) {
		body += "{gray-fg}(empty){/gray-fg}\n";
	}

	return `${left}${roleText}${right}\n${body}\n`;
}

function updateChatLog() {
	chatLog.setContent(
		state.messages.map((m, i) => formatMessage(m, i)).join(""),
	);
	chatLog.setScrollPerc(100);
	state.screen.render();
	// Сохраняем кэш после каждого обновления чата
	state.cache.messages[state.currentSessionId] = JSON.parse(
		JSON.stringify(state.messages),
	);
}

function promptAsync(parent, opts = {}) {
	return new Promise((resolve) => {
		const box = blessed.prompt({
			parent,
			top: "center",
			left: "center",
			width: "30%",
			height: 5,
			border: { type: "line" },
			...opts,
		});
		box.input(opts.question || "", "", (err, value) => {
			box.destroy();
			resolve(value);
		});
	});
}

// Отправка нового пользовательского сообщения (всегда добавляет USER и ASSISTANT)
async function sendMessage(prompt, options = {}) {
	if (!state.currentSessionId) return;

	let effectiveParentId;

	// Приоритет: frozen > forced > options.parentId > автоматический
	console.error(
		state.frozenParentId,
		state.forcedParentId,
		effectiveParentId,
		options.parentId,
		state.messages.length,
	);
	if (state.frozenParentId !== null && state.frozenParentId !== undefined) {
		effectiveParentId = state.frozenParentId;
	} else if (
		state.forcedParentId !== null && state.forcedParentId !== undefined
	) {
		effectiveParentId = state.forcedParentId;
		state.forcedParentId = null;
	} else if (options.parentId !== undefined && options.parentId !== null) {
		effectiveParentId = options.parentId;
	} else if (state.messages.length > 0) {
		effectiveParentId = state.messages.length;
	} else {
		effectiveParentId = null;
	}

	console.error(
		state.frozenParentId,
		state.forcedParentId,
		effectiveParentId,
		options.parentId,
		state.messages.length,
	);

	const userMsg = {
		role: "USER",
		content: prompt,
		parent_id: effectiveParentId,
		message_id: null,
	};
	state.messages.push(userMsg);

	const assistantMsg = {
		role: "ASSISTANT",
		content: "",
		draft: true,
		thinking_content: "",
	};
	const assistantIdx = state.messages.length;
	state.messages.push(assistantMsg);
	updateChatLog();

	// Внутри sendMessage и regenerateLast замени цикл на:

	let fullContent = ""; // накопленный текст (включая мысли и ответы)
	let inThinking = state.thinkingEnabled; // флаг: сейчас идёт блок мыслей
	let streamController = null;

	try {
		const generator = core.completion(
			process.env.DEEPSEEK_TOKEN,
			prompt,
			state.currentSessionId,
			effectiveParentId,
			{
				search: state.searchEnabled,
				thinking: state.thinkingEnabled,
				file_ids: state.attachedFileIds,
			},
		);
		streamController = { abort: () => generator.return?.() };
		updateState({ streamCtrl: streamController });

		for await (const chunk of generator) {
			if (streamController.aborted) break;
			console.error(
				chunk.type,
				chunk.content,
				chunk.message_id,
				inThinking,
			);
			if (chunk.type === "text_start") {
				inThinking = false;
				fullContent += "\n"
			}
			if (inThinking === true) {
				// Добавляем мысль в общий контент, оборачивая в серый цвет, если флаг true
				const colored = `\x1b[90m${chunk.content}\x1b[0m`;
				fullContent += colored;
				state.messages[assistantIdx].content = fullContent;
				updateChatLog();
			} else if (chunk.type === "text") {
				// Обычный текст — без цвета
				fullContent += chunk.content;
				state.messages[assistantIdx].content = fullContent;
				updateChatLog();
			} else if (chunk.type === "searching") {
				fullContent = "🔍 Searching...";
				state.messages[assistantIdx].content = fullContent;
				updateChatLog();
			} else if (chunk.type === "message_id") {
				if (!state.messages[assistantIdx].message_id) {
					state.messages[assistantIdx].message_id = chunk.message_id;
				}
			} else if (chunk.type === "finished") {
				// можно ничего не делать, стрим завершится
			}
		}
	} catch (err) {
		state.messages[assistantIdx].content = `❌ ${err.message}`;
	} finally {
		delete state.messages[assistantIdx].draft;
		updateState({ streamCtrl: null });
		updateChatLog();
		updateState({ attachedFileIds: [] });
		updateStatusBar();
	}
}

// Регенерация последнего ответа (без создания нового USER)
async function regenerateLast() {
	const msgs = state.messages;
	if (msgs.length < 2) return;
	const lastUserIdx = msgs.length - 2;
	if (msgs[lastUserIdx].role !== "USER") return;
	const lastUser = msgs[lastUserIdx];
	// Удаляем последний ASSISTANT
	state.messages.pop();
	updateChatLog();

	// Переотправляем запрос для существующего USER
	const assistantMsg = {
		role: "ASSISTANT",
		content: "",
		draft: true,
		thinking_content: "",
	};
	const assistantIdx = state.messages.length;
	state.messages.push(assistantMsg);
	updateChatLog();

	let answer = "";
	let thinking = "";
	let streamController = null;
	try {
		const generator = core.completion(
			process.env.DEEPSEEK_TOKEN,
			lastUser.content,
			state.currentSessionId,
			lastUserIdx,
			{
				search: state.searchEnabled,
				thinking: state.thinkingEnabled,
				file_ids: [], // при регенерации файлы не перезагружаем
			},
		);
		streamController = { abort: () => generator.return?.() };
		updateState({ streamCtrl: streamController });

		for await (const chunk of generator) {
			if (streamController.aborted) break;
			if (chunk.type === "thinking") {
				thinking += chunk.content;
				state.messages[assistantIdx].thinking_content = thinking;
			} else if (chunk.type === "text") {
				answer += chunk.content;
				state.messages[assistantIdx].content = answer;
				updateChatLog();
			} else if (chunk.type === "searching") {
				state.messages[assistantIdx].content = "🔍 Searching...";
				updateChatLog();
			}
			if (chunk.message_id && !state.messages[assistantIdx].message_id) {
				state.messages[assistantIdx].message_id = chunk.message_id;
			}
		}
	} catch (err) {
		state.messages[assistantIdx].content = `❌ ${err.message}`;
	} finally {
		delete state.messages[assistantIdx].draft;
		updateState({ streamCtrl: null });
		updateChatLog();
	}
}

async function stopCurrentStream() {
	if (state.streamCtrl) {
		state.streamCtrl.abort();
		if (state.currentSessionId && state.messages.length > 0) {
			const lastAssistant = [...state.messages].reverse().find((m) =>
				m.role === "ASSISTANT" && m.message_id
			);
			if (lastAssistant?.message_id) {
				await core.stopStream(
					process.env.DEEPSEEK_TOKEN,
					state.currentSessionId,
					lastAssistant.message_id,
				);
			}
		}
		updateState({ streamCtrl: null });
	}
}

function findMessageByIdOrLast(idStr) {
	const num = parseInt(idStr?.trim());
	if (isNaN(num)) return state.messages[state.messages.length - 1];
	return state.messages.find((m) => m.message_id === num);
}

export function showChat() {
	const { screen } = state;
	screen.children.forEach((c) => c.destroy());

	chatLog = blessed.box({
		parent: screen,
		top: 0,
		left: 0,
		width: "100%",
		height: "85%",
		tags: true,
		scrollable: true,
		scrollbar: { ch: " " },
		keys: true,
		mouse: true,
		border: { type: "line" },
		style: { border: { fg: "red" } },
		label: ` ${state.sessionTitle} `,
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
	});

	const handlers = {
		"C-q": () => showSessionSelector(),
		"C-r": () => regenerateLast(),
		"C-s": () => stopCurrentStream(),
		"M-s": () => {
			updateState({ ignoreResponses: !state.ignoreResponses });
			updateStatusBar();
		},
		"C-t": () => {
			updateState({ thinkingEnabled: !state.thinkingEnabled });
			updateStatusBar();
		},
		"M-t": () => {
			updateState({ searchEnabled: !state.searchEnabled });
			updateStatusBar();
		},
		"C-v": async () => {
			const idStr = await promptAsync(screen, {
				question: "message_id (empty for last)",
			});
			const msg = findMessageByIdOrLast(idStr);
			if (!msg) return;
			const blocks = [
				...(msg.content || "").matchAll(/```([\s\S]*?)```/g),
			].map((m) => m[1]);
			if (blocks.length === 0) {
				copyToClipboard(msg.content);
				return;
			}
			const idxStr = await promptAsync(screen, {
				question: `block index (1-${blocks.length}, empty for 1)`,
			});
			const idx = parseInt(idxStr?.trim()) || 1;
			copyToClipboard(
				blocks[Math.min(Math.max(idx, 1), blocks.length) - 1],
			);
		},
		"M-c": async () => {
			const idStr = await promptAsync(screen, {
				question: "message_id (empty for last)",
			});
			const msg = findMessageByIdOrLast(idStr);
			if (msg) copyToClipboard(msg.content || "");
		},
		"M-v": async () => {
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
		},
		"M-e": async () => {
			const newParent = await promptAsync(screen, {
				question: "Enter parent message_id (empty to clear):",
			});
			if (newParent === null || newParent.trim() === "") {
				// Если заморозка активна — снимаем заморозку? Нет, просто очищаем forced
				if (state.frozenParentId !== null) {
					// не трогаем frozen, только forced
					updateState({ forcedParentId: null });
				} else {
					updateState({ forcedParentId: null });
				}
			} else {
				const raw = newParent.trim();
				// если заморозка включена — меняем frozenParentId
				if (state.frozenParentId !== null) {
					updateState({ frozenParentId: raw });
				} else {
					updateState({ forcedParentId: raw });
				}
			}
			updateStatusBar();
		},
		"C-x": () => {
			if (state.frozenParentId !== null) {
				state.frozenParentId = null;
			} else {
				if (
					state.forcedParentId !== null &&
					state.forcedParentId !== undefined
				) {
					state.frozenParentId = state.forcedParentId;
				} else {
					state.frozenParentId = state.messages.length;
				}
				if (state.frozenParentId === null) {
					statusBar.setContent(
						" {red-fg}No parent to freeze{/red-fg}",
					);
					setTimeout(() => updateStatusBar(), 1500);
					return;
				}
			}
			updateStatusBar();
		},
	};

	const bindKeys = (target) =>
		Object.entries(handlers).forEach(([key, fn]) => target.key(key, fn));
	bindKeys(screen);
	bindKeys(inputBox);

	screen.key("tab", () => {
		(screen.focused === chatLog ? inputBox : chatLog).focus();
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

	inputBox.key("enter", async () => {
		const text = inputBox.getValue().trim();
		if (!text) return;
		inputBox.clearValue();
		await sendMessage(text);
		inputBox.focus();
	});

	updateChatLog();
	updateStatusBar();
	inputBox.focus();
	screen.render();
}
