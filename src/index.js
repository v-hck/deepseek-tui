#!/usr/bin/env node
import blessed from "blessed";
import { state, updateState } from "./state.js";
import * as core from "./api/core.js";
import { logToFile } from "./utils/logger.js";
import { showSessionSelector } from "./ui/sessionSelector.js";

const TOKEN = process.env.DEEPSEEK_TOKEN;
if (!TOKEN) {
	logToFile("❌ DEEPSEEK_TOKEN environment variable not set.");
	process.exit(1);
}

const screen = blessed.screen({ smartCSR: true, title: "DeepTerm" });
updateState({ screen });

async function init() {
	try {
		await core.solvePow("test", "0", Date.now() + 10000, 0);
		await showSessionSelector();
	} catch (e) {
		logToFile("Init error:", e);
		process.exit(1);
	}
}

init();
