/**
 * MindSpace Android - Main Application
 * A mobile-first productivity app
 */

(function() {
  'use strict';

  // ═══════════════════════════════════════════════════════════
  // State Management
  // ═══════════════════════════════════════════════════════════
  
  const State = {
    thoughts: [],
    notes: [],
    events: [],
    archives: [],
    tools: [],
    settings: {
      defaultPriority: 'medium',
      animationsEnabled: true,
      aiProvider: 'groq',
      aiApiKey: '',
      aiModel: ''
    },
    currentView: 'canvas',
    editingNoteId: null,
    editingEventId: null,
    isAuthenticated: false
  };

  // ═══════════════════════════════════════════════════════════
  // Storage
  // ═══════════════════════════════════════════════════════════
  
  const Storage = {
    KEYS: {
      THOUGHTS: 'mindspace_thoughts',
      NOTES: 'mindspace_notes',
      EVENTS: 'mindspace_events',
      ARCHIVES: 'mindspace_archives',
      TOOLS: 'mindspace_tools',
      SETTINGS: 'mindspace_settings',
      AUTH: 'mindspace_auth'
    },

    get(key) {
      try {
        const data = localStorage.getItem(key);
        return data ? JSON.parse(data) : null;
      } catch (e) {
        console.error('Storage get error:', e);
        return null;
      }
    },

    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (e) {
        console.error('Storage set error:', e);
      }
    },

    init() {
      State.thoughts = this.get(this.KEYS.THOUGHTS) || [];
      State.notes = this.get(this.KEYS.NOTES) || [];
      State.events = this.get(this.KEYS.EVENTS) || [];
      State.archives = this.get(this.KEYS.ARCHIVES) || [];
      State.tools = this.get(this.KEYS.TOOLS) || [];
      const savedSettings = this.get(this.KEYS.SETTINGS);
      if (savedSettings) {
        State.settings = { ...State.settings, ...savedSettings };
      }
    },

    saveThoughts() {
      this.set(this.KEYS.THOUGHTS, State.thoughts);
    },

    saveNotes() {
      this.set(this.KEYS.NOTES, State.notes);
    },

    saveEvents() {
      this.set(this.KEYS.EVENTS, State.events);
    },

    saveArchives() {
      this.set(this.KEYS.ARCHIVES, State.archives);
    },

    saveTools() {
      this.set(this.KEYS.TOOLS, State.tools);
    },

    saveSettings() {
      this.set(this.KEYS.SETTINGS, State.settings);
    },

    saveAuth(password) {
      // Simple hash for demo - in production use proper hashing
      const hash = btoa(password);
      this.set(this.KEYS.AUTH, hash);
    },

    checkAuth(password) {
      const hash = this.get(this.KEYS.AUTH);
      if (!hash) return true; // No password set
      return btoa(password) === hash;
    },

    hasAuth() {
      return !!this.get(this.KEYS.AUTH);
    }
  };

  // ═══════════════════════════════════════════════════════════
  // Utilities
  // ═══════════════════════════════════════════════════════════
  
  const Utils = {
    generateId() {
      return Date.now().toString(36) + Math.random().toString(36).substr(2);
    },

    formatDate(date) {
      const d = new Date(date);
      const now = new Date();
      const diff = now - d;
      
      if (diff < 60000) return 'Just now';
      if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
      if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
      if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
      
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    },

    formatTime(date) {
      const d = new Date(date);
      return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    },

    formatDateTime(dateStr) {
      const d = new Date(dateStr);
      return d.toLocaleDateString('en-US', { 
        month: 'short', 
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      });
    },

    debounce(func, wait) {
      let timeout;
      return function executedFunction(...args) {
        const later = () => {
          clearTimeout(timeout);
          func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
      };
    }
  };

  // ═══════════════════════════════════════════════════════════
  // DOM Elements
  // ═══════════════════════════════════════════════════════════
  
  const DOM = {
    authScreen: null,
    appScreen: null,
    bottomNav: null,
    mainContent: null,
    fabAdd: null,
    quickaddOverlay: null,
    notesModalOverlay: null,
    calModalOverlay: null,
    searchOverlay: null,

    init() {
      this.authScreen = document.getElementById('auth-screen');
      this.appScreen = document.getElementById('app-screen');
      this.bottomNav = document.getElementById('bottom-nav');
      this.mainContent = document.getElementById('main-content');
      this.fabAdd = document.getElementById('fab-add');
      this.quickaddOverlay = document.getElementById('quickadd-overlay');
      this.notesModalOverlay = document.getElementById('notes-modal-overlay');
      this.calModalOverlay = document.getElementById('cal-modal-overlay');
      this.searchOverlay = document.getElementById('search-overlay');
    }
  };

  // ═══════════════════════════════════════════════════════════
  // Navigation
  // ═══════════════════════════════════════════════════════════
  
  function navigateTo(viewName) {
    // Update active nav item
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
      item.classList.toggle('active', item.dataset.view === viewName);
    });

    // Update content views
    const views = document.querySelectorAll('.content-view');
    views.forEach(view => {
      view.classList.toggle('active', view.id === `${viewName}-view`);
    });

    State.currentView = viewName;
  }

  // ═══════════════════════════════════════════════════════════
  // Authentication
  // ═══════════════════════════════════════════════════════════
  
  function initAuth() {
    const authForm = document.getElementById('auth-form');
    const authPassword = document.getElementById('auth-password');
    const authSubmit = document.getElementById('auth-submit');
    const authError = document.getElementById('auth-error');
    const authToggleVis = document.getElementById('auth-toggle-vis');
    const eyeIcon = document.getElementById('eye-icon');

    // Check if auth is required
    if (!Storage.hasAuth()) {
      showApp();
      return;
    }

    authToggleVis.addEventListener('click', () => {
      const isPassword = authPassword.type === 'password';
      authPassword.type = isPassword ? 'text' : 'password';
      eyeIcon.innerHTML = isPassword 
        ? '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>'
        : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
    });

    authForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const password = authPassword.value;
      
      if (Storage.checkAuth(password)) {
        State.isAuthenticated = true;
        showApp();
      } else {
        authError.textContent = 'Incorrect password';
        authPassword.value = '';
        authPassword.focus();
        
        // Haptic feedback
        if (navigator.vibrate) navigator.vibrate(100);
      }
    });
  }

  function showApp() {
    DOM.authScreen.style.display = 'none';
    DOM.appScreen.style.display = 'block';
    Storage.init();
    initApp();
  }

  function lockApp() {
    State.isAuthenticated = false;
    DOM.appScreen.style.display = 'none';
    DOM.authScreen.style.display = 'flex';
    document.getElementById('auth-password').value = '';
    document.getElementById('auth-password').focus();
  }

  // ═══════════════════════════════════════════════════════════
  // Thought Management
  // ═══════════════════════════════════════════════════════════
  
  function addThought(content, priority = 'medium', tags = [], persistence = 'persistent') {
    const thought = {
      id: Utils.generateId(),
      content,
      priority,
      tags,
      persistence,
      createdAt: new Date().toISOString(),
      finished: false
    };
    
    State.thoughts.unshift(thought);
    Storage.saveThoughts();
    renderThoughts();
    updatePriorityCounts();
  }

  function toggleThought(id) {
    const thought = State.thoughts.find(t => t.id === id);
    if (thought) {
      thought.finished = !thought.finished;
      Storage.saveThoughts();
      renderThoughts();
      updatePriorityCounts();
      renderFinishedStack();
    }
  }

  function deleteThought(id) {
    State.thoughts = State.thoughts.filter(t => t.id !== id);
    Storage.saveThoughts();
    renderThoughts();
    updatePriorityCounts();
    renderFinishedStack();
  }

  function renderThoughts() {
    const canvasContent = document.getElementById('canvas-content');
    const canvasEmpty = document.getElementById('canvas-empty');
    
    const activeThoughts = State.thoughts.filter(t => !t.finished);
    const highPriority = activeThoughts.filter(t => t.priority === 'high');
    const mediumPriority = activeThoughts.filter(t => t.priority === 'medium');
    const lowPriority = activeThoughts.filter(t => t.priority === 'low');

    let html = `
      <div class="priority-zone priority-zone-high" data-priority="high">
        <span class="zone-label">🔴 High Priority</span>
        ${highPriority.map(t => renderThoughtCard(t)).join('')}
      </div>
      <div class="priority-zone priority-zone-medium" data-priority="medium">
        <span class="zone-label">🟡 Medium Priority</span>
        ${mediumPriority.map(t => renderThoughtCard(t)).join('')}
      </div>
      <div class="priority-zone priority-zone-low" data-priority="low">
        <span class="zone-label">🟢 Low Priority</span>
        ${lowPriority.map(t => renderThoughtCard(t)).join('')}
      </div>
    `;

    canvasContent.innerHTML = html;
    canvasEmpty.style.display = activeThoughts.length ? 'none' : 'flex';

    // Attach event listeners
    canvasContent.querySelectorAll('.thought-card').forEach(card => {
      card.addEventListener('click', () => toggleThought(card.dataset.id));
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        deleteThought(card.dataset.id);
      });
    });
  }

  function renderThoughtCard(thought) {
    const tagsHtml = thought.tags.map(tag => `<span class="thought-tag">${tag}</span>`).join('');
    
    return `
      <div class="thought-card" data-id="${thought.id}" data-priority="${thought.priority}">
        <div class="thought-content">${escapeHtml(thought.content)}</div>
        <div class="thought-meta">
          <span class="thought-time">${Utils.formatDate(thought.createdAt)}</span>
          ${tagsHtml ? `<div class="thought-tags">${tagsHtml}</div>` : ''}
        </div>
      </div>
    `;
  }

  function renderFinishedStack() {
    const finishedStack = document.getElementById('finished-stack');
    const finishedList = document.getElementById('finished-list');
    const finishedCount = document.getElementById('finished-count');
    
    const finishedThoughts = State.thoughts.filter(t => t.finished);
    finishedCount.textContent = finishedThoughts.length;
    
    if (finishedThoughts.length === 0) {
      finishedStack.style.display = 'none';
      return;
    }
    
    finishedStack.style.display = 'block';
    finishedList.innerHTML = finishedThoughts.map(t => `
      <div class="thought-card" data-id="${t.id}" data-priority="${t.priority}">
        <div class="thought-content">${escapeHtml(t.content)}</div>
        <div class="thought-meta">
          <span class="thought-time">${Utils.formatDate(t.createdAt)}</span>
        </div>
      </div>
    `).join('');
    
    finishedList.querySelectorAll('.thought-card').forEach(card => {
      card.addEventListener('click', () => toggleThought(card.dataset.id));
    });
  }

  function updatePriorityCounts() {
    const active = State.thoughts.filter(t => !t.finished);
    document.getElementById('count-high').textContent = active.filter(t => t.priority === 'high').length;
    document.getElementById('count-medium').textContent = active.filter(t => t.priority === 'medium').length;
    document.getElementById('count-low').textContent = active.filter(t => t.priority === 'low').length;
  }

  // ═══════════════════════════════════════════════════════════
  // Notes Management
  // ═══════════════════════════════════════════════════════════
  
  function openNotesModal(noteId = null) {
    const modal = DOM.notesModalOverlay;
    const heading = document.getElementById('notes-modal-heading');
    const nameInput = document.getElementById('notes-modal-name');
    const contentInput = document.getElementById('notes-modal-content');
    const deleteBtn = document.getElementById('notes-modal-delete');
    
    if (noteId) {
      const note = State.notes.find(n => n.id === noteId);
      if (note) {
        heading.textContent = 'Edit Note';
        nameInput.value = note.name;
        contentInput.value = note.content;
        deleteBtn.style.display = 'block';
        State.editingNoteId = noteId;
      }
    } else {
      heading.textContent = 'New Note';
      nameInput.value = '';
      contentInput.value = '';
      deleteBtn.style.display = 'none';
      State.editingNoteId = null;
    }
    
    modal.classList.add('visible');
    nameInput.focus();
  }

  function closeNotesModal() {
    DOM.notesModalOverlay.classList.remove('visible');
    State.editingNoteId = null;
  }

  function saveNote() {
    const nameInput = document.getElementById('notes-modal-name');
    const contentInput = document.getElementById('notes-modal-content');
    
    const name = nameInput.value.trim();
    const content = contentInput.value.trim();
    
    if (!name) {
      nameInput.focus();
      return;
    }
    
    if (State.editingNoteId) {
      const note = State.notes.find(n => n.id === State.editingNoteId);
      if (note) {
        note.name = name;
        note.content = content;
        note.updatedAt = new Date().toISOString();
      }
    } else {
      const note = {
        id: Utils.generateId(),
        name,
        content,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      State.notes.unshift(note);
    }
    
    Storage.saveNotes();
    closeNotesModal();
    renderNotes();
  }

  function deleteNote(id) {
    State.notes = State.notes.filter(n => n.id !== id);
    Storage.saveNotes();
    closeNotesModal();
    renderNotes();
  }

  function renderNotes() {
    const notesList = document.getElementById('notes-list');
    const notesEmpty = document.getElementById('notes-empty');
    const searchInput = document.getElementById('notes-search');
    
    let notes = [...State.notes];
    
    // Filter by search
    if (searchInput.value) {
      const query = searchInput.value.toLowerCase();
      notes = notes.filter(n => 
        n.name.toLowerCase().includes(query) || 
        n.content.toLowerCase().includes(query)
      );
    }
    
    if (notes.length === 0) {
      notesList.style.display = 'none';
      notesEmpty.style.display = 'flex';
    } else {
      notesList.style.display = 'flex';
      notesEmpty.style.display = 'none';
      notesList.innerHTML = notes.map(note => `
        <div class="note-card" data-id="${note.id}">
          <div class="note-title">${escapeHtml(note.name)}</div>
          <div class="note-preview">${escapeHtml(note.content)}</div>
          <div class="note-date">${Utils.formatDate(note.updatedAt)}</div>
        </div>
      `).join('');
      
      notesList.querySelectorAll('.note-card').forEach(card => {
        card.addEventListener('click', () => openNotesModal(card.dataset.id));
      });
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Calendar Management
  // ═══════════════════════════════════════════════════════════
  
  function openCalModal(eventId = null) {
    const modal = DOM.calModalOverlay;
    const heading = document.getElementById('cal-modal-heading');
    const titleInput = document.getElementById('cal-event-title');
    const dateInput = document.getElementById('cal-event-date');
    const timeInput = document.getElementById('cal-event-time');
    const descInput = document.getElementById('cal-event-desc');
    const deleteBtn = document.getElementById('cal-modal-delete');
    
    // Set default date
    const today = new Date().toISOString().split('T')[0];
    
    if (eventId) {
      const event = State.events.find(e => e.id === eventId);
      if (event) {
        heading.textContent = 'Edit Event';
        titleInput.value = event.title;
        dateInput.value = event.date;
        timeInput.value = event.time;
        descInput.value = event.description || '';
        deleteBtn.style.display = 'block';
        State.editingEventId = eventId;
      }
    } else {
      heading.textContent = 'New Event';
      titleInput.value = '';
      dateInput.value = today;
      timeInput.value = '09:00';
      descInput.value = '';
      deleteBtn.style.display = 'none';
      State.editingEventId = null;
    }
    
    modal.classList.add('visible');
    titleInput.focus();
  }

  function closeCalModal() {
    DOM.calModalOverlay.classList.remove('visible');
    State.editingEventId = null;
  }

  function saveEvent() {
    const titleInput = document.getElementById('cal-event-title');
    const dateInput = document.getElementById('cal-event-date');
    const timeInput = document.getElementById('cal-event-time');
    const descInput = document.getElementById('cal-event-desc');
    const categoryInput = document.getElementById('cal-event-category');
    const priorityInput = document.getElementById('cal-event-priority');
    
    const title = titleInput.value.trim();
    
    if (!title) {
      titleInput.focus();
      return;
    }
    
    if (State.editingEventId) {
      const event = State.events.find(e => e.id === State.editingEventId);
      if (event) {
        event.title = title;
        event.date = dateInput.value;
        event.time = timeInput.value;
        event.description = descInput.value;
        event.category = categoryInput.value;
        event.priority = priorityInput.value;
      }
    } else {
      const event = {
        id: Utils.generateId(),
        title,
        date: dateInput.value,
        time: timeInput.value,
        description: descInput.value,
        category: categoryInput.value,
        priority: priorityInput.value,
        completed: false,
        createdAt: new Date().toISOString()
      };
      State.events.unshift(event);
    }
    
    Storage.saveEvents();
    closeCalModal();
    renderCalendar();
  }

  function deleteEvent(id) {
    State.events = State.events.filter(e => e.id !== id);
    Storage.saveEvents();
    closeCalModal();
    renderCalendar();
  }

  function toggleEventComplete(id) {
    const event = State.events.find(e => e.id === id);
    if (event) {
      event.completed = !event.completed;
      Storage.saveEvents();
      renderCalendar();
    }
  }

  function renderCalendar() {
    // Update stats
    const now = new Date();
    const thisMonth = now.getMonth();
    const thisYear = now.getFullYear();
    
    const monthEvents = State.events.filter(e => {
      const d = new Date(e.date);
      return d.getMonth() === thisMonth && d.getFullYear() === thisYear;
    });
    
    const upcoming = State.events.filter(e => {
      const d = new Date(e.date);
      return d >= now && !e.completed;
    });
    
    const completed = State.events.filter(e => e.completed);
    
    document.getElementById('cal-stat-total').textContent = monthEvents.length;
    document.getElementById('cal-stat-upcoming').textContent = upcoming.length;
    document.getElementById('cal-stat-completed').textContent = completed.length;
    
    // Render today events
    const todayStr = now.toISOString().split('T')[0];
    const todayEvents = State.events.filter(e => e.date === todayStr && !e.completed);
    renderEventList('cal-list-today', todayEvents);
    
    // Render upcoming events
    const upcomingEvents = upcoming.slice(0, 5);
    renderEventList('cal-list-upcoming', upcomingEvents);
    
    // Render overdue events
    const overdueEvents = State.events.filter(e => {
      const d = new Date(e.date);
      return d < now && !e.completed;
    });
    renderEventList('cal-list-overdue', overdueEvents);
    
    // Render month grid
    renderMonthGrid();
  }

  function renderEventList(elementId, events) {
    const container = document.getElementById(elementId);
    if (!container) return;
    
    if (events.length === 0) {
      container.innerHTML = '<div class="cal-event-item"><span class="cal-event-title" style="color: var(--text-muted);">No events</span></div>';
    } else {
      container.innerHTML = events.map(e => `
        <div class="cal-event-item" data-id="${e.id}">
          <span class="cal-event-time">${e.time}</span>
          <span class="cal-event-title">${escapeHtml(e.title)}</span>
        </div>
      `).join('');
      
      container.querySelectorAll('.cal-event-item').forEach(item => {
        item.addEventListener('click', () => openCalModal(item.dataset.id));
      });
    }
  }

  function renderMonthGrid() {
    const grid = document.getElementById('cal-month-grid');
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = now.getDate();
    
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    let html = dayNames.map(d => `<div class="cal-day" style="font-weight:600;color:var(--text-muted)">${d}</div>`).join('');
    
    // Empty cells before first day
    for (let i = 0; i < firstDay; i++) {
      html += '<div class="cal-day"></div>';
    }
    
    // Days of month
    for (let day = 1; day <= daysInMonth; day++) {
      const hasEvents = State.events.some(e => {
        const d = new Date(e.date);
        return d.getDate() === day && d.getMonth() === month && d.getFullYear() === year;
      });
      const isToday = day === today;
      
      html += `<div class="cal-day${isToday ? ' today' : ''}${hasEvents ? ' has-events' : ''}">${day}</div>`;
    }
    
    grid.innerHTML = html;
  }

  // ═══════════════════════════════════════════════════════════
  // Archives Management
  // ═══════════════════════════════════════════════════════════
  
  function renderArchives() {
    const grid = document.getElementById('archives-grid');
    const empty = document.getElementById('archives-empty');
    
    if (State.archives.length === 0) {
      grid.style.display = 'none';
      empty.style.display = 'flex';
    } else {
      grid.style.display = 'grid';
      empty.style.display = 'none';
      grid.innerHTML = State.archives.map(a => `
        <div class="archive-card" data-id="${a.id}">
          <div class="archive-title">${escapeHtml(a.title)}</div>
          <div class="archive-content">${escapeHtml(a.content)}</div>
        </div>
      `).join('');
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Tools Management
  // ═══════════════════════════════════════════════════════════
  
  function renderTools() {
    const grid = document.getElementById('tools-grid');
    const empty = document.getElementById('tools-empty');
    
    if (State.tools.length === 0) {
      grid.style.display = 'none';
      empty.style.display = 'flex';
    } else {
      grid.style.display = 'grid';
      empty.style.display = 'none';
      grid.innerHTML = State.tools.map(t => `
        <div class="tool-card" data-id="${t.id}">
          <div class="tool-name">${escapeHtml(t.name)}</div>
          <div class="tool-path">${escapeHtml(t.path)}</div>
        </div>
      `).join('');
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Timeline View
  // ═══════════════════════════════════════════════════════════
  
  function renderTimeline() {
    const content = document.getElementById('timeline-content');
    const empty = document.getElementById('timeline-empty');
    
    const thoughts = [...State.thoughts].sort((a, b) => 
      new Date(b.createdAt) - new Date(a.createdAt)
    );
    
    if (thoughts.length === 0) {
      content.innerHTML = '';
      empty.style.display = 'flex';
    } else {
      empty.style.display = 'none';
      content.innerHTML = thoughts.map(t => `
        <div class="timeline-item">
          <div class="timeline-dot ${t.priority}"></div>
          <div class="timeline-card">
            <div class="thought-content">${escapeHtml(t.content)}</div>
            <div class="thought-meta">
              <span class="thought-time">${Utils.formatDateTime(t.createdAt)}</span>
              ${t.finished ? '<span style="color:var(--priority-low)">✓ Finished</span>' : ''}
            </div>
          </div>
        </div>
      `).join('');
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Search
  // ═══════════════════════════════════════════════════════════
  
  function openSearch() {
    DOM.searchOverlay.classList.add('visible');
    document.getElementById('search-input').focus();
  }

  function closeSearch() {
    DOM.searchOverlay.classList.remove('visible');
    document.getElementById('search-input').value = '';
    document.getElementById('search-results').innerHTML = '';
  }

  function performSearch(query) {
    const results = document.getElementById('search-results');
    
    if (!query.trim()) {
      results.innerHTML = '';
      return;
    }
    
    const q = query.toLowerCase();
    
    // Search thoughts
    const thoughtResults = State.thoughts.filter(t => 
      t.content.toLowerCase().includes(q)
    ).slice(0, 5);
    
    // Search notes
    const noteResults = State.notes.filter(n => 
      n.name.toLowerCase().includes(q) || n.content.toLowerCase().includes(q)
    ).slice(0, 5);
    
    // Search events
    const eventResults = State.events.filter(e => 
      e.title.toLowerCase().includes(q) || (e.description && e.description.toLowerCase().includes(q))
    ).slice(0, 5);
    
    let html = '';
    
    if (thoughtResults.length) {
      html += '<h4 style="padding:8px 16px;font-size:12px;color:var(--text-muted);">Thoughts</h4>';
      thoughtResults.forEach(t => {
        html += `
          <div class="search-result-item" data-type="thought" data-id="${t.id}">
            <div class="search-result-title">${escapeHtml(t.content.substring(0, 50))}...</div>
          </div>
        `;
      });
    }
    
    if (noteResults.length) {
      html += '<h4 style="padding:8px 16px;font-size:12px;color:var(--text-muted);">Notes</h4>';
      noteResults.forEach(n => {
        html += `
          <div class="search-result-item" data-type="note" data-id="${n.id}">
            <div class="search-result-title">${escapeHtml(n.name)}</div>
            <div class="search-result-preview">${escapeHtml(n.content.substring(0, 80))}...</div>
          </div>
        `;
      });
    }
    
    if (eventResults.length) {
      html += '<h4 style="padding:8px 16px;font-size:12px;color:var(--text-muted);">Events</h4>';
      eventResults.forEach(e => {
        html += `
          <div class="search-result-item" data-type="event" data-id="${e.id}">
            <div class="search-result-title">${escapeHtml(e.title)}</div>
            <div class="search-result-preview">${e.date} at ${e.time}</div>
          </div>
        `;
      });
    }
    
    if (!html) {
      html = '<div style="padding:20px;text-align:center;color:var(--text-muted);">No results found</div>';
    }
    
    results.innerHTML = html;
    
    // Attach click handlers
    results.querySelectorAll('.search-result-item').forEach(item => {
      item.addEventListener('click', () => {
        const type = item.dataset.type;
        const id = item.dataset.id;
        closeSearch();
        
        if (type === 'note') {
          navigateTo('notes');
          setTimeout(() => openNotesModal(id), 300);
        } else if (type === 'event') {
          navigateTo('calendar');
          setTimeout(() => openCalModal(id), 300);
        } else {
          navigateTo('canvas');
          toggleThought(id);
        }
      });
    });
  }

  // ═══════════════════════════════════════════════════════════
  // Quick Add Modal
  // ═══════════════════════════════════════════════════════════
  
  function openQuickAdd() {
    DOM.quickaddOverlay.classList.add('visible');
    document.getElementById('quickadd-input').focus();
  }

  function closeQuickAdd() {
    DOM.quickaddOverlay.classList.remove('visible');
    document.getElementById('quickadd-input').value = '';
    resetQuickAddForm();
  }

  function resetQuickAddForm() {
    const inputs = document.querySelectorAll('#quickadd-overlay input, #quickadd-overlay textarea');
    inputs.forEach(input => {
      if (input.type === 'text' || input.tagName === 'TEXTAREA') {
        input.value = '';
      }
    });
    
    // Reset priority buttons
    document.querySelectorAll('.priority-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.priority === State.settings.defaultPriority);
    });
    
    // Reset persistence buttons
    document.querySelectorAll('.persist-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.persist === 'persistent');
    });
  }

  function saveQuickAdd() {
    const input = document.getElementById('quickadd-input');
    const content = input.value.trim();
    
    if (!content) {
      input.focus();
      return;
    }
    
    // Get selected priority
    const priorityBtn = document.querySelector('.quickadd-modal .priority-btn.active');
    const priority = priorityBtn ? priorityBtn.dataset.priority : State.settings.defaultPriority;
    
    // Get selected persistence
    const persistBtn = document.querySelector('.quickadd-modal .persist-btn.active');
    const persistence = persistBtn ? persistBtn.dataset.persist : 'persistent';
    
    addThought(content, priority, [], persistence);
    closeQuickAdd();
    
    if (navigator.vibrate) navigator.vibrate(50);
  }

  // ═══════════════════════════════════════════════════════════
  // Settings
  // ═══════════════════════════════════════════════════════════
  
  function initSettings() {
    // Load saved settings
    document.getElementById('setting-defaultPriority').value = State.settings.defaultPriority;
    document.getElementById('setting-animationsEnabled').checked = State.settings.animationsEnabled;
    document.getElementById('setting-aiProvider').value = State.settings.aiProvider;
    document.getElementById('setting-aiApiKey').value = State.settings.aiApiKey;
    document.getElementById('setting-aiModel').value = State.settings.aiModel;
    
    // Save AI settings
    document.getElementById('setting-save-ai').addEventListener('click', () => {
      State.settings.aiProvider = document.getElementById('setting-aiProvider').value;
      State.settings.aiApiKey = document.getElementById('setting-aiApiKey').value;
      State.settings.aiModel = document.getElementById('setting-aiModel').value;
      Storage.saveSettings();
      alert('AI settings saved!');
    });
    
    // Test AI connection
    document.getElementById('setting-test-ai').addEventListener('click', async () => {
      const btn = document.getElementById('setting-test-ai');
      btn.textContent = 'Testing...';
      btn.disabled = true;
      
      // Simulate API test
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      btn.textContent = 'Test Connection';
      btn.disabled = false;
      
      if (State.settings.aiApiKey) {
        alert('Connection successful!');
      } else {
        alert('Please enter an API key first.');
      }
    });
    
    // Default priority change
    document.getElementById('setting-defaultPriority').addEventListener('change', (e) => {
      State.settings.defaultPriority = e.target.value;
      Storage.saveSettings();
    });
    
    // Animations toggle
    document.getElementById('setting-animationsEnabled').addEventListener('change', (e) => {
      State.settings.animationsEnabled = e.target.checked;
      Storage.saveSettings();
      document.body.style.setProperty('--transition-base', e.target.checked ? '250ms' : '0ms');
    });
    
    // Change password
    document.getElementById('setting-change-password').addEventListener('click', () => {
      const newPassword = prompt('Enter new password (leave empty to remove):');
      if (newPassword !== null) {
        if (newPassword) {
          Storage.saveAuth(newPassword);
          alert('Password updated!');
        } else {
          localStorage.removeItem('mindspace_auth');
          alert('Password removed. App will not require authentication.');
        }
      }
    });
  }

  // ═══════════════════════════════════════════════════════════
  // Event Listeners
  // ═══════════════════════════════════════════════════════════
  
  function initEventListeners() {
    // Bottom navigation
    DOM.bottomNav.addEventListener('click', (e) => {
      const navItem = e.target.closest('.nav-item');
      if (navItem) {
        navigateTo(navItem.dataset.view);
      }
    });
    
    // FAB - Open quick add
    DOM.fabAdd.addEventListener('click', openQuickAdd);
    
    // Quick Add Modal
    document.getElementById('quickadd-close').addEventListener('click', closeQuickAdd);
    document.getElementById('quickadd-save').addEventListener('click', saveQuickAdd);
    document.getElementById('quickadd-ai').addEventListener('click', () => {
      // AI auto-tag functionality (placeholder)
      alert('AI Auto-Tag will analyze your thought and suggest priority & tags.');
    });
    
    // Priority buttons
    document.querySelectorAll('.quickadd-modal .priority-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.quickadd-modal .priority-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
    
    // Persistence buttons
    document.querySelectorAll('.quickadd-modal .persist-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.quickadd-modal .persist-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
    
    // Notes Modal
    document.getElementById('notes-modal-close').addEventListener('click', closeNotesModal);
    document.getElementById('notes-modal-save').addEventListener('click', saveNote);
    document.getElementById('notes-modal-delete').addEventListener('click', () => {
      if (State.editingNoteId) deleteNote(State.editingNoteId);
    });
    document.getElementById('notes-add-btn').addEventListener('click', () => openNotesModal());
    
    // Calendar Modal
    document.getElementById('cal-modal-close').addEventListener('click', closeCalModal);
    document.getElementById('cal-modal-save').addEventListener('click', saveEvent);
    document.getElementById('cal-modal-delete').addEventListener('click', () => {
      if (State.editingEventId) deleteEvent(State.editingEventId);
    });
    document.getElementById('cal-add-btn').addEventListener('click', () => openCalModal());
    
    // Calendar view tabs
    document.querySelectorAll('.cal-view-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.cal-view-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.cal-panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.querySelector(`.cal-panel[data-cal-panel="${tab.dataset.calView}"]`).classList.add('active');
      });
    });
    
    // Search
    document.getElementById('header-search-btn').addEventListener('click', openSearch);
    document.getElementById('search-close').addEventListener('click', closeSearch);
    document.getElementById('search-input').addEventListener('input', Utils.debounce((e) => {
      performSearch(e.target.value);
    }, 300));
    
    // Notes search
    document.getElementById('notes-search').addEventListener('input', Utils.debounce((e) => {
      renderNotes();
    }, 300));
    
    // Header lock button
    document.getElementById('header-lock-btn').addEventListener('click', lockApp);
    
    // Finished stack toggle
    document.getElementById('finished-toggle').addEventListener('click', () => {
      document.getElementById('finished-stack').classList.toggle('expanded');
    });
    
    // Close modals on overlay click
    [DOM.quickaddOverlay, DOM.notesModalOverlay, DOM.calModalOverlay, DOM.searchOverlay].forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          modal.classList.remove('visible');
        }
      });
    });
    
    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        DOM.quickaddOverlay.classList.remove('visible');
        DOM.notesModalOverlay.classList.remove('visible');
        DOM.calModalOverlay.classList.remove('visible');
        DOM.searchOverlay.classList.remove('visible');
      }
    });
  }

  // ═══════════════════════════════════════════════════════════
  // Initialization
  // ═══════════════════════════════════════════════════════════
  
  function initApp() {
    // Render all views
    renderThoughts();
    renderFinishedStack();
    updatePriorityCounts();
    renderNotes();
    renderCalendar();
    renderArchives();
    renderTools();
    renderTimeline();
    
    // Initialize settings
    initSettings();
    
    // Initial render
    navigateTo('canvas');
  }

  function init() {
    DOM.init();
    initAuth();
    initEventListeners();
  }

  // Start the app
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ═══════════════════════════════════════════════════════════
  // Helper Functions
  // ═══════════════════════════════════════════════════════════
  
  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

})();