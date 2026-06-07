const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('spotlightAPI', {
  saveThought: (data) => ipcRenderer.send('spotlight-save-thought', data),
  saveArchive: (data) => ipcRenderer.send('spotlight-save-archive', data),
  executeWorkflow: (name) => ipcRenderer.send('spotlight-execute-workflow', name),
  getWorkflows: () => ipcRenderer.invoke('spotlight-get-workflows'),
  searchLocalFiles: (query) => ipcRenderer.invoke('spotlight-search-files', query),
  openFile: (filePath) => ipcRenderer.send('spotlight-open-file', filePath),
  openUrl: (url) => ipcRenderer.send('spotlight-open-url', url),
  close: () => ipcRenderer.send('spotlight-close'),
  openApp: () => ipcRenderer.send('spotlight-open-app'),
  onShown: (callback) => ipcRenderer.on('spotlight-shown', () => callback()),
  onHidden: (callback) => ipcRenderer.on('spotlight-hidden', () => callback()),
  resize: (size) => ipcRenderer.send('spotlight-resize', size),
  getLayout: () => ipcRenderer.invoke('spotlight-get-layout'),
  setPanelOpen: (open) => ipcRenderer.send('spotlight-set-panel-open', open),
  getAiConfig: () => ipcRenderer.invoke('spotlight-get-ai-config'),
  chat: (opts) => ipcRenderer.invoke('spotlight-ai-chat', opts),
  onChatChunk: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on('spotlight-ai-chunk', handler);
    return () => ipcRenderer.removeListener('spotlight-ai-chunk', handler);
  },
  webSearch: (query) => ipcRenderer.invoke('spotlight-web-search', query),
  openResultUrl: (url) => ipcRenderer.send('spotlight-open-result-url', url),
  getNotes: () => ipcRenderer.invoke('spotlight-get-notes'),
  saveNotes: (text) => ipcRenderer.invoke('spotlight-save-notes', text),
  createNote: (data) => ipcRenderer.invoke('notes-create', data),
  updateNote: (id, updates) => ipcRenderer.invoke('notes-update', id, updates),
  getAllNotes: () => ipcRenderer.invoke('notes-get-all'),
  getNote: (id) => ipcRenderer.invoke('notes-get', id),
  openCalendar: (prefill) => ipcRenderer.send('spotlight-open-calendar', prefill),
  parseCalendarCommand: (text) => ipcRenderer.invoke('calendar-parse', text),
  isCalendarTrigger: (text) => ipcRenderer.invoke('calendar-is-trigger', text),
  getTags: () => ipcRenderer.invoke('spotlight-get-tags'),
  createCalendarFromThought: (data) => ipcRenderer.invoke('spotlight-calendar-from-thought', data),
  saveChatSession: (session) => ipcRenderer.invoke('spotlight-chat-save', session),
  getChatSessions: () => ipcRenderer.invoke('spotlight-chat-get-all'),
  deleteChatSession: (id) => ipcRenderer.invoke('spotlight-chat-delete', id),

  // Memory
  getMemory: () => ipcRenderer.invoke('spotlight-get-memory'),

  // Thought Stack
  getRecentThoughts: () => ipcRenderer.invoke('spotlight-get-recent-thoughts'),
  openThought: (id) => ipcRenderer.send('spotlight-open-thought', id),
  onRefreshThoughts: (callback) => ipcRenderer.on('spotlight-refresh-thoughts', () => callback()),

  // Whispr (speech-to-text)
  onWhisprToggle: (callback) => ipcRenderer.on('whispr-toggle', (e, recording) => callback(recording)),
  whisprTranscribe: (audioBuffer) => ipcRenderer.invoke('whispr-transcribe', audioBuffer),
  onWhisprResult: (callback) => ipcRenderer.on('whispr-result', (e, result) => callback(result)),
  whisprToggleFromRenderer: () => ipcRenderer.send('whispr-toggle-from-renderer'),
});
