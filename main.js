const { app, BrowserWindow, ipcMain, shell, dialog, clipboard, nativeImage, globalShortcut, screen, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, exec } = require('child_process');
const https = require('https');
const http = require('http');
const settingsStore = require('./services/settings-store');
const { chatCompletion, streamChatCompletion, validateApiKey, getDefaultModel, PROVIDERS } = require('./services/llm-providers');
const { searchWeb } = require('./services/web-search');
const notesStore = require('./services/notes-store');
const calendarStore = require('./services/calendar-store');
const CalendarScheduler = require('./services/calendar-scheduler');
const calendarParser = require('./services/calendar-parser');
const whispr = require('./services/whispr');

let mainWindow;
let calendarScheduler = null;
let spotlightWindow = null;
let spotlightPanelOpen = false;
let spotlightReady = false;
let cachedSpotlightWorkflows = null;
let workflowsCacheMtime = 0;
let tray = null;

// ─── Whispr (speech-to-text) state ───
let whisprPillWindow = null;
let whisprRecording = false;

function getNotesPath() {
  return path.join(app.getPath('userData'), 'mindspace-data', 'spotlight-notes.txt');
}

function readSpotlightNotes() {
  const notesPath = getNotesPath();
  if (!fs.existsSync(notesPath)) return '';
  return fs.readFileSync(notesPath, 'utf8');
}

function writeSpotlightNotes(text) {
  const notesPath = getNotesPath();
  const dir = path.dirname(notesPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(notesPath, text || '', 'utf8');
}

async function migrateLegacySpotlightNotes() {
  const legacyPath = getNotesPath();
  if (!fs.existsSync(legacyPath)) return;
  const text = fs.readFileSync(legacyPath, 'utf8').trim();
  if (!text) return;
  const existing = await notesStore.getAll();
  const alreadyMigrated = existing.some((n) => n.name === 'Spotlight Scratchpad (migrated)');
  if (!alreadyMigrated) {
    await notesStore.create({
      name: 'Spotlight Scratchpad (migrated)',
      content: text,
    });
  }
  fs.unlinkSync(legacyPath);
}

// ─── Notes database (shared: main app + spotlight) ───
ipcMain.handle('notes-create', async (event, data) => notesStore.create(data));
ipcMain.handle('notes-update', async (event, id, updates) => notesStore.update(id, updates));
ipcMain.handle('notes-delete', async (event, id) => notesStore.remove(id));
ipcMain.handle('notes-get', async (event, id) => notesStore.getById(id));
ipcMain.handle('notes-get-all', async () => notesStore.getAll());
ipcMain.handle('notes-search', async (event, query) => notesStore.search(query));

// ─── Calendar events database ───
ipcMain.handle('calendar-create', async (event, data) => {
  const created = await calendarStore.create(data);
  if (calendarScheduler) await calendarScheduler.rescheduleAll();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('calendar-refresh');
  return created;
});
ipcMain.handle('calendar-update', async (event, id, updates) => {
  const updated = await calendarStore.update(id, updates);
  if (calendarScheduler) await calendarScheduler.rescheduleAll();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('calendar-refresh');

  // 2-Way Sync: If calendar event is completed, mark associated thought as finished
  if (updates.status === 'completed' && updated.thought_id) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('spotlight-ai-update-thought', { 
        id: updated.thought_id, 
        updates: { status: 'finished' },
        replyChannel: 'ignore-sync' 
      });
    }
  }

  return updated;
});
ipcMain.handle('calendar-delete', async (event, id) => {
  const result = await calendarStore.remove(id);
  if (calendarScheduler) await calendarScheduler.rescheduleAll();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('calendar-refresh');
  return result;
});
ipcMain.handle('calendar-get', async (event, id) => calendarStore.getById(id));
ipcMain.handle('calendar-get-all', async () => calendarStore.getAll());
ipcMain.handle('calendar-search', async (event, filters) => calendarStore.search(filters));
ipcMain.handle('calendar-stats', async () => calendarStore.getStats());
ipcMain.handle('calendar-parse', async (event, text) => calendarParser.parseCalendarCommand(text));
ipcMain.handle('calendar-is-trigger', async (event, text) => calendarParser.isCalendarTrigger(text));
ipcMain.handle('calendar-snooze', async (event, id, minutes) => {
  if (calendarScheduler) await calendarScheduler.snooze(id, minutes);
  return true;
});
ipcMain.handle('calendar-dismiss-notification', async (event, id) => {
  if (calendarScheduler) await calendarScheduler.dismiss(id);
  return true;
});

function getAiConfigFromStore() {
  const userData = app.getPath('userData');
  const provider = settingsStore.getSetting(userData, 'aiProvider') || 'groq';

  // API Key Fallback Logic
  const primaryKey = settingsStore.getSetting(userData, 'aiApiKey') || '';
  const secondaryKey = settingsStore.getSetting(userData, 'aiApiKeySecondary') || '';
  const activeKeyIndex = settingsStore.getSetting(userData, 'aiActiveKeyIndex') || 0;
  const apiKey = (activeKeyIndex === 1 && secondaryKey.trim()) ? secondaryKey : primaryKey;

  const model = settingsStore.getSetting(userData, 'aiModel') || '';
  const whisprModel = settingsStore.getSetting(userData, 'aiWhisprModel') || 'whisper-large-v3-turbo';
  const aiAutoFallback = settingsStore.getSetting(userData, 'aiAutoFallback') || false;

  // Whispr has its own dedicated Groq key; falls back to the active chat key
  const dedicatedWhisprKey = settingsStore.getSetting(userData, 'whisprApiKey') || '';
  const whisprApiKey = dedicatedWhisprKey.trim() ? dedicatedWhisprKey : apiKey;

  return {
    provider,
    apiKey,
    primaryKey,
    secondaryKey,
    activeKeyIndex,
    model: model || getDefaultModel(provider),
    whisprModel,
    whisprApiKey,
    aiAutoFallback,
    hasKey: !!(apiKey && apiKey.trim()),
    supportsStream: !!(PROVIDERS[provider]?.supportsStream),
  };
}
let clipboardPollTimer = null;
let lastClipText = '';
let lastClipImageHash = '';

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#f8f7f4',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    icon: path.join(__dirname, 'src', 'assets', 'icon.png'),
    show: false,
    fullscreen: true,
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.webContents.setZoomLevel(0);
    mainWindow.show();
  });

  // ─── Close = Hide to tray (keep services alive) ───
  // Only truly close if app.isQuitting (set by tray "Exit" or system shutdown)
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      return;
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // When the main window reloads (Ctrl+R), also reload the spotlight
  let initialLoadDone = false;
  mainWindow.webContents.on('did-finish-load', () => {
    if (!initialLoadDone) {
      initialLoadDone = true;
      return; // Skip the first load (app startup)
    }
    // Main window was reloaded — reload spotlight too
    if (spotlightWindow && !spotlightWindow.isDestroyed()) {
      spotlightReady = false;
      spotlightPanelOpen = false;
      spotlightWindow.webContents.reload();
      spotlightWindow.once('ready-to-show', () => { spotlightReady = true; });
    }
  });
}

// ─── System Tray ───
function createTray() {
  const trayIconPath = path.join(__dirname, 'src', 'assets', 'tray-icon.png');
  const icon = nativeImage.createFromPath(trayIconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('MindSpace');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open MindSpace',
      click: () => showOrCreateMainWindow(),
    },
    {
      label: 'Toggle Spotlight',
      click: () => toggleSpotlight(),
    },
    { type: 'separator' },
    {
      label: 'Exit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  // Double-click tray icon → open/show main window
  tray.on('double-click', () => {
    showOrCreateMainWindow();
  });
}

// ─── Show or Create Main Window ───
function showOrCreateMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  } else {
    createWindow();
  }
}

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showOrCreateMainWindow();
  });
}

// Set AppUserModelId for Windows notifications to work correctly
app.setAppUserModelId('com.abeezzz.mindspace');

