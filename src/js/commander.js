/* ═══════════════════════════════════════════════════════════════
   Commander — AI-powered command palette (Ctrl+K).
   Supports OpenRouter, Groq, and Gemini APIs.
   ═══════════════════════════════════════════════════════════════ */

const Commander = {
  isOpen: false,
  initialized: false,

  init() {
    if (this.initialized) return;
    this.initialized = true;
    this.bindEvents();
  },

  bindEvents() {
    const overlay = document.getElementById('commander-overlay');
    const input = document.getElementById('commander-input');
    const closeBtn = document.getElementById('commander-close');

    closeBtn.addEventListener('click', () => this.close());
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.close();
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.execute();
      }
      if (e.key === 'Escape') this.close();
    });

    input.addEventListener('input', () => {
      this.handleInput();
    });
  },

  open() {
    const overlay = document.getElementById('commander-overlay');
    const input = document.getElementById('commander-input');
    const results = document.getElementById('commander-results');

    results.innerHTML = '';
    input.value = '';
    overlay.style.display = 'flex';
    setTimeout(() => overlay.classList.add('visible'), 10);
    this.isOpen = true;
    input.focus();
  },

  close() {
    const overlay = document.getElementById('commander-overlay');
    overlay.classList.remove('visible');
    setTimeout(() => overlay.style.display = 'none', 200);
    this.isOpen = false;
  },

  handleInput() {
    if (!window.Workflows) return;
    const input = document.getElementById('commander-input');
    const results = document.getElementById('commander-results');
    const query = input.value.trim();
    
    if (!query) {
      results.innerHTML = '';
      return;
    }

    if (window.store && store.isCalendarTrigger) {
      store.isCalendarTrigger(query).then((isCal) => {
        if (isCal && query === input.value.trim()) {
          results.innerHTML = `
            <div class="commander-workflow-match" style="cursor:pointer" id="commander-cal-hint">
              <span class="wf-icon">📅</span>
              <span class="wf-name">Create calendar event</span>
              <span class="wf-desc">— "${Workflows.escapeHtml(query)}"</span>
              <span class="wf-hint">Press Enter to open</span>
            </div>`;
          document.getElementById('commander-cal-hint')?.addEventListener('click', () => this.execute());
        }
      });
    }

    // If they type just '/', show all workflows!
    const matches = query === '/' ? Workflows.all : Workflows.findByName(query.replace(/^\//, ''));
    
    if (matches.length > 0) {
      let html = '';
      if (query === '/') {
        html += '<div style="padding: 8px 12px; font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase;">Available Workflows</div>';
      }
      
      matches.forEach((wf) => {
        html += `
          <div class="commander-workflow-match" data-id="${wf._id}">
            <span class="wf-icon">⚡</span>
            <span class="wf-name">${Workflows.escapeHtml(wf.name)}</span>
            ${wf.description ? `<span class="wf-desc">— ${Workflows.escapeHtml(wf.description)}</span>` : ''}
            <span class="wf-hint">Press Enter to run</span>
          </div>
        `;
      });
      results.innerHTML = html;

      // Allow clicking the match
      results.querySelectorAll('.commander-workflow-match').forEach((el) => {
        el.addEventListener('click', () => {
          const wf = Workflows.all.find(w => w._id === el.dataset.id);
          if (wf) {
            Workflows.execute(wf);
            this.close();
          }
        });
      });
    } else if (results.innerHTML.includes('commander-workflow-match')) {
      // Clear if there are no matches but old ones are showing
      results.innerHTML = '';
    }
  },

  async execute() {
    const input = document.getElementById('commander-input');
    const results = document.getElementById('commander-results');
    const query = input.value.trim();
    if (!query) return;

    const isCal = await store.isCalendarTrigger(query);
    if (isCal) {
      const prefill = await store.parseCalendarCommand(query);
      this.close();
      App.switchView('calendar');
      Calendar.openModal(null, prefill);
      return;
    }

    // Check for exact workflow match first
    if (window.Workflows) {
      const exactMatch = Workflows.findExact(query);
      if (exactMatch) {
        Workflows.execute(exactMatch);
        this.close();
        return;
      }
    }

    // Show loading
    results.innerHTML = '<div class="commander-loading"><div class="commander-spinner"></div> Thinking...</div>';

    const config = this.getAIConfig();
    if (!config) {
      results.innerHTML = '<div class="commander-error">⚠️ No AI provider configured. Go to Settings → AI Configuration.</div>';
      return;
    }

    const systemPrompt = `You are MindSpace Commander, an AI assistant integrated into a desktop productivity app on Windows.
You help the user control their PC, manage tasks, and find information.

You MUST respond with valid JSON only. No markdown, no explanation outside JSON.

Response format:
{
  "type": "action" | "answer" | "confirm",
  "message": "Brief description of what you're doing",
  "actions": [
    {
      "type": "shell" | "open_url" | "create_thought" | "create_archive" | "info",
      "command": "the shell command to run (for shell type)",
      "url": "URL to open (for open_url type)",
      "content": "content text (for create_thought/create_archive)",
      "priority": "high/medium/low (for create_thought)",
      "title": "title (for create_archive)",
      "info": "information text (for info type)"
    }
  ]
}

Available action types:
- "shell": Run a PowerShell command on Windows
- "open_url": Open a URL in the default browser
- "create_thought": Create a new thought in MindSpace Canvas
- "create_archive": Save something to MindSpace Archives
- "info": Just display information to the user

Always prefer safe, non-destructive commands. For dangerous operations, use type "confirm".
The user's OS is Windows. Use PowerShell commands.`;

    try {
      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: query },
      ];

      const response = await window.electronAPI.aiQuery({
        provider: config.provider,
        apiKey: config.apiKey,
        model: config.model,
        messages,
      });

      const text = this.extractResponseText(response, config.provider);
      this.handleResponse(text, results);
    } catch (err) {
      results.innerHTML = `<div class="commander-error">⚠️ ${err.message}</div>`;
    }
  },

  extractResponseText(response, provider) {
    if (provider === 'gemini') {
      return response?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }
    // OpenAI-compatible (OpenRouter, Groq)
    return response?.choices?.[0]?.message?.content || '';
  },

  handleResponse(text, resultsEl) {
    let data;
    try {
      // Try to extract JSON from the response (in case there's markdown wrapping)
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      data = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    } catch (e) {
      // Not JSON — just display as text
      resultsEl.innerHTML = `<div class="commander-answer">${this.escapeHtml(text)}</div>`;
      return;
    }

    let html = '';
    if (data.message) {
      html += `<div class="commander-message">${this.escapeHtml(data.message)}</div>`;
    }

    if (data.actions && data.actions.length > 0) {
      data.actions.forEach((action, i) => {
        html += this.renderAction(action, i);
      });
    }

    resultsEl.innerHTML = html;

    // Bind action buttons
    resultsEl.querySelectorAll('.commander-action-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index);
        this.executeAction(data.actions[idx], btn);
      });
    });
  },

  renderAction(action, index) {
    const icons = {
      shell: '⚡',
      open_url: '🌐',
      create_thought: '💭',
      create_archive: '📦',
      info: 'ℹ️',
    };

    const icon = icons[action.type] || '▶';
    let detail = '';

    if (action.type === 'shell') detail = `<code>${this.escapeHtml(action.command)}</code>`;
    else if (action.type === 'open_url') detail = `<span class="commander-url">${this.escapeHtml(action.url)}</span>`;
    else if (action.type === 'create_thought') detail = this.escapeHtml(action.content);
    else if (action.type === 'create_archive') detail = this.escapeHtml(action.title || action.content);
    else if (action.type === 'info') detail = this.escapeHtml(action.info);

    return `
      <div class="commander-action">
        <div class="commander-action-info">
          <span class="commander-action-icon">${icon}</span>
          <span class="commander-action-detail">${detail}</span>
        </div>
        ${action.type !== 'info' ? `<button class="commander-action-btn" data-index="${index}">Run</button>` : ''}
      </div>
    `;
  },

  async executeAction(action, btn) {
    btn.disabled = true;
    btn.textContent = '...';

    try {
      switch (action.type) {
        case 'shell': {
          const result = await window.electronAPI.runShellCommand(action.command);
          btn.textContent = result.success ? '✓ Done' : '✗ Error';
          if (result.stdout) {
            const output = document.createElement('pre');
            output.className = 'commander-output';
            output.textContent = result.stdout.substring(0, 500);
            btn.parentElement.parentElement.appendChild(output);
          }
          break;
        }
        case 'open_url':
          window.electronAPI.openExternal(action.url);
          btn.textContent = '✓ Opened';
          break;
        case 'create_thought': {
          const priority = action.priority || 'medium';
          const pos = Canvas.findOpenPosition(priority);
          await store.createThought({
            _id: Utils.generateId(),
            content: action.content,
            priority,
            persistence: 'persistent',
            tags: ['commander'],
            x: pos.x,
            y: pos.y,
            createdAt: new Date().toISOString(),
          });
          Canvas.thoughts.push({
            x: pos.x, y: pos.y,
            width: 260, priority,
            content: action.content,
          });
          btn.textContent = '✓ Created';
          Canvas.refresh();
          break;
        }
        case 'create_archive':
          await store.createArchive({
            title: action.title || action.content?.substring(0, 50),
            content: action.content || '',
            images: [],
            tags: ['commander'],
          });
          btn.textContent = '✓ Archived';
          break;
      }
    } catch (err) {
      btn.textContent = '✗ Error';
    }
  },

  getAIConfig() {
    const provider = Settings.cache.aiProvider;
    const apiKey = Settings.cache.aiApiKey;
    const model = Settings.cache.aiModel;
    if (!provider || !apiKey) return null;
    return { provider, apiKey, model: model || this.getDefaultModel(provider) };
  },

  getDefaultModel(provider) {
    const defaults = {
      openrouter: 'google/gemini-2.0-flash-001',
      groq: 'llama-3.3-70b-versatile',
      gemini: 'gemini-2.0-flash',
      openai: 'gpt-4o-mini',
    };
    return defaults[provider] || 'gpt-3.5-turbo';
  },

  escapeHtml(text) {
    if (!text) return '';
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },
};

window.Commander = Commander;
