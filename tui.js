#!/usr/bin/env node
import blessed from 'blessed';
import * as core from './core.js';
import { mdToBlessed } from './md.js';
import { copyToClipboard, readClipboard, extractFilePaths } from './utils.js';
import fs from 'fs';

const TOKEN = process.env.DEEPSEEK_TOKEN;
if (!TOKEN) {
  console.error('❌ DEEPSEEK_TOKEN env variable not set.');
  process.exit(1);
}

// -------------------- Глобальное состояние --------------------
let screen;
let currentSessionId = null;
let messages = [];                // { role, message_id, parent_id, content, thinking_content?, draft? }
let lastAssistantMessageId = null;
let streamCtrl = null;            // { abort: boolean }
let regenLock = false;            // Ctrl+E режим перегенерации
let ignoreResponses = false;      // Alt+S режим игнора ответов
let thinkingEnabled = false;      // Ctrl+T
let searchEnabled = true;         // Alt+T
let attachedFileIds = [];         // id файлов для следующей отправки

// -------------------- Хелперы --------------------
function escapeBlessed(text) {
  return text.replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}

function formatMessage(msg, idx) {
  const role = msg.role === 'USER' ? 'Вы' : 'DeepSeek';
  const idStr = msg.message_id ? `#${msg.message_id}` : '';
  let body = '';
  if (msg.thinking_content) {
    body += `{yellow-fg}[Думал ${msg.thinking_elapsed_secs?.toFixed(2) || '?'}c]{/yellow-fg}\n`;
  }
  body += mdToBlessed(msg.content || '');
  return `{bold}${role}${idStr}{/bold}\n${body}`;
}

function buildChatLogContent() {
  return messages.map(formatMessage).join('\n');
}

function updateChatLog() {
  chatLog.setContent(buildChatLogContent());
  chatLog.setScrollPerc(100);
  screen.render();
}

function updateStatus() {
  const parts = [];
  if (regenLock) parts.push('{bold}REGEN{/bold}');
  if (ignoreResponses) parts.push('{bold}NO-RESP{/bold}');
  if (thinkingEnabled) parts.push('💭');
  if (searchEnabled) parts.push('🔍');
  if (attachedFileIds.length) parts.push(`📎${attachedFileIds.length}`);
  parts.push('Ctrl+Q Exit');
  statusBar.setContent(parts.join(' | '));
  screen.render();
}

// -------------------- API взаимодействие --------------------
async function sendMessage(prompt, parentMsgId = null) {
  if (!currentSessionId) return;
  // Добавляем сообщение пользователя в историю
  const userMsg = { role: 'USER', content: prompt, message_id: null, parent_id: parentMsgId };
  messages.push(userMsg);
  updateChatLog();

  if (ignoreResponses) {
    // Просто добавили сообщение пользователя и всё
    return;
  }

  // Подготовка file_ids
  const fileIds = [...attachedFileIds];
  attachedFileIds = [];
  updateStatus();

  // Создаём запись-заглушку для ответа
  const assistantMsg = { role: 'ASSISTANT', content: '', message_id: null, thinking_content: '', draft: true };
  messages.push(assistantMsg);
  const assistantIdx = messages.length - 1;

  thinkingBox.show();
  screen.render();

  streamCtrl = { abort: false };
  let thinkingText = '';
  let answerText = '';
  let newMessageId = null;
  try {
    for await (const chunk of core.completion(TOKEN, prompt, currentSessionId, parentMsgId, {
      search: searchEnabled,
      thinking: thinkingEnabled,
      file_ids: fileIds,
    })) {
      if (streamCtrl.abort) break;
      if (chunk.type === 'thinking') {
        thinkingText += chunk.content;
        thinkingBox.setContent(thinkingText);
        messages[assistantIdx].thinking_content = thinkingText;
        updateChatLog();
      } else if (chunk.type === 'text') {
        answerText += chunk.content;
        messages[assistantIdx].content = answerText;
        updateChatLog();
        if (chunk.message_id) newMessageId = chunk.message_id;
      } else if (chunk.type === 'searching') {
        messages[assistantIdx].content = '🔍 Ищу...';
        updateChatLog();
      }
    }
  } catch (e) {
    messages[assistantIdx].content = `❌ Ошибка: ${e.message}`;
  }

  streamCtrl = null;
  messages[assistantIdx].draft = false;
  if (newMessageId) messages[assistantIdx].message_id = newMessageId;
  lastAssistantMessageId = newMessageId;
  thinkingBox.hide();
  updateChatLog();
  screen.render();

  // Если режим перегенерации: после получения ответа вновь включаем ожидание ввода
  if (regenLock) {
    inputBox.focus();
  }
}

