#!/usr/bin/env node
import blessed from 'blessed';
import * as core from './core.js';
import { mdToBlessed } from './md.js';
import { copyToClipboard, readClipboard, extractFilePaths } from './utils.js';
import fs from 'fs';

const TOKEN = process.env.DEEPSEEK_TOKEN;
if (!TOKEN) {
  console.error('❌ Переменная DEEPSEEK_TOKEN не задана.');
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
let sessionTitle = '';

// ---------- Элементы UI ----------
let sessionList, chatLog, inputBox, thinkingBox, statusBar;

// ---------- Вспомогательные функции ----------
function showError(msg) {
  console.error(`${msg}`)
  const errBox = blessed.message({
    parent: screen,
    top: 'center', left: 'center', width: '50%', height: '20%',
    border: { type: 'line' },
    style: { border: { fg: 'red' } },
    label: ' Ошибка ',
    content: msg,
  });
  setTimeout(() => { errBox.destroy(); screen.render(); }, 3000);
  screen.render();
}

async function initCore() {
  try {
    // Тестовая инициализация wasm
    await core.solvePow('test', '0', Date.now()+10000, 0);
  } catch (e) {
    throw e;
  }
}

// ---------- Селектор сессий ----------
async function showSessionSelector() {
  // Уничтожаем все дочерние элементы
  screen.children.forEach(c => c.destroy());

  sessionList = blessed.list({
    parent: screen,
    top: 2, left: 2, width: '96%', height: '90%',
    border: { type: 'line' },
    style: { selected: { bg: 'red' }, border: { fg: 'red' } },
    keys: true,
    vi: true,
    label: ' Чат сессии (стрелки, Enter/Пробел — выбрать, e — переименовать, d — удалить, D — удалить без подтверждения) ',
  });

  let sessions = [];

  async function loadSessions() {
    const data = await core.fetchAllChatSessions(TOKEN);
    if (!data?.data?.biz_data?.chat_sessions) {
      showError('Не удалось загрузить сессии.');
      return;
    }
    sessions = data.data.biz_data.chat_sessions;
    refreshList();
  }

  function refreshList() {
    sessionList.setItems(
      sessions.map(s => `[${s.title || 'без названия'}]`).concat(['[+] Новый чат'])
    );
    screen.render();
  }

  sessionList.on('select', async (item, index) => {
    if (index === sessions.length) {
      // Создать новый
      const newChat = await core.createChatSession(TOKEN);
      if (newChat?.data?.biz_data?.id) {
        currentSessionId = newChat.data.biz_data.id;
        sessionTitle = 'Новый чат';
        messages = [];
        screen.children.forEach(c => c.destroy());
        showChat();
      }
    } else {
      currentSessionId = sessions[index].id;
      sessionTitle = sessions[index].title || 'Без названия';
      const hist = await core.fetchHistoryMessages(TOKEN, currentSessionId);
      messages = hist?.data?.biz_data?.chat_messages || [];
      screen.children.forEach(c => c.destroy());
      showChat();
    }
  });

  // Клавиши для селектора
  sessionList.key('e', async () => {
    const idx = sessionList.selected;
    if (idx >= sessions.length) return;
    const prompt = blessed.prompt({
      parent: screen,
      top: 'center', left: 'center', width: '40%', height: 5,
      border: { type: 'line' },
      style: { border: { fg: 'red' } },
    });
    const newName = await prompt.input('Новое имя', sessions[idx].title || '');
    if (newName) {
      await core.updateChatTitle(TOKEN, sessions[idx].id, newName);
      sessions[idx].title = newName;
      refreshList();
    }
    sessionList.focus();
    screen.render();
  });

  sessionList.key('d', async () => {
    const idx = sessionList.selected;
    if (idx >= sessions.length) return;
    const prompt = blessed.prompt({
      parent: screen,
      top: 'center', left: 'center', width: '40%', height: 5,
      border: { type: 'line' },
      style: { border: { fg: 'red' } },
    });
    const confirm = await prompt.input('Введите "yes" для удаления', '');
    if (confirm?.toLowerCase() === 'yes') {
      // Сохраняем историю перед удалением
      const hist = await core.fetchHistoryMessages(TOKEN, sessions[idx].id);
      if (hist?.data?.biz_data?.chat_messages) {
        core.saveHistoryToFile(hist.data.biz_data.chat_messages, sessions[idx].title);
      }
      await core.deleteChatSession(TOKEN, sessions[idx].id);
      sessions.splice(idx, 1);
      refreshList();
    }
    sessionList.focus();
    screen.render();
  });

  sessionList.key('D', async () => {
    const idx = sessionList.selected;
    if (idx >= sessions.length) return;
    // Сохраняем историю
    const hist = await core.fetchHistoryMessages(TOKEN, sessions[idx].id);
    if (hist?.data?.biz_data?.chat_messages) {
      core.saveHistoryToFile(hist.data.biz_data.chat_messages, sessions[idx].title);
    }
    await core.deleteChatSession(TOKEN, sessions[idx].id);
    sessions.splice(idx, 1);
    refreshList();
    sessionList.focus();
    screen.render();
  });

  sessionList.key('escape', () => process.exit(0));
  sessionList.focus();
  screen.render();
  await loadSessions();
}

// ---------- Чат ----------
function showChat() {
  chatLog = blessed.box({
    parent: screen,
    top: 0, left: 0, width: '100%', height: '90%',
    tags: true,
    scrollable: true,
    scrollbar: { ch: ' ' },
    keys: true,
    mouse: true,
    border: { type: 'line' },
    style: { border: { fg: 'red' } },
    label: ` ${sessionTitle} `,
    content: '',
  });

  thinkingBox = blessed.box({
    parent: screen,
    top: 0, left: 0, width: '100%', height: '25%',
    hidden: true,
    border: { type: 'line' },
    style: { border: { fg: 'yellow' } },
    label: ' 💭 Мышление ',
    content: '',
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
    content: ' Ctrl+Q выход | Ctrl+E реген | Ctrl+S стоп | Alt+S игнор | Ctrl+C копировать блок | Alt+C копировать сообщение | Ctrl+T мышление | Alt+T поиск | Tab фокус ввода | ↑↓ скролл ',
  });

  // Перемещение фокуса по Tab
  screen.key('tab', () => {
    if (screen.focused === chatLog) inputBox.focus();
    else chatLog.focus();
    screen.render();
  });

  // Клик мыши на поле ввода
  inputBox.on('click', () => {
    inputBox.focus();
    screen.render();
  });

  chatLog.on('wheelup', () => {
    chatLog.scroll(-1);
    screen.render();
  });
  chatLog.on('wheeldown', () => {
    chatLog.scroll(1);
    screen.render();
  });

  // Стрелки вверх/вниз скроллят чат (когда в фокусе)
  chatLog.key('up', () => { chatLog.scroll(-1); screen.render(); });
  chatLog.key('down', () => { chatLog.scroll(1); screen.render(); });

  // Глобальные хоткеи
  screen.key(['C-q'], () => {
    showSessionSelector();
  });

  screen.key('C-e', () => {
    regenLock = !regenLock;
    updateStatus();
  });

  screen.key('M-e', async () => {
    // Редактирование сообщения
    const prompt = blessed.prompt({
      parent: screen,
      top: 'center', left: 'center', width: '30%', height: 5,
      border: { type: 'line' },
    });
    const numStr = await prompt.input('message_id для редактирования', '');
    if (!numStr) return;
    const msgId = parseInt(numStr);
    const msg = messages.find(m => m.message_id === msgId && m.role === 'USER');
    if (!msg) return;
    const editBox = blessed.textbox({
      parent: screen,
      top: 'center', left: 'center', width: '80%', height: 10,
      border: { type: 'line' },
      inputOnFocus: true,
      label: ' Редактировать (Enter отправить, Esc отмена) ',
    });
    editBox.setValue(msg.content);
    editBox.focus();
    screen.render();
    editBox.key('enter', () => {
      const newText = editBox.getValue().trim();
      editBox.destroy();
      const idx = messages.indexOf(msg);
      if (idx >= 0) {
        messages.splice(idx + 1);
        messages[idx].content = newText;
        updateChatLog();
        const parent = msg.parent_id || (idx > 0 ? messages[idx - 1]?.message_id : null);
        sendMessage(newText, parent);
      }
    });
    editBox.key('escape', () => { editBox.destroy(); screen.render(); });
  });

  screen.key('C-s', async () => {
    await stopCurrentStream();
  });

  screen.key('M-s', () => {
    ignoreResponses = !ignoreResponses;
    updateStatus();
  });

  screen.key('C-c', () => {
    // Копировать блок
    const lastMsg = [...messages].reverse().find(m => m.role === 'ASSISTANT');
    if (!lastMsg) return;
    const blocks = [...lastMsg.content.matchAll(/```([\s\S]*?)```/g)].map(m => m[1]);
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
      top: 'center', left: 'center', width: '50%', height: '30%',
      border: { type: 'line' },
      items: blocks.map((b, i) => `[${i + 1}] ${b.slice(0, 40).replace(/\n/g, ' ')}...`),
      style: { selected: { bg: 'red' } },
      keys: true,
    });
    choices.focus();
    choices.on('select', (_, i) => {
      copyToClipboard(blocks[i]);
      choices.destroy();
      screen.render();
    });
    choices.key('escape', () => { choices.destroy(); screen.render(); });
    screen.render();
  });

  screen.key('M-c', () => {
    const prompt = blessed.prompt({
      parent: screen,
      top: 'center', left: 'center', width: '30%', height: 5,
      border: { type: 'line' },
    });
    prompt.input('message_id или Enter для последнего', '', (err, value) => {
      const num = parseInt(value?.trim());
      let msg;
      if (isNaN(num)) msg = messages[messages.length - 1];
      else msg = messages.find(m => m.message_id === num);
      if (msg) copyToClipboard(msg.content);
      screen.render();
    });
  });

  screen.key('C-t', () => {
    thinkingEnabled = !thinkingEnabled;
    updateStatus();
  });

  screen.key('M-t', () => {
    searchEnabled = !searchEnabled;
    updateStatus();
  });

  screen.key('C-v', async () => {
    const clip = readClipboard();
    const paths = extractFilePaths(clip).filter(p => {
      try { return fs.existsSync(p); } catch { return false; }
    });
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

  screen.key('M-v', () => {
    const clip = readClipboard();
    inputBox.setValue(clip);
    screen.render();
  });

  // Отправка сообщения
  inputBox.key('enter', async () => {
    const text = inputBox.getValue().trim();
    if (!text) return;
    inputBox.clearValue();
    let parent = null;
    if (regenLock) {
      // Перегенерация последнего ответа
      const lastAsIdx = messages.map(m => m.role).lastIndexOf('ASSISTANT');
      if (lastAsIdx >= 0) {
        messages.splice(lastAsIdx, 1);
        const lastUserIdx = messages.map(m => m.role).lastIndexOf('USER');
        if (lastUserIdx >= 0) {
          parent = messages[lastUserIdx].message_id || null;
        }
      }
      messages.push({ role: 'USER', content: text, message_id: null, parent_id: parent });
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
function formatMessage(msg) {
  const role = msg.role === 'USER' ? 'Вы' : 'DeepSeek';
  const idStr = msg.message_id ? ` #${msg.message_id}` : '';

  // Извлекаем текст из fragments
  let raw = '';
  if (Array.isArray(msg.fragments)) {
    raw = msg.fragments
      .filter(f => f.content && (f.type === 'REQUEST' || f.type === 'RESPONSE'))
      .map(f => f.content)
      .join('\n');
  } else if (typeof msg.content === 'string') {
    raw = msg.content; // fallback на старый формат
  }

  let body = '';
  if (msg.thinking_content) {
    const elapsed = msg.thinking_elapsed_secs?.toFixed(2) || '?';
    body += `{yellow-fg}[Думал ${elapsed}с]{/yellow-fg}\n`;
  }
  body += mdToBlessed(raw);
  return `{bold}${role}${idStr}{/bold}\n${body}\n`;
}

function updateChatLog() {
  chatLog.setContent(messages.map(formatMessage).join(''));
  chatLog.setScrollPerc(100);
  screen.render();
}

function updateStatus() {
  const parts = [];
  if (regenLock) parts.push('REGEN');
  if (ignoreResponses) parts.push('NO-RESP');
  if (thinkingEnabled) parts.push('THINK');
  if (searchEnabled) parts.push('SEARCH');
  if (attachedFileIds.length) parts.push(`FILES:${attachedFileIds.length}`);
  statusBar.setContent(parts.join(' | ') + ' | Ctrl+Q выход | Ctrl+E реген | Ctrl+S стоп | Alt+S игнор | Ctrl+C копировать блок | Alt+C копировать сообщение | Ctrl+T мышление | Alt+T поиск | Tab фокус ввода | ↑↓ скролл ');
  screen.render();
}

async function sendMessage(prompt, parentMsgId = null) {
  if (!currentSessionId) return;
  const userMsg = { role: 'USER', content: prompt, message_id: null, parent_id: parentMsgId };
  messages.push(userMsg);
  updateChatLog();

  if (ignoreResponses) return;

  const fileIds = [...attachedFileIds];
  attachedFileIds = [];
  updateStatus();

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
    const generator = core.completion(TOKEN, prompt, currentSessionId, parentMsgId, {
      search: searchEnabled,
      thinking: thinkingEnabled,
      file_ids: fileIds,
    });

    for await (const chunk of generator) {
      if (streamCtrl.abort) break;
      if (chunk.type === 'thinking') {
        thinkingText += chunk.content;
        thinkingBox.setContent(thinkingText);
        messages[assistantIdx].thinking_content = thinkingText;
        updateChatLog();
      } else if (chunk.type === 'text') {
        answerText += chunk.content;
        messages[assistantIdx].content = answerText;
        if (chunk.message_id) newMessageId = chunk.message_id;
        updateChatLog();
      } else if (chunk.type === 'searching') {
        messages[assistantIdx].content = '🔍 Поиск...';
        updateChatLog();
      }
    }
  } catch (e) {
	console.error(`${e.message}`)
    messages[assistantIdx].content = `❌ Ошибка: ${e.message}`;
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
      await core.stopStream(TOKEN, currentSessionId, lastAssistantMessageId);
    }
  }
}

// ---------- Entry point ----------
screen = blessed.screen({ smartCSR: true, title: 'DeepTerm' });

(async () => {
  try {
    await initCore();
    await showSessionSelector();
  } catch (e) {
	console.error(`${e.message}`)
    process.exit(1);
  }
})();
