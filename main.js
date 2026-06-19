// Main 
const { app, BrowserWindow, ipcMain, shell, dialog, clipboard, nativeImage, globalShortcut, screen, Tray, Menu, powerMonitor } = require('electron');
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
const agent = require('./services/agent');
const agentMemory = require('./services/agent-memory');
const notifications = require('./services/notifications');

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
let whisprRecordingTimeout = null;
const WHISPR_MAX_RECORDING_MS = 120000;
let pttProcess = null;
let pttActive = false;
let pttPendingStart = null;
let pttStartedRecording = false;
const PTT_MIN_HOLD_MS = 120;
let selfHealTimer = null;
let whisprSanityTimer = null;
let selfHealRunning = false;
const SELF_HEAL_INTERVAL_MS = 60 * 60 * 1000;
const WHISPR_SANITY_INTERVAL_MS = 5 * 60 * 1000;

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
  await agentMemory.init(app.getPath('userData'));

  createWindow();

  // Create system tray (persistent lifecycle control)
  createTray();

  calendarScheduler = new CalendarScheduler(() => mainWindow);
  await calendarScheduler.start();

  // Register global shortcuts
  registerGlobalShortcuts();

  // Pre-warm spotlight so Alt+Space opens instantly (hidden, already loaded)
  prewarmSpotlight();

  // Start clipboard polling
  startClipboardPolling();

  // Start push-to-talk monitor (Right Shift key)
  startPushToTalkMonitor();

  // Pre-warm whispr pill so it's instantly ready on first PTT press
  createWhisprPill();

  // Release mic on sleep/lock; recover after resume
  powerMonitor.on('suspend', () => forceStopWhispr());
  powerMonitor.on('lock-screen', () => forceStopWhispr());
  powerMonitor.on('resume', () => {
    if (whisprRecording || pttActive) forceStopWhispr();
  });

  // Periodic self-heal + whispr sanity checks
  startHourlySelfHeal();
  startWhisprSanityCheck();

  // Setup Daily Briefing and Canvas Cleanup Autopilot (runs 15 seconds after startup, then every 24 hours)
  setTimeout(() => {
    runDailyAutopilot();
  }, 15000);
  setInterval(() => {
    runDailyAutopilot();
  }, 24 * 60 * 60 * 1000);
});

