/* ═══════════════════════════════════════════════════════════════
   Notes — Save, view, edit, search, and manage persistent notes
   ═══════════════════════════════════════════════════════════════ */

const Notes = {
  items: [],
  initialized: false,
  editingId: null,
  dateFilter: 'all',

  isInternalNote(note) {
    return note.name === '__spotlight_draft__';
  },

  async init() {
    if (this.initialized) return;
    this.initialized = true;
    await this.loadItems();
    this.bindEvents();
    this.render();
  },

  async loadItems() {
    this.items = await store.getAllNotes();
  },

  async refresh() {
    await this.loadItems();
    this.render();
  },

  bindEvents() {
    document.getElementById('notes-add-btn').addEventListener('click', () => this.openModal());
    document.getElementById('notes-modal-close').addEventListener('click', () => this.closeModal());
    document.getElementById('notes-modal-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'notes-modal-overlay') this.closeModal();
    });
    document.getElementById('notes-modal-save').addEventListener('click', () => this.save());
    document.getElementById('notes-modal-delete').addEventListener('click', () => this.deleteCurrent());
    
    const editBtn = document.getElementById('notes-modal-edit');
    if(editBtn) {
      editBtn.addEventListener('click', () => {
        this.openModal(this.editingId, 'edit');
      });
    }

    ['notes-modal-name', 'notes-modal-content'].forEach((id) => {
      document.getElementById(id).addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.key === 'Enter') this.save();
      });
    });

    const search = document.getElementById('notes-search');
    let debounce;
    search.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => this.render(), 250);
    });

    document.getElementById('notes-date-filter').addEventListener('change', (e) => {
      this.dateFilter = e.target.value;
      this.render();
    });
  },

  getFilteredItems() {
    const searchInput = document.getElementById('notes-search');
    const query = searchInput ? searchInput.value.trim().toLowerCase() : '';

    let filtered = this.items.filter((n) => !this.isInternalNote(n));

    if (query) {
      filtered = filtered.filter(
        (n) =>
          (n.name || '').toLowerCase().includes(query) ||
          (n.content || '').toLowerCase().includes(query)
      );
    }

    if (this.dateFilter !== 'all') {
      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      filtered = filtered.filter((n) => {
        const created = new Date(n.createdAt);
        if (this.dateFilter === 'today') return created >= startOfToday;
        if (this.dateFilter === 'week') return created >= new Date(now - 7 * 86400000);
        if (this.dateFilter === 'month') return created >= new Date(now - 30 * 86400000);
        if (this.dateFilter === 'year') return created.getFullYear() === now.getFullYear();
        return true;
      });
    }

    filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return filtered;
  },

  groupByDate(items) {
    const groups = new Map();
    items.forEach((item) => {
      const key = Utils.getDayKey(item.createdAt);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    });
    return groups;
  },

  render() {
    const list = document.getElementById('notes-list');
    const empty = document.getElementById('notes-empty');
    list.innerHTML = '';

    const filtered = this.getFilteredItems();

    if (filtered.length === 0) {
      empty.classList.add('visible');
      list.style.display = 'none';
      return;
    }

    empty.classList.remove('visible');
    list.style.display = '';

    const groups = this.groupByDate(filtered);
    const sortedKeys = [...groups.keys()].sort((a, b) => b.localeCompare(a));

    sortedKeys.forEach((dayKey) => {
      const section = document.createElement('div');
      section.className = 'notes-date-group';

      const header = document.createElement('div');
      header.className = 'notes-date-header';
      const sampleDate = groups.get(dayKey)[0].createdAt;
      header.textContent = Utils.formatDate(sampleDate);
      section.appendChild(header);

      groups.get(dayKey).forEach((note, i) => {
        section.appendChild(this.createRow(note, i));
      });

      list.appendChild(section);
    });
  },

  createRow(note, index) {
    const row = document.createElement('div');
    row.className = 'notes-row';
    row.style.animationDelay = `${index * 0.03}s`;

    const main = document.createElement('div');
    main.className = 'notes-row-main';

    const name = document.createElement('span');
    name.className = 'notes-row-name';
    name.textContent = note.name || 'Untitled';
    main.appendChild(name);

    const preview = document.createElement('span');
    preview.className = 'notes-row-preview';
    preview.textContent = note.content || '';
    main.appendChild(preview);

    row.appendChild(main);

    const meta = document.createElement('div');
    meta.className = 'notes-row-meta';
    meta.innerHTML = `
      <span title="Created">${Utils.formatTimestamp(note.createdAt)}</span>
      ${note.updatedAt !== note.createdAt ? `<span class="notes-modified" title="Last modified">Edited ${Utils.formatDate(note.updatedAt)}</span>` : ''}
    `;
    row.appendChild(meta);

    // Hover actions
    const actions = document.createElement('div');
    actions.className = 'notes-card-actions';
    
    const editBtn = document.createElement('button');
    editBtn.className = 'notes-action-btn edit';
    editBtn.title = 'Edit';
    editBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openModal(note._id, 'edit');
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'notes-action-btn delete';
    delBtn.title = 'Delete';
    delBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.editingId = note._id;
      this.deleteCurrent();
    });

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    row.appendChild(actions);

    row.addEventListener('click', () => this.openModal(note._id, 'view'));
    return row;
  },

  openModal(id = null, mode = 'create') {
    this.editingId = id;
    const overlay = document.getElementById('notes-modal-overlay');
    const modal = overlay.querySelector('.notes-modal');
    const heading = document.getElementById('notes-modal-heading');
    const nameInput = document.getElementById('notes-modal-name');
    const contentInput = document.getElementById('notes-modal-content');
    const datesEl = document.getElementById('notes-modal-dates');
    const deleteBtn = document.getElementById('notes-modal-delete');
    const editBtn = document.getElementById('notes-modal-edit');
    const saveBtn = document.getElementById('notes-modal-save');
    const saveText = document.getElementById('notes-modal-save-text');

    if (mode === 'view') {
      modal.classList.add('view-mode');
      nameInput.readOnly = true;
      contentInput.readOnly = true;
      editBtn.style.display = '';
      saveBtn.style.display = 'none';
      deleteBtn.style.display = 'none';
    } else {
      modal.classList.remove('view-mode');
      nameInput.readOnly = false;
      contentInput.readOnly = false;
      if (editBtn) editBtn.style.display = 'none';
      saveBtn.style.display = '';
      deleteBtn.style.display = id ? '' : 'none';
    }

    if (id) {
      const note = this.items.find((n) => n._id === id);
      if (!note) return;
      heading.textContent = mode === 'view' ? 'Note Details' : 'Edit Note';
      nameInput.value = note.name || '';
      contentInput.value = note.content || '';
      datesEl.innerHTML = `
        <span>Created: ${Utils.formatTimestamp(note.createdAt)}</span>
        <span>Modified: ${Utils.formatTimestamp(note.updatedAt)}</span>
      `;
      datesEl.style.display = '';
      saveText.textContent = 'Save Changes';
    } else {
      heading.textContent = 'New Note';
      nameInput.value = '';
      contentInput.value = '';
      datesEl.style.display = 'none';
      saveText.textContent = 'Save Note';
    }

    overlay.classList.add('visible');
    if (mode !== 'view') {
      nameInput.focus();
    }
  },

  closeModal() {
    document.getElementById('notes-modal-overlay').classList.remove('visible');
    this.editingId = null;
  },

  async save() {
    const name = document.getElementById('notes-modal-name').value.trim();
    const content = document.getElementById('notes-modal-content').value;

    if (!name) {
      document.getElementById('notes-modal-name').focus();
      SmartActions.toast('Please enter a note name');
      return;
    }

    if (this.editingId) {
      await store.updateNote(this.editingId, { name, content });
      SmartActions.toast('Note updated');
    } else {
      await store.createNote({ name, content });
      SmartActions.toast('Note saved');
    }

    this.closeModal();
    await this.refresh();
  },

  async deleteCurrent() {
    if (!this.editingId) return;
    const note = this.items.find((n) => n._id === this.editingId);
    if (!note) return;
    if (!confirm(`Delete "${note.name}"? This cannot be undone.`)) return;

    await store.deleteNote(this.editingId);
    SmartActions.toast('Note deleted');
    this.closeModal();
    await this.refresh();
  },
};

window.Notes = Notes;
