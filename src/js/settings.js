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

    // ─── AI Chat Config ───
    const aiProvider = document.getElementById('setting-aiProvider');
    if (aiProvider) aiProvider.value = this.cache.aiProvider || 'groq';
    this.updateModelPlaceholder();

    const aiApiKey = document.getElementById('setting-aiApiKey');
    if (aiApiKey) aiApiKey.value = this.cache.aiApiKey || '';

    const aiApiKeySecondary = document.getElementById('setting-aiApiKeySecondary');
    if (aiApiKeySecondary) aiApiKeySecondary.value = this.cache.aiApiKeySecondary || '';

    const activeKeyIndex = this.cache.aiActiveKeyIndex || 0;
    const radios = document.querySelectorAll('input[name="setting-aiActiveKeyIndex"]');
    radios.forEach(r => r.checked = (parseInt(r.value) === activeKeyIndex));

    const aiModel = document.getElementById('setting-aiModel');
    if (aiModel) aiModel.value = this.cache.aiModel || '';

    const autoFallback = document.getElementById('setting-aiAutoFallback');
    if (autoFallback) autoFallback.checked = this.cache.aiAutoFallback === true;

    // ─── Whispr Config ───
    const whisprApiKey = document.getElementById('setting-whisprApiKey');
    if (whisprApiKey) whisprApiKey.value = this.cache.whisprApiKey || '';

    const aiWhisprModel = document.getElementById('setting-aiWhisprModel');
    if (aiWhisprModel) aiWhisprModel.value = this.cache.aiWhisprModel || '';
  },

  bindEvents() {
    // Auto-save selects
    document.querySelectorAll('.setting-select').forEach((el) => {
      el.addEventListener('change', () => {
        const key = el.id.replace('setting-', '');
        this.save(key, el.value);
      });
    });

    // Auto-save checkboxes (excluding AI-specific ones handled separately)
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

    // ─── AI Chat Config Events ───
    const saveAiBtn = document.getElementById('setting-save-ai');
    if (saveAiBtn) {
      saveAiBtn.addEventListener('click', async () => {
        await this.persistChatSettings(saveAiBtn);
      });
    }

    const testAiBtn = document.getElementById('setting-test-ai');
    if (testAiBtn) {
      testAiBtn.addEventListener('click', () => this.testChatConnection());
    }

    const removeAiBtn = document.getElementById('setting-remove-ai-key');
    if (removeAiBtn) {
      removeAiBtn.addEventListener('click', () => this.removeChatKeys());
    }

    const aiProviderEl = document.getElementById('setting-aiProvider');
    if (aiProviderEl) {
      aiProviderEl.addEventListener('change', () => this.updateModelPlaceholder());
    }

    document.querySelectorAll('input[name="setting-aiActiveKeyIndex"]').forEach(el => {
      el.addEventListener('change', () => {
        this.save('aiActiveKeyIndex', parseInt(el.value));
      });
    });

    // ─── Whispr Config Events ───
    const saveWhisprBtn = document.getElementById('setting-save-whispr');
    if (saveWhisprBtn) {
      saveWhisprBtn.addEventListener('click', async () => {
        await this.persistWhisprSettings(saveWhisprBtn);
      });
    }

    const testWhisprBtn = document.getElementById('setting-test-whispr');
    if (testWhisprBtn) {
      testWhisprBtn.addEventListener('click', () => this.testWhisprConnection());
    }

    const removeWhisprBtn = document.getElementById('setting-remove-whispr-key');
    if (removeWhisprBtn) {
      removeWhisprBtn.addEventListener('click', () => this.removeWhisprKey());
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

  setWhisprStatus(message, isError) {
    const el = document.getElementById('setting-whispr-status');
    if (!el) return;
    el.textContent = message || '';
    el.style.color = isError ? 'var(--priority-high, #ef4444)' : 'var(--text-muted)';
  },

  // ─── Chat Settings ───

  async persistChatSettings(btn) {
    const saveBtn = btn || document.getElementById('setting-save-ai');
    if (saveBtn) saveBtn.textContent = 'Saving...';

    await this.save('aiProvider', document.getElementById('setting-aiProvider').value);
    await this.save('aiApiKey', document.getElementById('setting-aiApiKey').value);
    await this.save('aiApiKeySecondary', document.getElementById('setting-aiApiKeySecondary')?.value || '');
    await this.save('aiModel', document.getElementById('setting-aiModel').value);

    const autoFallback = document.getElementById('setting-aiAutoFallback');
    if (autoFallback) await this.save('aiAutoFallback', autoFallback.checked);

    const activeRadio = document.querySelector('input[name="setting-aiActiveKeyIndex"]:checked');
    if (activeRadio) await this.save('aiActiveKeyIndex', parseInt(activeRadio.value));

    this.setAiStatus('Chat settings saved locally.');
    if (saveBtn) {
      setTimeout(() => {
        saveBtn.textContent = '✓ Saved';
        setTimeout(() => { saveBtn.textContent = 'Save Chat Settings'; }, 2000);
      }, 300);
    }
  },

  async testChatConnection() {
    const provider = document.getElementById('setting-aiProvider').value;
    const model = document.getElementById('setting-aiModel').value;
    const testBtn = document.getElementById('setting-test-ai');

    const primaryKey = document.getElementById('setting-aiApiKey').value;
    const secondaryKey = document.getElementById('setting-aiApiKeySecondary')?.value || '';
    const activeRadio = document.querySelector('input[name="setting-aiActiveKeyIndex"]:checked');
    const activeIndex = activeRadio ? parseInt(activeRadio.value) : 0;
    
    const apiKey = (activeIndex === 1 && secondaryKey.trim()) ? secondaryKey : primaryKey;

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
      await this.persistChatSettings();
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

  async removeChatKeys() {
    if (!confirm('Remove the stored Chat API keys? Chat and AI features will require new keys.')) return;
    document.getElementById('setting-aiApiKey').value = '';
    document.getElementById('setting-aiApiKeySecondary').value = '';
    await this.save('aiApiKey', '');
    await this.save('aiApiKeySecondary', '');
    this.setAiStatus('Chat API keys removed.');
  },

  // ─── Whispr Settings ───

  async persistWhisprSettings(btn) {
    const saveBtn = btn || document.getElementById('setting-save-whispr');
    if (saveBtn) saveBtn.textContent = 'Saving...';

    await this.save('whisprApiKey', document.getElementById('setting-whisprApiKey')?.value || '');
    await this.save('aiWhisprModel', document.getElementById('setting-aiWhisprModel')?.value || '');

    this.setWhisprStatus('Whispr settings saved locally.');
    if (saveBtn) {
      setTimeout(() => {
        saveBtn.textContent = '✓ Saved';
        setTimeout(() => { saveBtn.textContent = 'Save Whispr Settings'; }, 2000);
      }, 300);
    }
  },

  async testWhisprConnection() {
    const testBtn = document.getElementById('setting-test-whispr');
    const whisprKey = document.getElementById('setting-whisprApiKey')?.value || '';

    // Resolve the key: use dedicated Whispr key, or fall back to active Chat key
    let apiKey = whisprKey.trim();
    if (!apiKey) {
      const primaryKey = document.getElementById('setting-aiApiKey')?.value || '';
      const secondaryKey = document.getElementById('setting-aiApiKeySecondary')?.value || '';
      const activeRadio = document.querySelector('input[name="setting-aiActiveKeyIndex"]:checked');
      const activeIndex = activeRadio ? parseInt(activeRadio.value) : 0;
      apiKey = (activeIndex === 1 && secondaryKey.trim()) ? secondaryKey : primaryKey;
    }

    if (!apiKey?.trim()) {
      this.setWhisprStatus('Enter a Whispr API key or Chat API key first.', true);
      return;
    }

    if (testBtn) {
      testBtn.disabled = true;
      testBtn.textContent = 'Testing...';
    }
    this.setWhisprStatus('Validating Whispr key with Groq...');

    try {
      await this.persistWhisprSettings();
      const result = await window.electronAPI.testWhisprConnection({ apiKey });
      if (result.ok) {
        this.setWhisprStatus('Whispr connection successful. Speech-to-text is ready.');
      } else {
        this.setWhisprStatus(result.error || 'Whispr test failed.', true);
      }
    } catch (err) {
      this.setWhisprStatus(err.message || 'Whispr test failed.', true);
    } finally {
      if (testBtn) {
        testBtn.disabled = false;
        testBtn.textContent = 'Test Whispr';
      }
    }
  },

  async removeWhisprKey() {
    if (!confirm('Remove the Whispr API key? Speech-to-text will fall back to using the Chat key.')) return;
    const el = document.getElementById('setting-whisprApiKey');
    if (el) el.value = '';
    await this.save('whisprApiKey', '');
    this.setWhisprStatus('Whispr API key removed. Will use Chat key as fallback.');
  },

  // ─── Core ───

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

  /** Resolve the active Chat API key (respecting primary/secondary selection) */
  getActiveChatApiKey() {
    const primaryKey = this.cache.aiApiKey || '';
    const secondaryKey = this.cache.aiApiKeySecondary || '';
    const activeIndex = this.cache.aiActiveKeyIndex || 0;
    return (activeIndex === 1 && secondaryKey.trim()) ? secondaryKey : primaryKey;
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
