import fs from 'fs';
import path from 'path';
import { homedir } from 'os';

const LOG_DIR = path.join(homedir(), '.local', 'state', 'deepseek-tui');
const LOG_FILE = path.join(LOG_DIR, 'debug.log');

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

export function logToFile(...args) {
  try {
    ensureLogDir();
    const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n';
    fs.appendFileSync(LOG_FILE, line, 'utf-8');
  } catch (err) {
    // тихо падаем в консоль, но не ломаем TUI
    console.error('Logger failed:', err);
  }
}
