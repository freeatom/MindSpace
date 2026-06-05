/* ═══════════════════════════════════════════════════════════════
   Settings — Configuration panel with auto-save
   ═══════════════════════════════════════════════════════════════ */

const Settings = {
  cache: {},

  initialized: false,

  async init() {
    this.cache = await store.getAllSettings();
    this.applyToForm();
    if (!this.initialized) {
      this.bindEvents();
      this.initialized = true;
    }
    this.applyToApp();
  },

  applyToForm() {
    // Selects
    const dp = document.getElementById('setting-defaultPriority');
    if (dp) dp.value = this.cache.defaultPriority || 'medium';

    const dpe = document.getElementById('setting-defaultPersistence');
    if (dpe) dpe.value = this.cache.defaultPersistence || 'persistent';

    // Checkboxes
    const checkboxMap = {
      'setting-showThoughtNumbers': 'showThoughtNumbers',
      'setting-compactCards': 'compactCards',
      'setting-showFinishedOnCanvas': 'showFinishedOnCanvas',
      'setting-autoArchiveExpired': 'autoArchiveExpired',
      'setting-animationsEnabled': 'animationsEnabled',
    };

    for (const [elId, key] of Object.entries(checkboxMap)) {
      const el = document.getElementById(elId);
      if (el) el.checked = this.cache[key] !== false;
    }

    // Range
    const zoom = document.getElementById('setting-canvasZoom');
    if (zoom) {
      zoom.value = this.cache.canvasZoom || 100;
      document.getElementById('setting-canvasZoom-label').textContent = `${zoom.value}%`;
    }

    // AI Config
    const aiProvider = document.getElementById('setting-aiProvider');
    if (aiProvider) aiProvider.value = this.cache.aiProvider || 'groq';
    this.updateModelPlaceholder();

    const aiApiKey = document.getElementById('setting-aiApiKey');
    if (aiApiKey) aiApiKey.value = this.cache.aiApiKey || '';

    const aiModel = document.getElementById('setting-aiModel');
    if (aiModel) aiModel.value = this.cache.aiModel || '';
  },

  bindEvents() {
    // Auto-save selects
    document.querySelectorAll('.setting-select').forEach((el) => {
      el.addEventListener('change', () => {
        const key = el.id.replace('setting-', '');
        this.save(key, el.value);
      });
    });

    // Auto-save checkboxes
    document.querySelectorAll('.toggle-switch input').forEach((el) => {
      el.addEventListener('change', () => {
        const key = el.id.replace('setting-', '');
        this.save(key, el.checked);
      });
    });

    // Zoom range
    const zoom = document.getElementById('setting-canvasZoom');
    if (zoom) {
      zoom.addEventListener('input', () => {
        document.getElementById('setting-canvasZoom-label').textContent = `${zoom.value}%`;
        this.save('canvasZoom', parseInt(zoom.value));
        Canvas.setZoom(parseInt(zoom.value));
      });
    }

    // Change password
    const changePwBtn = document.getElementById('setting-change-password');
    if (changePwBtn) {
      changePwBtn.addEventListener('click', () => {
        this.openPasswordModal();
      });

      document.getElementById('password-close').addEventListener('click', () => {
        this.closePasswordModal();
      });

      document.getElementById('password-overlay').addEventListener('click', (e) => {
        if (e.target.id === 'password-overlay') this.closePasswordModal();
      });

      document.getElementById('pw-save').addEventListener('click', () => {
        this.savePassword();
      });
    }

    // AI Config Save
    const saveAiBtn = document.getElementById('setting-save-ai');
    if (saveAiBtn) {
      saveAiBtn.addEventListener('click', async () => {
        await this.persistAiSettings(saveAiBtn);
      });
    }

    const testAiBtn = document.getElementById('setting-test-ai');
    if (testAiBtn) {
      testAiBtn.addEventListener('click', () => this.testAiConnection());
    }

    const removeAiBtn = document.getElementById('setting-remove-ai-key');
    if (removeAiBtn) {
      removeAiBtn.addEventListener('click', () => this.removeAiKey());
    }

    const aiProviderEl = document.getElementById('setting-aiProvider');
    if (aiProviderEl) {
      aiProviderEl.addEventListener('change', () => this.updateModelPlaceholder());
    }
  },

  updateModelPlaceholder() {
    const provider = document.getElementById('setting-aiProvider')?.value || 'groq';
    const modelInput = document.getElementById('setting-aiModel');
    const placeholders = {
      groq: 'llama-3.3-70b-versatile',
      openrouter: 'google/gemini-2.0-flash-001',
      gemini: 'gemini-2.0-flash',
      openai: 'gpt-4o-mini',
    };
    if (modelInput && !modelInput.value) {
      modelInput.placeholder = placeholders[provider] || '';
    }
  },

  setAiStatus(message, isError) {
    const el = document.getElementById('setting-ai-status');
    if (!el) return;
    el.textContent = message || '';
    el.style.color = isError ? 'var(--priority-high, #ef4444)' : 'var(--text-muted)';
  },

  async persistAiSettings(btn) {
    const saveAiBtn = btn || document.getElementById('setting-save-ai');
    if (saveAiBtn) saveAiBtn.textContent = 'Saving...';
    await this.save('aiProvider', document.getElementById('setting-aiProvider').value);
    await this.save('aiApiKey', document.getElementById('setting-aiApiKey').value);
    await this.save('aiModel', document.getElementById('setting-aiModel').value);
    this.setAiStatus('Settings saved locally.');
    if (saveAiBtn) {
      setTimeout(() => {
        saveAiBtn.textContent = '✓ Saved';
        setTimeout(() => { saveAiBtn.textContent = 'Save AI Settings'; }, 2000);
      }, 300);
    }
  },

  async testAiConnection() {
    const provider = document.getElementById('setting-aiProvider').value;
    const apiKey = document.getElementById('setting-aiApiKey').value;
    const model = document.getElementById('setting-aiModel').value;
    const testBtn = document.getElementById('setting-test-ai');

    if (!apiKey?.trim()) {
      this.setAiStatus('Enter an API key first.', true);
      return;
    }

    if (testBtn) {
      testBtn.disabled = true;
      testBtn.textContent = 'Testing...';
    }
    this.setAiStatus('Validating API key...');

    try {
      await this.persistAiSettings();
      const result = await window.electronAPI.testAiConnection({ provider, apiKey, model });
      if (result.ok) {
        this.setAiStatus('Connection successful. Chat is ready.');
      } else {
        this.setAiStatus(result.error || 'Connection failed.', true);
      }
    } catch (err) {
      this.setAiStatus(err.message || 'Connection failed.', true);
    } finally {
      if (testBtn) {
        testBtn.disabled = false;
        testBtn.textContent = 'Test Connection';
      }
    }
  },

  async removeAiKey() {
    if (!confirm('Remove the stored API key? Chat and AI features will require a new key.')) return;
    document.getElementById('setting-aiApiKey').value = '';
    await this.save('aiApiKey', '');
    this.setAiStatus('API key removed.');
  },

  async save(key, value) {
    this.cache[key] = value;
    await store.setSetting(key, value);
    this.applyToApp();
  },

  applyToApp() {
    // Compact cards
    document.body.classList.toggle('compact-cards', this.cache.compactCards === true);

    // Animations
    document.body.classList.toggle('no-animations', this.cache.animationsEnabled === false);

    // Show/hide finished stack
    const finishedStack = document.getElementById('finished-stack');
    if (finishedStack) {
      finishedStack.style.display = this.cache.showFinishedOnCanvas === false ? 'none' : '';
    }
  },

  get(key) {
    return this.cache[key];
  },

  openPasswordModal() {
    document.getElementById('pw-current').value = '';
    document.getElementById('pw-new').value = '';
    document.getElementById('pw-confirm').value = '';
    document.getElementById('pw-error').textContent = '';
    document.getElementById('password-overlay').classList.add('visible');
    setTimeout(() => document.getElementById('pw-current').focus(), 100);
  },

  closePasswordModal() {
    document.getElementById('password-overlay').classList.remove('visible');
  },

  async savePassword() {
    const current = document.getElementById('pw-current').value;
    const newPw = document.getElementById('pw-new').value;
    const confirm = document.getElementById('pw-confirm').value;
    const errorEl = document.getElementById('pw-error');
    const saveBtn = document.getElementById('pw-save');
    errorEl.textContent = '';

    if (!current || !newPw || !confirm) {
      errorEl.textContent = 'All fields are required';
      return;
    }

    if (newPw.length < 4) {
      errorEl.textContent = 'New password must be at least 4 characters';
      return;
    }

    if (newPw !== confirm) {
      errorEl.textContent = 'New passwords do not match';
      return;
    }

    saveBtn.disabled = true;
    errorEl.textContent = 'Re-encrypting database...';

    try {
      await window.electronAPI.changePassword(current, newPw);
      this.closePasswordModal();
    } catch (err) {
      errorEl.textContent = err.message || 'Incorrect current password';
    } finally {
      saveBtn.disabled = false;
    }
  },
};

window.Settings = Settings;