app.on('will-quit', () => {
  app.isQuitting = true;
  globalShortcut.unregisterAll();
  stopClipboardPolling();
  forceStopWhispr();
  stopPushToTalkMonitor();
  stopHourlySelfHeal();
  stopWhisprSanityCheck();
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

// ─── PEAK INTELLIGENCE AGENT — Spotlight AI Chat ───
ipcMain.handle('spotlight-ai-chat', async (event, { messages, stream }) => {
  const config = getAiConfigFromStore();
  if (!config.hasKey) {
    throw new Error('No API key configured. Add your API key in Settings → AI Chat Assistant.');
  }

  // Bridge: send thought-related ops to the renderer (which has the encryption key)
  const thoughtBridge = (op) => (payload) => new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) return resolve({ success: false, error: 'main window unavailable', _op: op });
    const replyChannel = `agent-thought-reply-${op}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const t = setTimeout(() => {
      ipcMain.removeAllListeners(replyChannel);
      resolve({ success: false, error: 'timeout', _op: op });
    }, 5000);
    ipcMain.once(replyChannel, (_e, res) => {
      clearTimeout(t);
      resolve(res);
    });
    if (op === 'create') mainWindow.webContents.send('spotlight-create-thought', { ...payload, _replyChannel: replyChannel });
    else if (op === 'get') mainWindow.webContents.send('spotlight-ai-get-thought', { id: payload.id, replyChannel });
    else if (op === 'update') mainWindow.webContents.send('spotlight-ai-update-thought', { id: payload.id, updates: payload.updates, replyChannel });
    else if (op === 'delete') mainWindow.webContents.send('spotlight-ai-delete-thought', { id: payload.id, replyChannel });
    else if (op === 'search') mainWindow.webContents.send('spotlight-ai-search-thoughts', { query: payload.query, replyChannel });
  });

  // Bridge: trigger a workflow in the main window
  const triggerWorkflow = (name) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('spotlight-execute-workflow', name);
    }
  };

  // Bridge: broadcast a calendar refresh
  const broadcastCalendarRefresh = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('calendar-refresh');
    }
  };

  // Bridge: read clipboard (main process has direct access)
  const readClipboard = async () => clipboard.readText();

  // Bridge: web search
  const webSearch = async (query) => {
    try {
      const data = await searchWeb(query);
      return data;
    } catch (e) {
      return { results: [], aiAnswer: null, error: e.message };
    }
  };

  // Helper: 429 key-fallback for chatCompletion
  const tryWithFallback = async (attemptOpts) => {
    try {
      return await chatCompletion(attemptOpts);
    } catch (err) {
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

  // Build the agent context
  const ctx = {
    event,
    emitChunk: (str) => {
      if (event.sender && !event.sender.isDestroyed()) {
        try { event.sender.send('spotlight-ai-chunk', { chunk: str }); } catch (e) { }
      }
    },
    config,
    memory: agentMemory,
    calendarStore,
    notesStore,
    calendarScheduler,
    llm: { chatCompletion, streamChatCompletion, PROVIDERS, getDefaultModel },
    tryWithFallback,
    getAlternateApiKey,
    persistKeySwitch,
    ipc: {
      createThought: async (data) => {
        const r = await thoughtBridge('create')(data);
        // The createThought bridge needs to return the inserted doc. The preload's
        // createThought handler is the canonical one. Let's just call it via spotlight-save-thought.
        if (!mainWindow || mainWindow.isDestroyed()) return null;
        return new Promise((resolve) => {
          const replyChannel = `agent-thought-create-reply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const t = setTimeout(() => { ipcMain.removeAllListeners(replyChannel); resolve(null); }, 5000);
          ipcMain.once(replyChannel, (_e, res) => { clearTimeout(t); resolve(res); });
          mainWindow.webContents.send('spotlight-save-thought', { ...data, _replyChannel: replyChannel });
        });
      },
      getThought: async (id) => {
        const r = await thoughtBridge('get')({ id });
        return r && r._id ? r : null;
      },
      updateThought: async (id, updates) => {
        return thoughtBridge('update')({ id, updates });
      },
      deleteThought: async (id) => {
        return thoughtBridge('delete')({ id });
      },
      searchThoughts: async (query) => {
        const r = await thoughtBridge('search')({ query });
        if (r && r.locked) return [];
        return Array.isArray(r) ? r : [];
      },
      getAllThoughts: async () => {
        const r = await thoughtBridge('search')({ query: '' });
        return Array.isArray(r) ? r : [];
      },
      updateCalendarEvent: async (id, updates) => {
        return calendarStore.update(id, updates);
      },
      broadcastCalendarRefresh,
      triggerWorkflow,
      readClipboard,
      webSearch,
    },
  };

  // Run the agent
  try {
    const result = await agent.handleTurn({ messages, config, ctx, stream });
    return { content: result.content, streamed: !!stream, verifications: result.verifications, verified: result.verified };
  } catch (err) {
    console.error('Agent error:', err);
    throw err;
  }
});

// ─── AGENT MEMORY IPC BRIDGES (read/write knowledge graph + scratchpad) ───
ipcMain.handle('agent-memory-snapshot', async () => {
  return agentMemory.buildContextSnapshot();
});
ipcMain.handle('agent-scratchpad-read', async () => {
  return agentMemory.readScratchpad();
});
ipcMain.handle('agent-scratchpad-update', async (event, patch) => {
  return agentMemory.updateScratchpad(patch || {});
});
ipcMain.handle('agent-entity-upsert', async (event, payload) => {
  return agentMemory.upsertEntity(payload || {});
});
ipcMain.handle('agent-entity-list', async (event, filters) => {
  return agentMemory.findEntities(filters || {});
});
ipcMain.handle('agent-entity-delete', async (event, id) => {
  return agentMemory.deleteEntity(id);
});
ipcMain.handle('agent-relation-upsert', async (event, payload) => {
  return agentMemory.upsertRelation(payload || {});
});
ipcMain.handle('agent-history', async (event, limit) => {
  return agentMemory.getHistory(limit || 50);
});
ipcMain.handle('agent-learn-facts', async (event, facts) => {
  return agentMemory.applyExtractedFacts(facts || {});
});

