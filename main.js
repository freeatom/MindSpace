const { app, BrowserWindow, ipcMain, shell, dialog, clipboard, nativeImage, globalShortcut, screen } = require('electron');
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

let mainWindow;
let calendarScheduler = null;
let spotlightWindow = null;
let spotlightPanelOpen = false;
let spotlightReady = false;
let cachedSpotlightWorkflows = null;
let workflowsCacheMtime = 0;

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
  return created;
});
ipcMain.handle('calendar-update', async (event, id, updates) => {
  const updated = await calendarStore.update(id, updates);
  if (calendarScheduler) await calendarScheduler.rescheduleAll();
  return updated;
});
ipcMain.handle('calendar-delete', async (event, id) => {
  const result = await calendarStore.remove(id);
  if (calendarScheduler) await calendarScheduler.rescheduleAll();
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
  const apiKey = settingsStore.getSetting(userData, 'aiApiKey') || '';
  const model = settingsStore.getSetting(userData, 'aiModel') || '';
  return {
    provider,
    apiKey,
    model: model || getDefaultModel(provider),
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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(async () => {
  await notesStore.init(app.getPath('userData'));
  await migrateLegacySpotlightNotes();
  await calendarStore.init(app.getPath('userData'));

  createWindow();

  calendarScheduler = new CalendarScheduler(() => mainWindow);
  await calendarScheduler.start();

  // Register global spotlight shortcut
  globalShortcut.register('Alt+Space', () => {
    toggleSpotlight();
  });

  // Pre-warm spotlight so Alt+Space opens instantly (hidden, already loaded)
  prewarmSpotlight();

  // Start clipboard polling
  startClipboardPolling();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopClipboardPolling();
  if (calendarScheduler) calendarScheduler.stop();
});

app.on('window-all-closed', () => {
  app.quit();
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

  spotlightWindow = new BrowserWindow({
    width: layout.width,
    height: SPOTLIGHT_COMPACT_HEIGHT,
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

  positionSpotlightWindow(spotlightWindow, layout.width, SPOTLIGHT_COMPACT_HEIGHT);

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

  return spotlightWindow;
}

function prewarmSpotlight() {
  createSpotlightWindow();
}

function showSpotlight() {
  const win = createSpotlightWindow();
  const layout = getSpotlightLayout();

  const reveal = () => {
    spotlightPanelOpen = false;
    positionSpotlightWindow(win, layout.width, SPOTLIGHT_COMPACT_HEIGHT);
    if (!win.isVisible()) win.show();
    win.focus();
    win.webContents.send('spotlight-shown');
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
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('calendar-open-event-modal', prefill || {});
  }
});

// Spotlight saves go through main window's webContents
ipcMain.on('spotlight-save-thought', (event, data) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('spotlight-create-thought', data);
  }
});

ipcMain.on('spotlight-save-archive', (event, data) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('spotlight-create-archive', data);
  }
});

ipcMain.on('spotlight-execute-workflow', (event, name) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('spotlight-execute-workflow', name);
  }
});

ipcMain.handle('spotlight-get-workflows', () => readSpotlightWorkflows());
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

ipcMain.handle('spotlight-ai-chat', async (event, { messages, stream }) => {
  const config = getAiConfigFromStore();
  if (!config.hasKey) {
    throw new Error('No API key configured. Add your Groq API key in Settings.');
  }

  const opts = {
    provider: config.provider,
    apiKey: config.apiKey,
    model: config.model,
    messages,
  };

  if (stream && config.supportsStream) {
    return new Promise((resolve, reject) => {
      streamChatCompletion({
        ...opts,
        onChunk: (chunk) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('spotlight-ai-chunk', { chunk });
          }
        },
        onDone: () => resolve({ streamed: true }),
        onError: (err) => reject(err),
      });
    });
  }

  const result = await chatCompletion(opts);
  return { content: result.content, streamed: false };
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
  const result = await chatCompletion({ provider, apiKey, model: resolvedModel, messages });

  if (provider === 'gemini') {
    return result.raw;
  }
  return result.raw;
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