app.whenReady().then(async () => {
  await notesStore.init(app.getPath('userData'));
  await migrateLegacySpotlightNotes();
  await calendarStore.init(app.getPath('userData'));

  createWindow();

  // Create system tray (persistent lifecycle control)
  createTray();

  calendarScheduler = new CalendarScheduler(() => mainWindow);
  await calendarScheduler.start();

  // Register global spotlight shortcut
  globalShortcut.register('Alt+Space', () => {
    toggleSpotlight();
  });

  // Register Whispr shortcut (Alt+`)
  globalShortcut.register('Alt+`', () => {
    toggleWhispr();
  });

  // Pre-warm spotlight so Alt+Space opens instantly (hidden, already loaded)
  prewarmSpotlight();

  // Start clipboard polling
  startClipboardPolling();

  // Start push-to-talk monitor (Right Shift key)
  startPushToTalkMonitor();

  // Pre-warm whispr pill so it's instantly ready on first PTT press
  createWhisprPill();
});

app.on('will-quit', () => {
  app.isQuitting = true;
  globalShortcut.unregisterAll();
  stopClipboardPolling();
  stopPushToTalkMonitor();
  if (calendarScheduler) calendarScheduler.stop();
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

// ─── Keep process alive when all windows are closed ───
// Services (calendar, spotlight, PTT, clipboard) continue running in background.
// Only exit when the user explicitly clicks "Exit" from the system tray.
app.on('window-all-closed', () => {
  // Do NOT quit — keep background services running
  // The tray icon remains visible for the user to reopen or exit
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// ─── Spotlight Window (right-docked, above system tray) ───
const SPOTLIGHT_WIDTH = 380;

function getSpotlightLayout() {
  const display = screen.getPrimaryDisplay();
  const { workArea } = display;
  return {
    width: SPOTLIGHT_WIDTH,
    maxHeight: workArea.height,
    workArea,
  };
}

function positionSpotlightWindow(win, width, height) {
  const { workArea } = getSpotlightLayout();
  const w = width || SPOTLIGHT_WIDTH;
  const h = Math.min(height, workArea.height);
  const x = workArea.x + workArea.width - w;
  const y = workArea.y + workArea.height - h;
  win.setBounds({ x, y, width: w, height: h });
}

const SPOTLIGHT_COMPACT_HEIGHT = 118;

function createSpotlightWindow() {
  if (spotlightWindow && !spotlightWindow.isDestroyed()) {
    return spotlightWindow;
  }

  spotlightReady = false;
  const layout = getSpotlightLayout();

  // Create at full height from the start so there's no resize flash
  spotlightWindow = new BrowserWindow({
    width: layout.width,
    height: layout.maxHeight,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    center: false,
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: path.join(__dirname, 'spotlight-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      backgroundThrottling: false,
    },
  });

  positionSpotlightWindow(spotlightWindow, layout.width, layout.maxHeight);

  spotlightWindow.loadFile(path.join(__dirname, 'src', 'spotlight.html'));

  spotlightWindow.once('ready-to-show', () => {
    spotlightReady = true;
  });

  spotlightWindow.on('blur', () => {
    if (spotlightPanelOpen) return;
    hideSpotlight();
  });

  spotlightWindow.on('closed', () => {
    spotlightWindow = null;
    spotlightReady = false;
    spotlightPanelOpen = false;
  });

  // Catch Escape at the Chromium level — works regardless of DOM focus state
  // This is the bulletproof way to handle Escape in transparent/frameless windows
  spotlightWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'Escape' && input.type === 'keyDown') {
      event.preventDefault();
      hideSpotlight();
    }
  });

  return spotlightWindow;
}

function prewarmSpotlight() {
  createSpotlightWindow();
}

function showSpotlight() {
  const win = createSpotlightWindow();
  const layout = getSpotlightLayout();

  const reveal = () => {
    // Position at full height before showing to avoid resize flash
    positionSpotlightWindow(win, layout.width, layout.maxHeight);
    if (!win.isVisible()) win.show();
    win.focus();
    // Small delay to let the window paint at correct size before triggering
    // renderer animations, preventing the double-pop effect
    setTimeout(() => {
      if (!win.isDestroyed()) {
        win.webContents.send('spotlight-shown');
      }
    }, 30);
  };

  const isLoaded = spotlightReady
    || (!win.webContents.isLoading() && win.webContents.getURL() !== '');

  if (isLoaded) {
    spotlightReady = true;
    reveal();
  } else {
    win.once('ready-to-show', () => {
      spotlightReady = true;
      reveal();
    });
  }
}

function hideSpotlight() {
  if (spotlightWindow && !spotlightWindow.isDestroyed() && spotlightWindow.isVisible()) {
    spotlightWindow.webContents.send('spotlight-hidden');
    spotlightWindow.hide();
  }
}

function toggleSpotlight() {
  if (spotlightWindow && !spotlightWindow.isDestroyed() && spotlightWindow.isVisible()) {
    hideSpotlight();
    return;
  }
  showSpotlight();
}

function readSpotlightWorkflows() {
  const dbPath = path.join(app.getPath('userData'), 'mindspace-data', 'workflows.db');
  if (!fs.existsSync(dbPath)) return [];
  try {
    const stat = fs.statSync(dbPath);
    if (cachedSpotlightWorkflows && stat.mtimeMs === workflowsCacheMtime) {
      return cachedSpotlightWorkflows;
    }
    const lines = fs.readFileSync(dbPath, 'utf8').split('\n');
    const wfs = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try { wfs.push(JSON.parse(line)); } catch (e) { /* skip bad line */ }
    }
    cachedSpotlightWorkflows = wfs;
    workflowsCacheMtime = stat.mtimeMs;
    return wfs;
  } catch (err) {
    console.error('Failed to read workflows for spotlight:', err);
    return cachedSpotlightWorkflows || [];
  }
}

ipcMain.on('spotlight-set-panel-open', (event, open) => {
  spotlightPanelOpen = !!open;
});

ipcMain.handle('spotlight-get-layout', () => getSpotlightLayout());

ipcMain.on('spotlight-resize', (event, { width, height }) => {
  if (spotlightWindow && !spotlightWindow.isDestroyed()) {
    const layout = getSpotlightLayout();
    const w = width || layout.width;
    const h = Math.min(Math.max(height || 108, 96), layout.maxHeight);
    positionSpotlightWindow(spotlightWindow, w, h);
  }
});

ipcMain.on('spotlight-close', () => {
  hideSpotlight();
});

ipcMain.on('spotlight-open-calendar', (event, prefill) => {
  hideSpotlight();
  showOrCreateMainWindow();
  // Wait briefly for window to be ready if it was just created
  const sendCalendarEvent = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('calendar-open-event-modal', prefill || {});
    }
  };
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
    sendCalendarEvent();
  } else if (mainWindow) {
    mainWindow.webContents.once('did-finish-load', sendCalendarEvent);
  }
});

// ─── Spotlight: Open in App ───
ipcMain.on('spotlight-open-app', () => {
  hideSpotlight();
  showOrCreateMainWindow();
});

// ─── Spotlight Chat History ───
let chatHistoryDb = null;
function getChatHistoryDb() {
  if (chatHistoryDb) return chatHistoryDb;
  const Datastore = require('nedb-promises');
  const dbPath = path.join(app.getPath('userData'), 'mindspace-data', 'chat-history.db');
  chatHistoryDb = Datastore.create({ filename: dbPath, autoload: true });
  return chatHistoryDb;
}

