import fs from "fs";
import { Buffer } from "buffer";
import { fileURLToPath } from "url";
import { basename, dirname, join } from "path";
import FormData from "form-data";
import { logToFile } from "../utils/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPath = join(__dirname, "../../deepseek.wasm"); // был ./deepseek.wasm
if (!fs.existsSync(wasmPath)) {
	logToFile("❌ deepseek.wasm not found at", wasmPath);
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

export async function* completion(
	token,
	prompt,
	chatSessionId,
	parentMessageId,
	options = {},
) {
	const { search = true, thinking = false, file_ids = [] } = options;
	const pow = await generatePowHeader(
		token,
		chatSessionId,
		"/api/v0/chat/completion",
	);
	const res = await fetch(
		"https://chat.deepseek.com/api/v0/chat/completion",
		{
			method: "POST",
			headers: {
				...headers(token),
				"content-type": "application/json",
				"x-ds-pow-response": pow,
			},
			body: JSON.stringify({
				chat_session_id: chatSessionId,
				parent_message_id: parentMessageId,
				model_type: "expert",
				prompt: prompt,
				ref_file_ids: file_ids,
				thinking_enabled: thinking,
				search_enabled: search,
			}),
		},
	);

	const reader = res.body.getReader();
	const decoder = new TextDecoder("utf-8");
	let buffer = "";

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
				if (obj.v === "SEARCHING") {
					yield { type: "searching" };
					continue;
				}
				if (obj.v === "FINISHED") {
					yield { type: "finished" };
					continue;
				}
				if (obj.type === "thinking") {
					yield { type: "thinking", content: obj.v };
				} else if (obj.v && typeof obj.v === "string") {
					const chunk = { type: "text", content: obj.v };
					if (obj.message_id) chunk.message_id = obj.message_id;
					yield chunk;
				}
			} catch {}
		}
	}
}

export function saveHistoryToFile(messages, sessionTitle) {
	const sanitized = (sessionTitle || "session").replace(/[^a-z0-9]/gi, "_");
	const path = join(process.cwd(), `history_${sanitized}_${Date.now()}.json`);
	fs.writeFileSync(path, JSON.stringify(messages, null, 2), "utf-8");
	return path;
}