ipcMain.on('spotlight-open-result-url', (event, url) => {
  if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
    shell.openExternal(url);
  }
});

// ─── Mindspace Autopilot (Less is More) Helpers ───
const processedClips = new Set();

function isVoiceCommand(text) {
  if (!text) return false;
  const clean = text.trim().toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "");
  const triggers = [
    'hey space',
    'hey mindspace',
    'hey mind space',
    'schedule',
    'remind me',
    'create a note',
    'create note',
    'add note',
    'create thought',
    'create a thought',
    'add a thought',
    'add thought',
    'run workflow',
    'trigger workflow',
    'search for'
  ];
  return triggers.some(trigger => clean.startsWith(trigger));
}

async function runAgentInBackground(userText) {
  const config = getAiConfigFromStore();
  if (!config.hasKey) {
    throw new Error('API key is not configured.');
  }

  const thoughtBridge = (op) => (payload) => new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) return resolve({ success: false, error: 'main window unavailable', _op: op });
    const replyChannel = `agent-thought-reply-${op}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const t = setTimeout(() => {
      ipcMain.removeAllListeners(replyChannel);
      resolve({ success: false, error: 'timeout', _op: op });
    }, 5000);
    ipcMain.once(replyChannel, (_e, res) => {
      clearTimeout(t);
      resolve(res);
    });
    if (op === 'create') mainWindow.webContents.send('spotlight-create-thought', { ...payload, _replyChannel: replyChannel });
    else if (op === 'get') mainWindow.webContents.send('spotlight-ai-get-thought', { id: payload.id, replyChannel });
    else if (op === 'update') mainWindow.webContents.send('spotlight-ai-update-thought', { id: payload.id, updates: payload.updates, replyChannel });
    else if (op === 'delete') mainWindow.webContents.send('spotlight-ai-delete-thought', { id: payload.id, replyChannel });
    else if (op === 'search') mainWindow.webContents.send('spotlight-ai-search-thoughts', { query: payload.query, replyChannel });
  });

  const triggerWorkflow = (name) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('spotlight-execute-workflow', name);
    }
  };

  const broadcastCalendarRefresh = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('calendar-refresh');
    }
  };

  const readClipboard = async () => clipboard.readText();

  const webSearch = async (query) => {
    try {
      return await searchWeb(query);
    } catch (e) {
      return { results: [], aiAnswer: null, error: e.message };
    }
  };

  const tryWithFallback = async (attemptOpts) => {
    try {
      return await chatCompletion(attemptOpts);
    } catch (err) {
      if (err.statusCode === 429) {
        const altKey = getAlternateApiKey(config);
        if (altKey && altKey !== attemptOpts.apiKey) {
          persistKeySwitch(config);
          return await chatCompletion({ ...attemptOpts, apiKey: altKey });
        }
      }
      throw err;
    }
  };

  const ctx = {
    event: { sender: null },
    emitChunk: (str) => {
      console.log('[Autopilot Agent Chunk]:', str);
    },
    config,
    memory: agentMemory,
    calendarStore,
    notesStore,
    calendarScheduler,
    llm: { chatCompletion, streamChatCompletion, PROVIDERS, getDefaultModel },
    tryWithFallback,
    getAlternateApiKey,
    persistKeySwitch,
    ipc: {
      createThought: async (data) => {
        if (!mainWindow || mainWindow.isDestroyed()) return null;
        return new Promise((resolve) => {
          const replyChannel = `agent-thought-create-reply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const t = setTimeout(() => { ipcMain.removeAllListeners(replyChannel); resolve(null); }, 5000);
          ipcMain.once(replyChannel, (_e, res) => { clearTimeout(t); resolve(res); });
          mainWindow.webContents.send('spotlight-save-thought', { ...data, _replyChannel: replyChannel });
        });
      },
      getThought: async (id) => {
        const r = await thoughtBridge('get')({ id });
        return r && r._id ? r : null;
      },
      updateThought: async (id, updates) => {
        return thoughtBridge('update')({ id, updates });
      },
      deleteThought: async (id) => {
        return thoughtBridge('delete')({ id });
      },
      searchThoughts: async (query) => {
        const r = await thoughtBridge('search')({ query });
        if (r && r.locked) return [];
        return Array.isArray(r) ? r : [];
      },
      getAllThoughts: async () => {
        const r = await thoughtBridge('search')({ query: '' });
        return Array.isArray(r) ? r : [];
      },
      updateCalendarEvent: async (id, updates) => {
        return calendarStore.update(id, updates);
      },
      broadcastCalendarRefresh,
      triggerWorkflow,
      readClipboard,
      webSearch,
    },
  };

  const messages = [{ role: 'user', content: userText }];
  return await agent.handleTurn({ messages, config, ctx, stream: false });
}

