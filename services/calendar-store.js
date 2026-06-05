const path = require('path');
const fs = require('fs');
const Datastore = require('nedb-promises');

let eventsDb = null;

const CATEGORIES = ['meeting', 'task', 'reminder', 'personal', 'work', 'custom'];
const PRIORITIES = ['high', 'medium', 'low'];
const REPEAT_TYPES = ['none', 'daily', 'weekly', 'monthly', 'yearly'];
const STATUSES = ['upcoming', 'completed', 'cancelled', 'overdue'];

async function init(userDataPath) {
  const dir = path.join(userDataPath, 'mindspace-data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  eventsDb = Datastore.create({
    filename: path.join(dir, 'calendar_events.db'),
    autoload: true,
  });
}

function ensureReady() {
  if (!eventsDb) throw new Error('Calendar database not initialized');
}

function getEventTimestamp(event) {
  const [h, m] = (event.event_time || '09:00').split(':').map(Number);
  const d = new Date(event.event_date);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

function normalizeEvent(data) {
  const now = new Date().toISOString();
  return {
    event_title: (data.event_title || data.title || 'Untitled Event').trim(),
    event_description: data.event_description || data.description || '',
    event_date: data.event_date,
    event_time: data.event_time || '09:00',
    category: CATEGORIES.includes(data.category) ? data.category : 'meeting',
    priority: PRIORITIES.includes(data.priority) ? data.priority : 'medium',
    reminder_minutes: data.reminder_minutes ?? 15,
    repeat_type: REPEAT_TYPES.includes(data.repeat_type) ? data.repeat_type : 'none',
    status: STATUSES.includes(data.status) ? data.status : 'upcoming',
    created_by: data.created_by || 'user',
    created_at: data.created_at || now,
    updated_at: now,
    snoozed_until: data.snoozed_until || null,
  };
}

async function create(data) {
  ensureReady();
  const doc = normalizeEvent(data);
  return eventsDb.insert(doc);
}

async function update(id, updates) {
  ensureReady();
  const patch = { updated_at: new Date().toISOString() };
  if (updates.event_title !== undefined) patch.event_title = updates.event_title.trim() || 'Untitled Event';
  if (updates.event_description !== undefined) patch.event_description = updates.event_description;
  if (updates.event_date !== undefined) patch.event_date = updates.event_date;
  if (updates.event_time !== undefined) patch.event_time = updates.event_time;
  if (updates.category !== undefined) patch.category = CATEGORIES.includes(updates.category) ? updates.category : 'meeting';
  if (updates.priority !== undefined) patch.priority = PRIORITIES.includes(updates.priority) ? updates.priority : 'medium';
  if (updates.reminder_minutes !== undefined) patch.reminder_minutes = updates.reminder_minutes;
  if (updates.repeat_type !== undefined) patch.repeat_type = REPEAT_TYPES.includes(updates.repeat_type) ? updates.repeat_type : 'none';
  if (updates.status !== undefined) patch.status = STATUSES.includes(updates.status) ? updates.status : 'upcoming';
  if (updates.snoozed_until !== undefined) patch.snoozed_until = updates.snoozed_until;
  await eventsDb.update({ _id: id }, { $set: patch });
  return getById(id);
}

async function remove(id) {
  ensureReady();
  return eventsDb.remove({ _id: id });
}

async function getById(id) {
  ensureReady();
  return eventsDb.findOne({ _id: id });
}

async function getAll() {
  ensureReady();
  return eventsDb.find({}).sort({ event_date: 1, event_time: 1 });
}

async function search({ query, category, status, dateFrom, dateTo, year, month } = {}) {
  ensureReady();
  let all = await eventsDb.find({});

  if (query && query.trim()) {
    const q = query.trim().toLowerCase();
    all = all.filter(
      (e) =>
        (e.event_title || '').toLowerCase().includes(q) ||
        (e.event_description || '').toLowerCase().includes(q)
    );
  }
  if (category && category !== 'all') {
    all = all.filter((e) => e.category === category);
  }
  if (status && status !== 'all') {
    all = all.filter((e) => e.status === status);
  }
  if (dateFrom) {
    all = all.filter((e) => e.event_date >= dateFrom);
  }
  if (dateTo) {
    all = all.filter((e) => e.event_date <= dateTo);
  }
  if (year) {
    all = all.filter((e) => e.event_date.startsWith(String(year)));
  }
  if (month) {
    const prefix = `${year || new Date().getFullYear()}-${String(month).padStart(2, '0')}`;
    all = all.filter((e) => e.event_date.startsWith(prefix));
  }

  return all.sort((a, b) => getEventTimestamp(b) - getEventTimestamp(a));
}

async function getStats(referenceDate = new Date()) {
  ensureReady();
  const all = await eventsDb.find({});
  const todayKey = referenceDate.toISOString().slice(0, 10);
  const now = Date.now();

  const upcoming = all.filter((e) => e.status === 'upcoming' && getEventTimestamp(e) >= now);
  const today = all.filter((e) => e.event_date === todayKey && e.status !== 'cancelled');
  const overdue = all.filter((e) => e.status === 'overdue' || (e.status === 'upcoming' && getEventTimestamp(e) < now));
  const completed = all.filter((e) => e.status === 'completed');

  const monthPrefix = todayKey.slice(0, 7);
  const monthEvents = all.filter((e) => e.event_date.startsWith(monthPrefix));

  return {
    total: monthEvents.length,
    upcoming: upcoming.length,
    today: today.length,
    overdue: overdue.length,
    completed: completed.length,
    monthUpcoming: monthEvents.filter((e) => e.status === 'upcoming').length,
    monthCompleted: monthEvents.filter((e) => e.status === 'completed').length,
    monthOverdue: monthEvents.filter((e) => e.status === 'overdue').length,
  };
}

async function markOverdue() {
  ensureReady();
  const all = await eventsDb.find({ status: 'upcoming' });
  const now = Date.now();
  for (const event of all) {
    if (getEventTimestamp(event) < now) {
      await eventsDb.update({ _id: event._id }, { $set: { status: 'overdue', updated_at: new Date().toISOString() } });
    }
  }
}

function advanceDate(dateStr, repeatType) {
  const d = new Date(dateStr);
  if (repeatType === 'daily') d.setDate(d.getDate() + 1);
  else if (repeatType === 'weekly') d.setDate(d.getDate() + 7);
  else if (repeatType === 'monthly') d.setMonth(d.getMonth() + 1);
  else if (repeatType === 'yearly') d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

module.exports = {
  init,
  create,
  update,
  remove,
  getById,
  getAll,
  search,
  getStats,
  markOverdue,
  getEventTimestamp,
  advanceDate,
  CATEGORIES,
  PRIORITIES,
  REPEAT_TYPES,
  STATUSES,
};
