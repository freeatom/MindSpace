/* ═══════════════════════════════════════════════════════════════
   App — Main application initialization & view routing
   ═══════════════════════════════════════════════════════════════ */

const App = {
  currentView: 'canvas',
  initialized: false,

  async init() {
    if (this.initialized) return;
    this.initialized = true;

    // Start clock immediately so it doesn't get blocked by other async initialization
    this.startClock();

    // Initialize modules
    await Settings.init();
    await Tags.init();
    await Canvas.init();
    await Timeline.init();
    await Archives.init();
    await Notes.init();
    await Calendar.init();
    await Tools.init();
    QuickAdd.init();
    SmartActions.init();
    
    // New Modules
    if (window.ClipboardMgr) await ClipboardMgr.init();
    if (window.Commander) Commander.init();
    if (window.BrainDump) BrainDump.init();
    if (window.Workflows) await Workflows.init();

    this.bindNavigation();
    this.bindKeyboardShortcuts();
    this.bindSpotlight();
  },

  bindSpotlight() {
    window.electronAPI.onSpotlightThought(async (data) => {
      // Frictionless trigger: check if it exactly matches a workflow first
      if (window.Workflows && data.content) {
        const wf = Workflows.findExact(data.content);
        if (wf) {
          Workflows.execute(wf);
          return; // Skip saving as a thought
        }
      }

      const priority = data.priority || 'medium';
      const pos = Canvas.findOpenPosition(priority);
      const newThought = await store.createThought({
        _id: Utils.generateId(),
        content: data.content,
        priority,
        persistence: data.persistence || 'persistent',
        tags: data.tags || ['spotlight'],
        x: pos.x,
        y: pos.y,
        createdAt: new Date().toISOString(),
      });
      if (window.Canvas && Canvas.initialized) {
        Canvas.addCard(newThought);
      }
      if (window.Timeline && typeof Timeline.render === 'function') {
        Timeline.render();
      }
      SmartActions.toast('Thought captured from Spotlight');
    });

    window.electronAPI.onSpotlightArchive(async (data) => {
      await store.createArchive({
        title: data.title,
        content: data.content,
        images: data.images,
        tags: data.tags,
      });
      if (this.currentView === 'archives') Archives.refresh();
      SmartActions.toast('Archived from Spotlight!');
    });

    if (window.electronAPI.onSpotlightWorkflow) {
      window.electronAPI.onSpotlightWorkflow((name) => {
        if (window.Workflows) {
          const wf = Workflows.findExact(name);
          if (wf) {
            Workflows.execute(wf);
          } else {
            SmartActions.toast(`Workflow "${name}" not found`);
          }
        }
      });
    }
  },

  bindNavigation() {
    // Sidebar navigation
    document.querySelectorAll('.sidebar-btn[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.switchView(btn.dataset.view);
      });
    });

    // Lock button
    document.getElementById('nav-lock').addEventListener('click', () => {
      Auth.lock();
    });
  },

  switchView(viewName) {
    this.currentView = viewName;

    // Update sidebar buttons
    document.querySelectorAll('.sidebar-btn[data-view]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === viewName);
    });

    // Update content views
    document.querySelectorAll('.content-view').forEach((view) => {
      view.classList.remove('active');
    });

    const targetView = document.getElementById(`${viewName}-view`);
    if (targetView) {
      targetView.classList.add('active');
      targetView.style.animation = 'fadeIn 0.25s ease';
    }

    // Update topbar title
    const titles = {
      canvas: 'Canvas',
      timeline: 'Timeline',
      archives: 'Archives',
      notes: 'Notes',
      calendar: 'Calendar',
      tools: 'Tools',
      settings: 'Settings',
    };
    document.getElementById('topbar-title').textContent = titles[viewName] || viewName;

    // Show/hide zoom controls (canvas only)
    const zoomControls = document.getElementById('zoom-controls');
    zoomControls.style.display = viewName === 'canvas' ? 'flex' : 'none';

    // Show/hide FAB (only on canvas and timeline)
    const fab = document.getElementById('fab-add');
    fab.style.display = (viewName === 'canvas' || viewName === 'timeline') ? '' : 'none';

    // Refresh timeline when switching to it
    if (viewName === 'timeline') {
      Timeline.refresh();
    }

    // Refresh archives when switching to it
    if (viewName === 'archives') {
      Archives.refresh();
    }

    if (viewName === 'notes') {
      Notes.refresh();
    }

    if (viewName === 'calendar') {
      Calendar.refresh();
    }

    // Refresh tools when switching to it
    if (viewName === 'tools') {
      Tools.refresh();
    }

    // Refresh clipboard when switching to it
    if (viewName === 'clipboard' && window.ClipboardMgr) {
      ClipboardMgr.render();
    }
  },

  bindKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Ctrl+K — Commander
      if (e.ctrlKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (window.Commander) Commander.open();
      }

      // Ctrl+N — Quick Add
      if (e.ctrlKey && e.key === 'n') {
        e.preventDefault();
        QuickAdd.open();
      }

      // Ctrl+T — Toggle Canvas / Timeline
      if (e.ctrlKey && e.key === 't') {
        e.preventDefault();
        this.switchView(this.currentView === 'canvas' ? 'timeline' : 'canvas');
      }

      // Ctrl+F — Focus search
      if (e.ctrlKey && e.key === 'f') {
        e.preventDefault();
        document.getElementById('search-input').focus();
      }

      // Ctrl+B — Archives
      if (e.ctrlKey && e.key === 'b') {
        e.preventDefault();
        this.switchView('archives');
      }

      // Escape — Close modals
      if (e.key === 'Escape') {
        if (QuickAdd.isOpen) {
          QuickAdd.close();
        } else if (document.getElementById('cal-modal-overlay')?.classList.contains('visible')) {
          Calendar.closeModal();
        } else if (document.getElementById('tools-iframe-container')?.classList.contains('visible')) {
          Tools.closeIframe();
        } else {
          Canvas.closeEditModal();
          Settings.closePasswordModal();
        }
      }

      // Ctrl+L — Lock
      if (e.ctrlKey && e.key === 'l') {
        e.preventDefault();
        Auth.lock();
      }

      // F11 — Fullscreen
      if (e.key === 'F11') {
        e.preventDefault();
        window.electronAPI.toggleFullscreen();
      }

      // Ctrl+= — Zoom In
      if (e.ctrlKey && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        Canvas.setZoom(Canvas.zoomLevel + 10);
      }

      // Ctrl+- — Zoom Out
      if (e.ctrlKey && e.key === '-') {
        e.preventDefault();
        Canvas.setZoom(Canvas.zoomLevel - 10);
      }

      // Ctrl+0 — Reset Zoom
      if (e.ctrlKey && e.key === '0') {
        e.preventDefault();
        Canvas.setZoom(100);
      }
    });
  },

  bindWindowControls() {
    document.getElementById('btn-minimize').addEventListener('click', () => {
      window.electronAPI.minimize();
    });

    document.getElementById('btn-maximize').addEventListener('click', () => {
      window.electronAPI.maximize();
    });

    document.getElementById('btn-close').addEventListener('click', () => {
      window.electronAPI.close();
    });

    document.getElementById('btn-fullscreen').addEventListener('click', () => {
      window.electronAPI.toggleFullscreen();
    });
  },

  startClock() {
    const clockEl = document.getElementById('titlebar-clock');
    if (!clockEl) return;
    
    const update = () => {
      const now = new Date();
      
      const dateOpts = { weekday: 'short', month: 'short', day: 'numeric' };
      const dateStr = now.toLocaleDateString(undefined, dateOpts);
      
      const timeOpts = { hour: 'numeric', minute: '2-digit', second: '2-digit' };
      const timeStr = now.toLocaleTimeString(undefined, timeOpts);
      
      clockEl.innerHTML = `<span>${dateStr}</span> <span style="opacity:0.4; margin: 0 4px;">|</span> <span>${timeStr}</span>`;
    };
    
    update();
    setInterval(update, 1000);
  }
};

// ─── Bootstrap ───
document.addEventListener('DOMContentLoaded', async () => {
  try {
    App.bindWindowControls();
    await store.init();
    await Auth.init();
  } catch (err) {
    console.error('Failed to initialize MindSpace:', err);
  }
});

window.App = App;
