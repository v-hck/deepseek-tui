import blessed from "blessed";
import * as core from "../api/core.js";
import { state, updateState } from "../state.js";
import { logToFile } from "../utils/logger.js";
import { showChat } from "./chat.js";

export async function showSessionSelector() {
	const { screen } = state;
	screen.children.forEach((c) => c.destroy());

	const sessionList = blessed.list({
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
			" Chat sessions (arrows, Enter select, e rename, d delete, D delete no confirm, Esc quit) ",
	});

	let sessions = state.cache.sessions || [];

	function refreshList() {
		sessions = state.cache.sessions || sessions;
		sessionList.setItems([
			...sessions.map((s) => `[${s.title || "untitled"}]`),
			"[+] New chat",
		]);
		screen.render();
	}

	async function loadSessions() {
		if (state.cache.sessions) {
			sessions = state.cache.sessions;
			refreshList();
			return;
		}
		const data = await core.fetchAllChatSessions(
			process.env.DEEPSEEK_TOKEN,
		);
		sessions = data?.data?.biz_data?.chat_sessions || [];
		state.cache.sessions = sessions;
		refreshList();
	}

	sessionList.on("select", async (item, idx) => {
		if (idx === sessions.length) { // new chat
			const newChat = await core.createChatSession(
				process.env.DEEPSEEK_TOKEN,
			);
			const id = newChat?.data?.biz_data?.chat_session?.id;
			if (!id) {
				const errBox = blessed.message({
					parent: screen,
					top: "center",
					left: "center",
					width: "50%",
					height: "20%",
					border: { type: "line" },
					style: { border: { fg: "red" } },
					label: " Error ",
					content: "Failed to create chat",
				});
				setTimeout(() => {
					errBox.destroy();
					screen.render();
				}, 2000);
				return;
			}
			updateState({
				currentSessionId: id,
				sessionTitle: "New chat",
				messages: [],
				lastAssistantMessageId: null,
				attachedFileIds: [],
			});
			state.cache.messages[id] = [];
			sessions.push({ id, title: "New chat" });
			state.cache.sessions = sessions;
			screen.children.forEach((c) => c.destroy());
			showChat();
		} else {
			const selected = sessions[idx];
			updateState({
				currentSessionId: selected.id,
				sessionTitle: selected.title || "Untitled",
			});
			if (state.cache.messages[selected.id]) {
				updateState({ messages: state.cache.messages[selected.id] });
			} else {
				const hist = await core.fetchHistoryMessages(
					process.env.DEEPSEEK_TOKEN,
					selected.id,
				);
				const msgs = hist?.data?.biz_data?.chat_messages || [];
				state.cache.messages[selected.id] = msgs;
				updateState({ messages: msgs });
			}
			screen.children.forEach((c) => c.destroy());
			showChat();
		}
	});

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
			await core.updateChatTitle(
				process.env.DEEPSEEK_TOKEN,
				sessions[idx].id,
				newName,
			);
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
			const hist = await core.fetchHistoryMessages(
				process.env.DEEPSEEK_TOKEN,
				sessions[idx].id,
			);
			if (hist?.data?.biz_data?.chat_messages) {
				core.saveHistoryToFile(
					hist.data.biz_data.chat_messages,
					sessions[idx].title,
				);
			}
			await core.deleteChatSession(
				process.env.DEEPSEEK_TOKEN,
				sessions[idx].id,
			);
			delete state.cache.messages[sessions[idx].id];
			sessions.splice(idx, 1);
			state.cache.sessions = sessions;
			refreshList();
		}
		sessionList.focus();
		screen.render();
	});

	sessionList.key("D", async () => {
		const idx = sessionList.selected;
		if (idx >= sessions.length) return;
		const hist = await core.fetchHistoryMessages(
			process.env.DEEPSEEK_TOKEN,
			sessions[idx].id,
		);
		if (hist?.data?.biz_data?.chat_messages) {
			core.saveHistoryToFile(
				hist.data.biz_data.chat_messages,
				sessions[idx].title,
			);
		}
		await core.deleteChatSession(
			process.env.DEEPSEEK_TOKEN,
			sessions[idx].id,
		);
		delete state.cache.messages[sessions[idx].id];
		sessions.splice(idx, 1);
		state.cache.sessions = sessions;
		refreshList();
		sessionList.focus();
		screen.render();
	});

	sessionList.key("escape", () => process.exit(0));
	sessionList.focus();
	screen.render();
	await loadSessions();
}