async function stopCurrentStream() {
  if (streamCtrl) {
    streamCtrl.abort = true;
    if (lastAssistantMessageId && currentSessionId) {
      await core.stopStream(TOKEN, currentSessionId, lastAssistantMessageId);
    }
  }
}

// -------------------- Модальные окна --------------------
function showSessionSelector() {
  // Удаляем все элементы экрана
  screen.children.forEach(c => c.destroy());
  // Создаём новый layout
  createSelectorUI();
}

function createSelectorUI() {
  const list = blessed.list({
    parent: screen,
    top: 2, left: 2, width: '96%', height: '90%',
    border: { type: 'line' },
    style: { selected: { bg: 'red' }, border: { fg: 'red' } },
    keys: true, vi: true,
    label: ' Чат сессии ',
  });

  const cmdInput = blessed.textbox({
    parent: screen,
    bottom: 0, left: 2, width: '96%', height: 3,
    border: { type: 'line' },
    style: { border: { fg: 'red' } },
    inputOnFocus: true,
    label: ' Команды: d N удалить, r N имя создать/переименовать, имя создать ',
  });

  let sessions = [];

  async function loadSessions() {
    const data = await core.fetchAllChatSessions(TOKEN);
    sessions = data?.data?.biz_data?.chat_sessions || [];
    refreshList();
  }

  function refreshList() {
    list.setItems(sessions.map((s, i) => `[${i + 1}] ${s.title || '(untitled)'}`).concat(['[+] Новый чат']));
    screen.render();
  }

  list.on('select', async (item, index) => {
    if (index === sessions.length) {
      const newChat = await core.createChatSession(TOKEN);
      if (newChat?.data?.biz_data?.id) {
        currentSessionId = newChat.data.biz_data.id;
        messages = [];
      }
      screen.children.forEach(c => c.destroy());
      createChatUI();
    } else {
      currentSessionId = sessions[index].id;
      const hist = await core.fetchHistoryMessages(TOKEN, currentSessionId);
      messages = hist?.data?.biz_data?.chat_messages || [];
      screen.children.forEach(c => c.destroy());
      createChatUI();
      updateChatLog();
    }
  });

  cmdInput.key('enter', async () => {
    const val = cmdInput.getValue().trim();
    cmdInput.clearValue();
    if (/^d\s+\d+$/.test(val)) {
      const idx = parseInt(val.split(/\s+/)[1]) - 1;
      if (idx >= 0 && idx < sessions.length) {
        await core.deleteChatSession(TOKEN, sessions[idx].id);
        sessions.splice(idx, 1);
        refreshList();
      }
    } else if (/^r\s+\d+\s+.+$/.test(val)) {
      const parts = val.split(/\s+/);
      const idx = parseInt(parts[1]) - 1;
      const newTitle = parts.slice(2).join(' ');
      if (idx >= 0 && idx < sessions.length) {
        await core.updateChatTitle(TOKEN, sessions[idx].id, newTitle);
        sessions[idx].title = newTitle;
        refreshList();
      }
    } else if (val) {
      const newChat = await core.createChatSession(TOKEN);
      if (newChat?.data?.biz_data?.id) {
        currentSessionId = newChat.data.biz_data.id;
        await core.updateChatTitle(TOKEN, currentSessionId, val);
        messages = [];
        screen.children.forEach(c => c.destroy());
        createChatUI();
      }
    }
    screen.render();
  });

  cmdInput.focus();
  screen.render();
  loadSessions();
}

// -------------------- UI чата --------------------
let chatLog, inputBox, thinkingBox, statusBar;

