import blessed from "blessed";
import * as core from "../api/core.js";
import { state, updateState } from "../state.js";
import { showChat } from "./chat.js";

function promptAsync(parent, opts = {}) {
	return new Promise((resolve) => {
		const box = blessed.prompt({
			parent,
			top: "center",
			left: "center",
			width: "40%",
			height: 5,
			border: { type: "line" },
			style: { border: { fg: "red" } },
			...opts,
		});
		box.input(opts.question || "", opts.default || "", (err, value) => {
			box.destroy();
			resolve(value);
		});
	});
}

export async function showSessionSelector() {
	const { screen } = state;
	screen.children.forEach((c) => c.destroy());

	let loadingBox = null;
	const showLoading = (msg) => {
		if (loadingBox) loadingBox.destroy();
		loadingBox = blessed.box({
			parent: screen,
			top: "center",
			left: "center",
			width: 30,
			height: 3,
			border: { type: "line" },
			style: { border: { fg: "red" }, label: { fg: "red" } },
			label: " ⏳ ",
			content: ` ${msg} `,
		});
		screen.render();
	};
	const hideLoading = () => {
		if (loadingBox) {
			loadingBox.destroy();
			loadingBox = null;
			screen.render();
		}
	};

	const sessionList = blessed.list({
		parent: screen,
		top: 2,
		left: 2,
		width: "96%",
		height: "90%",
		border: { type: "line" },
		style: { selected: { bg: "white" }, border: { fg: "red" } },
		keys: true,
		vi: true,
		label:
			" Chat sessions (arrows, Enter select, e rename, d/g delete, Esc back) ",
	});

	let sessions = [];

	function refreshList() {
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
		showLoading("Loading sessions...");
		try {
			const data = await core.fetchAllChatSessions(
				process.env.DEEPSEEK_TOKEN,
			);
			sessions = data?.data?.biz_data?.chat_sessions || [];
			state.cache.sessions = sessions;
			refreshList();
		} catch (err) {
			blessed.message({
				parent: screen,
				top: "center",
				left: "center",
				width: "50%",
				height: "20%",
				border: { type: "line" },
				style: { border: { fg: "red" } },
				label: " Error ",
				content: `Failed to load sessions: ${err.message}`,
			});
		} finally {
			hideLoading();
		}
	}

	async function deleteSession(idx, confirm = true) {
		if (idx >= sessions.length) return;
		if (confirm) {
			const answer = await promptAsync(screen, {
				question: 'Type "yes" to delete',
			});
			if (answer?.toLowerCase() !== "yes") return;
		}
		showLoading("Deleting...");
		try {
			const hist = await core.fetchHistoryMessages(
				process.env.DEEPSEEK_TOKEN,
				sessions[idx].id,
			);
			if (hist?.data?.biz_data?.chat_messages) {
				if (hist?.data?.biz_data?.chat_messages) {
					await core.saveHistoryToFile(hist.data.biz_data.chat_messages, sessions[idx].title);
				}
			}
			await core.deleteChatSession(
				process.env.DEEPSEEK_TOKEN,
				sessions[idx].id,
			);
			delete state.cache.messages[sessions[idx].id];
			if (state.currentSessionId === sessions[idx].id) {
				updateState({
					currentSessionId: null,
					sessionTitle: "New chat",
					messages: [],
					lastAssistantMessageId: null,
					attachedFileIds: [],
					frozenParentId: null,
					forcedParentId: null,
				});
			}
			sessions.splice(idx, 1);
			state.cache.sessions = sessions;
			refreshList();
			if (sessions.length > 0) sessionList.select(0);
		} catch (err) {
			blessed.message({
				parent: screen,
				top: "center",
				left: "center",
				width: "50%",
				height: "20%",
				border: { type: "line" },
				style: { border: { fg: "red" } },
				label: " Error ",
				content: `Delete failed: ${err.message}`,
			});
		} finally {
			hideLoading();
		}
	}

	async function renameSession(idx) {
		if (idx >= sessions.length) return;
		const newName = await promptAsync(screen, {
			question: "New name",
			default: sessions[idx].title || "",
		});
		if (!newName || newName === sessions[idx].title) return;
		showLoading("Renaming...");
		try {
			await core.updateChatTitle(
				process.env.DEEPSEEK_TOKEN,
				sessions[idx].id,
				newName,
			);
			sessions[idx].title = newName;
			refreshList();
			if (state.currentSessionId === sessions[idx].id) {
				updateState({ sessionTitle: newName });
			}
		} catch (err) {
			blessed.message({
				parent: screen,
				top: "center",
				left: "center",
				width: "50%",
				height: "20%",
				border: { type: "line" },
				style: { border: { fg: "red" } },
				label: " Error ",
				content: `Rename failed: ${err.message}`,
			});
		} finally {
			hideLoading();
		}
	}

	sessionList.on("select", async (item, idx) => {
		if (idx === sessions.length) {
			showLoading("Creating session...");
			try {
				const newChat = await core.createChatSession(
					process.env.DEEPSEEK_TOKEN,
				);
				const id = newChat?.data?.biz_data?.chat_session?.id;
				if (!id) throw new Error("No session id");
				updateState({
					currentSessionId: id,
					sessionTitle: "New chat",
					messages: [],
					lastAssistantMessageId: null,
					attachedFileIds: [],
					frozenParentId: null,
					forcedParentId: null,
				});
				state.cache.messages[id] = [];
				sessions.push({ id, title: "New chat" });
				state.cache.sessions = sessions;
				screen.children.forEach((c) => c.destroy());
				showChat();
			} catch (err) {
				blessed.message({
					parent: screen,
					top: "center",
					left: "center",
					width: "50%",
					height: "20%",
					border: { type: "line" },
					style: { border: { fg: "red" } },
					label: " Error ",
					content: `Create failed: ${err.message}`,
				});
			} finally {
				hideLoading();
			}
		} else {
			const selected = sessions[idx];
			showLoading("Loading chat...");
			try {
				updateState({
					currentSessionId: selected.id,
					sessionTitle: selected.title || "Untitled",
					frozenParentId: null,
					forcedParentId: null,
				});
				if (state.cache.messages[selected.id]) {
					updateState({
						messages: state.cache.messages[selected.id],
					});
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
			} catch (err) {
				blessed.message({
					parent: screen,
					top: "center",
					left: "center",
					width: "50%",
					height: "20%",
					border: { type: "line" },
					style: { border: { fg: "red" } },
					label: " Error ",
					content: `Failed to load chat: ${err.message}`,
				});
			} finally {
				hideLoading();
			}
		}
	});

	sessionList.key("w", async () => {
		refreshList();
	});

	sessionList.key("e", async () => {
		const idx = sessionList.selected;
		if (idx < sessions.length) await renameSession(idx);
		sessionList.focus();
		// screen.render();
	});

	sessionList.key("d", async () => {
		const idx = sessionList.selected;
		if (idx < sessions.length) await deleteSession(idx, true);
		sessionList.focus();
		// screen.render();
	});

	sessionList.key("g", async () => {
		const idx = sessionList.selected;
		if (idx < sessions.length) await deleteSession(idx, false);
		sessionList.focus();
		// screen.render();
	});

	sessionList.key("escape", () => {
		if (state.currentSessionId) {
			screen.children.forEach((c) => c.destroy());
			showChat();
		} else {
			process.exit(0);
		}
	});

	sessionList.focus();
	screen.render();
	await loadSessions();
}