ipcMain.handle('spotlight-chat-save', async (event, session) => {
  const db = getChatHistoryDb();
  const doc = {
    _id: session._id || require('crypto').randomBytes(16).toString('hex'),
    messages: session.messages || [],
    preview: session.preview || '',
    createdAt: session.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  // Upsert: update if exists, insert if new
  const existing = await db.findOne({ _id: doc._id });
  if (existing) {
    await db.update({ _id: doc._id }, { $set: { messages: doc.messages, preview: doc.preview, updatedAt: doc.updatedAt } });
  } else {
    await db.insert(doc);
  }
  return doc;
});

ipcMain.handle('spotlight-chat-get-all', async () => {
  const db = getChatHistoryDb();
  return db.find({}).sort({ updatedAt: -1 });
});

ipcMain.handle('spotlight-chat-delete', async (event, id) => {
  const db = getChatHistoryDb();
  return db.remove({ _id: id });
});

// Spotlight saves go through main window's webContents
// ─── Spotlight saves: relay to main window (works even when hidden) ───
// When mainWindow is hidden (not destroyed), webContents is still alive and can receive messages.
// If mainWindow was somehow destroyed, we recreate it in the background to process the save.
ipcMain.on('spotlight-save-thought', (event, data) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('spotlight-create-thought', data);
  } else {
    // Recreate window in background to handle the save
    createWindow();
    mainWindow.hide();
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.webContents.send('spotlight-create-thought', data);
    });
  }
});

ipcMain.on('spotlight-save-archive', (event, data) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('spotlight-create-archive', data);
  } else {
    createWindow();
    mainWindow.hide();
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.webContents.send('spotlight-create-archive', data);
    });
  }
});

ipcMain.on('spotlight-execute-workflow', (event, name) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('spotlight-execute-workflow', name);
  } else {
    createWindow();
    mainWindow.hide();
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.webContents.send('spotlight-execute-workflow', name);
    });
  }
});

ipcMain.handle('spotlight-get-workflows', () => readSpotlightWorkflows());

// Spotlight: get all tags for the tag selector
ipcMain.handle('spotlight-get-tags', async () => {
  const Datastore = require('nedb-promises');
  const dbPath = path.join(app.getPath('userData'), 'mindspace-data', 'tags.db');
  if (!fs.existsSync(dbPath)) return [];
  try {
    const db = Datastore.create({ filename: dbPath, autoload: true });
    return await db.find({}).sort({ name: 1 });
  } catch (err) {
    console.error('Failed to read tags for spotlight:', err);
    return [];
  }
});

// Spotlight: get recent thoughts for the thought stack display
ipcMain.handle('spotlight-get-recent-thoughts', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return [];
  
  return new Promise((resolve) => {
    // Generate a unique reply channel for this request
    const replyChannel = 'spotlight-recent-thoughts-reply-' + Date.now() + Math.random().toString(36).substr(2, 9);
    
    // Listen for the reply once
    ipcMain.once(replyChannel, (event, thoughts) => {
      resolve(thoughts);
    });
    
    // Send request to main window (which has the decryption key and preload logic)
    mainWindow.webContents.send('spotlight-request-recent-thoughts', replyChannel);
    
    // Timeout fallback just in case main window doesn't reply
    setTimeout(() => {
      ipcMain.removeAllListeners(replyChannel);
      resolve([]);
    }, 2000);
  });
});

ipcMain.handle('spotlight-get-memory', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return '';
  return new Promise((resolve) => {
    const replyChannel = 'spotlight-get-memory-reply-' + Date.now() + Math.random().toString(36).substr(2, 9);
    ipcMain.once(replyChannel, (event, memory) => resolve(memory));
    mainWindow.webContents.send('spotlight-request-memory', replyChannel);
    setTimeout(() => {
      ipcMain.removeAllListeners(replyChannel);
      resolve('');
    }, 2000);
  });
});

// Spotlight: open a thought in the main app
ipcMain.on('spotlight-open-thought', (event, id) => {
  hideSpotlight();
  showOrCreateMainWindow();
  const sendOpenThought = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('spotlight-focus-thought', id);
    }
  };
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
    sendOpenThought();
  } else if (mainWindow) {
    mainWindow.webContents.once('did-finish-load', sendOpenThought);
  }
});

// Broadcast refresh signal to Spotlight and Main Window
ipcMain.on('trigger-spotlight-refresh', () => {
  if (spotlightWindow && !spotlightWindow.isDestroyed()) {
    spotlightWindow.webContents.send('spotlight-refresh-thoughts');
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('thought-refresh');
  }
});

// Spotlight: create calendar event from a thought with today/until_date persistence
ipcMain.handle('spotlight-calendar-from-thought', async (event, data) => {
  try {
    const todayKey = new Date().toISOString().slice(0, 10);
    let eventDate = todayKey;
    let eventTime = '09:00';
    let reminderMinutes = 15;

    if (data.persistence === 'until_date' && data.expiresAt) {
      const d = new Date(data.expiresAt);
      eventDate = d.toISOString().slice(0, 10);
      const hours = String(d.getHours()).padStart(2, '0');
      const mins = String(d.getMinutes()).padStart(2, '0');
      eventTime = `${hours}:${mins}`;
    } else if (data.persistence === 'today') {
      // End-of-day deadline
      eventDate = todayKey;
      eventTime = '23:59';
    }

    const title = (data.content || 'Thought').length > 60
      ? data.content.substring(0, 60) + '…'
      : data.content;

    const calEvent = await calendarStore.create({
      event_title: title,
      event_description: data.content,
      event_date: eventDate,
      event_time: eventTime,
      category: 'task',
      priority: data.priority || 'medium',
      repeat_type: 'none',
      reminder_minutes: reminderMinutes,
      status: 'upcoming',
      source_type: 'thought',
      thought_id: data.id,
    });

    if (calendarScheduler) await calendarScheduler.rescheduleAll();
    return { calendarEventId: calEvent._id };
  } catch (err) {
    console.error('Failed to create calendar event from thought:', err);
    return { calendarEventId: null };
  }
});
ipcMain.handle('spotlight-search-files', async (event, query) => {
  if (!query) return [];
  return new Promise((resolve) => {
    // Escape query for PowerShell
    const safeQuery = query.replace(/"/g, '""').replace(/'/g, "''");

    const psCommand = `
      $con = New-Object System.Data.OleDb.OleDbConnection("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")
      $con.Open()
      $cmd = $con.CreateCommand()
      $cmd.CommandText = "SELECT TOP 10 System.ItemName, System.ItemPathDisplay FROM SystemIndex WHERE CONTAINS('*', '""*${safeQuery}*""') OR System.FileName LIKE '%${safeQuery}%'"
      try {
        $r = $cmd.ExecuteReader()
        $results = @()
        while($r.Read()) {
          $results += @{ Name = $r[0]; Path = $r[1] }
        }
        $results | ConvertTo-Json
      } catch {}
      $con.Close()
    `;

    exec(`powershell -NoProfile -Command "${psCommand.replace(/\n/g, '')}"`, (error, stdout, stderr) => {
      if (error || !stdout.trim()) {
        resolve([]);
        return;
      }
      try {
        const res = JSON.parse(stdout);
        resolve(Array.isArray(res) ? res : [res]);
      } catch (e) {
        resolve([]);
      }
    });
  });
});

ipcMain.on('spotlight-open-file', (event, filePath) => {
  shell.openPath(filePath);
});

ipcMain.on('spotlight-open-url', (event, url) => {
  shell.openExternal(url);
});

// ─── Spotlight: AI, Search, Notes ───
ipcMain.handle('spotlight-get-ai-config', () => getAiConfigFromStore());

ipcMain.handle('ai-test-connection', async (event, { provider, apiKey, model }) => {
  const p = provider || settingsStore.getSetting(app.getPath('userData'), 'aiProvider') || 'groq';
  const key = apiKey || settingsStore.getSetting(app.getPath('userData'), 'aiApiKey') || '';
  const m = model || settingsStore.getSetting(app.getPath('userData'), 'aiModel') || '';
  return validateApiKey({ provider: p, apiKey: key, model: m || getDefaultModel(p) });
});

ipcMain.handle('whispr-test-connection', async (event, { apiKey }) => {
  // Validate the Groq key by sending a lightweight chat request (Groq doesn't have a dedicated Whisper validation endpoint)
  const key = apiKey || settingsStore.getSetting(app.getPath('userData'), 'whisprApiKey') || '';
  if (!key || !key.trim()) {
    return { ok: false, error: 'No Whispr API key provided' };
  }
  return validateApiKey({ provider: 'groq', apiKey: key.trim(), model: 'llama-3.3-70b-versatile' });
});

ipcMain.handle('spotlight-web-search', async (event, query) => {
  try {
    const data = await searchWeb(query);
    const config = getAiConfigFromStore();
    if (config.hasKey && data.results?.length) {
      try {
        const snippets = data.results.slice(0, 5).map((r, i) =>
          `${i + 1}. ${r.title}: ${r.snippet || r.url}`
        ).join('\n');
        const context = data.aiAnswer?.text ? `Instant answer: ${data.aiAnswer.text}\n\n` : '';
        const reply = await chatCompletion({
          provider: config.provider,
          apiKey: config.apiKey,
          model: config.model,
          messages: [
            {
              role: 'system',
              content: 'You are a helpful search assistant. Provide a concise, accurate summary (3-5 sentences) answering the user query based on the search results. Be factual and direct.',
            },
            {
              role: 'user',
              content: `Query: "${query}"\n\n${context}Search results:\n${snippets}\n\nProvide a helpful summary answer.`,
            },
          ],
        });
        data.aiSummary = reply?.content || '';
      } catch (aiErr) {
        console.error('AI search summary failed:', aiErr.message);
      }
    }
    return data;
  } catch (err) {
    console.error('Web search failed:', err);
    return { results: [], aiAnswer: null, query: query || '' };
  }
});

ipcMain.handle('spotlight-get-notes', async () => {
  const all = await notesStore.getAll();
  const draft = all.find((n) => n.name === '__spotlight_draft__');
  return draft ? draft.content : '';
});

ipcMain.handle('spotlight-save-notes', async (event, text) => {
  if (!text || !text.trim()) return true;
  const all = await notesStore.getAll();
  const draft = all.find((n) => n.name === '__spotlight_draft__');
  if (draft) {
    await notesStore.update(draft._id, { content: text });
  } else {
    await notesStore.create({ name: '__spotlight_draft__', content: text });
  }
  return true;
});

// Helper: attempt auto-fallback to the other API key on 429 rate-limit
function getAlternateApiKey(config) {
  if (!config.aiAutoFallback) return null;
  const otherKey = config.activeKeyIndex === 0 ? config.secondaryKey : config.primaryKey;
  if (!otherKey || !otherKey.trim()) return null;
  return otherKey.trim();
}

function persistKeySwitch(config) {
  const userData = app.getPath('userData');
  const newIndex = config.activeKeyIndex === 0 ? 1 : 0;
  settingsStore.setSetting(userData, 'aiActiveKeyIndex', newIndex);
  // Notify main window so Settings cache updates
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ai-key-auto-switched', { newIndex });
  }
}

