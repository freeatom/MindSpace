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
});