async function processClipboardAutopilot(text) {
  if (!text) return;
  const trimmed = text.trim();
  if (trimmed.length < 10) return;

  if (processedClips.has(trimmed)) return;
  processedClips.add(trimmed);
  if (processedClips.size > 20) {
    const first = processedClips.values().next().value;
    processedClips.delete(first);
  }

  // A. Zoom / Teams / Meet link or meeting invite patterns
  const hasMeetingLink = /zoom\.us\/j\/|teams\.microsoft\.com\/l\/|meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(trimmed);
  const isMeetingInvite = hasMeetingLink || (/\b(schedule|meeting|invite|call|join indeed|zoom link|teams link)\b/i.test(trimmed) && /\b(at|on|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(trimmed));

  // B. URLs
  const isUrl = /^https?:\/\/[^\s]+$/i.test(trimmed);

  // C. Bullet checklist / actions format
  const hasTodoIndicators = /^\s*[\-\*•\d\.]+\s*(?:need to|todo|task|action item|must|should|will|please|fix|add|implement)\b/im.test(trimmed);

  if (isMeetingInvite) {
    console.log('Clipboard Autopilot: Processing meeting invite');
    notifications.notify({
      title: 'Mindspace Autopilot',
      message: 'Extracting meeting details from clipboard...',
      icon: path.join(__dirname, 'src', 'assets', 'icon.png'),
      appID: 'MindSpace',
      sound: false
    });

    const prompt = `I just copied a meeting/event invite to my clipboard. Please extract the event details (title, date, time, description/link) and schedule it using the schedule_meeting tool. Keep the date/time relative to today (shown in system prompt). Here is the clipboard text:\n\n${trimmed}`;
    
    runAgentInBackground(prompt).then((agentResult) => {
      const summary = agentResult.content || 'Meeting has been successfully scheduled.';
      notifications.notify({
        title: '📅 Event Scheduled',
        message: summary,
        icon: path.join(__dirname, 'src', 'assets', 'icon.png'),
        appID: 'MindSpace',
        sound: true
      });
    }).catch((err) => {
      console.error('Clipboard meeting autopilot failed:', err);
    });

  } else if (isUrl) {
    try {
      const urlObj = new URL(trimmed);
      const ignoreHostnames = [/google\.com/i, /bing\.com/i, /yahoo\.com/i, /baidu\.com/i, /duckduckgo\.com/i, /login\./i, /oauth\./i, /accounts\./i, /localhost/i];
      const shouldIgnore = ignoreHostnames.some(regex => regex.test(urlObj.hostname));
      
      if (!shouldIgnore) {
        console.log('Clipboard Autopilot: Summarizing website URL');
        notifications.notify({
          title: 'Mindspace Autopilot',
          message: `Summarizing webpage: ${urlObj.hostname}...`,
          icon: path.join(__dirname, 'src', 'assets', 'icon.png'),
          appID: 'MindSpace',
          sound: false
        });

        const prompt = `Please fetch or search the website URL "${trimmed}", summarize its core contents in 3 bullet points, and create a persistent thought card on the Canvas with priority "medium", tagged with "clipboard" and "summary", referencing the URL.`;
        
        runAgentInBackground(prompt).then((agentResult) => {
          const summary = agentResult.content || 'Webpage summarized and saved on Canvas.';
          notifications.notify({
            title: '🔗 Link Summarized',
            message: summary,
            icon: path.join(__dirname, 'src', 'assets', 'icon.png'),
            appID: 'MindSpace',
            sound: true
          });
        }).catch((err) => {
          console.error('Clipboard URL summary failed:', err);
        });
      }
    } catch (e) {
      // Ignore
    }

  } else if (hasTodoIndicators) {
    console.log('Clipboard Autopilot: Extracting action items');
    notifications.notify({
      title: 'Mindspace Autopilot',
      message: 'Extracting tasks from copied text...',
      icon: path.join(__dirname, 'src', 'assets', 'icon.png'),
      appID: 'MindSpace',
      sound: false
    });

    const prompt = `I just copied some notes/messages containing tasks. Please review them, extract the main actionable todo items for ME (the user), and create individual thought cards on the Canvas for each one with correct priorities (high/medium/low). Here is the copied text:\n\n${trimmed}`;
    
    runAgentInBackground(prompt).then((agentResult) => {
      const summary = agentResult.content || 'Action items created on Canvas.';
      notifications.notify({
        title: '📋 Tasks Extracted',
        message: summary,
        icon: path.join(__dirname, 'src', 'assets', 'icon.png'),
        appID: 'MindSpace',
        sound: true
      });
    }).catch((err) => {
      console.error('Clipboard todo autopilot failed:', err);
    });
  }
}

async function runDailyAutopilot() {
  const config = getAiConfigFromStore();
  if (!config.hasKey) return;

  console.log('Daily Autopilot: Initiating daily briefing & cleanup routine.');

  // Database Cleanup
  try {
    const clipboardDbPath = path.join(app.getPath('userData'), 'mindspace-data', 'clipboard.db');
    if (fs.existsSync(clipboardDbPath)) {
      const Datastore = require('nedb-promises');
      const clipboardDb = Datastore.create({ filename: clipboardDbPath, autoload: true });
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const numRemoved = await clipboardDb.remove({ timestamp: { $lt: sevenDaysAgo.toISOString() } }, { multi: true });
      if (numRemoved > 0) {
        console.log(`Daily Cleanup: Purged ${numRemoved} clipboard entries older than 7 days.`);
      }
    }
  } catch (err) {
    console.error('Daily Autopilot Cleanup Error:', err);
  }

  // Daily Briefing Generation (requires active unlocked window)
  if (!mainWindow || mainWindow.isDestroyed()) {
    console.log('Daily Autopilot: Main window unavailable. Skipping daily brief.');
    return;
  }

  notifications.notify({
    title: 'Mindspace Autopilot',
    message: 'Compiling your Daily Briefing...',
    icon: path.join(__dirname, 'src', 'assets', 'icon.png'),
    appID: 'MindSpace',
    sound: false
  });

  const prompt = `Good morning! It's a new day. Please:
1. Scan today's calendar events (get_calendar_events with filter="today").
2. Scan active thoughts (search_thoughts with query="").
3. Create a beautiful "Daily Briefing" thought card on the Canvas (create_thought with content summarizing my day, priority="high", persistence="today", tags=["daily-brief"]).
4. Clean up the Canvas: search for any finished or expired thoughts, and delete them using delete_thought to keep the canvas clean and tidy.`;

  runAgentInBackground(prompt).then((agentResult) => {
    const summary = agentResult.content || 'Your Daily Briefing card is ready on the Canvas.';
    notifications.notify({
      title: '☀️ Daily Briefing Ready',
      message: summary,
      icon: path.join(__dirname, 'src', 'assets', 'icon.png'),
      appID: 'MindSpace',
      sound: true
    });
  }).catch((err) => {
    console.error('Daily Briefing Autopilot failed:', err);
  });
}


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
      processClipboardAutopilot(currentText);
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
  if (clipboardPollTimer) {
    clearInterval(clipboardPollTimer);
    clipboardPollTimer = null;
  }
}