function createChatUI() {
  chatLog = blessed.log({
    parent: screen,
    top: 0, left: 0, width: '100%', height: '90%',
    tags: true,
    scrollable: true,
    scrollbar: { ch: ' ' },
    keys: true,
    vi: true,
    border: { type: 'line' },
    style: { border: { fg: 'red' } },
    label: ' DeepTerm Chat ',
  });

  thinkingBox = blessed.log({
    parent: screen,
    top: 0, left: 0, width: '100%', height: '30%',
    hidden: true,
    border: { type: 'line' },
    style: { border: { fg: 'yellow' } },
    label: ' 💭 Мышление ',
  });

  inputBox = blessed.textbox({
    parent: screen,
    bottom: 1, left: 0, width: '100%', height: '10%',
    inputOnFocus: true,
    border: { type: 'line' },
    style: { border: { fg: 'red' } },
    keys: true,
    label: ' Ввод ',
  });

  statusBar = blessed.text({
    parent: screen,
    bottom: 0, left: 0, width: '100%', height: 1,
    tags: true,
    style: { bg: 'red', fg: 'black' },
    content: '',
  });

  inputBox.focus();
  updateStatus();
  setupChatKeybindings();
  screen.render();
}

function setupChatKeybindings() {
  // Глобальные клавиши для чата
  screen.removeAllListeners('keypress');
  screen.key(['C-q', 'escape'], () => {
    // Выход в меню выбора сессий
    showSessionSelector();
  });

  // Ctrl+e – лок перегенерации
  screen.key('C-e', () => {
    regenLock = !regenLock;
    updateStatus();
  });

  // Alt+e – редактирование сообщения по номеру
  screen.key('M-e', () => {
    promptEditMessage();
  });

  // Ctrl+s – пауза стрима
  screen.key('C-s', async () => {
    await stopCurrentStream();
  });

  // Alt+s – игнор ответов
  screen.key('M-s', () => {
    ignoreResponses = !ignoreResponses;
    updateStatus();
  });

  // Ctrl+c – копирование кодового блока
  screen.key('C-c', () => {
    promptCopyBlock();
  });

  // Alt+c – копирование сообщения
  screen.key('M-c', () => {
    promptCopyMessage();
  });

  // Ctrl+t – тогл мышления
  screen.key('C-t', () => {
    thinkingEnabled = !thinkingEnabled;
    updateStatus();
  });

  // Alt+t – тогл поиска
  screen.key('M-t', () => {
    searchEnabled = !searchEnabled;
    updateStatus();
  });

  // Ctrl+v – добавить файлы из буфера обмена
  screen.key('C-v', async () => {
    const clip = readClipboard();
    const paths = extractFilePaths(clip).filter(p => fs.existsSync(p));
    if (paths.length) {
      const ids = [];
      for (const p of paths) {
        const res = await core.uploadFile(TOKEN, currentSessionId, p);
        const id = res?.data?.biz_data?.id;
        if (id) ids.push(id);
      }
      attachedFileIds.push(...ids);
      inputBox.setValue(`(прикреплено ${attachedFileIds.length} файлов) ` + inputBox.getValue());
      updateStatus();
    }
    screen.render();
  });

  // Alt+v – raw вставка из буфера
  screen.key('M-v', () => {
    const clip = readClipboard();
    inputBox.setValue(clip);
    screen.render();
  });

  // Enter – отправка сообщения
  inputBox.key('enter', async () => {
    const text = inputBox.getValue().trim();
    if (!text) return;
    inputBox.clearValue();
    let parent = null;
    if (regenLock) {
      // Перегенерация: находим последний ответ ассистента и удаляем его,
      // затем ищем предыдущее сообщение пользователя и берём его parent.
      const lastAssistantIdx = messages.map(m => m.role).lastIndexOf('ASSISTANT');
      if (lastAssistantIdx >= 0) {
        // Удаляем последний ответ ассистента
        messages.splice(lastAssistantIdx, 1);
        // Ищем сообщение пользователя, на которое был этот ответ
        const lastUserIdx = messages.map(m => m.role).lastIndexOf('USER');
        if (lastUserIdx >= 0) {
          parent = messages[lastUserIdx].message_id || null;
        }
      }
      // Добавляем новый запрос пользователя (заменяет старый?)
      // По логике перегенерации мы не должны добавлять новое сообщение пользователя,
      // а отправить тот же самый запрос. Поэтому просто используем найденный parent
      // и не добавляем userMsg.
      // Но если текст изменился, нужно добавить. Упростим: всегда добавляем новый USER
      // с новым текстом и тем же parent, а старый ответ уже удалён.
      messages.push({ role: 'USER', content: text, message_id: null, parent_id: parent });
      updateChatLog();
      await sendMessage(text, parent);
    } else {
      // Обычный режим
      await sendMessage(text, null);
    }
    inputBox.focus();
  });
}

