/* ═══════════════════════════════════════════════════════════════
   Canvas — Spatial thought layout with draggable cards,
   zoom, NOW marker, thought numbers, tick/cross actions,
   and finished stack
   ═══════════════════════════════════════════════════════════════ */

const Canvas = {
  thoughts: [],
  finishedThoughts: [],
  interactLib: null,
  zoomLevel: 100,
  finishedExpanded: false,

  initialized: false,

  async init() {
    this.interactLib = window.interact;
    this.zoomLevel = Settings.get('canvasZoom') || 100;
    await this.loadThoughts();
    this.render();
    if (!this.initialized) {
      this.initDraggable();
      this.initEditModal();
      this.initZoom();
      this.initFinishedStack();
      this.bindDblClick();
      this.initCanvasPanning();
      this.initialized = true;
    }
    this.applyZoom();
  },

  async loadThoughts() {
    this.thoughts = await store.getActiveThoughts();
    this.finishedThoughts = await store.getFinishedThoughts();
  },

  async refresh() {
    await this.loadThoughts();
    this.render();
  },

  // ─── Smart Positioning ───

  /**
   * Read the actual priority zone boundaries from the DOM.
   * Returns { high: {left,right}, medium: {left,right}, low: {left,right} }
   */
  getZoneBoundaries() {
    const high = document.querySelector('.priority-zone-high');
    const medium = document.querySelector('.priority-zone-medium');
    const low = document.querySelector('.priority-zone-low');

    let hw = high ? high.offsetWidth : 0;
    let mw = medium ? medium.offsetWidth : 0;
    let lw = low ? low.offsetWidth : 0;

    if (hw === 0) {
      const vw = (window.innerWidth > 800) ? window.innerWidth : (window.screen && window.screen.availWidth ? window.screen.availWidth : 1200);
      const width31 = (vw * 0.31) - 20;
      return {
        high: { left: 24, right: 24 + width31 },
        medium: { left: (vw * 0.31) + 24, right: (vw * 0.31) + 24 + width31 },
        low: { left: (vw * 0.62) + 24, right: (vw * 0.62) + 24 + width31 }
      };
    }

    return {
      high: { left: high.offsetLeft, right: high.offsetLeft + hw },
      medium: { left: medium.offsetLeft, right: medium.offsetLeft + mw },
      low: { left: low.offsetLeft, right: low.offsetLeft + lw },
    };
  },

  /**
   * Detect which priority zone an x-coordinate falls into.
   */
  detectPriorityZone(x) {
    const zones = this.getZoneBoundaries();
    if (x < zones.medium.left) return 'high';
    if (x < zones.low.left) return 'medium';
    return 'low';
  },

  /**
   * Find an open position on the canvas that doesn't overlap existing cards.
   * @param {string} priority - 'high' | 'medium' | 'low'
   * @returns {{x: number, y: number}}
   */
  findOpenPosition(priority = 'medium') {
    const CARD_W = 280;   // card width + horizontal padding
    const CARD_H = 140;   // estimated card height + vertical padding
    const PAD = 20;       // gap between cards
    const CANVAS_H = 1600;
    const TOP_MARGIN = 120;

    // Read actual zone boundaries from the DOM
    const zones = this.getZoneBoundaries();
    const zone = zones[priority] || zones.medium;
    const zoneLeft = zone.left + 16;
    const zoneRight = zone.right - 16;

    // Collect occupied rectangles from existing active thoughts
    const occupied = this.thoughts.map((t) => ({
      x: t.x || 0,
      y: t.y || 0,
      w: t.width || 260,
      h: CARD_H - PAD,
    }));

    // Check if a candidate position overlaps any existing card
    const overlaps = (cx, cy) => {
      for (const card of occupied) {
        if (
          cx < card.x + card.w + PAD &&
          cx + CARD_W > card.x - PAD &&
          cy < card.y + card.h + PAD &&
          cy + CARD_H > card.y - PAD
        ) {
          return true;
        }
      }
      return false;
    };

    // Grid-scan: try columns then rows within the priority zone
    for (let y = TOP_MARGIN; y + CARD_H < CANVAS_H; y += CARD_H + PAD) {
      for (let x = zoneLeft; x + CARD_W < zoneRight; x += CARD_W + PAD) {
        if (!overlaps(x, y)) {
          return { x, y };
        }
      }
    }

    // Fallback: if zone is packed, use a random offset so cards don't stack exactly
    return {
      x: zoneLeft + Math.random() * Math.max(50, zoneRight - zoneLeft - CARD_W),
      y: TOP_MARGIN + Math.random() * 400,
    };
  },

  // ─── Zoom ───

  initZoom() {
    document.getElementById('zoom-in').addEventListener('click', () => this.setZoom(this.zoomLevel + 10));
    document.getElementById('zoom-out').addEventListener('click', () => this.setZoom(this.zoomLevel - 10));
    document.getElementById('zoom-reset').addEventListener('click', () => this.setZoom(100));
  },

  setZoom(level) {
    this.zoomLevel = Math.max(30, Math.min(200, level));
    this.applyZoom();
    document.getElementById('zoom-level').textContent = `${this.zoomLevel}%`;

    // Sync settings slider
    const slider = document.getElementById('setting-canvasZoom');
    if (slider) {
      slider.value = this.zoomLevel;
      document.getElementById('setting-canvasZoom-label').textContent = `${this.zoomLevel}%`;
    }

    store.setSetting('canvasZoom', this.zoomLevel);
  },

  applyZoom() {
    const content = document.getElementById('canvas-content');
    const scale = this.zoomLevel / 100;
    content.style.transform = `scale(${scale})`;
    content.style.transformOrigin = 'top left';
    // Adjust the scrollable area
    content.style.width = `${2400 / scale}px`;
    content.style.height = `${1600 / scale}px`;
    document.getElementById('zoom-level').textContent = `${this.zoomLevel}%`;
  },

  // ─── Render ───

  render() {
    const container = document.getElementById('canvas-content');

    // Remove existing cards (not zones)
    container.querySelectorAll('.thought-card').forEach((el) => el.remove());
    container.querySelectorAll('.canvas-empty').forEach((el) => el.remove());

    const filtered = this.thoughts.filter((t) => Tags.passesFilter(t));

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'canvas-empty';
      empty.innerHTML = `
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5z"/>
          <path d="M2 17l10 5 10-5"/>
          <path d="M2 12l10 5 10-5"/>
        </svg>
        <p>Your mind space is empty</p>
        <p class="text-sm">Click <strong>+ What's on your mind?</strong> to start capturing thoughts</p>
      `;
      container.appendChild(empty);
    } else {
      // Sort: NOW-marked first, then by creation
      const sorted = [...filtered].sort((a, b) => {
        if (a.markedNow && !b.markedNow) return -1;
        if (!a.markedNow && b.markedNow) return 1;
        return 0;
      });
      sorted.forEach((thought) => {
        this.createCardElement(thought, container);
      });
    }

    this.renderFinishedStack();
    this.updatePriorityStatusBar();
  },

  createCardElement(thought, container) {
    const card = document.createElement('div');
    card.className = 'thought-card';
    if (thought.markedNow) card.classList.add('marked-now');
    card.dataset.id = thought._id;
    card.dataset.priority = thought.priority;
    card.style.left = `${thought.x}px`;
    card.style.top = `${thought.y}px`;
    card.style.width = `${thought.width || 260}px`;

    // NOW badge
    if (thought.markedNow) {
      const nowBadge = document.createElement('div');
      nowBadge.className = 'now-badge';
      nowBadge.innerHTML = `<span class="now-pulse"></span> NOW`;
      card.appendChild(nowBadge);
    }

    // Thought number — skip rendering on canvas (still stored for timeline)

    // Content (with clickable URLs)
    const content = document.createElement('div');
    content.className = 'card-content';
    content.innerHTML = this.linkify(thought.content);
    // Intercept link clicks to open in system browser
    content.addEventListener('click', (e) => {
      if (e.target.tagName === 'A') {
        e.preventDefault();
        e.stopPropagation();
        const url = e.target.getAttribute('href');
        if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
          window.electronAPI.openExternal(url);
        }
      }
    });
    card.appendChild(content);

    // Persistence badge
    if (thought.persistence !== 'persistent') {
      const persistBadge = document.createElement('div');
      persistBadge.className = 'persist-badge';
      if (thought.persistence === 'today') {
        persistBadge.textContent = '📅 Today only';
      } else if (thought.persistence === 'until_date' && thought.expiresAt) {
        persistBadge.textContent = `⏰ Until ${Utils.formatTimestamp(thought.expiresAt)}`;
      }
      card.appendChild(persistBadge);
    }

    // Tags
    if (thought.tags && thought.tags.length > 0) {
      const tagsDiv = document.createElement('div');
      tagsDiv.className = 'card-tags';
      thought.tags.forEach((tagName) => {
        const color = Tags.getTagColor(tagName);
        const tagEl = document.createElement('span');
        tagEl.className = 'card-tag';
        tagEl.textContent = tagName;
        tagEl.style.background = color.bg;
        tagEl.style.color = color.text;
        tagsDiv.appendChild(tagEl);
      });
      card.appendChild(tagsDiv);
    }

    // Footer
    const footer = document.createElement('div');
    footer.className = 'card-footer';

    const time = document.createElement('span');
    time.className = 'card-time';
    time.textContent = Utils.formatTimestamp(thought.createdAt);
    footer.appendChild(time);

    const actions = document.createElement('div');
    actions.className = 'card-actions';

    // NOW marker toggle
    const nowBtn = document.createElement('button');
    nowBtn.className = `card-action-btn now-btn ${thought.markedNow ? 'active' : ''}`;
    nowBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="${thought.markedNow ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
    </svg>`;
    nowBtn.title = thought.markedNow ? 'Unmark NOW' : 'Mark as NOW';
    nowBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleNow(thought._id);
    });
    actions.appendChild(nowBtn);

    // Tick (finish)
    const tickBtn = document.createElement('button');
    tickBtn.className = 'card-action-btn tick-btn';
    tickBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>`;
    tickBtn.title = 'Mark as finished';
    tickBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.finishThought(thought._id);
    });
    actions.appendChild(tickBtn);

    // Cross (dismiss)
    const crossBtn = document.createElement('button');
    crossBtn.className = 'card-action-btn cross-btn';
    crossBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
    </svg>`;
    crossBtn.title = 'Dismiss';
    crossBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.dismissThought(thought._id);
    });
    actions.appendChild(crossBtn);

    // Archive button (push to archives)
    const archiveBtn = document.createElement('button');
    archiveBtn.className = 'card-action-btn archive-btn';
    archiveBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="21 8 21 21 3 21 3 8"/>
      <rect x="1" y="3" width="22" height="5"/>
      <line x1="10" y1="12" x2="14" y2="12"/>
    </svg>`;
    archiveBtn.title = 'Push to Archive';
    archiveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.archiveThought(thought._id);
    });
    actions.appendChild(archiveBtn);

    // Edit button
    const editBtn = document.createElement('button');
    editBtn.className = 'card-action-btn';
    editBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>`;
    editBtn.title = 'Edit';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openEditModal(thought._id);
    });
    actions.appendChild(editBtn);

    footer.appendChild(actions);
    card.appendChild(footer);

    // ─── Comment Cloud Button ───
    const comments = (thought.comments || []).filter(c => c && c.text && c.text.trim().length > 0);
    const hasComments = comments.length > 0;

    const commentCloud = document.createElement('button');
    commentCloud.className = `comment-cloud ${hasComments ? 'has-comments' : ''}`;
    commentCloud.style.position = 'absolute';
    commentCloud.style.top = '8px';
    commentCloud.style.right = '8px';
    commentCloud.title = hasComments ? `${comments.length} comment${comments.length > 1 ? 's' : ''}` : 'Add a comment';
    commentCloud.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="${hasComments ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>${hasComments ? `<span class="comment-count">${comments.length}</span>` : ''}`;
    commentCloud.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleCommentPopover(thought._id, commentCloud);
    });
    card.appendChild(commentCloud);

    // ─── Hover-to-reveal comments (always attached, dynamically checked) ───
    let hoverTimer = null;
    card.addEventListener('mouseenter', () => {
      // Check live state of comments in case they were dynamically added
      const liveComments = (thought.comments || []).filter(c => c && c.text && c.text.trim().length > 0);
      if (liveComments.length === 0) return;

      hoverTimer = setTimeout(() => {
        if (!this._activePopover || this._activePopover.dataset.thoughtId !== thought._id) {
          this.closeCommentPopover();
          this.renderCommentPopover(thought._id, commentCloud);
        }
      }, 100); // 100ms for near-instant reveal without flickering
    });

    card.addEventListener('mouseleave', (e) => {
      if (hoverTimer) clearTimeout(hoverTimer);
      // Don't close if mouse moved into the popover itself
      const related = e.relatedTarget;
      if (this._activePopover && (this._activePopover.contains(related) || related === this._activePopover)) return;
      // Small delay to allow moving into popover
      setTimeout(() => {
        if (this._activePopover && this._activePopover.dataset.thoughtId === thought._id) {
          const popover = this._activePopover;
          if (!popover.matches(':hover') && !card.matches(':hover')) {
            this.closeCommentPopover();
          }
        }
      }, 200);
    });

    // Check for overflow
    if (thought.content.length > 200) {
      card.classList.add('overflow');
    }

    // ─── Double-click to quick-add comment ───
    card.addEventListener('dblclick', (e) => {
      // Don't trigger if they double-click an action button (like edit/delete/finish)
      if (e.target.closest('.card-action-btn') || e.target.closest('.comment-cloud') || e.target.closest('.comment-popover')) {
        return;
      }
      e.stopPropagation();

      // Open the comment popover using the cloud icon as the anchor
      if (!this._activePopover || this._activePopover.dataset.thoughtId !== thought._id) {
        this.closeCommentPopover();
        this.renderCommentPopover(thought._id, commentCloud);
      }
    });

    container.appendChild(card);
    return card;
  },

  addCard(thought) {
    this.thoughts.unshift(thought);
    const container = document.getElementById('canvas-content');
    container.querySelectorAll('.canvas-empty').forEach((el) => el.remove());
    this.createCardElement(thought, container);
    this.initDraggable();
  },

  // ─── Thought Actions ───

  async toggleNow(id) {
    const thought = this.thoughts.find((t) => t._id === id);
    if (!thought) return;
    const newVal = !thought.markedNow;
    thought.markedNow = newVal;
    await store.updateThought(id, { markedNow: newVal });

    // Update DOM inline to prevent full canvas re-render
    const card = document.querySelector(`.thought-card[data-id="${id}"]`);
    if (card) {
      const nowBtn = card.querySelector('.now-btn');
      if (newVal) {
        card.classList.add('marked-now');
        const nowBadge = document.createElement('div');
        nowBadge.className = 'now-badge';
        nowBadge.innerHTML = `<span class="now-pulse"></span> NOW`;
        card.insertBefore(nowBadge, card.firstChild);

        if (nowBtn) {
          nowBtn.classList.add('active');
          nowBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
          nowBtn.title = 'Unmark NOW';
        }
        // Bring to front
        card.parentNode.appendChild(card);
      } else {
        card.classList.remove('marked-now');
        const badge = card.querySelector('.now-badge');
        if (badge) badge.remove();

        if (nowBtn) {
          nowBtn.classList.remove('active');
          nowBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
          nowBtn.title = 'Mark as NOW';
        }
      }
    }
  },

  updatePriorityStatusBar() {
    const counts = { high: 0, medium: 0, low: 0 };
    // Only count thoughts currently visible (respecting filters)
    const filtered = this.thoughts.filter((t) => Tags.passesFilter(t));

    filtered.forEach(t => {
      if (counts[t.priority] !== undefined) {
        counts[t.priority]++;
      }
    });

    const highEl = document.getElementById('count-high');
    const mediumEl = document.getElementById('count-medium');
    const lowEl = document.getElementById('count-low');

    if (highEl) highEl.textContent = counts.high;
    if (mediumEl) mediumEl.textContent = counts.medium;
    if (lowEl) lowEl.textContent = counts.low;
  },

  async finishThought(id) {
    await store.finishThought(id);
    const thought = this.thoughts.find((t) => t._id === id);

    const card = document.querySelector(`.thought-card[data-id="${id}"]`);
    if (card) {
      card.style.transition = 'all 0.3s ease';
      card.style.opacity = '0';
      card.style.transform = 'scale(0.9) translateY(10px)';
      card.classList.add('finishing');
    }

    setTimeout(async () => {
      this.thoughts = this.thoughts.filter((t) => t._id !== id);
      if (thought) {
        thought.status = 'finished';
        thought.finishedAt = new Date().toISOString();
        this.finishedThoughts.unshift(thought);
      }
      this.render();
      this.initDraggable();
      Timeline.render();
    }, 300);
  },

  async dismissThought(id) {
    await store.dismissThought(id);

    const card = document.querySelector(`.thought-card[data-id="${id}"]`);
    if (card) {
      card.style.transition = 'all 0.25s ease';
      card.style.opacity = '0';
      card.style.transform = 'scale(0.85)';
    }

    setTimeout(async () => {
      this.thoughts = this.thoughts.filter((t) => t._id !== id);
      this.render();
      this.initDraggable();
      Timeline.render();
    }, 250);
  },

  async archiveThought(id) {
    const thought = this.thoughts.find((t) => t._id === id);
    if (!thought) return;

    // Create an archive entry from the thought
    await store.createArchive({
      title: thought.content.length > 60
        ? thought.content.substring(0, 60) + '…'
        : thought.content,
      content: thought.content,
      images: [],
      tags: [...(thought.tags || [])],
      history: [],
    });

    // Animate the card out with an "archived" feel
    const card = document.querySelector(`.thought-card[data-id="${id}"]`);
    if (card) {
      card.style.transition = 'all 0.35s cubic-bezier(0.4, 0, 0.2, 1)';
      card.style.opacity = '0';
      card.style.transform = 'scale(0.88) translateY(-12px)';
      card.style.borderColor = 'var(--accent-primary)';
    }

    // Dismiss the thought from the canvas after animation
    setTimeout(async () => {
      await store.dismissThought(id);
      this.thoughts = this.thoughts.filter((t) => t._id !== id);
      this.render();
      this.initDraggable();
      Timeline.render();
      // Refresh archives if it's currently visible
      if (typeof Archives !== 'undefined' && Archives.initialized) {
        Archives.refresh();
      }
    }, 350);
  },

  async deleteThought(id) {
    await store.deleteThought(id);
    this.thoughts = this.thoughts.filter((t) => t._id !== id);
    this.finishedThoughts = this.finishedThoughts.filter((t) => t._id !== id);

    const card = document.querySelector(`.thought-card[data-id="${id}"]`);
    if (card) {
      card.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
      card.style.opacity = '0';
      card.style.transform = 'scale(0.9)';
      setTimeout(() => {
        card.remove();
        if (this.thoughts.length === 0) this.render();
      }, 200);
    }

    this.renderFinishedStack();
    Timeline.render();
  },

  // ─── Finished Stack ───

  initFinishedStack() {
    document.getElementById('finished-toggle').addEventListener('click', () => {
      this.finishedExpanded = !this.finishedExpanded;
      this.renderFinishedStack();
    });
  },

  renderFinishedStack() {
    const countEl = document.getElementById('finished-count');
    const list = document.getElementById('finished-list');
    const toggle = document.getElementById('finished-toggle');

    countEl.textContent = this.finishedThoughts.length;

    if (this.finishedExpanded) {
      toggle.classList.add('expanded');
    } else {
      toggle.classList.remove('expanded');
    }

    list.innerHTML = '';
    if (!this.finishedExpanded || this.finishedThoughts.length === 0) {
      list.style.display = 'none';
      return;
    }

    list.style.display = 'flex';

    // Sort by finishedAt (most recent first)
    const sorted = [...this.finishedThoughts].sort((a, b) =>
      new Date(b.finishedAt || b.updatedAt) - new Date(a.finishedAt || a.updatedAt)
    );

    sorted.forEach((thought) => {
      const item = document.createElement('div');
      item.className = 'finished-item';
      item.dataset.priority = thought.priority;

      const numSpan = thought.number ? `<span class="finished-num">#${thought.number}</span>` : '';
      const tagSpans = (thought.tags || []).map((t) => {
        const c = Tags.getTagColor(t);
        return `<span class="card-tag" style="background:${c.bg};color:${c.text}">${t}</span>`;
      }).join('');

      item.innerHTML = `
        <div class="finished-item-main">
          ${numSpan}
          <span class="finished-text">${Utils.escapeHtml(Utils.truncate(thought.content, 60))}</span>
          <div class="finished-tags">${tagSpans}</div>
        </div>
        <div class="finished-item-meta">
          <span class="finished-time">${Utils.formatTimestamp(thought.finishedAt || thought.updatedAt)}</span>
          <button class="finished-restore" title="Restore to canvas">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
            </svg>
          </button>
        </div>
      `;

      item.querySelector('.finished-restore').addEventListener('click', async (e) => {
        e.stopPropagation();
        await store.restoreThought(thought._id);
        this.finishedThoughts = this.finishedThoughts.filter((t) => t._id !== thought._id);
        thought.status = 'active';
        thought.finishedAt = null;
        this.thoughts.unshift(thought);
        this.render();
        this.initDraggable();
        Timeline.render();
      });

      list.appendChild(item);
    });
  },

  // ─── Draggable ───

  initDraggable() {
    if (!this.interactLib) return;

    this.interactLib('.thought-card').draggable({
      inertia: false,
      modifiers: [
        this.interactLib.modifiers.restrictRect({
          restriction: '#canvas-content',
          endOnly: false,
        }),
      ],
      autoScroll: {
        container: document.getElementById('canvas'),
        speed: 300,
        margin: 50,
      },
      listeners: {
        start: (event) => {
          event.target.classList.add('dragging');
        },
        move: (event) => {
          const target = event.target;
          const x = (parseFloat(target.style.left) || 0) + event.dx / (this.zoomLevel / 100);
          const y = (parseFloat(target.style.top) || 0) + event.dy / (this.zoomLevel / 100);

          target.style.left = `${x}px`;
          target.style.top = `${y}px`;
        },
        end: (event) => {
          const target = event.target;
          target.classList.remove('dragging');

          const id = target.dataset.id;
          const x = parseFloat(target.style.left) || 0;
          const y = parseFloat(target.style.top) || 0;

          // Detect priority zone from actual DOM zone positions
          const newPriority = this.detectPriorityZone(x);

          const thought = this.thoughts.find((t) => t._id === id);
          if (thought) {
            const updates = { x, y };
            if (newPriority && newPriority !== thought.priority) {
              updates.priority = newPriority;
              thought.priority = newPriority;
              target.dataset.priority = newPriority;
            }
            thought.x = x;
            thought.y = y;
            store.updateThought(id, updates);
          }
        },
      },
    });
  },

  // ─── Edit Modal ───

  initEditModal() {
    const overlay = document.getElementById('edit-overlay');
    const closeBtn = document.getElementById('edit-close');
    const saveBtn = document.getElementById('edit-save');
    const deleteBtn = document.getElementById('edit-delete');

    closeBtn.addEventListener('click', () => this.closeEditModal());
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.closeEditModal();
    });

    saveBtn.addEventListener('click', () => this.saveEdit());
    deleteBtn.addEventListener('click', () => {
      const id = document.getElementById('edit-thought-id').value;
      this.closeEditModal();
      this.deleteThought(id);
    });

    // Edit priority buttons
    document.querySelectorAll('.edit-priority-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.edit-priority-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // Edit persistence buttons
    document.querySelectorAll('.edit-persist-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.edit-persist-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const dateRow = document.getElementById('edit-date-row');
        dateRow.style.display = btn.dataset.persist === 'until_date' ? 'flex' : 'none';
      });
    });
  },

  async openEditModal(id) {
    const thought = await store.getThought(id);
    if (!thought) return;

    document.getElementById('edit-thought-id').value = id;
    document.getElementById('edit-input').value = thought.content;

    // Set priority
    document.querySelectorAll('.edit-priority-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.priority === thought.priority);
    });

    // Set persistence
    document.querySelectorAll('.edit-persist-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.persist === (thought.persistence || 'persistent'));
    });

    const dateRow = document.getElementById('edit-date-row');
    dateRow.style.display = thought.persistence === 'until_date' ? 'flex' : 'none';
    if (thought.expiresAt) {
      document.getElementById('edit-expires').value = thought.expiresAt.slice(0, 16);
    }

    // Set tags
    const tagContainer = document.getElementById('edit-tag-list');
    Tags.renderTagSelector(tagContainer, thought.tags || []);

    document.getElementById('edit-overlay').classList.add('visible');
    setTimeout(() => document.getElementById('edit-input').focus(), 100);
  },

  closeEditModal() {
    document.getElementById('edit-overlay').classList.remove('visible');
  },

  isSavingEdit: false,

  async saveEdit() {
    if (this.isSavingEdit) return;
    const id = document.getElementById('edit-thought-id').value;
    const content = document.getElementById('edit-input').value.trim();
    if (!content) return;

    this.isSavingEdit = true;
    const saveBtn = document.getElementById('edit-save');
    if (saveBtn) saveBtn.disabled = true;

    try {
      const priority = document.querySelector('.edit-priority-btn.active')?.dataset.priority || 'medium';
      const persistence = document.querySelector('.edit-persist-btn.active')?.dataset.persist || 'persistent';
      const selectedTags = Array.from(document.querySelectorAll('#edit-tag-list .tag-pill.selected'))
        .map((el) => el.dataset.name);

      const updates = { content, priority, tags: selectedTags, persistence };

      const thought = this.thoughts.find((t) => t._id === id);

      // Auto-arrange: if priority changed, move card to new zone
      if (thought && thought.priority !== priority) {
        const pos = this.findOpenPosition(priority);
        updates.x = pos.x;
        updates.y = pos.y;
      }

      if (persistence === 'until_date') {
        updates.expiresAt = document.getElementById('edit-expires').value
          ? new Date(document.getElementById('edit-expires').value).toISOString()
          : null;
      } else {
        updates.expiresAt = null;
      }

      await store.updateThought(id, updates);

      // Update local data
      if (thought) {
        Object.assign(thought, updates);
      }

      this.closeEditModal();
      this.render();
      this.initDraggable();
      Timeline.render();
    } finally {
      this.isSavingEdit = false;
      if (saveBtn) saveBtn.disabled = false;
    }
  },

  applyFilters() {
    const cards = document.querySelectorAll('.thought-card');
    cards.forEach((card) => {
      const id = card.dataset.id;
      const thought = this.thoughts.find((t) => t._id === id);
      if (thought && Tags.passesFilter(thought)) {
        card.style.display = '';
        card.style.animation = 'fadeIn 0.2s ease';
      } else {
        card.style.display = 'none';
      }
    });

    const container = document.getElementById('canvas-content');
    container.querySelectorAll('.canvas-empty').forEach((el) => el.remove());

    let visibleCount = 0;
    document.querySelectorAll('.thought-card').forEach((c) => {
      if (c.style.display !== 'none') visibleCount++;
    });

    if (visibleCount === 0 && this.thoughts.length > 0) {
      const empty = document.createElement('div');
      empty.className = 'canvas-empty';
      empty.innerHTML = `
        <p>No thoughts match the selected filters</p>
        <p class="text-sm text-muted">Try clearing the tag filter</p>
      `;
      container.appendChild(empty);
    }
  },

  highlightCard(id) {
    const card = document.querySelector(`.thought-card[data-id="${id}"]`);
    if (!card) return;

    const canvas = document.getElementById('canvas');
    const cardLeft = parseFloat(card.style.left) || 0;
    const cardTop = parseFloat(card.style.top) || 0;
    const scale = this.zoomLevel / 100;

    canvas.scrollTo({
      left: cardLeft * scale - canvas.offsetWidth / 2 + 130,
      top: cardTop * scale - canvas.offsetHeight / 2 + 50,
      behavior: 'smooth',
    });

    card.style.transition = 'box-shadow 0.3s ease, border-color 0.3s ease';
    card.style.boxShadow = '0 0 0 3px var(--accent-primary-light), var(--shadow-lg)';
    card.style.borderColor = 'var(--accent-primary)';

    setTimeout(() => {
      card.style.boxShadow = '';
      card.style.borderColor = '';
    }, 2000);
  },

  bindDblClick() {
    const content = document.getElementById('canvas-content');
    content.addEventListener('dblclick', (e) => {
      // Don't open if clicked on an existing card or its children
      if (e.target.closest('.thought-card')) {
        return;
      }

      // Get double-click coordinates relative to #canvas-content
      const rect = content.getBoundingClientRect();
      const scale = this.zoomLevel / 100;

      // Calculate coordinates in the native 2400x1600 coordinate system
      const x = (e.clientX - rect.left) / scale;
      const y = (e.clientY - rect.top) / scale;

      // Determine priority from actual DOM zone positions
      const priority = Canvas.detectPriorityZone(x);

      // Offset so the card aligns centrally on the user's cursor
      const adjustedX = Math.max(40, x - 130);
      const adjustedY = Math.max(60, y - 40);

      QuickAdd.open(priority, { x: adjustedX, y: adjustedY });
    });
  },

  initCanvasPanning() {
    const canvas = document.getElementById('canvas');
    if (!canvas) return;

    let isPanning = false;
    let hasMoved = false;
    let startX = 0;
    let startY = 0;
    let scrollLeft = 0;
    let scrollTop = 0;

    canvas.addEventListener('mousedown', (e) => {
      // Only pan on middle click OR if clicking directly on empty canvas
      if (e.target.closest('.thought-card') || e.target.closest('.finished-stack') || e.target.closest('button') || e.target.closest('input')) {
        // Allow middle mouse button to pan anywhere though
        if (e.button !== 1) return;
      }

      isPanning = true;
      hasMoved = false;
      startX = e.clientX;
      startY = e.clientY;
      scrollLeft = canvas.scrollLeft;
      scrollTop = canvas.scrollTop;

      // If middle click, prevent default scroll wheel behavior
      if (e.button === 1) e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!isPanning) return;

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      // Add panning class only if mouse has moved beyond a small threshold (3px)
      if (!hasMoved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
        hasMoved = true;
        canvas.classList.add('is-panning');
      }

      if (hasMoved) {
        e.preventDefault(); // Prevent text selection while dragging
        canvas.scrollLeft = scrollLeft - dx;
        canvas.scrollTop = scrollTop - dy;
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (isPanning) {
        isPanning = false;
        canvas.classList.remove('is-panning');
      }
    });
  },

  // ─── Utilities ───

  /**
   * Escape HTML and convert URLs to clickable links.
   */
  linkify(text) {
    if (!text) return '';
    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const urlRegex = /(https?:\/\/[^\s<]+)/g;
    return escaped.replace(urlRegex, (url) =>
      `<a href="${url}" title="${url}" class="card-link">${url}</a>`
    );
  },

  // ─── Comments System ───

  _activePopover: null,

  closeCommentPopover() {
    if (this._activePopover) {
      const card = this._activePopover.closest('.thought-card');
      if (card) card.classList.remove('has-popover');

      this._activePopover.remove();
      this._activePopover = null;
    }
  },

  toggleCommentPopover(thoughtId, anchorEl) {
    // If the same popover is already open, close it
    if (this._activePopover && this._activePopover.dataset.thoughtId === thoughtId) {
      this.closeCommentPopover();
      return;
    }
    this.closeCommentPopover();
    this.renderCommentPopover(thoughtId, anchorEl);
  },

  renderCommentPopover(thoughtId, anchorEl) {
    const thought = this.thoughts.find(t => t._id === thoughtId);
    if (!thought) return;

    const comments = thought.comments || [];

    const popover = document.createElement('div');
    popover.className = 'comment-popover';
    popover.dataset.thoughtId = thoughtId;

    // Header and Input
    popover.innerHTML = `
      <div class="comment-popover-header">
        <span class="comment-popover-title">💬 Comments</span>
        <button class="comment-popover-close">✕</button>
      </div>
      <div class="comment-add-row" style="border-bottom: 1px solid var(--border-color-light); border-top: none;">
        <input type="text" class="comment-add-input" placeholder="Add a comment..." />
        <button class="comment-add-btn">+</button>
      </div>
      <div class="comment-popover-list comment-timeline">
        ${comments.length === 0
        ? '<div class="comment-empty">No comments yet</div>'
        : comments.map((c, i) => ({ c, i })).reverse().map(({ c, i }, reversedIndex) => `
            <div class="comment-item ${reversedIndex === 0 ? 'latest-comment' : ''}" data-index="${i}">
              <div class="timeline-node"></div>
              <div class="comment-content-wrapper">
                <div class="comment-text">${this.linkify(c.text)}</div>
                <div class="comment-meta">
                  <span class="comment-time">${Utils.formatTimestamp(c.createdAt)}${c.editedAt ? ' (edited)' : ''}</span>
                  <div class="comment-actions">
                    <button class="comment-edit-btn" data-index="${i}" title="Edit">✏️</button>
                    <button class="comment-delete-btn" data-index="${i}" title="Delete">🗑️</button>
                  </div>
                </div>
              </div>
            </div>
          `).join('')
      }
      </div>
    `;

    // Position the popover relative to the card
    const card = anchorEl.closest('.thought-card');
    card.appendChild(popover);
    card.classList.add('has-popover');
    this._activePopover = popover;

    // Close button
    popover.querySelector('.comment-popover-close').addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeCommentPopover();
    });

    // Add comment
    const input = popover.querySelector('.comment-add-input');
    const addBtn = popover.querySelector('.comment-add-btn');

    const doAdd = () => {
      const text = input.value.trim();
      if (!text) return;
      this.addComment(thoughtId, text, anchorEl);
    };

    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      doAdd();
    });

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        doAdd();
      }
    });

    input.addEventListener('click', (e) => e.stopPropagation());

    // Prevent drag/pan interactions and unexpected closing when clicking inside popover
    popover.addEventListener('mousedown', (e) => e.stopPropagation());
    popover.addEventListener('touchstart', (e) => e.stopPropagation());

    // Edit buttons
    popover.querySelectorAll('.comment-edit-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.index);
        this.editComment(thoughtId, idx, anchorEl);
      });
    });

    // Delete buttons
    popover.querySelectorAll('.comment-delete-btn').forEach(btn => {
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const idx = parseInt(btn.dataset.index);
        this.deleteComment(thoughtId, idx, anchorEl);
      });
    });

    // Focus input
    setTimeout(() => input.focus(), 50);

    // Keep popover alive when hovering inside it
    popover.addEventListener('mouseenter', () => { popover._hovered = true; });
    popover.addEventListener('mouseleave', (e) => {
      popover._hovered = false;
      const related = e.relatedTarget;
      const card = popover.closest('.thought-card');
      if (card && (card.contains(related) || related === card)) return;
      setTimeout(() => {
        // Only close if THIS popover is still the active one!
        if (this._activePopover === popover && !popover._hovered && !(card && card.matches(':hover'))) {
          this.closeCommentPopover();
        }
      }, 300);
    });

    // Close when clicking outside
    const closeHandler = (e) => {
      if (!popover.contains(e.target) && e.target !== anchorEl && !anchorEl.contains(e.target)) {
        this.closeCommentPopover();
        document.removeEventListener('mousedown', closeHandler);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', closeHandler), 100);
  },

  async addComment(thoughtId, text, anchorEl) {
    const thought = this.thoughts.find(t => t._id === thoughtId);
    if (!thought) return;

    if (!thought.comments) thought.comments = [];
    thought.comments.push({
      text,
      createdAt: new Date().toISOString(),
    });

    await store.updateThought(thoughtId, { comments: thought.comments });

    // Update the cloud icon locally without reloading the whole canvas
    const validComments = thought.comments.filter(c => c && c.text && c.text.trim().length > 0);
    const hasComments = validComments.length > 0;
    anchorEl.className = `comment-cloud ${hasComments ? 'has-comments' : ''}`;
    anchorEl.title = hasComments ? `${validComments.length} comment${validComments.length > 1 ? 's' : ''}` : 'Add a comment';
    anchorEl.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="${hasComments ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>${hasComments ? `<span class="comment-count">${validComments.length}</span>` : ''}`;

    // Re-render only the popover
    this.closeCommentPopover();
    this.renderCommentPopover(thoughtId, anchorEl);
  },

  isDeletingComment: false,

  async deleteComment(thoughtId, index, anchorEl) {
    if (this.isDeletingComment) return;

    const thought = this.thoughts.find(t => t._id === thoughtId);
    if (!thought || !thought.comments) return;

    if (index < 0 || index >= thought.comments.length) return;

    this.isDeletingComment = true;
    try {
      thought.comments.splice(index, 1);
      await store.updateThought(thoughtId, { comments: thought.comments });

      // Update the cloud icon locally without reloading the whole canvas
      const validComments = thought.comments.filter(c => c && c.text && c.text.trim().length > 0);
      const hasComments = validComments.length > 0;
      anchorEl.className = `comment-cloud ${hasComments ? 'has-comments' : ''}`;
      anchorEl.title = hasComments ? `${validComments.length} comment${validComments.length > 1 ? 's' : ''}` : 'Add a comment';
      anchorEl.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="${hasComments ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>${hasComments ? `<span class="comment-count">${validComments.length}</span>` : ''}`;

      this.closeCommentPopover();

      if (hasComments) {
        this.renderCommentPopover(thoughtId, anchorEl);
      }
    } finally {
      this.isDeletingComment = false;
    }
  },

  editComment(thoughtId, index, anchorEl) {
    const thought = this.thoughts.find(t => t._id === thoughtId);
    if (!thought || !thought.comments || !thought.comments[index]) return;

    const comment = thought.comments[index];
    const popover = this._activePopover;
    if (!popover) return;

    const item = popover.querySelector(`.comment-item[data-index="${index}"]`);
    if (!item) return;

    // Replace the comment text with an inline edit input
    const originalText = comment.text;
    item.innerHTML = `
      <div class="comment-edit-row">
        <input type="text" class="comment-edit-input" value="${originalText.replace(/"/g, '&quot;')}" />
        <button class="comment-save-edit-btn" title="Save">✓</button>
        <button class="comment-cancel-edit-btn" title="Cancel">✕</button>
      </div>
    `;

    const editInput = item.querySelector('.comment-edit-input');
    const saveBtn = item.querySelector('.comment-save-edit-btn');
    const cancelBtn = item.querySelector('.comment-cancel-edit-btn');

    editInput.focus();
    editInput.addEventListener('click', (e) => e.stopPropagation());
    editInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        this.saveCommentEdit(thoughtId, index, editInput.value.trim(), anchorEl);
      }
      if (e.key === 'Escape') {
        this.closeCommentPopover();
        setTimeout(() => {
          const newCard = document.querySelector(`.thought-card[data-id="${thoughtId}"]`);
          if (newCard) {
            const newCloud = newCard.querySelector('.comment-cloud');
            if (newCloud) this.renderCommentPopover(thoughtId, newCloud);
          }
        }, 50);
      }
    });

    saveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.saveCommentEdit(thoughtId, index, editInput.value.trim(), anchorEl);
    });

    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeCommentPopover();
      setTimeout(() => {
        const newCard = document.querySelector(`.thought-card[data-id="${thoughtId}"]`);
        if (newCard) {
          const newCloud = newCard.querySelector('.comment-cloud');
          if (newCloud) this.renderCommentPopover(thoughtId, newCloud);
        }
      }, 50);
    });
  },

  async saveCommentEdit(thoughtId, index, newText, anchorEl) {
    if (!newText) return;

    const thought = this.thoughts.find(t => t._id === thoughtId);
    if (!thought || !thought.comments || !thought.comments[index]) return;

    thought.comments[index].text = newText;
    thought.comments[index].editedAt = new Date().toISOString();

    await store.updateThought(thoughtId, { comments: thought.comments });

    this.closeCommentPopover();
    this.render();
    this.initDraggable();

    setTimeout(() => {
      const newCard = document.querySelector(`.thought-card[data-id="${thoughtId}"]`);
      if (newCard) {
        const newCloud = newCard.querySelector('.comment-cloud');
        if (newCloud) this.renderCommentPopover(thoughtId, newCloud);
      }
    }, 50);
  },
};

window.Canvas = Canvas;