function registerGlobalShortcuts() {
  try {
    globalShortcut.unregister('Alt+Space');
    globalShortcut.unregister('Alt+`');
  } catch (_) { /* first run */ }
  globalShortcut.register('Alt+Space', () => toggleSpotlight());
  globalShortcut.register('Alt+`', () => toggleWhispr());
}

function recycleWhisprPill() {
  clearWhisprPillTimers();
  whisprPillDisplayState = 'idle';
  if (whisprPillWindow && !whisprPillWindow.isDestroyed()) {
    sendWhisprPillState('idle');
    whisprPillWindow.hide();
    whisprPillReady = false;
    whisprPillReadyWaiters = [];
    whisprPillWindow.webContents.reload();
  } else {
    createWhisprPill();
  }
}

function isMindspaceActivelyInUse() {
  if (whisprRecording || pttActive) return true;
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()) {
    return true;
  }
  if (spotlightWindow && !spotlightWindow.isDestroyed() && spotlightWindow.isVisible()) {
    return true;
  }
  return false;
}

async function runHourlySelfHeal() {
  if (selfHealRunning || app.isQuitting) return;
  selfHealRunning = true;
  try {
    console.log('[Self-Heal] Running hourly maintenance…');
    forceStopWhispr();
    stopPushToTalkMonitor();
    startPushToTalkMonitor();
    stopClipboardPolling();
    startClipboardPolling();
    registerGlobalShortcuts();
    cachedSpotlightWorkflows = null;
    workflowsCacheMtime = 0;
    recycleWhisprPill();
    if (!isMindspaceActivelyInUse()) {
      if (spotlightWindow && !spotlightWindow.isDestroyed() && !spotlightWindow.isVisible()) {
        spotlightReady = false;
        spotlightPanelOpen = false;
        spotlightWindow.webContents.reload();
        spotlightWindow.once('ready-to-show', () => { spotlightReady = true; });
      }
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        mainWindow.webContents.reload();
      }
    }
    console.log('[Self-Heal] Complete.');
  } catch (err) {
    console.error('[Self-Heal] Error:', err);
  } finally {
    selfHealRunning = false;
  }
}

