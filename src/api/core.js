import fs from "fs";
import { mkdir, writeFile } from "fs/promises";
import { Buffer } from "buffer";
import { fileURLToPath } from "url";
import { basename, dirname, join } from "path";
import FormData from "form-data";
import path from "path";
import os from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPath = join(__dirname, "../../deepseek.wasm");
if (!fs.existsSync(wasmPath)) {
	console.log("❌ deepseek.wasm not found at", wasmPath);
	process.exit(1);
}
const wasmBytes = fs.readFileSync(wasmPath);
let wasmInstance, wasmExports, memory, malloc, stack_ptr;

async function initWasm() {
	if (wasmInstance) return;
	const { instance } = await WebAssembly.instantiate(wasmBytes, {});
	wasmInstance = instance;
	wasmExports = instance.exports;
	memory = wasmExports.memory;
	malloc = wasmExports.__wbindgen_export_0;
	stack_ptr = wasmExports.__wbindgen_add_to_stack_pointer(-16);
}

function alloc_utf8(str) {
	const encoder = new TextEncoder();
	const bytes = encoder.encode(str);
	const ptr = malloc(bytes.length, 1);
	const view = new Uint8Array(memory.buffer, ptr, bytes.length);
	view.set(bytes);
	return [ptr, bytes.length];
}

export async function solvePow(challenge, salt, expireAt, difficulty) {
	await initWasm();
	const prefix = `${salt}_${expireAt}_`;
	const [challengePtr, challengeLen] = alloc_utf8(challenge);
	const [prefixPtr, prefixLen] = alloc_utf8(prefix);
	wasmExports.wasm_solve(
		stack_ptr,
		challengePtr,
		challengeLen,
		prefixPtr,
		prefixLen,
		difficulty,
	);
	const view = new DataView(memory.buffer, stack_ptr, 16);
	const found = view.getInt32(0, true);
	const answer = view.getFloat64(8, true);
	return Math.floor(answer);
}

function headers(token) {
	return {
		"accept": "*/*",
		"authorization": `Bearer ${token}`,
		"x-app-version": "20241129.1",
		"x-client-locale": "en_US",
		"x-client-platform": "web",
		"x-client-version": "2.0.0",
	};
}

export async function getCurrentProfile(token) {
	const res = await fetch("https://chat.deepseek.com/api/v0/users/current", {
		headers: headers(token),
	});
	try {
		return await res.json();
	} catch {
		return null;
	}
}

export async function fetchAllChatSessions(token) {
	const res = await fetch(
		"https://chat.deepseek.com/api/v0/chat_session/fetch_page",
		{ headers: headers(token) },
	);
	try {
		return await res.json();
	} catch {
		return null;
	}
}

export async function createChatSession(token) {
	const res = await fetch(
		"https://chat.deepseek.com/api/v0/chat_session/create",
		{
			method: "POST",
			headers: { ...headers(token), "content-type": "application/json" },
			body: JSON.stringify({ character_id: null }),
		},
	);
	try {
		return await res.json();
	} catch {
		return null;
	}
}

export async function updateChatTitle(token, chatSessionId, title) {
	const res = await fetch(
		"https://chat.deepseek.com/api/v0/chat_session/update_title",
		{
			method: "POST",
			headers: { ...headers(token), "content-type": "application/json" },
			body: JSON.stringify({ chat_session_id: chatSessionId, title }),
		},
	);
	try {
		return await res.json();
	} catch {
		return null;
	}
}

export async function deleteChatSession(token, chatSessionId) {
	const res = await fetch(
		"https://chat.deepseek.com/api/v0/chat_session/delete",
		{
			method: "POST",
			headers: { ...headers(token), "content-type": "application/json" },
			body: JSON.stringify({ chat_session_id: chatSessionId }),
		},
	);
	try {
		return await res.json();
	} catch {
		return null;
	}
}

export async function fetchHistoryMessages(token, sessionId) {
	const res = await fetch(
		`https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=${sessionId}`,
		{ headers: headers(token) },
	);
	try {
		// console.error(await res.text());
		return await res.json();
	} catch {
		return null;
	}
}

export async function stopStream(token, chatSessionId, messageId) {
	const res = await fetch(
		"https://chat.deepseek.com/api/v0/chat/stop_stream",
		{
			method: "POST",
			headers: { ...headers(token), "content-type": "application/json" },
			body: JSON.stringify({
				chat_session_id: chatSessionId,
				message_id: messageId,
			}),
		},
	);
	try {
		return await res.json();
	} catch {
		return null;
	}
}

