/**
 * Parse natural-language calendar commands for Spotlight / Commander.
 * Example: "Schedule a meeting with John tomorrow at 3 PM"
 */

const TRIGGERS = [
  /^cal$/i,
  /^calendar$/i,
  /schedule\s+(a\s+)?meeting/i,
  /create\s+(a\s+)?reminder/i,
  /add\s+(an?\s+)?event/i,
  /set\s+(a\s+)?reminder/i,
  /book\s+(an?\s+)?appointment/i,
];

const CATEGORY_HINTS = {
  meeting: /meeting|call|sync|standup/i,
  task: /task|todo|to-do/i,
  reminder: /remind|reminder/i,
  personal: /personal|birthday|dinner|lunch/i,
  work: /work|office|client/i,
};

function isCalendarTrigger(text) {
  const t = (text || '').trim();
  if (!t) return false;
  return TRIGGERS.some((re) => re.test(t));
}

function parseTime(text) {
  const lower = text.toLowerCase();
  const patterns = [
    /(\d{1,2}):(\d{2})\s*(am|pm)/i,
    /(\d{1,2})\s*(am|pm)/i,
    /at\s+(\d{1,2}):(\d{2})/i,
    /at\s+(\d{1,2})\s*(am|pm)?/i,
    /(\d{1,2}):(\d{2})/,
  ];

  for (const re of patterns) {
    const m = lower.match(re);
    if (!m) continue;
    let hours = parseInt(m[1], 10);
    const minutes = m[2] && !/am|pm/i.test(m[2]) ? parseInt(m[2], 10) : 0;
    const ampm = (m[3] || m[2] || '').toString().toLowerCase();
    if (ampm === 'pm' && hours < 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
    if (!ampm && hours < 8) hours += 12;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }
  return null;
}

function parseDate(text, ref = new Date()) {
  const lower = text.toLowerCase();
  const d = new Date(ref);
  d.setHours(0, 0, 0, 0);

  if (/\btoday\b/.test(lower)) return d.toISOString().slice(0, 10);
  if (/\btomorrow\b/.test(lower)) {
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  if (/\bnext week\b/.test(lower)) {
    d.setDate(d.getDate() + 7);
    return d.toISOString().slice(0, 10);
  }

  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (let i = 0; i < days.length; i++) {
    if (new RegExp(`\\b${days[i]}\\b`).test(lower)) {
      const diff = (i - d.getDay() + 7) % 7 || 7;
      d.setDate(d.getDate() + diff);
      return d.toISOString().slice(0, 10);
    }
  }

  const dateMatch = lower.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
  if (dateMatch) {
    const month = parseInt(dateMatch[1], 10) - 1;
    const day = parseInt(dateMatch[2], 10);
    const year = dateMatch[3] ? parseInt(dateMatch[3], 10) : d.getFullYear();
    const parsed = new Date(year < 100 ? 2000 + year : year, month, day);
    return parsed.toISOString().slice(0, 10);
  }

  return d.toISOString().slice(0, 10);
}

function parseTitle(text) {
  let title = text.trim();
  title = title.replace(/^(cal|calendar)$/i, 'New Event');
  title = title.replace(/^(schedule\s+(a\s+)?meeting|create\s+(a\s+)?reminder|add\s+(an?\s+)?event|set\s+(a\s+)?reminder|book\s+(an?\s+)?appointment)\s*/i, '');
  title = title.replace(/\b(today|tomorrow|next week)\b/gi, '');
  title = title.replace(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, '');
  title = title.replace(/\bat\s+\d{1,2}(:\d{2})?\s*(am|pm)?\b/gi, '');
  title = title.replace(/\b\d{1,2}:\d{2}\s*(am|pm)?\b/gi, '');
  title = title.replace(/\b\d{1,2}\s*(am|pm)\b/gi, '');
  title = title.replace(/\s+/g, ' ').trim();
  if (!title) title = 'New Event';
  if (/^with\s/i.test(title)) title = 'Meeting ' + title;
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function parseCategory(text) {
  for (const [cat, re] of Object.entries(CATEGORY_HINTS)) {
    if (re.test(text)) return cat;
  }
  if (/meeting|appointment/i.test(text)) return 'meeting';
  if (/remind/i.test(text)) return 'reminder';
  return 'meeting';
}

function parseCalendarCommand(text) {
  if (!isCalendarTrigger(text)) return null;
  const time = parseTime(text);
  const date = parseDate(text);
  const title = parseTitle(text);
  const category = parseCategory(text);

  return {
    event_title: title,
    event_date: date,
    event_time: time || '09:00',
    category,
    event_description: '',
    priority: 'medium',
    reminder_minutes: 15,
    repeat_type: 'none',
  };
}

module.exports = {
  isCalendarTrigger,
  parseCalendarCommand,
  TRIGGERS,
};