function startHourlySelfHeal() {
  stopHourlySelfHeal();
  selfHealTimer = setInterval(runHourlySelfHeal, SELF_HEAL_INTERVAL_MS);
}

function stopHourlySelfHeal() {
  if (selfHealTimer) {
    clearInterval(selfHealTimer);
    selfHealTimer = null;
  }
}

function runWhisprSanityCheck() {
  if (app.isQuitting) return;
  // Orphaned recording state (e.g. after hours idle) with no active key hold
  if (whisprRecording && !pttActive) {
    console.warn('[Whispr Sanity] Stuck recording without PTT — force stopping');
    forceStopWhispr();
  }
  // Stale PTT flags without recording
  if (pttActive && !whisprRecording && !pttPendingStart) {
    resetPttState();
  }
}

function startWhisprSanityCheck() {
  stopWhisprSanityCheck();
  whisprSanityTimer = setInterval(runWhisprSanityCheck, WHISPR_SANITY_INTERVAL_MS);
}

function stopWhisprSanityCheck() {
  if (whisprSanityTimer) {
    clearInterval(whisprSanityTimer);
    whisprSanityTimer = null;
  }
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
let whisprHideTimeout = null;
let whisprPillErrorTimeout = null;
let whisprPillDisplayState = 'idle';
let whisprPillReadyWaiters = [];

function clearWhisprPillTimers() {
  if (whisprHideTimeout) {
    clearTimeout(whisprHideTimeout);
    whisprHideTimeout = null;
  }
  if (whisprPillErrorTimeout) {
    clearTimeout(whisprPillErrorTimeout);
    whisprPillErrorTimeout = null;
  }
}

function sendWhisprPillState(state) {
  if (!whisprPillWindow || whisprPillWindow.isDestroyed()) return;
  whisprPillWindow.webContents.send('whispr-pill-state', state);
}

function waitForWhisprPillReady() {
  if (whisprPillReady) return Promise.resolve();
  return new Promise((resolve) => {
    whisprPillReadyWaiters.push(resolve);
    setTimeout(resolve, 4000);
  });
}

function createWhisprPill() {
  if (whisprPillWindow && !whisprPillWindow.isDestroyed()) return whisprPillWindow;

  whisprPillReady = false;
  whisprPillReadyWaiters = [];

  const display = screen.getPrimaryDisplay();
  const pillWidth = 200;
  const pillHeight = 44;
  const x = Math.round(display.workArea.x + (display.workArea.width - pillWidth) / 2);
  const y = display.workArea.y + display.workArea.height - pillHeight - 20;

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
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: true,
    },
  });

  whisprPillWindow.loadFile(path.join(__dirname, 'src', 'whispr-pill.html'));

  whisprPillWindow.on('closed', () => {
    whisprPillWindow = null;
    whisprPillReady = false;
    whisprPillReadyWaiters = [];
    whisprPillDisplayState = 'idle';
  });

  return whisprPillWindow;
}

