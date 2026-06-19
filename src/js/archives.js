/* ═══════════════════════════════════════════════════════════════
   Archives — Save URLs, text, images for future reference.
   Simple create/edit modal (like QuickAdd), tag-based filtering,
   Ctrl+V image paste, and version history (time machine).
   ═══════════════════════════════════════════════════════════════ */

const Archives = {
  items: [],
  selectedTags: [],
  pendingImages: [],
  activeTagFilter: null,
  initialized: false,
  editingId: null,       // null = create mode, string = edit mode
  showingVault: false,

  async init() {
    if (this.initialized) return;
    this.initialized = true;
    await this.loadItems();
    this.bindEvents();
    this.render();
  },

  async loadItems() {
    this.items = await store.getAllArchives();
  },

  async refresh() {
    await this.loadItems();
    this.render();
  },

  // ─── Events ───

  bindEvents() {
    // Add button
    document.getElementById('archives-add-btn').addEventListener('click', () => this.openModal());

    // Modal close
    document.getElementById('archive-modal-close').addEventListener('click', () => this.closeModal());
    document.getElementById('archive-modal-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'archive-modal-overlay') this.closeModal();
    });

    // Save
    document.getElementById('archive-modal-save').addEventListener('click', () => this.save());

    // Ctrl+Enter to save from modal inputs
    ['archive-title', 'archive-content'].forEach((id) => {
      document.getElementById(id).addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.key === 'Enter') this.save();
      });
    });

    // GLOBAL paste listener — catches Ctrl+V anywhere when modal is open
    document.addEventListener('paste', (e) => {
      const modalVisible = document.getElementById('archive-modal-overlay').classList.contains('visible');
      if (!modalVisible) return;

      const clipItems = e.clipboardData?.items;
      if (!clipItems) return;

      for (let i = 0; i < clipItems.length; i++) {
        if (clipItems[i].type.startsWith('image/')) {
          e.preventDefault();
          e.stopPropagation();
          const file = clipItems[i].getAsFile();
          const reader = new FileReader();
          reader.onload = (ev) => {
            if (ev.target.result.length > 5 * 1024 * 1024) {
              alert('Image too large (max 5MB)');
              return;
            }
            this.pendingImages.push(ev.target.result);
            this.renderPasteArea();
          };
          reader.readAsDataURL(file);
          return; // stop — we handled the image
        }
      }
    });

    // New tag input
    document.getElementById('archive-new-tag').addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const name = e.target.value.trim();
        if (name) {
          const tag = await Tags.createTag(name);
          if (tag && !this.selectedTags.includes(tag.name)) {
            this.selectedTags.push(tag.name);
          }
          e.target.value = '';
          this.renderTagSelector();
        }
      }
    });

    // Search
    const search = document.getElementById('archives-search');
    let debounce;
    search.addEventListener('input', (e) => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        this.render();
      }, 250);
    });

    // Vault Toggle
    document.getElementById('archives-vault-toggle').addEventListener('click', (e) => {
      this.showingVault = !this.showingVault;
      if (this.showingVault) {
        e.currentTarget.classList.add('active');
        document.getElementById('archives-add-btn').style.display = 'none'; // Optional: hide add in vault
      } else {
        e.currentTarget.classList.remove('active');
        document.getElementById('archives-add-btn').style.display = 'inline-flex';
      }
      this.render();
    });

    // Lightbox close
    document.getElementById('archive-lightbox').addEventListener('click', () => {
      document.getElementById('archive-lightbox').classList.remove('visible');
    });

    // History panel close
    document.getElementById('archive-history-close').addEventListener('click', () => {
      document.getElementById('archive-history-overlay').classList.remove('visible');
    });
    document.getElementById('archive-history-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'archive-history-overlay') {
        document.getElementById('archive-history-overlay').classList.remove('visible');
      }
    });
  },

  // ─── Render ───

  render() {
    const grid = document.getElementById('archives-grid');
    const empty = document.getElementById('archives-empty');
    const searchInput = document.getElementById('archives-search');
    const query = searchInput ? searchInput.value.trim().toLowerCase() : '';

    grid.innerHTML = '';

    let filtered = [...this.items];

    // Vault filter
    filtered = filtered.filter(item => (!!item.isVaulted) === this.showingVault);

    // Text search
    if (query) {
      filtered = filtered.filter((item) =>
        (item.title || '').toLowerCase().includes(query) ||
        (item.content || '').toLowerCase().includes(query) ||
        (item.tags || []).some((t) => t.toLowerCase().includes(query))
      );
    }

    // Tag filter
    if (this.activeTagFilter) {
      filtered = filtered.filter((item) =>
        (item.tags || []).includes(this.activeTagFilter)
      );
    }

    // Sort newest first
    filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    if (filtered.length === 0) {
      empty.classList.add('visible');
      grid.style.display = 'none';
      return;
    }

    empty.classList.remove('visible');
    grid.style.display = '';

    filtered.forEach((item, i) => {
      grid.appendChild(this.createCard(item, i));
    });

    this.renderTagFilters();
  },

  createCard(item, index) {
    const card = document.createElement('div');
    card.className = 'archive-card';
    card.style.animationDelay = `${index * 0.04}s`;

    // Header
    const header = document.createElement('div');
    header.className = 'archive-card-header';

    const title = document.createElement('div');
    title.className = 'archive-card-title';
    title.textContent = item.title || 'Untitled';
    header.appendChild(title);

    const time = document.createElement('span');
    time.className = 'archive-card-time';
    time.textContent = Utils.formatDate(item.createdAt) + ' · ' + Utils.formatTime(item.createdAt);
    header.appendChild(time);

    card.appendChild(header);

    // Content with auto-linkified URLs
    if (item.content) {
      const content = document.createElement('div');
      content.className = 'archive-card-content';
      content.innerHTML = this.linkify(item.content);
      // Check overflow
      requestAnimationFrame(() => {
        if (content.scrollHeight > 120) content.classList.add('overflow');
      });
      // Intercept link clicks
      content.addEventListener('click', (e) => {
        if (e.target.tagName === 'A') {
          e.preventDefault();
          const url = e.target.getAttribute('href');
          if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
            window.electronAPI.openExternal(url);
          }
        }
      });
      card.appendChild(content);
    }

    // Images
    if (item.images && item.images.length > 0) {
      const imgRow = document.createElement('div');
      imgRow.className = 'archive-card-images';
      item.images.forEach((src) => {
        const img = document.createElement('img');
        img.className = 'archive-card-img';
        img.src = src;
        img.addEventListener('click', () => this.showLightbox(src));
        imgRow.appendChild(img);
      });
      card.appendChild(imgRow);
    }

    // Tags
    if (item.tags && item.tags.length > 0) {
      const tagRow = document.createElement('div');
      tagRow.className = 'archive-card-tags';
      item.tags.forEach((tagName) => {
        const tagColor = Tags.getTagColor(tagName);
        const el = document.createElement('span');
        el.className = 'archive-card-tag';
        el.textContent = tagName;
        el.style.background = tagColor.bg;
        el.style.color = tagColor.text;
        tagRow.appendChild(el);
      });
      card.appendChild(tagRow);
    }

    // Footer actions
    const footer = document.createElement('div');
    footer.className = 'archive-card-footer';

    // Share button
    const shareBtn = document.createElement('button');
    shareBtn.className = 'archive-action-btn';
    shareBtn.innerHTML = '📤 Share';
    shareBtn.addEventListener('click', () => {
      let textToCopy = item.title ? `${item.title}\n` : '';
      if (item.content) textToCopy += `${item.content}\n`;
      if (item.images && item.images.length > 0) textToCopy += `[Contains ${item.images.length} image(s)]`;
      navigator.clipboard.writeText(textToCopy.trim());
      SmartActions.toast('Copied to clipboard!');
    });
    footer.appendChild(shareBtn);

    // Vault button
    const vaultBtn = document.createElement('button');
    vaultBtn.className = 'archive-action-btn';
    vaultBtn.innerHTML = item.isVaulted ? '🔓 Unvault' : '🔒 Vault';
    vaultBtn.addEventListener('click', async () => {
      const newState = !item.isVaulted;
      await window.electronAPI.updateArchive(item._id, { isVaulted: newState });
      item.isVaulted = newState;
      SmartActions.toast(newState ? 'Moved to Vault' : 'Removed from Vault');
      this.render();
    });
    footer.appendChild(vaultBtn);

    // Edit button
    const editBtn = document.createElement('button');
    editBtn.className = 'archive-action-btn';
    editBtn.textContent = '✏️ Edit';
    editBtn.addEventListener('click', () => this.openEditModal(item));
    footer.appendChild(editBtn);

    // History button (only show if item has history)
    const historyCount = (item.history || []).length;
    if (historyCount > 0) {
      const histBtn = document.createElement('button');
      histBtn.className = 'archive-action-btn';
      histBtn.textContent = `⏱ History (${historyCount})`;
      histBtn.addEventListener('click', () => this.showHistory(item));
      footer.appendChild(histBtn);
    }

    // Delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'archive-action-btn danger';
    deleteBtn.textContent = '✕ Delete';
    deleteBtn.addEventListener('click', () => {
      this.promptDelete(item._id);
    });
    footer.appendChild(deleteBtn);

    card.appendChild(footer);

    return card;
  },

  renderTagFilters() {
    const container = document.getElementById('archives-tag-filters');
    if (!container) return;
    container.innerHTML = '';

    // Derive unique tags from items
    const tagSet = new Set();
    this.items.forEach((item) => (item.tags || []).forEach((t) => tagSet.add(t)));
    const allTags = [...tagSet].sort();

    if (allTags.length === 0) return;

    // "All" button
    const allBtn = document.createElement('button');
    allBtn.className = 'archives-tag-filter' + (!this.activeTagFilter ? ' active' : '');
    allBtn.textContent = 'All';
    allBtn.addEventListener('click', () => {
      this.activeTagFilter = null;
      this.render();
    });
    container.appendChild(allBtn);

    allTags.forEach((tagName) => {
      const btn = document.createElement('button');
      btn.className = 'archives-tag-filter' + (this.activeTagFilter === tagName ? ' active' : '');
      btn.textContent = tagName;
      const tagColor = Tags.getTagColor(tagName);
      if (this.activeTagFilter === tagName) {
        btn.style.background = tagColor.text;
        btn.style.borderColor = tagColor.text;
      }
      btn.addEventListener('click', () => {
        this.activeTagFilter = this.activeTagFilter === tagName ? null : tagName;
        this.render();
      });
      container.appendChild(btn);
    });
  },

  // ─── Modal (Create & Edit) ───

  openModal() {
    this.editingId = null;
    this.selectedTags = [];
    this.pendingImages = [];
    document.getElementById('archive-title').value = '';
    document.getElementById('archive-content').value = '';
    document.getElementById('archive-new-tag').value = '';
    document.getElementById('archive-modal-heading').textContent = 'Save to Archives';
    document.getElementById('archive-modal-save-text').textContent = 'Save';
    this.renderPasteArea();
    this.renderTagSelector();
    document.getElementById('archive-modal-overlay').classList.add('visible');
    setTimeout(() => document.getElementById('archive-title').focus(), 100);
  },

  openEditModal(item) {
    this.editingId = item._id;
    this.selectedTags = [...(item.tags || [])];
    this.pendingImages = [...(item.images || [])];
    document.getElementById('archive-title').value = item.title || '';
    document.getElementById('archive-content').value = item.content || '';
    document.getElementById('archive-new-tag').value = '';
    document.getElementById('archive-modal-heading').textContent = 'Edit Archive';
    document.getElementById('archive-modal-save-text').textContent = 'Update';
    this.renderPasteArea();
    this.renderTagSelector();
    document.getElementById('archive-modal-overlay').classList.add('visible');
    setTimeout(() => document.getElementById('archive-title').focus(), 100);
  },

  closeModal() {
    document.getElementById('archive-modal-overlay').classList.remove('visible');
    this.pendingImages = [];
    this.editingId = null;
  },

  renderTagSelector() {
    const container = document.getElementById('archive-tag-list');
    Tags.renderTagSelector(container, this.selectedTags, (tagName, isSelected) => {
      if (isSelected) {
        if (!this.selectedTags.includes(tagName)) this.selectedTags.push(tagName);
      } else {
        this.selectedTags = this.selectedTags.filter((t) => t !== tagName);
      }
    });
  },

  renderPasteArea() {
    const area = document.getElementById('archive-paste-area');
    area.innerHTML = '';

    if (this.pendingImages.length === 0) {
      area.classList.remove('has-images');
      area.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
        <span>Press <kbd>Ctrl+V</kbd> to paste screenshots</span>
      `;
    } else {
      area.classList.add('has-images');
      this.pendingImages.forEach((src, idx) => {
        const wrap = document.createElement('div');
        wrap.className = 'archive-paste-preview';
        const img = document.createElement('img');
        img.src = src;
        wrap.appendChild(img);
        const removeBtn = document.createElement('button');
        removeBtn.className = 'archive-paste-remove';
        removeBtn.textContent = '✕';
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.pendingImages.splice(idx, 1);
          this.renderPasteArea();
        });
        wrap.appendChild(removeBtn);
        area.appendChild(wrap);
      });
    }
  },

  isSaving: false,

  async save() {
    if (this.isSaving) return;

    const title = document.getElementById('archive-title').value.trim();
    const content = document.getElementById('archive-content').value.trim();

    if (!title && !content && this.pendingImages.length === 0) {
      const input = document.getElementById('archive-title');
      input.style.borderColor = 'var(--priority-high)';
      input.focus();
      setTimeout(() => { input.style.borderColor = ''; }, 1000);
      return;
    }

    this.isSaving = true;
    const saveBtn = document.getElementById('archive-modal-save');
    saveBtn.disabled = true;

    try {
      if (this.editingId) {
        // ─── Update existing (with history snapshot) ───
        const existing = this.items.find((i) => i._id === this.editingId);
        const history = existing ? [...(existing.history || [])] : [];

        // Push a snapshot of the current version before overwriting
        if (existing) {
          history.push({
            title: existing.title,
            content: existing.content,
            images: existing.images || [],
            tags: existing.tags || [],
            savedAt: new Date().toISOString(),
          });
          // Keep last 20 versions max
          if (history.length > 20) history.splice(0, history.length - 20);
        }

        await store.updateArchive(this.editingId, {
          title: title || 'Untitled',
          content,
          images: [...this.pendingImages],
          tags: [...this.selectedTags],
          history,
        });
      } else {
        // ─── Create new ───
        await store.createArchive({
          title: title || 'Untitled',
          content,
          images: [...this.pendingImages],
          tags: [...this.selectedTags],
          history: [],
        });
      }
      this.closeModal();
      await this.refresh();
    } finally {
      this.isSaving = false;
      saveBtn.disabled = false;
    }
  },

  // ─── Version History (Time Machine) ───

  showHistory(item) {
    const list = document.getElementById('archive-history-list');
    list.innerHTML = '';

    const history = item.history || [];
    if (history.length === 0) return;

    // Show newest versions first
    [...history].reverse().forEach((ver, i) => {
      const entry = document.createElement('div');
      entry.className = 'archive-history-entry';

      const header = document.createElement('div');
      header.className = 'archive-history-entry-header';

      const versionLabel = document.createElement('span');
      versionLabel.className = 'archive-history-version';
      versionLabel.textContent = `v${history.length - i}`;
      header.appendChild(versionLabel);

      const dateLabel = document.createElement('span');
      dateLabel.className = 'archive-history-date';
      dateLabel.textContent = Utils.formatDate(ver.savedAt) + ' · ' + Utils.formatTime(ver.savedAt);
      header.appendChild(dateLabel);

      const restoreBtn = document.createElement('button');
      restoreBtn.className = 'archive-action-btn';
      restoreBtn.textContent = '↩ Restore';
      restoreBtn.addEventListener('click', async () => {
        await this.restoreVersion(item._id, ver, item);
      });
      header.appendChild(restoreBtn);

      entry.appendChild(header);

      // Preview content
      if (ver.title) {
        const titlePre = document.createElement('div');
        titlePre.className = 'archive-history-title';
        titlePre.textContent = ver.title;
        entry.appendChild(titlePre);
      }
      if (ver.content) {
        const contentPre = document.createElement('div');
        contentPre.className = 'archive-history-content';
        contentPre.innerHTML = this.linkify(ver.content);
        entry.appendChild(contentPre);
      }
      if (ver.images && ver.images.length > 0) {
        const imgRow = document.createElement('div');
        imgRow.className = 'archive-history-images';
        ver.images.forEach((src) => {
          const img = document.createElement('img');
          img.src = src;
          imgRow.appendChild(img);
        });
        entry.appendChild(imgRow);
      }
      if (ver.tags && ver.tags.length > 0) {
        const tagRow = document.createElement('div');
        tagRow.className = 'archive-history-tags';
        ver.tags.forEach((t) => {
          const span = document.createElement('span');
          span.className = 'archive-card-tag';
          const tc = Tags.getTagColor(t);
          span.textContent = t;
          span.style.background = tc.bg;
          span.style.color = tc.text;
          tagRow.appendChild(span);
        });
        entry.appendChild(tagRow);
      }

      list.appendChild(entry);
    });

    document.getElementById('archive-history-item-title').textContent = item.title || 'Untitled';
    document.getElementById('archive-history-overlay').classList.add('visible');
  },

  async restoreVersion(itemId, version, currentItem) {
    // Save current as a history entry before restoring
    const history = [...(currentItem.history || [])];
    history.push({
      title: currentItem.title,
      content: currentItem.content,
      images: currentItem.images || [],
      tags: currentItem.tags || [],
      savedAt: new Date().toISOString(),
    });
    if (history.length > 20) history.splice(0, history.length - 20);

    await store.updateArchive(itemId, {
      title: version.title,
      content: version.content,
      images: version.images || [],
      tags: version.tags || [],
      history,
    });

    document.getElementById('archive-history-overlay').classList.remove('visible');
    await this.refresh();
  },

  // ─── Utilities ───

  linkify(text) {
    if (!text) return '';
    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const urlRegex = /(https?:\/\/[^\s<]+)/g;
    return escaped.replace(urlRegex, (url) =>
      `<a href="${url}" title="${url}">${url}</a>`
    );
  },

  showLightbox(src) {
    const lb = document.getElementById('archive-lightbox');
    lb.innerHTML = `<img src="${src}" />`;
    lb.classList.add('visible');
  },

  // ─── Delete Protection ───
  promptDelete(archiveId) {
    const overlay = document.getElementById('delete-protect-overlay');
    const input = document.getElementById('delete-protect-password');
    const errorEl = document.getElementById('delete-protect-error');
    const confirmBtn = document.getElementById('delete-protect-confirm');
    const closeBtn = document.getElementById('delete-protect-close');

    // Reset state
    input.value = '';
    errorEl.textContent = '';

    // Show modal
    overlay.style.display = 'flex';
    // Small delay to allow CSS transition to work
    setTimeout(() => overlay.style.opacity = '1', 10);
    input.focus();

    // Clean up previous event listeners (to prevent multiple fires)
    const newConfirm = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirm, confirmBtn);
    const newClose = closeBtn.cloneNode(true);
    closeBtn.parentNode.replaceChild(newClose, closeBtn);

    const closeModal = () => {
      overlay.style.opacity = '0';
      setTimeout(() => overlay.style.display = 'none', 300);
    };

    newClose.addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });

    const handleConfirm = async () => {
      const password = input.value;
      if (!password) {
        errorEl.textContent = 'Please enter your password';
        return;
      }

      newConfirm.disabled = true;
      try {
        const valid = await store.verifyPassword(password);
        if (valid) {
          await store.deleteArchive(archiveId);
          await this.refresh();
          closeModal();
        } else {
          errorEl.textContent = 'Incorrect password';
          newConfirm.disabled = false;
          input.value = '';
          input.focus();
        }
      } catch (err) {
        errorEl.textContent = 'Error verifying password';
        newConfirm.disabled = false;
      }
    };

    newConfirm.addEventListener('click', handleConfirm);

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleConfirm();
      } else if (e.key === 'Escape') {
        closeModal();
      }
    });
  }
};

window.Archives = Archives;