ipcMain.handle('spotlight-ai-chat', async (event, { messages, stream }) => {
  const config = getAiConfigFromStore();
  if (!config.hasKey) {
    throw new Error('No API key configured. Add your API key in Settings → AI Chat Assistant.');
  }
  const mindspaceTools = [
    {
      type: 'function',
      function: {
        name: 'schedule_meeting',
        description: 'Schedules a calendar event/meeting in MindSpace.',
        parameters: {
          type: 'object',
          properties: {
            reasoning: { type: 'string', description: 'Explain why you are calling this tool and what it will achieve.' },
            title: { type: 'string', description: 'Title of the event or meeting.' },
            description: { type: 'string', description: 'Details or context about the event.' },
            event_date: { type: 'string', description: 'Date in YYYY-MM-DD format.' },
            event_time: { type: 'string', description: 'Time in HH:MM format (24-hour).' },
            priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Importance level of the event.' },
          },
          required: ['reasoning', 'title', 'event_date', 'event_time'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_thought',
        description: 'Creates a thought/reminder on the MindSpace canvas.',
        parameters: {
          type: 'object',
          properties: {
            reasoning: { type: 'string', description: 'Explain why you are calling this tool and what it will achieve.' },
            content: { type: 'string', description: 'The text content of the thought.' },
            priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Urgency of the thought.' },
            persistence: { type: 'string', enum: ['persistent', 'today', 'until_date'], description: 'How long the thought should persist.' },
            expiresAt: { type: 'string', description: 'Expiration ISO string, required if persistence is until_date.' },
          },
          required: ['reasoning', 'content', 'priority'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_thoughts',
        description: 'Searches the user\'s thoughts for a given keyword.',
        parameters: {
          type: 'object',
          properties: {
            reasoning: { type: 'string', description: 'Explain why you are calling this tool.' },
            query: { type: 'string', description: 'Keyword or phrase to search for.' }
          },
          required: ['reasoning', 'query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'update_thought',
        description: 'Updates an existing thought (e.g., mark finished, change content).',
        parameters: {
          type: 'object',
          properties: {
            reasoning: { type: 'string', description: 'Explain why you are calling this tool.' },
            id: { type: 'string', description: 'The unique ID of the thought.' },
            content: { type: 'string' },
            priority: { type: 'string', enum: ['high', 'medium', 'low'] },
            status: { type: 'string', enum: ['active', 'finished', 'dismissed'], description: 'Set to finished to mark complete.' }
          },
          required: ['reasoning', 'id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'delete_thought',
        description: 'Permanently deletes a thought.',
        parameters: {
          type: 'object',
          properties: {
            reasoning: { type: 'string', description: 'Explain why you are calling this tool.' },
            id: { type: 'string', description: 'The unique ID of the thought.' }
          },
          required: ['reasoning', 'id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_calendar_events',
        description: 'Gets upcoming calendar events and meetings.',
        parameters: {
          type: 'object',
          properties: {
            reasoning: { type: 'string', description: 'Explain why you are calling this tool.' }
          },
          required: ['reasoning'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'update_meeting',
        description: 'Updates an existing meeting/calendar event (reschedule, mark complete).',
        parameters: {
          type: 'object',
          properties: {
            reasoning: { type: 'string', description: 'Explain why you are calling this tool.' },
            id: { type: 'string', description: 'The event ID.' },
            title: { type: 'string' },
            event_date: { type: 'string', description: 'YYYY-MM-DD' },
            event_time: { type: 'string', description: 'HH:MM' },
            status: { type: 'string', enum: ['upcoming', 'completed', 'cancelled'] }
          },
          required: ['reasoning', 'id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'cancel_meeting',
        description: 'Cancels/deletes a calendar event.',
        parameters: {
          type: 'object',
          properties: {
            reasoning: { type: 'string', description: 'Explain why you are calling this tool.' },
            id: { type: 'string', description: 'The event ID.' }
          },
          required: ['reasoning', 'id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_clipboard',
        description: 'Reads the user\'s current clipboard text.',
        parameters: {
          type: 'object',
          properties: {
            reasoning: { type: 'string', description: 'Explain why you are calling this tool.' }
          },
          required: ['reasoning'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'trigger_workflow',
        description: 'Executes a MindSpace workflow by name.',
        parameters: {
          type: 'object',
          properties: {
            reasoning: { type: 'string', description: 'Explain why you are calling this tool.' },
            name: { type: 'string', description: 'The exact name of the workflow.' }
          },
          required: ['reasoning', 'name'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_notes',
        description: 'Searches the user\'s long-form notes.',
        parameters: {
          type: 'object',
          properties: {
            reasoning: { type: 'string', description: 'Explain why you are calling this tool.' },
            query: { type: 'string', description: 'Keyword to search for in notes. Leave empty to get all recent notes.' }
          },
          required: ['reasoning'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'update_core_memory',
        description: 'Updates the active core memory with new condensed facts, preferences, or context about the user.',
        parameters: {
          type: 'object',
          properties: {
            reasoning: { type: 'string', description: 'Explain why you are calling this tool.' },
            content: { type: 'string', description: 'The complete condensed memory string, combining previous memory with new facts.' }
          },
          required: ['reasoning', 'content'],
        },
      },
    }
  ];

  // Helper IPC Functions for Thoughts (Decryption in Renderer)
  const aiSearchThoughts = async (query) => {
    if (!mainWindow || mainWindow.isDestroyed()) return [];
    return new Promise((resolve) => {
      const replyChannel = 'ai-search-reply-' + Date.now() + Math.random();
      ipcMain.once(replyChannel, (e, res) => resolve(res));
      mainWindow.webContents.send('spotlight-ai-search-thoughts', { query, replyChannel });
      setTimeout(() => { ipcMain.removeAllListeners(replyChannel); resolve([]); }, 2000);
    });
  };

  const aiUpdateThought = async (id, updates) => {
    if (!mainWindow || mainWindow.isDestroyed()) return { success: false };
    return new Promise((resolve) => {
      const replyChannel = 'ai-update-reply-' + Date.now() + Math.random();
      ipcMain.once(replyChannel, (e, res) => resolve(res));
      mainWindow.webContents.send('spotlight-ai-update-thought', { id, updates, replyChannel });
      setTimeout(() => { ipcMain.removeAllListeners(replyChannel); resolve({ success: false }); }, 2000);
    });
  };

  const aiDeleteThought = async (id) => {
    if (!mainWindow || mainWindow.isDestroyed()) return { success: false };
    return new Promise((resolve) => {
      const replyChannel = 'ai-delete-reply-' + Date.now() + Math.random();
      ipcMain.once(replyChannel, (e, res) => resolve(res));
      mainWindow.webContents.send('spotlight-ai-delete-thought', { id, replyChannel });
      setTimeout(() => { ipcMain.removeAllListeners(replyChannel); resolve({ success: false }); }, 2000);
    });
  };

  const aiUpdateMemory = async (content) => {
    if (!mainWindow || mainWindow.isDestroyed()) return { success: false };
    return new Promise((resolve) => {
      const replyChannel = 'ai-memory-reply-' + Date.now() + Math.random();
      ipcMain.once(replyChannel, (e, res) => resolve(res));
      mainWindow.webContents.send('spotlight-ai-update-memory', { content, replyChannel });
      setTimeout(() => { ipcMain.removeAllListeners(replyChannel); resolve({ success: false }); }, 2000);
    });
  };

  const toolsEnabled = true;

  let currentMessages = [...messages];
  // Inject system prompt with date/time rules
  const systemMsg = {
    role: 'system',
    content: `You are the MindSpace Peak Intelligence AI Assistant. You have a "broski" attitude—a homie who is extremely helpful, conversational, sharp, and uses a bit of casual slang, but still gets things done professionally.
Current Local Date and Time: ${new Date().toString()}
Current ISO Date: ${new Date().toISOString()}

Rules & Capabilities:
1. EYES & MEMORY: Use 'search_thoughts', 'get_calendar_events', and 'read_notes' when asked about the user's data. You have FULL ACCESS to Notes, Thoughts, and Calendar.
2. STRICT BANS: You DO NOT have access to Archives and you CANNOT change Settings. If asked, politely refuse, homie.
3. CONTEXT AWARENESS: Use 'read_clipboard' if the user asks you to "summarize this" or if they paste something without context.
4. CRUD CONTROL: Use 'update_thought', 'delete_thought', 'update_meeting', and 'cancel_meeting' to modify existing data in real time.
5. ACTIVE MEMORY: Use 'update_core_memory' to constantly track and condense new facts, preferences, and essential context about the user from your chats. Keep the memory robust and actively updated.
6. WORKFLOWS: Use 'trigger_workflow' if the user wants to execute an automation.
7. CALENDAR SCHEDULING: Always use tools to schedule events. Automatically infer priority. Use YYYY-MM-DD for dates.
8. RELATIVE TIME: If a user says "in 1 min", you must internally calculate the exact time (HH:MM) by adding it to Current Time. Do NOT show your math in text. Only pass the final HH:MM to the tool call.
9. COMMUNICATION: If the user is just chatting, greeting you, or asking a question that doesn't require tools, DO NOT call any tools. Just chat back using your broski persona. DO NOT loop on tools. Always output a final conversational message to the user summarizing what you did.
10. AVOID LOOPING: Never call the exact same tool repeatedly if the previous call gave you the answer or failed. If you have the answer, reply to the user.
11. REAL TOOL CALLS ONLY: You MUST invoke tools using the native JSON function calling format. NEVER write out markdown like "> Action: Using tool" in your text response.
12. TOOL CALLING REQUIRED PARAMETERS: When calling ANY tool, you MUST include the 'reasoning' parameter explaining your thought process. Do NOT omit it.`
  };
  
  // Combine any existing system messages (like injected memory from frontend) with the main systemMsg
  const systemContents = [systemMsg.content];
  const nonSystemMessages = [];
  for (const m of currentMessages) {
    if (m.role === 'system') systemContents.push(m.content);
    else nonSystemMessages.push(m);
  }
  
  currentMessages = [
    { role: 'system', content: systemContents.join('\n\n---\n\n') },
    ...nonSystemMessages
  ];

  const tryWithFallback = async (attemptOpts) => {
    try {
      return await chatCompletion(attemptOpts);
    } catch (err) {
      // Auto-fallback on 429 rate-limit
      if (err.statusCode === 429) {
        const altKey = getAlternateApiKey(config);
        if (altKey && altKey !== attemptOpts.apiKey) {
          console.log('AI Chat: 429 rate-limit detected, auto-switching to alternate key');
          persistKeySwitch(config);
          return await chatCompletion({ ...attemptOpts, apiKey: altKey });
        }
      }
      throw err;
    }
  };

  const getOpts = () => ({
    provider: config.provider,
    apiKey: config.apiKey,
    model: config.model,
    messages: currentMessages,
    tools: toolsEnabled ? mindspaceTools : undefined,
  });

  // We always execute non-streaming to easily handle tool calls, 
  // then simulate the streaming back to the frontend at the end.

  // Non-streaming execution loop for tool calling
  let maxLoops = 5;
  while (maxLoops > 0) {
    maxLoops--;
    const result = await tryWithFallback(getOpts());

    // Fallback parser for Llama-3 leaking function calls as raw XML in content
    if (result.content && result.content.includes('<function=')) {
      result.tool_calls = result.tool_calls || [];
      const robustRegex = /<function=([^>]+)>([\s\S]*?)<\/?function>/g;
      let match;
      let newContent = result.content;
      
      while ((match = robustRegex.exec(result.content)) !== null) {
         const name = match[1];
         let argsStr = match[2];
         // Sometimes the model adds a trailing '>' at the end of the JSON just before </function>
         if (argsStr.trim().endsWith('>') && argsStr.trim().length > 1) {
            argsStr = argsStr.trim().slice(0, -1);
         }
         
         try {
            JSON.parse(argsStr); // validate
            result.tool_calls.push({
               id: 'call_' + Date.now() + Math.random().toString(36).substr(2, 9),
               type: 'function',
               function: { name: name, arguments: argsStr }
            });
            // remove it from the raw content so it doesn't get shown to user
            newContent = newContent.replace(match[0], '');
         } catch(e) {
            console.error('Failed to parse hallucinated tool call:', argsStr);
         }
      }
      result.content = newContent;
      if (result.raw && result.raw.choices && result.raw.choices[0] && result.raw.choices[0].message) {
         result.raw.choices[0].message.tool_calls = result.tool_calls;
         result.raw.choices[0].message.content = newContent;
      }
    }

    if (result.tool_calls && result.tool_calls.length > 0) {
      // Add the assistant's tool_call message to the history
      currentMessages.push(result.raw.choices[0].message);

      let lastCreatedThoughtId = null;
      let lastCreatedCalendarId = null;
      let hasThinkingStr = false;
      let thinkingStrTotal = '';

      for (const call of result.tool_calls) {
        let funcResult = '';
        try {
          const args = JSON.parse(call.function.arguments);
          
          // Stream AI's chain-of-thought to the UI immediately
          if (!event.sender.isDestroyed()) {
             let thinkingStr = `\n\n> 🧠 **Thinking**: *${args.reasoning || 'Deciding on action...'}*\n> 🛠️ **Action**: *Using tool \`${call.function.name}\`*\n\n`;
             thinkingStrTotal += thinkingStr;
             hasThinkingStr = true;
             event.sender.send('spotlight-ai-chunk', { chunk: thinkingStr });
          }

          if (call.function.name === 'schedule_meeting') {
            const calEvent = await calendarStore.create({
              event_title: args.title,
              event_description: args.description || '',
              event_date: args.event_date,
              event_time: args.event_time,
              category: 'meeting',
              priority: args.priority || 'medium',
              repeat_type: 'none',
              reminder_minutes: 15,
              status: 'upcoming',
              source_type: 'thought'
            });
            if (calendarScheduler) await calendarScheduler.rescheduleAll();
            lastCreatedCalendarId = calEvent._id;
            funcResult = `Successfully scheduled meeting ID: ${calEvent._id}`;
          } else if (call.function.name === 'create_thought') {
            const thoughtData = {
              _id: require('crypto').randomBytes(16).toString('hex'),
              content: args.content,
              priority: args.priority || 'medium',
              persistence: args.persistence || 'persistent',
              expiresAt: args.expiresAt || null,
              tags: ['ai-generated']
            };
            if (mainWindow && !mainWindow.isDestroyed()) {
               mainWindow.webContents.send('spotlight-create-thought', thoughtData);
               lastCreatedThoughtId = thoughtData._id;
               funcResult = `Successfully created thought ID: ${thoughtData._id} with content: "${args.content}"`;
            } else {
               createWindow();
               mainWindow.hide();
               mainWindow.webContents.once('did-finish-load', () => {
                 mainWindow.webContents.send('spotlight-create-thought', thoughtData);
               });
               lastCreatedThoughtId = thoughtData._id;
               funcResult = `Successfully created thought ID: ${thoughtData._id} (in background)`;
            }
          } else if (call.function.name === 'search_thoughts') {
            const results = await aiSearchThoughts(args.query);
            if (results && results.locked) {
              funcResult = `Cannot search: MindSpace is currently locked. The user must unlock it first.`;
            } else {
              funcResult = `Found ${results.length} thoughts. Context: \n` + results.map(t => `ID: ${t._id} | Date: ${t.createdAt} | Content: ${t.content}`).join('\n');
            }
          } else if (call.function.name === 'update_thought') {
            const updates = {};
            if (args.content) updates.content = args.content;
            if (args.priority) updates.priority = args.priority;
            if (args.status) updates.status = args.status;
            const res = await aiUpdateThought(args.id, updates);
            funcResult = res.success ? `Successfully updated thought ${args.id}` : `Failed to update thought ${args.id}: ${res.error}`;
          } else if (call.function.name === 'delete_thought') {
            const res = await aiDeleteThought(args.id);
            funcResult = res.success ? `Successfully deleted thought ${args.id}` : `Failed to delete thought ${args.id}: ${res.error}`;
          } else if (call.function.name === 'get_calendar_events') {
            const events = await calendarStore.getAll();
            const upcoming = events.filter(e => e.status !== 'completed' && e.status !== 'cancelled').slice(0, 15);
            funcResult = `Upcoming ${upcoming.length} events:\n` + upcoming.map(e => `ID: ${e._id} | ${e.event_date} ${e.event_time} | ${e.event_title} (${e.status})`).join('\n');
          } else if (call.function.name === 'update_meeting') {
            const updates = {};
            if (args.title) updates.event_title = args.title;
            if (args.event_date) updates.event_date = args.event_date;
            if (args.event_time) updates.event_time = args.event_time;
            if (args.status) updates.status = args.status;
            const updated = await calendarStore.update(args.id, updates);
            if (calendarScheduler) await calendarScheduler.rescheduleAll();
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('calendar-refresh');
            
            // 2-Way Sync: If marked completed, mark associated thought as finished
            if (updates.status === 'completed' && updated && updated.thought_id) {
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('spotlight-ai-update-thought', { 
                  id: updated.thought_id, 
                  updates: { status: 'finished' },
                  replyChannel: 'ignore-sync' 
                });
              }
            }
            funcResult = `Successfully updated meeting ${args.id}`;
          } else if (call.function.name === 'cancel_meeting') {
            await calendarStore.remove(args.id);
            if (calendarScheduler) await calendarScheduler.rescheduleAll();
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('calendar-refresh');
            funcResult = `Successfully cancelled meeting ${args.id}`;
          } else if (call.function.name === 'read_clipboard') {
            const text = clipboard.readText();
            funcResult = text ? `Clipboard Content:\n${text.substring(0, 5000)}` : `Clipboard is empty.`;
          } else if (call.function.name === 'trigger_workflow') {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('spotlight-execute-workflow', args.name);
            }
            funcResult = `Triggered workflow: ${args.name}`;
          } else if (call.function.name === 'read_notes') {
            const results = await notesStore.search(args.query || '');
            const recent = results.slice(0, 10);
            funcResult = `Found ${recent.length} notes:\n` + recent.map(n => `ID: ${n._id} | Title: ${n.title}\nContent: ${n.content.substring(0, 500)}...`).join('\n\n');
          } else if (call.function.name === 'update_core_memory') {
            const res = await aiUpdateMemory(args.content);
            funcResult = res.success ? `Successfully updated core memory.` : `Failed to update core memory: ${res.error}`;
          } else {
            funcResult = `Unknown tool: ${call.function.name}`;
          }
        } catch (e) {
          funcResult = `Error executing tool: ${e.message}`;
        }
        
        // Add the tool result back to the messages
        currentMessages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: funcResult,
        });
      }

      // Auto-link AI generated Thoughts and Calendar events created in the same turn
      if (lastCreatedThoughtId && lastCreatedCalendarId) {
        try {
          await calendarStore.update(lastCreatedCalendarId, { thought_id: lastCreatedThoughtId });
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('spotlight-ai-update-thought', {
              id: lastCreatedThoughtId,
              updates: { calendarEventId: lastCreatedCalendarId },
              replyChannel: 'ignore-link'
            });
          }
        } catch (e) { console.error('Failed to auto-link AI thought and calendar', e); }
      }

      // Loop again to let AI generate a final response
      continue;
    }
    
    // If no tool calls, it's a final response. Let's stream it back.
    if (stream) {
      return new Promise(async (resolve) => {
        // Simple chunking simulation for final text
        const text = result.content || '';
        const chunkSize = 4;
        for (let i = 0; i < text.length; i += chunkSize) {
          const chunk = text.slice(i, i + chunkSize);
          if (!event.sender.isDestroyed()) {
            event.sender.send('spotlight-ai-chunk', { chunk });
          }
          await new Promise(r => setTimeout(r, 10)); // ~400 chars per sec
        }
        resolve({ content: result.content, streamed: true });
      });
    }
    
    return { content: result.content, streamed: false };
  }
  
  return { content: "I had to stop thinking because the operation was too complex.", streamed: false };
});

ipcMain.on('spotlight-open-result-url', (event, url) => {
  if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
    shell.openExternal(url);
  }
});

// ─── Clipboard Polling ───
function startClipboardPolling() {
  lastClipText = clipboard.readText() || '';
  clipboardPollTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    // Check text
    const currentText = clipboard.readText() || '';
    if (currentText && currentText !== lastClipText) {
      lastClipText = currentText;
      mainWindow.webContents.send('clipboard-new-entry', {
        type: 'text',
        content: currentText,
        timestamp: new Date().toISOString(),
      });
    }

    // Check image
    const img = clipboard.readImage();
    if (!img.isEmpty()) {
      const png = img.toPNG();
      const hash = require('crypto').createHash('md5').update(png).digest('hex');
      if (hash !== lastClipImageHash) {
        lastClipImageHash = hash;
        const dataUrl = 'data:image/png;base64,' + png.toString('base64');
        mainWindow.webContents.send('clipboard-new-entry', {
          type: 'image',
          content: dataUrl,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }, 1000);
}

function stopClipboardPolling() {
  if (clipboardPollTimer) clearInterval(clipboardPollTimer);
}

// ─── AI Query (Commander / Braindump — preserves existing API shape) ───
ipcMain.handle('ai-query', async (event, { provider, apiKey, model, messages }) => {
  const resolvedModel = model || getDefaultModel(provider);

  try {
    const result = await chatCompletion({ provider, apiKey, model: resolvedModel, messages });
    return result.raw;
  } catch (err) {
    // Auto-fallback on 429 rate-limit
    if (err.statusCode === 429) {
      const config = getAiConfigFromStore();
      const altKey = getAlternateApiKey(config);
      if (altKey && altKey !== apiKey) {
        console.log('AI Query: 429 rate-limit detected, auto-switching to alternate key');
        persistKeySwitch(config);
        const result = await chatCompletion({ provider, apiKey: altKey, model: resolvedModel, messages });
        return result.raw;
      }
    }
    throw err;
  }
});

// ─── Run Shell Command ───
ipcMain.handle('run-shell-command', async (event, command) => {
  return new Promise(async (resolve) => {
    // Hotfix for Windows cmd.exe "start URI:" error dialog
    // If the command is exactly "start something:" (a URI protocol), use Electron's native shell.openExternal
    if (/^start\s+[a-zA-Z0-9_-]+:$/.test(command.trim())) {
      const uri = command.trim().replace(/^start\s+/, '');
      try {
        await shell.openExternal(uri);
        resolve({ success: true, stdout: 'Opened via native shell.openExternal', stderr: '' });
      } catch (e) {
        resolve({ success: false, error: e.message });
      }
      return;
    }

    exec(command, { timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ success: !err, stdout: stdout || '', stderr: stderr || '', error: err?.message });
    });
  });
});

// ─── Window Controls ───
ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on('window-close', () => {
  // This triggers the 'close' event handler which will hide instead of quit
  if (mainWindow) mainWindow.close();
});

ipcMain.handle('window-is-maximized', () => {
  return mainWindow ? mainWindow.isMaximized() : false;
});

// ─── Expose userData path ───
ipcMain.handle('get-user-data-path', () => {
  return app.getPath('userData');
});

// ─── Fullscreen Toggle ───
ipcMain.on('window-toggle-fullscreen', () => {
  if (mainWindow) {
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
  }
});

ipcMain.handle('window-is-fullscreen', () => {
  return mainWindow ? mainWindow.isFullScreen() : false;
});

// ─── File Drop Reading ───
ipcMain.handle('read-dropped-file', async (event, filePath) => {
  try {
    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const name = path.basename(filePath);
    const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg'].includes(ext);
    const isText = ['.txt', '.md', '.json', '.csv', '.xml', '.html', '.css', '.js', '.ts', '.py', '.yaml', '.yml', '.log', '.ini', '.cfg', '.toml'].includes(ext);

    let content = '';
    let type = 'unknown';

    if (isImage) {
      const buf = fs.readFileSync(filePath);
      const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
      content = `data:${mimeMap[ext] || 'image/png'};base64,${buf.toString('base64')}`;
      type = 'image';
    } else if (isText || stat.size < 50000) {
      // Read text content (first 5KB for preview)
      const buf = Buffer.alloc(Math.min(5120, stat.size));
      const fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      content = buf.toString('utf8');
      type = 'text';
    } else {
      content = `[Binary file: ${name}, ${(stat.size / 1024).toFixed(1)} KB]`;
      type = 'binary';
    }

    return { name, path: filePath, content, type, size: stat.size, ext };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.on('open-file-location', (event, filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    shell.showItemInFolder(filePath);
  }
});

// ─── Open External URLs ───
ipcMain.on('open-external', (event, url) => {
  if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
    shell.openExternal(url);
  }
});

// ─── Copy Image to Clipboard (decoded, not base64 text) ───
ipcMain.on('copy-image-to-clipboard', (event, base64Data) => {
  try {
    // Strip data URL prefix if present
    const raw = base64Data.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(raw, 'base64');
    const img = nativeImage.createFromBuffer(buffer);
    clipboard.writeImage(img);
  } catch (e) {
    console.error('Failed to copy image to clipboard:', e);
  }
});

// ─── Select Tool Path (file picker) ───
ipcMain.handle('select-tool-path', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select tool entry file (index.html)',
    filters: [
      { name: 'HTML Files', extensions: ['html', 'htm'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// ─── Open Tool in New Window ───
ipcMain.on('open-tool-window', (event, toolPath, toolName) => {
  // Verify file exists
  if (!fs.existsSync(toolPath)) return;

  const toolWin = new BrowserWindow({
    width: 1200,
    height: 800,
    title: toolName || 'Tool',
    icon: path.join(__dirname, 'src', 'assets', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  toolWin.loadFile(toolPath);
});

// ─── Auto Paste & Search (keyboard automation) ───
// Waits for browser to load, then simulates Ctrl+V and Enter

ipcMain.on('auto-paste-search', (event, delayMs) => {
  const delay = Math.max(delayMs || 3000, 1000);
  const delaySec = delay / 1000;

  const psScript = [
    'Add-Type -AssemblyName System.Windows.Forms',
    `Start-Sleep -Seconds ${delaySec}`,
    '[System.Windows.Forms.SendKeys]::SendWait("^v")',
    'Start-Sleep -Seconds 1',
    '[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")',
  ].join('\n');

  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
  execFile('powershell', ['-NoProfile', '-EncodedCommand', encoded], (err) => {
    if (err) console.error('Auto-paste failed:', err.message);
  });
});

// ─── Auto Paste Full (image + text → submit) ───
// Image must already be in clipboard before calling this.
// Sequence: wait → paste image → switch clipboard to text → paste text → wait → Enter
ipcMain.on('auto-paste-full', (event, text, delayMs) => {
  const delay = Math.max(delayMs || 3000, 1000);
  const delaySec = delay / 1000;

  // Use a temporary file to hold the text to avoid escaping issues
  const os = require('os');
  const tempFile = path.join(os.tmpdir(), `mindspace-paste-${Date.now()}.txt`);
  fs.writeFileSync(tempFile, text || '', 'utf8');

  const psScript = [
    'Add-Type -AssemblyName System.Windows.Forms',
    `Start-Sleep -Seconds ${delaySec}`,
    // Step 1: Paste image (already in clipboard)
    '[System.Windows.Forms.SendKeys]::SendWait("^v")',
    // Increased wait time for image upload as requested (1.5 seconds)
    'Start-Sleep -Seconds 2.6',
    // Step 2: Read text from file into clipboard and paste it
    `Get-Content -Path '${tempFile.replace(/'/g, "''")}' -Raw | Set-Clipboard`,
    'Start-Sleep -Milliseconds 300',
    '[System.Windows.Forms.SendKeys]::SendWait("^v")',
    // Step 3: Wait then submit
    'Start-Sleep -Seconds 1',
    '[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")',
    // Cleanup temp file
    `Remove-Item -Path '${tempFile.replace(/'/g, "''")}' -ErrorAction SilentlyContinue`
  ].join('\n');

  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
  execFile('powershell', ['-NoProfile', '-EncodedCommand', encoded], (err) => {
    if (err) console.error('Auto-paste-full failed:', err.message);
  });
});

// ─── Whispr — Speech-to-Text ───

let whisprPillReady = false;
let whisprPillPendingState = null;
let whisprHideTimeout = null;

function createWhisprPill() {
  if (whisprPillWindow && !whisprPillWindow.isDestroyed()) return whisprPillWindow;

  whisprPillReady = false;

  const display = screen.getPrimaryDisplay();
  const pillWidth = 220;
  const pillHeight = 48;
  const x = Math.round(display.workArea.x + (display.workArea.width - pillWidth) / 2);
  const y = display.workArea.y + display.workArea.height - pillHeight - 20; // Bottom offset

  whisprPillWindow = new BrowserWindow({
    width: pillWidth,
    height: pillHeight,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  whisprPillWindow.loadFile(path.join(__dirname, 'src', 'whispr-pill.html'));

  whisprPillWindow.on('closed', () => {
    whisprPillWindow = null;
    whisprPillReady = false;
  });

  return whisprPillWindow;
}

// Called by the pill renderer once its JS is initialized and listening for IPC
ipcMain.on('whispr-pill-ready', () => {
  whisprPillReady = true;
  // Flush any pending state that was queued before the pill was ready
  if (whisprPillPendingState && whisprPillWindow && !whisprPillWindow.isDestroyed()) {
    if (!whisprPillWindow.isVisible()) whisprPillWindow.show();
    whisprPillWindow.webContents.send('whispr-pill-state', whisprPillPendingState);
    whisprPillPendingState = null;
  }
});

function showWhisprPill(state) {
  // Cancel any pending hide — a new show takes priority
  if (whisprHideTimeout) {
    clearTimeout(whisprHideTimeout);
    whisprHideTimeout = null;
  }

  const pill = createWhisprPill();

  if (whisprPillReady && !pill.webContents.isLoading()) {
    // Pill is warm and ready — send immediately
    if (!pill.isVisible()) pill.show();
    pill.webContents.send('whispr-pill-state', state);
    whisprPillPendingState = null;
  } else {
    // Pill is still loading — queue the state for when it signals ready
    whisprPillPendingState = state;
    // Also listen for did-finish-load as a fallback safety net
    pill.webContents.once('did-finish-load', () => {
      // Give the renderer a moment to set up its IPC listeners
      setTimeout(() => {
        if (whisprPillPendingState && whisprPillWindow && !whisprPillWindow.isDestroyed()) {
          if (!whisprPillWindow.isVisible()) whisprPillWindow.show();
          whisprPillWindow.webContents.send('whispr-pill-state', whisprPillPendingState);
          whisprPillPendingState = null;
          whisprPillReady = true;
        }
      }, 50);
    });
  }
}

function hideWhisprPill() {
  if (whisprPillWindow && !whisprPillWindow.isDestroyed()) {
    whisprPillWindow.webContents.send('whispr-pill-state', 'done');
    // Cancel any previous hide timeout
    if (whisprHideTimeout) clearTimeout(whisprHideTimeout);
    whisprHideTimeout = setTimeout(() => {
      whisprHideTimeout = null;
      if (whisprPillWindow && !whisprPillWindow.isDestroyed()) {
        whisprPillWindow.hide();
      }
    }, 400);
  }
  whisprPillPendingState = null;
}

function toggleWhispr() {
  whisprRecording = !whisprRecording;

  // Notify all renderer windows
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('whispr-toggle', whisprRecording);
  }
  if (spotlightWindow && !spotlightWindow.isDestroyed()) {
    spotlightWindow.webContents.send('whispr-toggle', whisprRecording);
  }

  if (whisprRecording) {
    showWhisprPill('listening');
  } else {
    // Pill will transition to 'transcribing' when audio is received
  }
}

// Receive recorded audio from renderer, call Groq API, route result smartly
ipcMain.handle('whispr-transcribe', async (event, audioArrayBuffer) => {
  const aiConfig = getAiConfigFromStore();
  if (!aiConfig.hasKey) {
    hideWhisprPill();
    whisprRecording = false;
    return { error: 'No API key configured. Go to Settings → AI Assistant.' };
  }

  showWhisprPill('transcribing');

  try {
    const audioBuffer = Buffer.from(audioArrayBuffer);
    const result = await whispr.transcribe(audioBuffer, aiConfig.whisprApiKey, { model: aiConfig.whisprModel });

    // Smart routing: send result to the focused window, or paste externally
    const spotlightVisible = spotlightWindow && !spotlightWindow.isDestroyed() && spotlightWindow.isVisible();
    const spotlightFocused = spotlightVisible && spotlightWindow.isFocused();
    const mainFocused = mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused();

    if (spotlightFocused) {
      spotlightWindow.webContents.send('whispr-result', result);
    } else if (mainFocused) {
      mainWindow.webContents.send('whispr-result', result);
    } else {
      // No MindSpace window focused — paste into external app
      pasteToExternalApp(result.text);
    }

    hideWhisprPill();
    return result;
  } catch (err) {
    console.error('Whispr transcription error:', err.message);
    showWhisprPill('error');
    setTimeout(() => hideWhisprPill(), 2000);
    return { error: err.message };
  } finally {
    whisprRecording = false;
  }
});

// Paste transcribed text into external apps via clipboard + Ctrl+V
function pasteToExternalApp(text) {
  if (!text) return;

  // Save previous clipboard state
  const prevText = clipboard.readText();
  const prevHtml = clipboard.readHTML();
  const prevImage = clipboard.readImage();
  const prevRtf = clipboard.readRTF();

  clipboard.writeText(text);

  // Small delay to let the clipboard settle, then simulate Ctrl+V
  setTimeout(() => {
    const psScript = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '[System.Windows.Forms.SendKeys]::SendWait("^v")',
    ].join('\n');
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    execFile('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], (err) => {
      if (err) console.error('Whispr external paste failed:', err.message);

      // Wait a moment for OS to process the paste, then restore previous clipboard
      setTimeout(() => {
        if (!prevImage.isEmpty()) {
          clipboard.writeImage(prevImage);
        } else if (prevHtml) {
          clipboard.writeHTML(prevHtml);
        } else if (prevRtf) {
          clipboard.writeRTF(prevRtf);
        } else if (prevText) {
          clipboard.writeText(prevText);
        } else {
          clipboard.clear();
        }
      }, 300);
    });
  }, 150);
}

// Allow spotlight button click to toggle too
ipcMain.on('whispr-toggle-from-renderer', () => {
  toggleWhispr();
});

// ─── Push-to-Talk (Right Shift key) ───
let pttProcess = null;
let pttActive = false;

function startPushToTalkMonitor() {
  const psScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class KeyStateMonitor {
    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);
}
"@
$$VK_RSHIFT = 0xA1
$$wasDown = $$false
while ($$true) {
    $$down = ([KeyStateMonitor]::GetAsyncKeyState($$VK_RSHIFT) -band 0x8000) -ne 0
    if ($$down -and -not $$wasDown) {
        [Console]::Out.WriteLine("DOWN")
        [Console]::Out.Flush()
    }
    if (-not $$down -and $$wasDown) {
        [Console]::Out.WriteLine("UP")
        [Console]::Out.Flush()
    }
    $$wasDown = $$down
    Start-Sleep -Milliseconds 50
}
`.replace(/\$\$/g, '$');

  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
  pttProcess = execFile('powershell', [
    '-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded
  ]);

  let buffer = '';
  pttProcess.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === 'DOWN' && !pttActive && !whisprRecording) {
        pttActive = true;
        toggleWhispr();
      } else if (trimmed === 'UP' && pttActive) {
        pttActive = false;
        if (whisprRecording) {
          toggleWhispr();
        }
      }
    }
  });

  pttProcess.stderr.on('data', (d) => console.error('PTT monitor:', d.toString()));
  pttProcess.on('exit', (code) => {
    pttProcess = null;
    // Auto-restart unless app is quitting
    if (!app.isQuitting) {
      setTimeout(startPushToTalkMonitor, 2000);
    }
  });
}

function stopPushToTalkMonitor() {
  if (pttProcess) {
    pttProcess.kill();
    pttProcess = null;
  }
}