ipcMain.on('whispr-pill-ready', () => {
  whisprPillReady = true;
  const waiters = whisprPillReadyWaiters.splice(0);
  waiters.forEach((resolve) => resolve());
});

async function showWhisprPill(state) {
  if (state === 'done') state = 'idle';
  if (state === 'idle') {
    hideWhisprPill();
    return;
  }

  // Skip redundant updates (except re-entering listening)
  if (state === whisprPillDisplayState && state !== 'listening') return;

  clearWhisprPillTimers();

  const pill = createWhisprPill();
  await waitForWhisprPillReady();

  if (pill.isDestroyed()) return;

  whisprPillDisplayState = state;

  if (!pill.isVisible()) pill.show();
  sendWhisprPillState(state);

  if (state === 'error') {
    whisprPillErrorTimeout = setTimeout(() => hideWhisprPill(), 1800);
  }
}

function hideWhisprPill() {
  clearWhisprPillTimers();
  whisprPillDisplayState = 'idle';

  if (whisprPillWindow && !whisprPillWindow.isDestroyed()) {
    sendWhisprPillState('idle');
    whisprHideTimeout = setTimeout(() => {
      whisprHideTimeout = null;
      if (whisprPillWindow && !whisprPillWindow.isDestroyed()) {
        whisprPillWindow.hide();
      }
    }, 220);
  }
}

function clearWhisprWatchdog() {
  if (whisprRecordingTimeout) {
    clearTimeout(whisprRecordingTimeout);
    whisprRecordingTimeout = null;
  }
}

function scheduleWhisprWatchdog() {
  clearWhisprWatchdog();
  whisprRecordingTimeout = setTimeout(() => {
    console.warn('Whispr: max recording duration — force stopping');
    forceStopWhispr();
  }, WHISPR_MAX_RECORDING_MS);
}

function clearPttPendingStart() {
  if (pttPendingStart) {
    clearTimeout(pttPendingStart);
    pttPendingStart = null;
  }
}

function resetPttState() {
  clearPttPendingStart();
  pttActive = false;
  pttStartedRecording = false;
}

function notifyWhisprRenderers(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
  if (spotlightWindow && !spotlightWindow.isDestroyed()) {
    spotlightWindow.webContents.send(channel, payload);
  }
}

function startWhispr() {
  if (whisprRecording) return;
  whisprRecording = true;
  notifyWhisprRenderers('whispr-toggle', true);
  showWhisprPill('listening');
  scheduleWhisprWatchdog();
}

function stopWhispr() {
  if (!whisprRecording) return;
  whisprRecording = false;
  clearWhisprWatchdog();
  notifyWhisprRenderers('whispr-toggle', false);
  // Pill transitions to transcribing when audio arrives, or hides via whispr-recording-ended
}