async function generatePowHeader(token, chatSessionId, targetPath) {
	const res = await fetch(
		"https://chat.deepseek.com/api/v0/chat/create_pow_challenge",
		{
			method: "POST",
			headers: { ...headers(token), "content-type": "application/json" },
			body: JSON.stringify({ target_path: targetPath }),
		},
	);
	if (!res.ok) throw new Error("PoW challenge failed");
	const data = await res.json();
	const {
		challenge,
		salt,
		expire_at,
		difficulty,
		signature,
		algorithm,
		target_path,
	} = data.data.biz_data.challenge;
	const answer = await solvePow(challenge, salt, expire_at, difficulty);
	return Buffer.from(
		JSON.stringify({
			algorithm,
			challenge,
			salt,
			answer,
			signature,
			target_path,
		}),
	).toString("base64");
}

export async function uploadFile(token, chatSessionId, filePath) {
	const pow = await generatePowHeader(
		token,
		chatSessionId,
		"/api/v0/file/upload_file",
	);
	const form = new FormData();
	form.append("file", fs.createReadStream(filePath), {
		filename: basename(filePath),
	});
	const res = await fetch(
		"https://chat.deepseek.com/api/v0/file/upload_file",
		{
			method: "POST",
			headers: {
				...form.getHeaders(),
				...headers(token),
				"x-ds-pow-response": pow,
			},
			body: form,
		},
	);
	try {
		return await res.json();
	} catch {
		return null;
	}
}

// api/core.js
export async function* completion(
	token,
	prompt,
	sessionId,
	parentIdx,
	options = {},
) {
	const pow = await generatePowHeader(
		token,
		sessionId,
		"/api/v0/chat/completion",
	);

	const response = await fetch(
		"https://chat.deepseek.com/api/v0/chat/completion",
		{
			method: "POST",
			headers: {
				...headers(token),
				"content-type": "application/json",
				"x-ds-pow-response": pow,
			},
			body: JSON.stringify({
				chat_session_id: sessionId,
				parent_message_id: parentIdx,
				model_type: "expert",
				prompt: prompt,
				ref_file_ids: options.file_ids,
				thinking_enabled: options.thinking,
				search_enabled: options.search,
			}),
		},
	);

	console.error(parentIdx)
	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8");
	let buffer = "";
	let currentThinking = "";
	let currentText = "";
	let inThinking = false; // внутри фрагмента THINK?
	let inResponse = false;

	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop();
		for (const line of lines) {
			if (!line.startsWith("data:")) continue;
			const jsonStr = line.slice(5).trim();
			if (jsonStr === "[DONE]" || jsonStr === "") continue;
			try {
				const obj = JSON.parse(jsonStr);

				// Обработка патчей (формат DeepSeek)
				if (obj.p && obj.v !== undefined) {
					const path = obj.p;
					const op = obj.o || "SET";

					// Фрагмент THINK
					if (
						path === "response/fragments" && op === "APPEND" &&
						Array.isArray(obj.v)
					) {
						for (const frag of obj.v) {
							// console.error(frag.type, frag, obj.v, obj);
							if (frag.type === "THINK") {
								if (!inThinking && currentThinking === "") {
									inThinking = true;
									yield { type: "thinking_start" };
								}
								currentThinking = frag.content || "";
								yield {
									type: "thinking",
									content: frag.content || "",
								};
							} else if (frag.type === "RESPONSE") {
								if (inThinking) {
									inThinking = false;
									yield { type: "thinking_end" };
								}
								if (!inResponse) {
									inResponse = true;
									yield { type: "text_start" };
								}
								currentText = frag.content || "";
								yield {
									type: "text",
									content: frag.content || "",
								};
							}
						}
					} // APPEND к content существующего фрагмента
					else if (path.match(/\/content$/) && op === "APPEND") {
						if (inThinking) {
							currentThinking += obj.v;
							yield { type: "thinking", content: obj.v };
						} else if (inResponse) {
							currentText += obj.v;
							yield { type: "text", content: obj.v };
						}
					}
					// SET elapsed_secs — игнорируем
				} // Обработка старых простых форматов
				else if (obj.v === "SEARCHING") {
					yield { type: "searching" };
				} else if (obj.v === "FINISHED") {
					if (inThinking) yield { type: "thinking_end" };
					if (inResponse) yield { type: "text_end" };
					yield { type: "finished", message_id: obj.message_id };
				} else if (obj.type === "thinking") {
					yield { type: "thinking", content: obj.v };
				} else if (obj.v && typeof obj.v === "string") {
					yield { type: "text", content: obj.v };
				}
				if (obj.message_id) {
					// последний чанк может нести message_id
					yield { type: "message_id", message_id: obj.message_id };
				}
			} catch (e) {
				// ignore parse errors
			}
		}
	}
}

export async function saveHistoryToFile(messages, title) {
  const dir = path.join(os.homedir(), ".local", "state", "deepseek-tui");
  await mkdir(dir, { recursive: true });
  const sanitized = title.replace(/[^a-z0-9]/gi, "_").slice(0, 50);
  const timestamp = Date.now();
  const filename = `${timestamp}_${sanitized}.json`;
  const filePath = path.join(dir, filename);
  await writeFile(filePath, JSON.stringify(messages, null, 2));
  return filePath;
}
