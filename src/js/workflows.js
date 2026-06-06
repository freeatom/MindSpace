/* ═══════════════════════════════════════════════════════════════
   Workflows — Reusable macro sequences triggered by keyword.
   Each workflow has a name (trigger), description, and steps.
   Steps: shell | open_url | create_thought | open_tool | delay
   ═══════════════════════════════════════════════════════════════ */

const Workflows = {
  all: [],
  initialized: false,

  async init() {
    if (this.initialized) return;
    this.initialized = true;
    await this.load();
    this.renderSettings();
    this.bindSettingsEvents();
  },

  async load() {
    this.all = await store.getAllWorkflows();
  },

  // ─── Execution Engine ───

  async execute(workflow) {
    SmartActions.toast(`Running workflow: ${workflow.name}`);
    for (const step of workflow.steps) {
      try {
        await this.executeStep(step);
      } catch (e) {
        console.error(`Workflow step failed:`, step, e);
      }
    }
    SmartActions.toast(`✓ Workflow "${workflow.name}" complete`);
  },

  async executeStep(step) {
    switch (step.type) {
      case 'shell':
        await window.electronAPI.runShellCommand(step.value);
        break;
      case 'open_url':
        window.electronAPI.openExternal(step.value);
        break;
      case 'create_thought': {
        const priority = step.priority || 'medium';
        const pos = Canvas.findOpenPosition(priority);
        await store.createThought({
          _id: Utils.generateId(),
          content: step.value,
          priority,
          persistence: 'persistent',
          tags: ['workflow'],
          x: pos.x,
          y: pos.y,
          createdAt: new Date().toISOString(),
        });
        Canvas.refresh();
        break;
      }
      case 'delay':
        await new Promise((resolve) => setTimeout(resolve, parseInt(step.value) || 1000));
        break;
    }
  },

  // ─── Match & Lookup ───

  findByName(query) {
    const q = query.toLowerCase().trim();
    return this.all.filter((w) =>
      w.name.toLowerCase() === q ||
      w.name.toLowerCase().startsWith(q)
    );
  },

  findExact(name) {
    return this.all.find((w) => w.name.toLowerCase() === name.toLowerCase().trim());
  },

  // ─── Settings UI ───

  renderSettings() {
    const container = document.getElementById('workflow-list');
    if (!container) return;

    container.innerHTML = '';

    if (this.all.length === 0) {
      container.innerHTML = '<p style="color:var(--text-muted); font-size:13px;">No workflows yet. Click "Add Workflow" to create one.</p>';
      return;
    }

    this.all.forEach((wf) => {
      const card = document.createElement('div');
      card.className = 'workflow-card';
      card.innerHTML = `
        <div class="workflow-card-info">
          <div class="workflow-card-name">${this.escapeHtml(wf.name)}</div>
          <div class="workflow-card-trigger">${this.escapeHtml(wf.name)}</div>
          ${wf.description ? `<div class="workflow-card-desc">${this.escapeHtml(wf.description)}</div>` : ''}
        </div>
        <span class="workflow-card-steps">${wf.steps.length} step${wf.steps.length !== 1 ? 's' : ''}</span>
        <div class="workflow-card-actions">
          <button class="workflow-card-btn play" title="Run now">▶</button>
          <button class="workflow-card-btn edit" title="Edit">✏️</button>
          <button class="workflow-card-btn delete" title="Delete">🗑️</button>
        </div>
      `;

      card.querySelector('.play').addEventListener('click', () => this.execute(wf));
      card.querySelector('.edit').addEventListener('click', () => this.openEditor(wf));
      card.querySelector('.delete').addEventListener('click', async () => {
        if (confirm(`Delete workflow "${wf.name}"?`)) {
          await store.deleteWorkflow(wf._id);
          await this.load();
          this.renderSettings();
        }
      });

      container.appendChild(card);
    });
  },

  bindSettingsEvents() {
    const addBtn = document.getElementById('workflow-add-btn');
    if (addBtn) {
      addBtn.addEventListener('click', () => this.openEditor(null));
    }
  },

  // ─── Editor Modal ───

  openEditor(workflow) {
    const overlay = document.getElementById('workflow-editor-overlay');
    const heading = document.getElementById('workflow-editor-heading');
    const nameInput = document.getElementById('workflow-name');
    const descInput = document.getElementById('workflow-desc');
    const stepsContainer = document.getElementById('workflow-steps');

    heading.textContent = workflow ? 'Edit Workflow' : 'New Workflow';
    nameInput.value = workflow ? workflow.name : '';
    descInput.value = workflow ? workflow.description : '';

    // Store editing state
    this._editingId = workflow ? workflow._id : null;
    this._steps = workflow ? [...workflow.steps] : [];

    this.renderSteps(stepsContainer);

    overlay.classList.add('visible');
    setTimeout(() => nameInput.focus(), 100);

    // Bind buttons (clone to remove old listeners)
    const saveBtn = document.getElementById('workflow-save-btn');
    const cancelBtn = document.getElementById('workflow-cancel-btn');
    const addStepBtn = document.getElementById('workflow-add-step-btn');

    const newSave = saveBtn.cloneNode(true);
    saveBtn.parentNode.replaceChild(newSave, saveBtn);
    const newCancel = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
    const newAddStep = addStepBtn.cloneNode(true);
    addStepBtn.parentNode.replaceChild(newAddStep, addStepBtn);

    newCancel.addEventListener('click', () => {
      overlay.classList.remove('visible');
    });

    newAddStep.addEventListener('click', () => {
      this._steps.push({ type: 'shell', value: '' });
      this.renderSteps(document.getElementById('workflow-steps'));
    });

    // ─── AI Create Bindings ───
    const aiCreateBtn = document.getElementById('workflow-ai-create-btn');
    const newAiCreateBtn = aiCreateBtn.cloneNode(true);
    aiCreateBtn.parentNode.replaceChild(newAiCreateBtn, aiCreateBtn);

    const aiBox = document.getElementById('workflow-ai-box');
    const aiCloseBtn = document.getElementById('workflow-ai-close-btn');
    const aiChips = document.querySelectorAll('.workflow-ai-chip');
    const aiInput = document.getElementById('workflow-ai-input');
    
    // Reset UI
    aiBox.classList.remove('visible');
    document.getElementById('workflow-ai-result-area').style.display = 'none';
    aiInput.value = '';

    newAiCreateBtn.addEventListener('click', () => {
      aiBox.classList.toggle('visible');
    });

    aiCloseBtn.addEventListener('click', () => {
      aiBox.classList.remove('visible');
    });

    aiChips.forEach(chip => {
      const newChip = chip.cloneNode(true);
      chip.parentNode.replaceChild(newChip, chip);
      newChip.addEventListener('click', () => {
        document.getElementById('workflow-ai-result-code').textContent = newChip.dataset.script;
        document.getElementById('workflow-ai-result-area').style.display = 'block';
      });
    });

    const aiGenBtn = document.getElementById('workflow-ai-generate-btn');
    const newAiGenBtn = aiGenBtn.cloneNode(true);
    aiGenBtn.parentNode.replaceChild(newAiGenBtn, aiGenBtn);

    newAiGenBtn.addEventListener('click', async () => {
      const query = aiInput.value.trim();
      if (!query) return;

      const config = window.Commander ? Commander.getAIConfig() : null;
      if (!config) {
        SmartActions.toast('Please configure AI Provider in Settings first.');
        return;
      }

      newAiGenBtn.disabled = true;
      newAiGenBtn.textContent = '...';

      const systemPrompt = `You generate simple Windows shell commands (PowerShell).
The user wants to open an application or run a script.
Output ONLY the raw command, nothing else. No markdown wrapping.
Examples: 
- code .
- start spotify:
- start msteams:`;

      try {
        const messages = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: query }
        ];
        
        const response = await window.electronAPI.aiQuery({
          provider: config.provider,
          apiKey: config.apiKey,
          model: config.model,
          messages
        });

        const script = response?.choices?.[0]?.message?.content || response?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        
        // Strip markdown backticks if any
        let cleanScript = script.replace(/```[\s\S]*?\n/g, '').replace(/```/g, '').trim();

        document.getElementById('workflow-ai-result-code').textContent = cleanScript;
        document.getElementById('workflow-ai-result-area').style.display = 'block';
      } catch (err) {
        SmartActions.toast('AI Error: ' + err.message);
      } finally {
        newAiGenBtn.disabled = false;
        newAiGenBtn.textContent = 'Ask AI';
      }
    });

    const aiTestBtn = document.getElementById('workflow-ai-test-btn');
    const newAiTestBtn = aiTestBtn.cloneNode(true);
    aiTestBtn.parentNode.replaceChild(newAiTestBtn, aiTestBtn);

    newAiTestBtn.addEventListener('click', async () => {
      const script = document.getElementById('workflow-ai-result-code').textContent;
      if (!script) return;
      newAiTestBtn.textContent = '...';
      try {
        await window.electronAPI.runShellCommand(script);
        newAiTestBtn.textContent = '✓ Sent';
        setTimeout(() => newAiTestBtn.textContent = 'Test', 1500);
      } catch (e) {
        newAiTestBtn.textContent = '✗ Error';
        setTimeout(() => newAiTestBtn.textContent = 'Test', 1500);
      }
    });

    const aiUseBtn = document.getElementById('workflow-ai-use-btn');
    const newAiUseBtn = aiUseBtn.cloneNode(true);
    aiUseBtn.parentNode.replaceChild(newAiUseBtn, aiUseBtn);

    newAiUseBtn.addEventListener('click', () => {
      const script = document.getElementById('workflow-ai-result-code').textContent;
      if (!script) return;
      
      this._steps.push({ type: 'shell', value: script });
      this.renderSteps(document.getElementById('workflow-steps'));
      
      aiBox.classList.remove('visible');
    });

    newSave.addEventListener('click', async () => {
      const name = document.getElementById('workflow-name').value.trim();
      if (!name) {
        SmartActions.toast('Workflow needs a name/trigger keyword');
        return;
      }

      // Read current step values from the DOM
      this.readStepsFromDOM();

      const data = {
        name,
        description: document.getElementById('workflow-desc').value.trim(),
        steps: this._steps.filter((s) => s.value.trim()),
      };

      if (this._editingId) {
        await store.updateWorkflow(this._editingId, data);
      } else {
        await store.createWorkflow(data);
      }

      await this.load();
      this.renderSettings();
      overlay.classList.remove('visible');
      SmartActions.toast(`Workflow "${name}" saved!`);
    });
  },

  renderSteps(container) {
    container.innerHTML = '';
    this._steps.forEach((step, i) => {
      const row = document.createElement('div');
      row.className = 'workflow-step';
      row.dataset.index = i;
      row.innerHTML = `
        <span class="workflow-step-num">${i + 1}</span>
        <select class="workflow-step-type" data-index="${i}">
          <option value="shell" ${step.type === 'shell' ? 'selected' : ''}>⚡ Shell</option>
          <option value="open_url" ${step.type === 'open_url' ? 'selected' : ''}>🌐 Open URL</option>
          <option value="create_thought" ${step.type === 'create_thought' ? 'selected' : ''}>💭 Create Thought</option>
          <option value="delay" ${step.type === 'delay' ? 'selected' : ''}>⏱️ Delay (ms)</option>
        </select>
        <input type="text" class="workflow-step-value" data-index="${i}" value="${this.escapeHtml(step.value)}"
          placeholder="${this.getPlaceholder(step.type)}" />
        <button class="workflow-step-remove" data-index="${i}">✕</button>
      `;

      // Update type change
      row.querySelector('select').addEventListener('change', (e) => {
        this._steps[i].type = e.target.value;
        row.querySelector('input').placeholder = this.getPlaceholder(e.target.value);
      });

      // Update value change
      row.querySelector('input').addEventListener('input', (e) => {
        this._steps[i].value = e.target.value;
      });

      // Remove step
      row.querySelector('.workflow-step-remove').addEventListener('click', () => {
        this._steps.splice(i, 1);
        this.renderSteps(container);
      });

      container.appendChild(row);
    });
  },

  readStepsFromDOM() {
    document.querySelectorAll('.workflow-step').forEach((row) => {
      const idx = parseInt(row.dataset.index);
      if (this._steps[idx]) {
        this._steps[idx].type = row.querySelector('select').value;
        this._steps[idx].value = row.querySelector('input').value;
      }
    });
  },

  getPlaceholder(type) {
    const p = {
      shell: 'e.g. code . or npm start',
      open_url: 'e.g. https://localhost:3000',
      create_thought: 'e.g. Start today\'s sprint',
      delay: 'e.g. 2000',
    };
    return p[type] || '';
  },

  escapeHtml(text) {
    if (!text) return '';
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },
};

window.Workflows = Workflows;