function forceStopWhispr() {
  clearWhisprWatchdog();
  resetPttState();
  const wasRecording = whisprRecording;
  whisprRecording = false;
  if (wasRecording) {
    notifyWhisprRenderers('whispr-force-stop');
  }
  hideWhisprPill();
}

function toggleWhispr() {
  if (whisprRecording) {
    stopWhispr();
  } else {
    startWhispr();
  }
}

// Receive recorded audio from renderer, call Groq API, route result smartly
ipcMain.handle('whispr-transcribe', async (event, audioArrayBuffer) => {
  const aiConfig = getAiConfigFromStore();
  if (!aiConfig.hasKey) {
    hideWhisprPill();
    whisprRecording = false;
    resetPttState();
    clearWhisprWatchdog();
    return { error: 'No API key configured. Go to Settings → AI Assistant.' };
  }

  showWhisprPill('transcribing');

  try {
    const audioBuffer = Buffer.from(audioArrayBuffer);
    const result = await whispr.transcribe(audioBuffer, aiConfig.whisprApiKey, { model: aiConfig.whisprModel });

    const text = (result.text || '').trim();
    if (isVoiceCommand(text)) {
      runAgentInBackground(text).then((agentResult) => {
        const finalContent = agentResult.content || 'Voice command processed successfully.';
        notifications.notify({
          title: 'Mindspace Autopilot',
          message: finalContent,
          icon: path.join(__dirname, 'src', 'assets', 'icon.png'),
          appID: 'MindSpace',
          sound: true,
          wait: false
        });
      }).catch((err) => {
        console.error('Voice autopilot failed:', err);
        notifications.notify({
          title: 'Mindspace Autopilot Error',
          message: err.message,
          icon: path.join(__dirname, 'src', 'assets', 'icon.png'),
          appID: 'MindSpace',
          sound: true,
          wait: false
        });
      });

      hideWhisprPill();
      return { text, isCommand: true };
    }

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
    return { error: err.message };
  } finally {
    whisprRecording = false;
    resetPttState();
    clearWhisprWatchdog();
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

ipcMain.on('whispr-recording-failed', () => {
  forceStopWhispr();
});

ipcMain.on('whispr-recording-ended', (_event, { hasAudio } = {}) => {
  if (!hasAudio) hideWhisprPill();
});

// ─── Push-to-Talk (Right Shift key) ───

function handlePttKeyDown() {
  if (pttActive) return;
  if (whisprRecording) forceStopWhispr();

  pttActive = true;
  clearPttPendingStart();
  pttStartedRecording = false;

  // Ignore accidental taps — only start mic after brief hold
  pttPendingStart = setTimeout(() => {
    pttPendingStart = null;
    if (!pttActive) return;
    pttStartedRecording = true;
    startWhispr();
  }, PTT_MIN_HOLD_MS);
}

function handlePttKeyUp() {
  if (!pttActive) return;

  const hadPendingStart = !!pttPendingStart;
  clearPttPendingStart();
  pttActive = false;

  // Quick tap: never opened mic — just reset
  if (hadPendingStart && !pttStartedRecording) {
    hideWhisprPill();
    return;
  }

  if (pttStartedRecording || whisprRecording) {
    pttStartedRecording = false;
    stopWhispr();
  }
}

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
for ($$i = 0; $$i -lt 6; $$i++) {
    [void][KeyStateMonitor]::GetAsyncKeyState($$VK_RSHIFT)
    Start-Sleep -Milliseconds 50
}
$$wasDown = ([KeyStateMonitor]::GetAsyncKeyState($$VK_RSHIFT) -band 0x8000) -ne 0
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
      if (trimmed === 'DOWN') handlePttKeyDown();
      else if (trimmed === 'UP') handlePttKeyUp();
    }
  });

  pttProcess.stderr.on('data', (d) => console.error('PTT monitor:', d.toString()));
  pttProcess.on('exit', () => {
    pttProcess = null;
    if (pttActive || whisprRecording) forceStopWhispr();
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
