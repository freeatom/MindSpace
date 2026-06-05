const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');
const Datastore = require('nedb-promises');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// We expose the store operations directly through the preload bridge
// since nedb and bcrypt need Node.js APIs

let thoughts, tags, settings, archives, tools, clipboardHistory, workflows;
let dbReady = false;
let sessionKey = null; // Derived dynamically on login, kept only in-memory

function deriveKey(password, salt) {
  // Derive a 256-bit (32-byte) key using PBKDF2 with SHA-256
  return crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
}

function encryptText(text, key) {
  const iv = crypto.randomBytes(12); // Standard IV size for GCM is 12 bytes
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return {
    ciphertext: encrypted,
    iv: iv.toString('hex'),
    tag: tag
  };
}

function decryptText(ciphertext, ivHex, tagHex, key) {
  try {
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('Decryption failed:', err);
    return '[Decryption Error: Invalid key or corrupted data]';
  }
}

async function encryptPlainThoughts() {
  if (!sessionKey) return;
  const allThoughts = await thoughts.find({});
  let migratedCount = 0;
  for (const t of allThoughts) {
    if (!t.iv) {
      const encrypted = encryptText(t.content, sessionKey);
      await thoughts.update(
        { _id: t._id },
        {
          $set: {
            content: encrypted.ciphertext,
            iv: encrypted.iv,
            tag: encrypted.tag
          }
        }
      );
      migratedCount++;
    }
  }
  if (migratedCount > 0) {
    console.log(`Zero-knowledge migration: Encrypted ${migratedCount} existing plain-text thoughts.`);
  }
}

async function initDB(userDataPath) {
  const dbPath = path.join(userDataPath, 'mindspace-data');

  thoughts = Datastore.create({
    filename: path.join(dbPath, 'thoughts.db'),
    autoload: true,
  });

  tags = Datastore.create({
    filename: path.join(dbPath, 'tags.db'),
    autoload: true,
  });

  settings = Datastore.create({
    filename: path.join(dbPath, 'settings.db'),
    autoload: true,
  });

  archives = Datastore.create({
    filename: path.join(dbPath, 'archives.db'),
    autoload: true,
  });

  tools = Datastore.create({
    filename: path.join(dbPath, 'tools.db'),
    autoload: true,
  });

  clipboardHistory = Datastore.create({
    filename: path.join(dbPath, 'clipboard.db'),
    autoload: true,
  });

  workflows = Datastore.create({
    filename: path.join(dbPath, 'workflows.db'),
    autoload: true,
  });

  dbReady = true;
}

contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  toggleFullscreen: () => ipcRenderer.send('window-toggle-fullscreen'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  isFullscreen: () => ipcRenderer.invoke('window-is-fullscreen'),
  getUserDataPath: () => ipcRenderer.invoke('get-user-data-path'),
  openExternal: (url) => ipcRenderer.send('open-external', url),

  // ─── Database Operations ───
  initDB: async () => {
    const userDataPath = await ipcRenderer.invoke('get-user-data-path');
    await initDB(userDataPath);
  },

  // Settings
  getSetting: async (key) => {
    const doc = await settings.findOne({ key });
    return doc ? doc.value : null;
  },
  setSetting: async (key, value) => {
    await settings.update({ key }, { key, value }, { upsert: true });
  },

  // Auth
  setPassword: async (password) => {
    const hash = await bcrypt.hash(password, 10);
    const salt = crypto.randomBytes(16).toString('hex');
    await settings.update({ key: 'passwordHash' }, { key: 'passwordHash', value: hash }, { upsert: true });
    await settings.update({ key: 'encryption_salt' }, { key: 'encryption_salt', value: salt }, { upsert: true });
    sessionKey = deriveKey(password, salt);
    await encryptPlainThoughts();
  },
  verifyPassword: async (password, hash) => {
    const valid = await bcrypt.compare(password, hash);
    if (valid) {
      let saltDoc = await settings.findOne({ key: 'encryption_salt' });
      let salt;
      if (!saltDoc) {
        salt = crypto.randomBytes(16).toString('hex');
        await settings.update({ key: 'encryption_salt' }, { key: 'encryption_salt', value: salt }, { upsert: true });
      } else {
        salt = saltDoc.value;
      }
      sessionKey = deriveKey(password, salt);
      await encryptPlainThoughts();
    }
    return valid;
  },
  lockSession: () => {
    sessionKey = null;
  },
  changePassword: async (currentPassword, newPassword) => {
    const hashDoc = await settings.findOne({ key: 'passwordHash' });
    if (!hashDoc) throw new Error('No password set');
    const valid = await bcrypt.compare(currentPassword, hashDoc.value);
    if (!valid) throw new Error('Incorrect current password');

    const allThoughts = await thoughts.find({});
    const newSalt = crypto.randomBytes(16).toString('hex');
    const newKey = deriveKey(newPassword, newSalt);

    for (const t of allThoughts) {
      let plainText;
      if (t.iv) {
        plainText = decryptText(t.content, t.iv, t.tag, sessionKey);
      } else {
        plainText = t.content;
      }
      const encrypted = encryptText(plainText, newKey);
      await thoughts.update(
        { _id: t._id },
        {
          $set: {
            content: encrypted.ciphertext,
            iv: encrypted.iv,
            tag: encrypted.tag
          }
        }
      );
    }

    // Re-encrypt archive items
    const allArchives = await archives.find({});
    for (const a of allArchives) {
      if (a.iv) {
        const plain = decryptText(a.content, a.iv, a.tag, sessionKey);
        const enc = encryptText(plain, newKey);
        await archives.update({ _id: a._id }, { $set: { content: enc.ciphertext, iv: enc.iv, tag: enc.tag } });
      } else if (a.content) {
        const enc = encryptText(a.content, newKey);
        await archives.update({ _id: a._id }, { $set: { content: enc.ciphertext, iv: enc.iv, tag: enc.tag } });
      }
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await settings.update({ key: 'passwordHash' }, { key: 'passwordHash', value: newHash }, { upsert: true });
    await settings.update({ key: 'encryption_salt' }, { key: 'encryption_salt', value: newSalt }, { upsert: true });
    sessionKey = newKey;
  },

  // Thoughts
  createThought: async (thought) => {
    const docToInsert = { ...thought };
    if (sessionKey) {
      const encrypted = encryptText(docToInsert.content, sessionKey);
      docToInsert.content = encrypted.ciphertext;
      docToInsert.iv = encrypted.iv;
      docToInsert.tag = encrypted.tag;
    }
    const insertedDoc = await thoughts.insert(docToInsert);
    if (insertedDoc && insertedDoc.iv && sessionKey) {
      insertedDoc.content = decryptText(insertedDoc.content, insertedDoc.iv, insertedDoc.tag, sessionKey);
    }
    return insertedDoc;
  },
  updateThought: async (id, updates) => {
    const updatesToApply = { ...updates };
    if (sessionKey && updatesToApply.content !== undefined) {
      const encrypted = encryptText(updatesToApply.content, sessionKey);
      updatesToApply.content = encrypted.ciphertext;
      updatesToApply.iv = encrypted.iv;
      updatesToApply.tag = encrypted.tag;
    }
    return thoughts.update({ _id: id }, { $set: updatesToApply });
  },
  deleteThought: async (id) => {
    return thoughts.remove({ _id: id });
  },
  getThought: async (id) => {
    const doc = await thoughts.findOne({ _id: id });
    if (doc && doc.iv && sessionKey) {
      doc.content = decryptText(doc.content, doc.iv, doc.tag, sessionKey);
    }
    return doc;
  },
  getAllThoughts: async () => {
    const docs = await thoughts.find({}).sort({ createdAt: -1 });
    if (sessionKey) {
      docs.forEach((doc) => {
        if (doc.iv) {
          doc.content = decryptText(doc.content, doc.iv, doc.tag, sessionKey);
        }
      });
    }
    return docs;
  },
  searchThoughts: async (query) => {
    const docs = await thoughts.find({});
    if (sessionKey) {
      docs.forEach((doc) => {
        if (doc.iv) {
          doc.content = decryptText(doc.content, doc.iv, doc.tag, sessionKey);
        }
      });
    }
    const regex = new RegExp(query, 'i');
    const filtered = docs.filter((doc) => regex.test(doc.content));
    return filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  },

  // Tags
  createTag: async (tag) => {
    const existing = await tags.findOne({ name: tag.name });
    if (existing) return existing;
    return tags.insert(tag);
  },
  getAllTags: async () => {
    return tags.find({}).sort({ name: 1 });
  },
  deleteTag: async (id) => {
    const tag = await tags.findOne({ _id: id });
    if (tag) {
      const relatedThoughts = await thoughts.find({ tags: tag.name });
      for (const t of relatedThoughts) {
        const newTags = t.tags.filter((tn) => tn !== tag.name);
        await thoughts.update({ _id: t._id }, { $set: { tags: newTags } });
      }
    }
    return tags.remove({ _id: id });
  },

  // Archives
  createArchive: async (item) => {
    const doc = { ...item };
    if (sessionKey && doc.content) {
      const enc = encryptText(doc.content, sessionKey);
      doc.content = enc.ciphertext;
      doc.iv = enc.iv;
      doc.tag = enc.tag;
    }
    const inserted = await archives.insert(doc);
    if (inserted && inserted.iv && sessionKey) {
      inserted.content = decryptText(inserted.content, inserted.iv, inserted.tag, sessionKey);
    }
    return inserted;
  },
  updateArchive: async (id, updates) => {
    const u = { ...updates };
    if (sessionKey && u.content !== undefined) {
      const enc = encryptText(u.content, sessionKey);
      u.content = enc.ciphertext;
      u.iv = enc.iv;
      u.tag = enc.tag;
    }
    return archives.update({ _id: id }, { $set: u });
  },
  deleteArchive: async (id) => {
    return archives.remove({ _id: id });
  },
  getAllArchives: async () => {
    const docs = await archives.find({}).sort({ createdAt: -1 });
    if (sessionKey) {
      docs.forEach((doc) => {
        if (doc.iv) {
          doc.content = decryptText(doc.content, doc.iv, doc.tag, sessionKey);
        }
      });
    }
    return docs;
  },

  // Smart Actions
  copyImageToClipboard: (base64Data) => ipcRenderer.send('copy-image-to-clipboard', base64Data),
  autoPasteSearch: (delayMs) => ipcRenderer.send('auto-paste-search', delayMs),
  autoPasteFull: (text, delayMs) => ipcRenderer.send('auto-paste-full', text, delayMs),

  // File Drop
  readDroppedFile: (filePath) => ipcRenderer.invoke('read-dropped-file', filePath),
  openFileLocation: (filePath) => ipcRenderer.send('open-file-location', filePath),

  // Tools Hub
  selectToolPath: () => ipcRenderer.invoke('select-tool-path'),
  openToolWindow: (toolPath, toolName) => ipcRenderer.send('open-tool-window', toolPath, toolName),

  createTool: async (item) => {
    return tools.insert(item);
  },
  updateTool: async (id, updates) => {
    return tools.update({ _id: id }, { $set: updates });
  },
  deleteTool: async (id) => {
    return tools.remove({ _id: id });
  },
  getAllTools: async () => {
    return tools.find({}).sort({ createdAt: -1 });
  },

  // Clipboard Manager
  onClipboardEntry: (callback) => ipcRenderer.on('clipboard-new-entry', (e, entry) => callback(entry)),

  // Clipboard Persistence
  createClipboardEntry: async (entry) => {
    return clipboardHistory.insert(entry);
  },
  getAllClipboardEntries: async () => {
    return clipboardHistory.find({}).sort({ timestamp: -1 });
  },
  deleteClipboardEntry: async (id) => {
    return clipboardHistory.remove({ _id: id });
  },
  clearClipboardHistory: async () => {
    return clipboardHistory.remove({}, { multi: true });
  },

  // Workflows
  createWorkflow: async (workflow) => {
    return workflows.insert(workflow);
  },
  getAllWorkflows: async () => {
    return workflows.find({}).sort({ name: 1 });
  },
  updateWorkflow: async (id, updates) => {
    return workflows.update({ _id: id }, { $set: updates });
  },
  deleteWorkflow: async (id) => {
    return workflows.remove({ _id: id });
  },

  // Spotlight (receive from main → save)
  onSpotlightThought: (callback) => ipcRenderer.on('spotlight-create-thought', (e, data) => callback(data)),
  onSpotlightArchive: (callback) => ipcRenderer.on('spotlight-create-archive', (e, data) => callback(data)),
  onSpotlightWorkflow: (callback) => ipcRenderer.on('spotlight-execute-workflow', (e, name) => callback(name)),

  // AI Command Palette
  aiQuery: (opts) => ipcRenderer.invoke('ai-query', opts),
  testAiConnection: (opts) => ipcRenderer.invoke('ai-test-connection', opts),
  runShellCommand: (cmd) => ipcRenderer.invoke('run-shell-command', cmd),

  // Notes repository
  createNote: (data) => ipcRenderer.invoke('notes-create', data),
  updateNote: (id, updates) => ipcRenderer.invoke('notes-update', id, updates),
  deleteNote: (id) => ipcRenderer.invoke('notes-delete', id),
  getNote: (id) => ipcRenderer.invoke('notes-get', id),
  getAllNotes: () => ipcRenderer.invoke('notes-get-all'),
  searchNotes: (query) => ipcRenderer.invoke('notes-search', query),

  // Calendar
  createCalendarEvent: (data) => ipcRenderer.invoke('calendar-create', data),
  updateCalendarEvent: (id, updates) => ipcRenderer.invoke('calendar-update', id, updates),
  deleteCalendarEvent: (id) => ipcRenderer.invoke('calendar-delete', id),
  getCalendarEvent: (id) => ipcRenderer.invoke('calendar-get', id),
  getAllCalendarEvents: () => ipcRenderer.invoke('calendar-get-all'),
  searchCalendarEvents: (filters) => ipcRenderer.invoke('calendar-search', filters),
  getCalendarStats: () => ipcRenderer.invoke('calendar-stats'),
  parseCalendarCommand: (text) => ipcRenderer.invoke('calendar-parse', text),
  isCalendarTrigger: (text) => ipcRenderer.invoke('calendar-is-trigger', text),
  snoozeCalendarEvent: (id, minutes) => ipcRenderer.invoke('calendar-snooze', id, minutes),
  dismissCalendarNotification: (id) => ipcRenderer.invoke('calendar-dismiss-notification', id),
  onCalendarNotification: (callback) => ipcRenderer.on('calendar-notification', (e, data) => callback(data)),
  onCalendarOpenEvent: (callback) => ipcRenderer.on('calendar-open-event', (e, data) => callback(data)),
  onCalendarOpenEventModal: (callback) => ipcRenderer.on('calendar-open-event-modal', (e, data) => callback(data)),
});

