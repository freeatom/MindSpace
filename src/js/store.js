/* ═══════════════════════════════════════════════════════════════
   Store — Thin wrapper around electronAPI database operations
   All heavy lifting (nedb, bcrypt) runs in the preload script.
   ═══════════════════════════════════════════════════════════════ */

const store = {
  ready: false,
  thoughtCounter: 0,

  async init() {
    await window.electronAPI.initDB();
    this.ready = true;

    // Load the current thought counter
    const counter = await this.getSetting('thoughtCounter');
    this.thoughtCounter = counter || 0;

    // Seed default tags if empty
    const existingTags = await this.getAllTags();
    if (existingTags.length === 0) {
      await this.seedDefaultTags();
    }

    // Initialize default settings
    await this.initDefaultSettings();
  },

  // ─── Settings / Auth ───

  async getSetting(key) {
    return window.electronAPI.getSetting(key);
  },

  async setSetting(key, value) {
    return window.electronAPI.setSetting(key, value);
  },

  async hasPassword() {
    const hash = await this.getSetting('passwordHash');
    return !!hash;
  },

  async setPassword(password) {
    return window.electronAPI.setPassword(password);
  },

  async verifyPassword(password) {
    const hash = await this.getSetting('passwordHash');
    if (!hash) return false;
    return window.electronAPI.verifyPassword(password, hash);
  },

  async lockSession() {
    return window.electronAPI.lockSession();
  },

  async initDefaultSettings() {
    const defaults = {
      canvasZoom: 100,
      autoArchiveExpired: true,
      showFinishedOnCanvas: true,
      defaultPriority: 'medium',
      defaultPersistence: 'persistent',
      compactCards: false,
      showThoughtNumbers: true,
      animationsEnabled: true,
    };
    for (const [key, value] of Object.entries(defaults)) {
      const existing = await this.getSetting(key);
      if (existing === null || existing === undefined) {
        await this.setSetting(key, value);
      }
    }
  },

  async getAllSettings() {
    const keys = [
      'canvasZoom', 'autoArchiveExpired', 'showFinishedOnCanvas',
      'defaultPriority', 'defaultPersistence', 'compactCards',
      'showThoughtNumbers', 'animationsEnabled',
      'aiProvider', 'aiApiKey', 'aiModel',
    ];
    const result = {};
    for (const key of keys) {
      result[key] = await this.getSetting(key);
    }
    return result;
  },

  // ─── Thoughts ───

  async getNextNumber() {
    this.thoughtCounter++;
    await this.setSetting('thoughtCounter', this.thoughtCounter);
    return this.thoughtCounter;
  },

  async createThought(thought) {
    const number = await this.getNextNumber();
    // Use smart positioning if no coordinates provided and Canvas is available
    let defaultX = 100, defaultY = 100;
    if ((!thought.x || !thought.y) && typeof Canvas !== 'undefined' && Canvas.findOpenPosition) {
      const pos = Canvas.findOpenPosition(thought.priority || 'medium');
      defaultX = pos.x;
      defaultY = pos.y;
    }
    const doc = {
      _id: thought.id || Utils.generateId(),
      number,
      content: thought.content,
      priority: thought.priority || 'medium',
      tags: thought.tags || [],
      status: thought.status || 'active',     // 'active' | 'finished' | 'dismissed'
      persistence: thought.persistence || 'persistent',  // 'persistent' | 'today' | 'until_date'
      expiresAt: thought.expiresAt || null,    // ISO date string for 'until_date' mode
      markedNow: thought.markedNow || false,   // "NOW" marker
      finishedAt: null,
      x: thought.x || defaultX,
      y: thought.y || defaultY,
      width: thought.width || 260,
      height: thought.height || null,
      createdAt: thought.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return window.electronAPI.createThought(doc);
  },

  async updateThought(id, updates) {
    updates.updatedAt = new Date().toISOString();
    return window.electronAPI.updateThought(id, updates);
  },

  async deleteThought(id) {
    return window.electronAPI.deleteThought(id);
  },

  async getThought(id) {
    return window.electronAPI.getThought(id);
  },

  async getAllThoughts() {
    return window.electronAPI.getAllThoughts();
  },

  async getActiveThoughts() {
    const all = await this.getAllThoughts();
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

    return all.filter((t) => {
      if (t.status !== 'active') return false;

      // Check expiry
      if (t.persistence === 'today') {
        const createdDay = Utils.getDayKey(t.createdAt);
        const todayKey = Utils.getDayKey(now.toISOString());
        if (createdDay !== todayKey) return false;
      }

      if (t.persistence === 'until_date' && t.expiresAt) {
        if (new Date(t.expiresAt) < now) return false;
      }

      return true;
    });
  },

  async getFinishedThoughts() {
    const all = await this.getAllThoughts();
    return all.filter((t) => t.status === 'finished');
  },

  async finishThought(id) {
    return this.updateThought(id, {
      status: 'finished',
      finishedAt: new Date().toISOString(),
    });
  },

  async dismissThought(id) {
    return this.updateThought(id, {
      status: 'dismissed',
      finishedAt: new Date().toISOString(),
    });
  },

  async restoreThought(id) {
    return this.updateThought(id, {
      status: 'active',
      finishedAt: null,
    });
  },

  async searchThoughts(query) {
    return window.electronAPI.searchThoughts(query);
  },

  // ─── Tags ───

  async createTag(tag) {
    const doc = {
      _id: tag.id || Utils.generateId(),
      name: (tag.name || '').toLowerCase(),
      color: tag.color || Utils.generateTagColor(),
      createdAt: new Date().toISOString(),
    };
    return window.electronAPI.createTag(doc);
  },

  async getAllTags() {
    return window.electronAPI.getAllTags();
  },

  async deleteTag(id) {
    return window.electronAPI.deleteTag(id);
  },

  async seedDefaultTags() {
    const defaults = [
      { name: 'work', color: Utils.tagColorPresets[0] },
      { name: 'personal', color: Utils.tagColorPresets[2] },
      { name: 'idea', color: Utils.tagColorPresets[1] },
      { name: 'urgent', color: Utils.tagColorPresets[4] },
      { name: 'later', color: Utils.tagColorPresets[3] },
    ];
    for (const tag of defaults) {
      await this.createTag(tag);
    }
  },

  // ─── Archives ───

  async createArchive(item) {
    const doc = {
      _id: item.id || Utils.generateId(),
      title: item.title || '',
      content: item.content || '',
      images: item.images || [],
      tags: item.tags || [],
      createdAt: item.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return window.electronAPI.createArchive(doc);
  },

  async updateArchive(id, updates) {
    updates.updatedAt = new Date().toISOString();
    return window.electronAPI.updateArchive(id, updates);
  },

  async deleteArchive(id) {
    return window.electronAPI.deleteArchive(id);
  },

  async getAllArchives() {
    return window.electronAPI.getAllArchives();
  },

  // ─── Notes ───

  async createNote(data) {
    return window.electronAPI.createNote(data);
  },

  async updateNote(id, updates) {
    return window.electronAPI.updateNote(id, updates);
  },

  async deleteNote(id) {
    return window.electronAPI.deleteNote(id);
  },

  async getNote(id) {
    return window.electronAPI.getNote(id);
  },

  async getAllNotes() {
    return window.electronAPI.getAllNotes();
  },

  async searchNotes(query) {
    return window.electronAPI.searchNotes(query);
  },

  // ─── Calendar ───

  async createCalendarEvent(data) {
    return window.electronAPI.createCalendarEvent(data);
  },

  async updateCalendarEvent(id, updates) {
    return window.electronAPI.updateCalendarEvent(id, updates);
  },

  async deleteCalendarEvent(id) {
    return window.electronAPI.deleteCalendarEvent(id);
  },

  async getCalendarEvent(id) {
    return window.electronAPI.getCalendarEvent(id);
  },

  async getAllCalendarEvents() {
    return window.electronAPI.getAllCalendarEvents();
  },

  async searchCalendarEvents(filters) {
    return window.electronAPI.searchCalendarEvents(filters);
  },

  async getCalendarStats() {
    return window.electronAPI.getCalendarStats();
  },

  async parseCalendarCommand(text) {
    return window.electronAPI.parseCalendarCommand(text);
  },

  async isCalendarTrigger(text) {
    return window.electronAPI.isCalendarTrigger(text);
  },

  async snoozeCalendarEvent(id, minutes) {
    return window.electronAPI.snoozeCalendarEvent(id, minutes);
  },

  async dismissCalendarNotification(id) {
    return window.electronAPI.dismissCalendarNotification(id);
  },

  // ─── Tools ───

  async createTool(item) {
    const doc = {
      _id: item.id || Utils.generateId(),
      name: item.name || 'Untitled Tool',
      path: item.path,
      color: item.color || '#6366f1',
      createdAt: item.createdAt || new Date().toISOString(),
      lastOpened: null,
    };
    return window.electronAPI.createTool(doc);
  },

  async updateTool(id, updates) {
    return window.electronAPI.updateTool(id, updates);
  },

  async deleteTool(id) {
    return window.electronAPI.deleteTool(id);
  },

  async getAllTools() {
    return window.electronAPI.getAllTools();
  },

  // ─── Workflows ───

  async createWorkflow(workflow) {
    const doc = {
      _id: workflow.id || Utils.generateId(),
      name: workflow.name || 'Untitled',
      description: workflow.description || '',
      steps: workflow.steps || [],
      createdAt: workflow.createdAt || new Date().toISOString(),
    };
    return window.electronAPI.createWorkflow(doc);
  },

  async getAllWorkflows() {
    return window.electronAPI.getAllWorkflows();
  },

  async updateWorkflow(id, updates) {
    return window.electronAPI.updateWorkflow(id, updates);
  },

  async deleteWorkflow(id) {
    return window.electronAPI.deleteWorkflow(id);
  },

  // ─── Helpers ───

  selectToolPath() {
    return window.electronAPI.selectToolPath();
  },

  openToolWindow(path, name) {
    window.electronAPI.openToolWindow(path, name);
  },

  copyImageToClipboard(base64) {
    window.electronAPI.copyImageToClipboard(base64);
  },
};

window.store = store;
