/* ═══════════════════════════════════════════════════════════════
   Calendar — Events, reminders, dashboard, notifications
   ═══════════════════════════════════════════════════════════════ */

const Calendar = {
  events: [],
  stats: {},
  view: 'dashboard',
  currentDate: new Date(),
  selectedDate: new Date(),
  editingId: null,
  modalCal: null,
  filters: { query: '', category: 'all', status: 'all', dateFrom: '', dateTo: '', year: '', month: '' },
  dragEventId: null,
  initialized: false,

  CATEGORY_COLORS: {
    meeting: '#6366f1',
    task: '#10b981',
    reminder: '#f59e0b',
    personal: '#ec4899',
    work: '#3b82f6',
    custom: '#8b5cf6',
  },

  REMINDER_OPTIONS: [
    { value: 0, label: 'At event time' },
    { value: 5, label: '5 minutes before' },
    { value: 15, label: '15 minutes before' },
    { value: 30, label: '30 minutes before' },
    { value: 60, label: '1 hour before' },
    { value: 1440, label: '1 day before' },
    { value: -1, label: 'Custom (minutes)' },
  ],

  async init() {
    if (this.initialized) return;
    this.initialized = true;
    this.populateYearFilter();
    await this.refresh();
    this.bindEvents();
    this.bindNotifications();
    this.render();
  },

  populateYearFilter() {
    const sel = document.getElementById('cal-filter-year');
    if (!sel || sel.options.length > 1) return;
    const year = new Date().getFullYear();
    for (let y = year + 1; y >= year - 5; y--) {
      const opt = document.createElement('option');
      opt.value = String(y);
      opt.textContent = String(y);
      sel.appendChild(opt);
    }
  },

  async refresh() {
    this.events = await store.getAllCalendarEvents();
    this.stats = await store.getCalendarStats();
    this.render();
  },

  bindNotifications() {
    window.electronAPI.onCalendarNotification((data) => this.showNotification(data));
    window.electronAPI.onCalendarOpenEvent((data) => {
      if (data?.eventId) this.openEventById(data.eventId);
    });
    window.electronAPI.onCalendarOpenEventModal((prefill) => {
      App.switchView('calendar');
      this.openModal(null, prefill);
    });
  },

  bindEvents() {
    document.querySelectorAll('.cal-view-tab').forEach((tab) => {
      tab.addEventListener('click', () => this.setView(tab.dataset.calView));
    });

    document.getElementById('cal-prev-period')?.addEventListener('click', () => this.navigatePeriod(-1));
    document.getElementById('cal-next-period')?.addEventListener('click', () => this.navigatePeriod(1));
    document.getElementById('cal-today-btn')?.addEventListener('click', () => {
      this.currentDate = new Date();
      this.selectedDate = new Date();
      this.render();
    });

    document.getElementById('cal-add-btn')?.addEventListener('click', () => this.openModal());
    document.getElementById('fab-add-event')?.addEventListener('click', () => this.openModal());

    document.getElementById('cal-modal-close')?.addEventListener('click', () => this.closeModal());
    document.getElementById('cal-modal-overlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'cal-modal-overlay') this.closeModal();
    });
    document.getElementById('cal-modal-save')?.addEventListener('click', () => this.saveEvent());
    document.getElementById('cal-modal-delete')?.addEventListener('click', () => this.deleteEvent());
    document.getElementById('cal-modal-complete')?.addEventListener('click', () => this.completeEvent());

    document.getElementById('cal-reminder-select')?.addEventListener('change', (e) => {
      const custom = document.getElementById('cal-reminder-custom');
      if (custom) custom.style.display = e.target.value === '-1' ? '' : 'none';
    });

    const search = document.getElementById('cal-history-search');
    let debounce;
    search?.addEventListener('input', (e) => {
      this.filters.query = e.target.value;
      clearTimeout(debounce);
      debounce = setTimeout(() => this.renderHistory(), 250);
    });

    ['cal-filter-category', 'cal-filter-status', 'cal-filter-year', 'cal-filter-month', 'cal-filter-from', 'cal-filter-to'].forEach((id) => {
      document.getElementById(id)?.addEventListener('change', (e) => {
        const key = id.replace('cal-filter-', '');
        if (key === 'from') this.filters.dateFrom = e.target.value;
        else if (key === 'to') this.filters.dateTo = e.target.value;
        else this.filters[key] = e.target.value;
        this.renderHistory();
      });
    });
  },

  setView(view) {
    this.view = view;
    document.querySelectorAll('.cal-view-tab').forEach((t) => {
      t.classList.toggle('active', t.dataset.calView === view);
    });
    document.querySelectorAll('.cal-panel').forEach((p) => {
      p.classList.toggle('active', p.dataset.calPanel === view);
    });
    this.render();
  },

  navigatePeriod(dir) {
    const d = new Date(this.currentDate);
    if (this.view === 'month') d.setMonth(d.getMonth() + dir);
    else if (this.view === 'week') d.setDate(d.getDate() + dir * 7);
    else d.setDate(d.getDate() + dir);
    this.currentDate = d;
    this.render();
  },

  getEventDateTime(event) {
    const [h, m] = (event.event_time || '09:00').split(':').map(Number);
    const dt = new Date(event.event_date + 'T00:00:00');
    dt.setHours(h, m, 0, 0);
    return dt;
  },

  formatTime24(timeStr) {
    const [h, m] = (timeStr || '09:00').split(':').map(Number);
    const d = new Date();
    d.setHours(h, m);
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  },

  eventsForDate(dateKey) {
    return this.events
      .filter((e) => e.event_date === dateKey && e.status !== 'cancelled')
      .sort((a, b) => a.event_time.localeCompare(b.event_time));
  },

  render() {
    this.renderPeriodLabel();
    if (this.view === 'dashboard') this.renderDashboard();
    else if (this.view === 'month') this.renderMonth();
    else if (this.view === 'week') this.renderWeek();
    else if (this.view === 'day') this.renderDay();
    if (this.view === 'dashboard' || this.view === 'history') this.renderHistory();
  },

  renderPeriodLabel() {
    const el = document.getElementById('cal-period-label');
    if (!el) return;
    const d = this.currentDate;
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    if (this.view === 'month') el.textContent = `${months[d.getMonth()]} ${d.getFullYear()}`;
    else if (this.view === 'week') {
      const start = this.getWeekStart(d);
      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      el.textContent = `${start.toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`;
    } else if (this.view === 'day') {
      el.textContent = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    } else {
      el.textContent = 'Calendar';
    }
  },

  getWeekStart(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - d.getDay());
    return d;
  },

  renderDashboard() {
    const s = this.stats;
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('cal-stat-total', s.total ?? 0);
    set('cal-stat-upcoming', s.upcoming ?? 0);
    set('cal-stat-completed', s.completed ?? 0);
    set('cal-stat-overdue', s.overdue ?? 0);

    const now = Date.now();
    const todayKey = new Date().toISOString().slice(0, 10);

    const upcoming = this.events
      .filter((e) => e.status === 'upcoming' && this.getEventDateTime(e).getTime() >= now)
      .sort((a, b) => this.getEventDateTime(a) - this.getEventDateTime(b))
      .slice(0, 10);

    const today = this.eventsForDate(todayKey);
    const overdue = this.events.filter((e) => e.status === 'overdue');
    const completed = this.events.filter((e) => e.status === 'completed').slice(0, 8);

    this.renderEventCards('cal-list-upcoming', upcoming);
    this.renderEventCards('cal-list-today', today);
    this.renderEventCards('cal-list-overdue', overdue);
    this.renderEventCards('cal-list-completed', completed);
  },

  renderEventCards(containerId, events) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (!events.length) {
      container.innerHTML = '<p class="cal-empty-list">No events</p>';
      return;
    }
    container.innerHTML = '';
    events.forEach((ev) => container.appendChild(this.createEventCard(ev)));
  },

  createEventCard(event, opts = {}) {
    const card = document.createElement('div');
    card.className = 'cal-event-card';
    card.style.borderLeftColor = this.CATEGORY_COLORS[event.category] || '#6366f1';
    card.dataset.id = event._id;
    card.draggable = !!opts.draggable;

    const dt = this.getEventDateTime(event);
    card.innerHTML = `
      <div class="cal-event-card-main">
        <span class="cal-event-card-title">${this.escape(event.event_title)}</span>
        <span class="cal-event-card-meta">${Utils.formatDate(event.event_date)} · ${this.formatTime24(event.event_time)}</span>
        ${event.event_description ? `<span class="cal-event-card-desc">${this.escape(event.event_description.slice(0, 60))}</span>` : ''}
      </div>
      <span class="cal-event-badge cal-badge-${event.category}">${event.category}</span>
      <span class="cal-event-status cal-status-${event.status}">${event.status}</span>
    `;

    card.title = `${event.event_title}\n${event.event_date} ${this.formatTime24(event.event_time)}\n${event.event_description || ''}`;

    card.addEventListener('click', () => this.openModal(event._id));
    if (opts.draggable) {
      card.addEventListener('dragstart', (e) => {
        this.dragEventId = event._id;
        e.dataTransfer.setData('text/plain', event._id);
      });
    }
    return card;
  },

  renderMonth() {
    const grid = document.getElementById('cal-month-grid');
    if (!grid) return;
    const year = this.currentDate.getFullYear();
    const month = this.currentDate.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    let html = dayNames.map((n) => `<div class="cal-month-dayname">${n}</div>`).join('');
    for (let i = 0; i < firstDay; i++) html += '<div class="cal-month-cell empty"></div>';

    for (let d = 1; d <= daysInMonth; d++) {
      const dateKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const dayEvents = this.eventsForDate(dateKey);
      const isToday = dateKey === new Date().toISOString().slice(0, 10);
      html += `<div class="cal-month-cell ${isToday ? 'today' : ''}" data-date="${dateKey}">
        <span class="cal-month-daynum">${d}</span>
        <div class="cal-month-events">${dayEvents.map((ev) =>
          `<div class="cal-month-chip cal-cat-${ev.category}" draggable="true" data-id="${ev._id}" title="${this.escape(ev.event_title)}">${this.escape(ev.event_title)}</div>`
        ).join('')}</div>
      </div>`;
    }

    grid.innerHTML = html;
    this.bindMonthDragDrop(grid);
  },

  bindMonthDragDrop(grid) {
    grid.querySelectorAll('.cal-month-chip').forEach((chip) => {
      chip.addEventListener('dragstart', (e) => {
        this.dragEventId = chip.dataset.id;
        e.dataTransfer.setData('text/plain', chip.dataset.id);
        e.stopPropagation();
      });
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        this.openModal(chip.dataset.id);
      });
    });

    grid.querySelectorAll('.cal-month-cell:not(.empty)').forEach((cell) => {
      cell.addEventListener('dragover', (e) => { e.preventDefault(); cell.classList.add('drag-over'); });
      cell.addEventListener('dragleave', () => cell.classList.remove('drag-over'));
      cell.addEventListener('drop', async (e) => {
        e.preventDefault();
        cell.classList.remove('drag-over');
        const id = e.dataTransfer.getData('text/plain') || this.dragEventId;
        if (!id) return;
        await store.updateCalendarEvent(id, { event_date: cell.dataset.date });
        SmartActions.toast('Event rescheduled');
        await this.refresh();
      });
      cell.addEventListener('click', () => {
        this.selectedDate = new Date(cell.dataset.date + 'T00:00:00');
        this.setView('day');
        this.currentDate = new Date(this.selectedDate);
      });
    });
  },

  renderWeek() {
    const grid = document.getElementById('cal-week-grid');
    if (!grid) return;
    const start = this.getWeekStart(this.currentDate);
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      days.push(d);
    }

    grid.innerHTML = days.map((d) => {
      const key = d.toISOString().slice(0, 10);
      const evs = this.eventsForDate(key);
      const isToday = key === new Date().toISOString().slice(0, 10);
      return `<div class="cal-week-col ${isToday ? 'today' : ''}" data-date="${key}">
        <div class="cal-week-header">${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</div>
        <div class="cal-week-events">${evs.map((ev) =>
          `<div class="cal-week-event cal-cat-${ev.category}" data-id="${ev._id}" title="${this.escape(ev.event_title)}">
            <span class="cal-week-time">${this.formatTime24(ev.event_time)}</span>
            <span>${this.escape(ev.event_title)}</span>
          </div>`
        ).join('')}</div>
      </div>`;
    }).join('');

    grid.querySelectorAll('.cal-week-event').forEach((el) => {
      el.addEventListener('click', () => this.openModal(el.dataset.id));
    });
  },

  renderDay() {
    const container = document.getElementById('cal-day-timeline');
    if (!container) return;
    const key = this.currentDate.toISOString().slice(0, 10);
    const evs = this.eventsForDate(key);

    if (!evs.length) {
      container.innerHTML = '<p class="cal-empty-list">No events scheduled for this day</p>';
      return;
    }

    container.innerHTML = '';
    evs.forEach((ev) => {
      const row = document.createElement('div');
      row.className = 'cal-day-slot';
      row.style.borderLeftColor = this.CATEGORY_COLORS[ev.category];
      row.innerHTML = `
        <span class="cal-day-time">${this.formatTime24(ev.event_time)}</span>
        <div class="cal-day-info">
          <strong>${this.escape(ev.event_title)}</strong>
          <span class="cal-day-cat">${ev.category} · ${ev.priority} priority</span>
          ${ev.event_description ? `<p>${this.escape(ev.event_description)}</p>` : ''}
        </div>
      `;
      row.addEventListener('click', () => this.openModal(ev._id));
      container.appendChild(row);
    });
  },

  renderHistory() {
    const list = document.getElementById('cal-history-list');
    if (!list) return;

    const filters = { ...this.filters };
    if (filters.year && filters.month) {
      filters.month = parseInt(filters.month, 10);
      filters.year = parseInt(filters.year, 10);
    }

    store.searchCalendarEvents(filters).then((results) => {
      list.innerHTML = '';
      if (!results.length) {
        list.innerHTML = '<p class="cal-empty-list">No matching events in history</p>';
        return;
      }
      results.forEach((ev) => list.appendChild(this.createEventCard(ev)));
    });
  },

  openModal(id = null, prefill = null) {
    this.editingId = id;
    const overlay = document.getElementById('cal-modal-overlay');
    const heading = document.getElementById('cal-modal-heading');
    const deleteBtn = document.getElementById('cal-modal-delete');
    const completeBtn = document.getElementById('cal-modal-complete');
    const datesEl = document.getElementById('cal-modal-dates');

    let data = prefill || {};
    if (id) {
      const ev = this.events.find((e) => e._id === id);
      if (ev) data = ev;
      heading.textContent = 'Edit Event';
      deleteBtn.style.display = '';
      completeBtn.style.display = '';
      datesEl.innerHTML = `<span>Created: ${Utils.formatTimestamp(data.created_at)}</span><span>Modified: ${Utils.formatTimestamp(data.updated_at)}</span>`;
      datesEl.style.display = '';
    } else {
      heading.textContent = 'New Event';
      deleteBtn.style.display = 'none';
      completeBtn.style.display = 'none';
      datesEl.style.display = 'none';
      if (!data.event_date) data.event_date = new Date().toISOString().slice(0, 10);
      if (!data.event_time) data.event_time = '09:00';
    }

    document.getElementById('cal-event-title').value = data.event_title || '';
    document.getElementById('cal-event-desc').value = data.event_description || '';
    document.getElementById('cal-event-date').value = data.event_date || '';
    document.getElementById('cal-event-time').value = data.event_time || '09:00';
    document.getElementById('cal-event-category').value = data.category || 'meeting';
    document.getElementById('cal-event-priority').value = data.priority || 'medium';
    document.getElementById('cal-event-repeat').value = data.repeat_type || 'none';

    const reminderSel = document.getElementById('cal-reminder-select');
    const customMin = document.getElementById('cal-reminder-custom');
    const rm = data.reminder_minutes ?? 15;
    const hasPreset = this.REMINDER_OPTIONS.some((o) => o.value === rm);
    reminderSel.value = hasPreset ? String(rm) : '-1';
    customMin.value = hasPreset ? '' : rm;
    customMin.style.display = reminderSel.value === '-1' ? '' : 'none';

    if (!this.modalCal) {
      this.modalCal = new MiniCalendar('cal-modal-picker', {
        allowPast: true,
        onDateSelect: (d) => {
          document.getElementById('cal-event-date').value = d.toISOString().slice(0, 10);
        },
        eventDates: this.events.map((e) => e.event_date),
      });
    } else {
      this.modalCal.setEventDates(this.events.map((e) => e.event_date));
      if (data.event_date) {
        const d = new Date(data.event_date + 'T00:00:00');
        this.modalCal.selectedDate = d;
        this.modalCal.setMonth(d.getFullYear(), d.getMonth());
      }
    }

    overlay.classList.add('visible');
    document.getElementById('cal-event-title').focus();
  },

  closeModal() {
    document.getElementById('cal-modal-overlay')?.classList.remove('visible');
    this.editingId = null;
  },

  async saveEvent() {
    const title = document.getElementById('cal-event-title').value.trim();
    const date = document.getElementById('cal-event-date').value;
    const time = document.getElementById('cal-event-time').value;
    if (!title || !date || !time) {
      SmartActions.toast('Title, date, and time are required');
      return;
    }

    const reminderSel = document.getElementById('cal-reminder-select');
    let reminderMinutes = parseInt(reminderSel.value, 10);
    if (reminderSel.value === '-1') {
      reminderMinutes = parseInt(document.getElementById('cal-reminder-custom').value, 10) || 15;
    }

    const payload = {
      event_title: title,
      event_description: document.getElementById('cal-event-desc').value,
      event_date: date,
      event_time: time,
      category: document.getElementById('cal-event-category').value,
      priority: document.getElementById('cal-event-priority').value,
      repeat_type: document.getElementById('cal-event-repeat').value,
      reminder_minutes: reminderMinutes,
      status: 'upcoming',
    };

    if (this.editingId) {
      await store.updateCalendarEvent(this.editingId, payload);
      SmartActions.toast('Event updated');
    } else {
      await store.createCalendarEvent(payload);
      SmartActions.toast('Event created');
    }

    this.closeModal();
    await this.refresh();
  },

  async deleteEvent() {
    if (!this.editingId) return;
    const ev = this.events.find((e) => e._id === this.editingId);
    if (!ev || !confirm(`Delete "${ev.event_title}"?`)) return;
    await store.deleteCalendarEvent(this.editingId);
    SmartActions.toast('Event deleted');
    this.closeModal();
    await this.refresh();
  },

  async completeEvent() {
    if (!this.editingId) return;
    await store.updateCalendarEvent(this.editingId, { status: 'completed' });
    SmartActions.toast('Event marked complete');
    this.closeModal();
    await this.refresh();
  },

  openEventById(id) {
    App.switchView('calendar');
    this.openModal(id);
  },

  showNotification(data) {
    let panel = document.getElementById('cal-notification-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'cal-notification-panel';
      panel.className = 'cal-notification-panel';
      document.body.appendChild(panel);
    }

    const item = document.createElement('div');
    item.className = 'cal-notification-item';
    item.innerHTML = `
      <div class="cal-notification-content">
        <strong>${this.escape(data.title)}</strong>
        <span>${data.date} at ${this.formatTime24(data.time)}</span>
        ${data.description ? `<p>${this.escape(data.description)}</p>` : ''}
      </div>
      <div class="cal-notification-actions">
        <button type="button" data-action="open">Open</button>
        <button type="button" data-action="snooze-5">5 min</button>
        <button type="button" data-action="snooze-10">10 min</button>
        <button type="button" data-action="snooze-30">30 min</button>
        <button type="button" data-action="snooze-60">1 hour</button>
        <button type="button" data-action="dismiss">Dismiss</button>
      </div>
    `;

    item.querySelector('[data-action="open"]').addEventListener('click', () => {
      this.openEventById(data.eventId);
      item.remove();
    });
    [[5, 'snooze-5'], [10, 'snooze-10'], [30, 'snooze-30'], [60, 'snooze-60']].forEach(([mins, action]) => {
      item.querySelector(`[data-action="${action}"]`)?.addEventListener('click', async () => {
        await store.snoozeCalendarEvent(data.eventId, mins);
        SmartActions.toast(`Snoozed ${mins} minute${mins === 1 ? '' : 's'}`);
        item.remove();
      });
    });
    item.querySelector('[data-action="dismiss"]').addEventListener('click', async () => {
      await store.dismissCalendarNotification(data.eventId);
      item.remove();
    });

    panel.prepend(item);
    setTimeout(() => item.classList.add('visible'), 10);
    setTimeout(() => { if (item.parentNode) item.remove(); }, 60000);
  },

  escape(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },
};

window.Calendar = Calendar;
