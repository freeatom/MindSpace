const { Notification } = require('electron');
const calendarStore = require('./calendar-store');

class CalendarScheduler {
  constructor(getMainWindow) {
    this.getMainWindow = getMainWindow;
    this.timers = new Map();
    this.pollInterval = null;
  }

  async start() {
    await calendarStore.markOverdue();
    await this.rescheduleAll();
    this.pollInterval = setInterval(async () => {
      await calendarStore.markOverdue();
      await this.rescheduleAll();
    }, 60000);
  }

  stop() {
    if (this.pollInterval) clearInterval(this.pollInterval);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  clearTimers() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  async rescheduleAll() {
    this.clearTimers();
    const events = await calendarStore.getAll();
    const now = Date.now();

    for (const event of events) {
      if (event.status === 'cancelled' || event.status === 'completed') continue;
      this.scheduleReminders(event, now);
    }
  }

  scheduleReminders(event, now = Date.now()) {
    const eventMs = calendarStore.getEventTimestamp(event);
    const reminderMin = event.reminder_minutes ?? 15;
    const snoozedUntil = event.snoozed_until ? new Date(event.snoozed_until).getTime() : 0;

    const schedules = [];
    if (reminderMin > 0) {
      schedules.push({ at: eventMs - reminderMin * 60000, type: 'reminder' });
    }
    schedules.push({ at: eventMs, type: 'start' });

    for (const sched of schedules) {
      const effectiveAt = Math.max(sched.at, snoozedUntil);
      if (effectiveAt <= now) continue;
      const delay = effectiveAt - now;
      const key = `${event._id}_${sched.type}_${sched.at}`;
      const timer = setTimeout(() => this.fire(event, sched.type), delay);
      this.timers.set(key, timer);
    }
  }

  async fire(event, type) {
    const fresh = await calendarStore.getById(event._id);
    if (!fresh || fresh.status === 'cancelled' || fresh.status === 'completed') return;

    this.showNativeNotification(fresh, type);
    const win = this.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('calendar-notification', {
        eventId: fresh._id,
        title: fresh.event_title,
        date: fresh.event_date,
        time: fresh.event_time,
        description: fresh.event_description,
        category: fresh.category,
        type,
      });
    }

    if (type === 'start' && fresh.repeat_type && fresh.repeat_type !== 'none') {
      const nextDate = calendarStore.advanceDate(fresh.event_date, fresh.repeat_type);
      await calendarStore.update(fresh._id, {
        event_date: nextDate,
        status: 'upcoming',
        snoozed_until: null,
      });
      const updated = await calendarStore.getById(fresh._id);
      this.scheduleReminders(updated);
    } else if (type === 'start') {
      await calendarStore.update(fresh._id, { status: 'completed', snoozed_until: null });
    }

    await this.rescheduleAll();
  }

  showNativeNotification(event, type) {
    if (!Notification.isSupported()) return;
    const label = type === 'start' ? 'Starting now' : 'Reminder';
    const n = new Notification({
      title: `${label}: ${event.event_title}`,
      body: `${event.event_date} at ${event.event_time}${event.event_description ? `\n${event.event_description}` : ''}`,
    });
    n.on('click', () => {
      const win = this.getMainWindow();
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        win.webContents.send('calendar-open-event', { eventId: event._id });
      }
    });
    n.show();
  }

  async snooze(eventId, minutes) {
    const until = new Date(Date.now() + minutes * 60000).toISOString();
    await calendarStore.update(eventId, { snoozed_until: until });
    await this.rescheduleAll();
  }

  async dismiss(eventId) {
    await calendarStore.update(eventId, { snoozed_until: null });
  }
}

module.exports = CalendarScheduler;
