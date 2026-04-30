// state.js
// Глобальное состояние приложения

export const state = {
  // Текущая сессия (ID)
  currentSessionId: null,
  // Название сессии (для отображения в заголовке)
  sessionTitle: "New chat",

  // История сообщений текущей сессии: массив объектов {role, content, parent_id, message_id, thinking_content?}
  messages: [],

  // Кэш сообщений по всем сессиям: { [sessionId]: messages[] }
  cache: {
    messages: {}
  },

  // ID последнего сообщения ассистента (необходимо для некоторых операций в других модулях)
  lastAssistantMessageId: null,

  // Флаги режимов
  ignoreResponses: false,   // игнорировать ответы (не отправлять)
  thinkingEnabled: true,   // показывать thinking-блок
  searchEnabled: true,     // включить поиск в интернете

  // Файлы, прикреплённые к следующему сообщению
  attachedFileIds: [],

  // Контроллер текущего стрима (для остановки)
  streamCtrl: null,

  // Ручная установка parent_id на одно сообщение (сбрасывается после отправки)
  forcedParentId: null,
  // Замороженный parent_id (действует для всех сообщений, пока не выключен)
  frozenParentId: null,

  // Экран blessed (устанавливается в main.js после инициализации)
  screen: null
};

// Функция частичного обновления состояния (мерджит переданные поля)
export function updateState(updates) {
  Object.assign(state, updates);
  // Здесь при необходимости можно добавить сохранение в localStorage,
  // синхронизацию с диском и т.п.
}
