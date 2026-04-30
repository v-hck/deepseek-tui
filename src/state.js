export const state = {
	screen: null,
	currentSessionId: null,
	messages: [],
	lastAssistantMessageId: null,
	streamCtrl: null,
	ignoreResponses: false,
	thinkingEnabled: false,
	searchEnabled: true,
	attachedFileIds: [],
	sessionTitle: "",
	cache: {
		sessions: null,
		messages: {},
	},
};

export function updateState(updates) {
	Object.assign(state, updates);
}