// -------------------- Вспомогательные диалоги --------------------
async function promptEditMessage() {
  // Запрашиваем номер сообщения
  const prompt = blessed.prompt({
    parent: screen,
    top: 'center', left: 'center', width: '30%', height: 5,
    border: { type: 'line' },
    style: { border: { fg: 'red' } },
  });
  const numStr = await prompt.input('Номер сообщения (message_id)', '');
  if (!numStr) return;
  const msgId = parseInt(numStr);
  const msg = messages.find(m => m.message_id === msgId && m.role === 'USER');
  if (!msg) return;
  // Показываем текст для редактирования
  const editBox = blessed.textbox({
    parent: screen,
    top: 'center', left: 'center', width: '80%', height: 10,
    border: { type: 'line' },
    style: { border: { fg: 'red' } },
    inputOnFocus: true,
    label: ' Редактирование (Enter отправить, Esc отмена) ',
  });
  editBox.setValue(msg.content);
  editBox.focus();
  screen.render();
  return new Promise(resolve => {
    editBox.key('enter', () => {
      const newText = editBox.getValue().trim();
      editBox.destroy();
      // Удаляем все сообщения после этого (включая ответы)
      const idx = messages.indexOf(msg);
      if (idx >= 0) {
        messages.splice(idx + 1);
        messages[idx].content = newText;
        updateChatLog();
        // Отправляем перегенерацию
        const parent = msg.parent_id || (idx > 0 ? messages[idx - 1]?.message_id : null);
        sendMessage(newText, parent);
      }
      resolve();
    });
    editBox.key('escape', () => {
      editBox.destroy();
      screen.render();
      resolve();
    });
  });
}

function promptCopyBlock() {
  const lastMsg = [...messages].reverse().find(m => m.role === 'ASSISTANT');
  if (!lastMsg) return;
  const blocks = [...lastMsg.content.matchAll(/```([\s\S]*?)```/g)].map(m => m[1]);
  if (blocks.length === 0) { copyToClipboard(lastMsg.content); return; }
  if (blocks.length === 1) { copyToClipboard(blocks[0]); return; }
  // Показываем выбор
  const list = blessed.list({
    parent: screen,
    top: 'center', left: 'center', width: '50%', height: '30%',
    border: { type: 'line' },
    items: blocks.map((b, i) => `[${i + 1}] ${b.slice(0, 40).replace(/\n/g, ' ')}...`),
    style: { selected: { bg: 'red' } },
    keys: true, vi: true,
  });
  list.focus();
  list.on('select', (_, idx) => {
    copyToClipboard(blocks[idx]);
    list.destroy();
    screen.render();
  });
  list.key('escape', () => { list.destroy(); screen.render(); });
  screen.render();
}

function promptCopyMessage() {
  const prompt = blessed.prompt({
    parent: screen,
    top: 'center', left: 'center', width: '30%', height: 5,
    border: { type: 'line' },
  });
  prompt.input('Номер сообщения (Enter для последнего)', '', (err, value) => {
    const num = parseInt(value?.trim());
    let msg;
    if (isNaN(num)) {
      msg = messages[messages.length - 1];
    } else {
      msg = messages.find(m => m.message_id === num);
    }
    if (msg) copyToClipboard(msg.content);
    screen.render();
  });
}

// -------------------- Старт --------------------
screen = blessed.screen({ smartCSR: true, title: 'DeepTerm' });
screen.key(['C-q'], () => process.exit(0)); // глобальный выход на Ctrl+Q

showSessionSelector();
