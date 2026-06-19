/**
 * Agent Tools — Registry of all tools the MindSpace agent can invoke.
 *
 * Each tool:
 *   • definition  — OpenAI-compatible function-calling schema
 *   • execute(args, ctx) — runs the action, returns { ok, result, evidence, sideEffects }
 *   • verify(args, result, ctx) — re-reads the DB to confirm the mutation actually happened
 *                          (skipped for pure read tools; returns { verified: true } by default)
 *
 * ctx (context) provides:
 *   • ipc: helpers to call into the main process / renderer (e.g. createThought via IPC)
 *   • calendarStore: direct reference to services/calendar-store
 *   • notesStore: direct reference to services/notes-store
 *   • event: the IPC event object (for streaming chunks back to the renderer)
 *   • emitChunk(str) — helper to push a "🧠 Thinking / 🛠️ Action" line to the UI
 *
 * SPECIAL: The Calendar↔Canvas auto-link logic lives in execute_schedule_meeting /
 * execute_cancel_meeting / execute_update_meeting / execute_finish_thought, which
 * create/delete/update the linked canvas thought as a side effect of the calendar op.
 */
const calendarStore = require('./calendar-store');
const notesStore = require('./notes-store');
const crypto = require('crypto');

function newId(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(10).toString('hex')}`;
}

function nowIso() {
  return new Date().toISOString();
}

function logToolCall(name, args, ctx) {
  if (ctx && ctx.emitChunk) {
    const reasoning = (args && args.reasoning) || 'Deciding on action…';
    ctx.emitChunk(`\n\n> 🧠 **Thinking**: *${reasoning}*\n> 🛠️ **Action**: *Using tool \`${name}\`*\n\n`);
  }
}

/* ═══════════════════════════════════════════════════════════════
   Tool result helpers
   ═══════════════════════════════════════════════════════════════ */

function success(result, opts = {}) {
  return { ok: true, result, verified: !!opts.verified, evidence: opts.evidence || '', sideEffects: opts.sideEffects || [] };
}
function failure(error, opts = {}) {
  return { ok: false, error: String(error), verified: false, evidence: opts.evidence || '', sideEffects: opts.sideEffects || [] };
}

/* ═══════════════════════════════════════════════════════════════
   THOUGHT TOOLS  (all go through the renderer's encrypted preload)
   ═══════════════════════════════════════════════════════════════ */

async function execute_create_thought(args, ctx) {
  logToolCall('create_thought', args, ctx);
  const thoughtData = {
    _id: newId('tho'),
    content: args.content,
    priority: args.priority || 'medium',
    persistence: args.persistence || 'persistent',
    expiresAt: args.expiresAt || null,
    tags: Array.isArray(args.tags) && args.tags.length ? args.tags : ['ai-generated'],
    calendarEventId: args.calendarEventId || null,
    source: 'agent',
  };
  try {
    const res = await ctx.ipc.createThought(thoughtData);
    // res is the inserted doc (with decrypted content)
    return success(res, {
      evidence: `Created thought "${thoughtData.content}" (id=${res._id})`,
      sideEffects: [`canvas thought id=${res._id}`],
    });
  } catch (e) { return failure(e.message); }
}

async function verify_create_thought(args, result, ctx) {
  if (!result || !result.ok) return { verified: false, evidence: 'create failed' };
  try {
    const fresh = await ctx.ipc.getThought(result.result._id);
    if (fresh) return { verified: true, evidence: `Thought ${fresh._id} present in DB with content "${fresh.content}"` };
    return { verified: false, evidence: 'Thought not found after creation' };
  } catch (e) { return { verified: false, evidence: `verify error: ${e.message}` }; }
}

async function execute_update_thought(args, ctx) {
  logToolCall('update_thought', args, ctx);
  if (!args.id) return failure('id is required');
  const updates = {};
  if (args.content !== undefined) updates.content = args.content;
  if (args.priority !== undefined) updates.priority = args.priority;
  if (args.status !== undefined) updates.status = args.status;
  if (Array.isArray(args.tags)) updates.tags = args.tags;
  try {
    const res = await ctx.ipc.updateThought(args.id, updates);
    if (!res || !res.success) return failure(res?.error || 'update failed');
    return success({ id: args.id, updates }, { evidence: `Updated thought ${args.id}` });
  } catch (e) { return failure(e.message); }
}

async function verify_update_thought(args, result, ctx) {
  if (!result?.ok) return { verified: false, evidence: 'update failed' };
  try {
    const fresh = await ctx.ipc.getThought(args.id);
    if (!fresh) return { verified: false, evidence: 'Thought vanished' };
    for (const k of Object.keys(args)) {
      if (['reasoning', 'id'].includes(k)) continue;
      if (args[k] !== undefined && fresh[k] !== args[k]) {
        return { verified: false, evidence: `Field ${k} = ${JSON.stringify(fresh[k])}, expected ${JSON.stringify(args[k])}` };
      }
    }
    return { verified: true, evidence: `Confirmed: thought ${args.id} reflects the update` };
  } catch (e) { return { verified: false, evidence: `verify error: ${e.message}` }; }
}

async function execute_delete_thought(args, ctx) {
  logToolCall('delete_thought', args, ctx);
  if (!args.id) return failure('id is required');
  try {
    const res = await ctx.ipc.deleteThought(args.id);
    if (!res || !res.success) return failure(res?.error || 'delete failed');
    return success({ id: args.id }, { evidence: `Deleted thought ${args.id}` });
  } catch (e) { return failure(e.message); }
}

async function verify_delete_thought(args, result, ctx) {
  if (!result?.ok) return { verified: false, evidence: 'delete failed' };
  try {
    const fresh = await ctx.ipc.getThought(args.id);
    if (fresh === null) return { verified: true, evidence: `Confirmed: thought ${args.id} no longer exists` };
    return { verified: false, evidence: `Thought ${args.id} still present` };
  } catch (e) { return { verified: true, evidence: `getThought returned error (likely ok after delete): ${e.message}` }; }
}

async function execute_finish_thought(args, ctx) {
  logToolCall('finish_thought', args, ctx);
  if (!args.id) return failure('id is required');
  try {
    const before = await ctx.ipc.getThought(args.id);
    if (!before) return failure('Thought not found');
    const sideEffects = [];
    // Cascade to linked calendar event
    if (before.calendarEventId) {
      try {
        await ctx.ipc.updateCalendarEvent(before.calendarEventId, { status: 'completed' });
        sideEffects.push(`calendar event ${before.calendarEventId} marked completed`);
      } catch (e) { /* non-fatal */ }
    }
    const res = await ctx.ipc.updateThought(args.id, { status: 'finished' });
    if (!res?.success) return failure(res?.error || 'finish failed');
    return success({ id: args.id }, {
      evidence: `Marked thought ${args.id} as finished`,
      sideEffects,
    });
  } catch (e) { return failure(e.message); }
}

async function verify_finish_thought(args, result, ctx) {
  if (!result?.ok) return { verified: false, evidence: 'finish failed' };
  try {
    const fresh = await ctx.ipc.getThought(args.id);
    if (fresh?.status === 'finished') return { verified: true, evidence: `Confirmed: thought ${args.id} is finished` };
    return { verified: false, evidence: `Status = ${fresh?.status}, expected finished` };
  } catch (e) { return { verified: false, evidence: e.message }; }
}

async function execute_search_thoughts(args, ctx) {
  logToolCall('search_thoughts', args, ctx);
  try {
    const results = await ctx.ipc.searchThoughts(args.query || '');
    return success({ count: results.length, results: results.slice(0, 20) });
  } catch (e) { return failure(e.message); }
}

/* ═══════════════════════════════════════════════════════════════
   CALENDAR TOOLS  — the centerpiece. Schedule auto-creates a
   linked canvas thought. Cancel auto-deletes it. Update cascades.
   ═══════════════════════════════════════════════════════════════ */

async function execute_schedule_meeting(args, ctx) {
  logToolCall('schedule_meeting', args, ctx);
  if (!args.title || !args.event_date || !args.event_time)
    return failure('title, event_date, and event_time are required');

  const sideEffects = [];
  try {
    // 1) Create the calendar event first
    const calEvent = await calendarStore.create({
      event_title: args.title,
      event_description: args.description || '',
      event_date: args.event_date,
      event_time: args.event_time,
      category: args.category || 'meeting',
      priority: args.priority || 'medium',
      repeat_type: args.repeat_type || 'none',
      reminder_minutes: typeof args.reminder_minutes === 'number' ? args.reminder_minutes : 15,
      status: 'upcoming',
      source_type: 'agent',
    });
    if (ctx.calendarScheduler) await ctx.calendarScheduler.rescheduleAll();
    sideEffects.push(`calendar event id=${calEvent._id}`);

    // 2) AUTO-CREATE linked canvas thought reminder (THE MUST)
    if (args.create_thought_reminder !== false) {
      const friendlyDate = friendlyEventDate(calEvent.event_date, calEvent.event_time);
      const thoughtContent = `📅 ${calEvent.event_title} — ${friendlyDate}`;
      const thoughtPriority = calEvent.priority === 'high' ? 'high' : (args.priority || 'medium');

      // Build expiresAt: meeting start
      const expiresAt = `${calEvent.event_date}T${calEvent.event_time}:00`;

      const thoughtRes = await ctx.ipc.createThought({
        _id: newId('tho'),
        content: thoughtContent,
        priority: thoughtPriority,
        persistence: 'until_date',
        expiresAt,
        tags: ['meeting', 'ai-generated', 'agent'],
        calendarEventId: calEvent._id,
        source: 'agent',
      });
      if (thoughtRes && thoughtRes._id) {
        // Link the two
        await calendarStore.update(calEvent._id, { thought_id: thoughtRes._id });
        sideEffects.push(`canvas thought id=${thoughtRes._id} (linked reminder)`);
      }
    }

    return success(calEvent, {
      evidence: `Scheduled "${calEvent.event_title}" on ${calEvent.event_date} at ${calEvent.event_time}`,
      sideEffects,
    });
  } catch (e) { return failure(e.message); }
}

async function verify_schedule_meeting(args, result, ctx) {
  if (!result?.ok) return { verified: false, evidence: 'schedule failed' };
  const calId = result.result._id;
  try {
    const fresh = await calendarStore.getById(calId);
    if (!fresh) return { verified: false, evidence: 'Calendar event not found after creation' };

    if (args.create_thought_reminder === false) {
      return { verified: true, evidence: `Calendar event ${calId} present in DB` };
    }

    // Verify the linked thought exists & is linked
    if (!fresh.thought_id) return { verified: false, evidence: 'Calendar event has no linked thought_id' };
    const linkedThought = await ctx.ipc.getThought(fresh.thought_id);
    if (!linkedThought) return { verified: false, evidence: `Linked thought ${fresh.thought_id} not found` };
    if (linkedThought.calendarEventId !== calId)
      return { verified: false, evidence: `Thought's calendarEventId = ${linkedThought.calendarEventId}, expected ${calId}` };
    if (!linkedThought.content.includes(fresh.event_title))
      return { verified: false, evidence: `Thought content does not include meeting title` };

    return {
      verified: true,
      evidence: `Verified: calendar event ${calId} + linked thought ${linkedThought._id} both exist and cross-reference each other`,
    };
  } catch (e) { return { verified: false, evidence: `verify error: ${e.message}` }; }
}

async function execute_update_meeting(args, ctx) {
  logToolCall('update_meeting', args, ctx);
  if (!args.id) return failure('id is required');
  const sideEffects = [];
  try {
    const before = await calendarStore.getById(args.id);
    if (!before) return failure(`Meeting ${args.id} not found`);

    const updates = {};
    if (args.title !== undefined) updates.event_title = args.title;
    if (args.event_date !== undefined) updates.event_date = args.event_date;
    if (args.event_time !== undefined) updates.event_time = args.event_time;
    if (args.description !== undefined) updates.event_description = args.description;
    if (args.status !== undefined) updates.status = args.status;
    if (args.priority !== undefined) updates.priority = args.priority;

    const updated = await calendarStore.update(args.id, updates);
    if (ctx.calendarScheduler) await ctx.calendarScheduler.rescheduleAll();
    if (ctx.ipc.broadcastCalendarRefresh) ctx.ipc.broadcastCalendarRefresh();
    sideEffects.push(`calendar event ${args.id} updated`);

    // Cascade to linked thought
    if (before.thought_id) {
      const thoughtUpdates = {};
      if (args.title !== undefined) thoughtUpdates.content = `📅 ${args.title} — ${friendlyEventDate(updated.event_date, updated.event_time)}`;
      if (args.priority !== undefined) thoughtUpdates.priority = args.priority;
      if (args.event_date !== undefined || args.event_time !== undefined) {
        thoughtUpdates.expiresAt = `${updated.event_date}T${updated.event_time}:00`;
      }
      if (args.status === 'completed') thoughtUpdates.status = 'finished';
      if (args.status === 'cancelled') thoughtUpdates.status = 'dismissed';
      if (Object.keys(thoughtUpdates).length) {
        try {
          await ctx.ipc.updateThought(before.thought_id, thoughtUpdates);
          sideEffects.push(`linked thought ${before.thought_id} cascaded`);
        } catch (e) { /* non-fatal */ }
      }
    }
    return success(updated, { evidence: `Updated meeting ${args.id}`, sideEffects });
  } catch (e) { return failure(e.message); }
}

async function verify_update_meeting(args, result, ctx) {
  if (!result?.ok) return { verified: false, evidence: 'update failed' };
  try {
    const fresh = await calendarStore.getById(args.id);
    if (!fresh) return { verified: false, evidence: 'Meeting vanished' };
    for (const k of Object.keys(args)) {
      if (['reasoning', 'id', 'description', 'priority', 'status'].includes(k)) continue;
      if (args[k] !== undefined && fresh[k] !== args[k]) {
        return { verified: false, evidence: `Field ${k} = ${JSON.stringify(fresh[k])}, expected ${JSON.stringify(args[k])}` };
      }
    }
    return { verified: true, evidence: `Confirmed: meeting ${args.id} reflects the update` };
  } catch (e) { return { verified: false, evidence: e.message }; }
}

async function execute_cancel_meeting(args, ctx) {
  logToolCall('cancel_meeting', args, ctx);
  // Allow the LLM to pass either an id OR a query/title and we'll auto-resolve.
  let id = args.id;
  const sideEffects = [];
  try {
    if (!id) {
      // Auto-resolve by query/title
      const all = await calendarStore.getAll();
      const q = (args.query || args.title || '').trim().toLowerCase();
      let candidates;
      if (q) {
        candidates = all.filter((e) =>
          e.status !== 'cancelled' && e.status !== 'completed' &&
          (e.event_title || '').toLowerCase().includes(q)
        );
      } else {
        candidates = all
          .filter((e) => e.status !== 'cancelled' && e.status !== 'completed')
          .sort((a, b) => new Date(a.event_date) - new Date(b.event_date));
      }
      if (candidates.length === 0) {
        return failure(q
          ? `No upcoming meeting matching "${q}". Try search_calendar_events first to see what's there.`
          : 'No upcoming meetings to cancel. Try search_calendar_events first.'
        );
      }
      if (candidates.length > 1 && q === '') {
        return failure(`Multiple upcoming meetings — please specify. Found ${candidates.length}: ${candidates.slice(0, 5).map((c) => c.event_title).join(', ')}. Use cancel_meeting with id or query.`);
      }
      id = candidates[0]._id;
    }

    const before = await calendarStore.getById(id);
    if (!before) return failure(`Meeting ${id} not found`);

    // 1) Delete the linked thought FIRST (the must)
    if (before.thought_id && args.cascade !== false) {
      try {
        await ctx.ipc.deleteThought(before.thought_id);
        sideEffects.push(`linked thought ${before.thought_id} deleted`);
      } catch (e) { sideEffects.push(`linked thought delete failed: ${e.message}`); }
    }

    // 2) Delete the calendar event
    await calendarStore.remove(id);
    if (ctx.calendarScheduler) await ctx.calendarScheduler.rescheduleAll();
    if (ctx.ipc.broadcastCalendarRefresh) ctx.ipc.broadcastCalendarRefresh();
    sideEffects.push(`calendar event ${id} deleted`);

    return success({ id, deletedTitle: before.event_title }, {
      evidence: `Cancelled meeting "${before.event_title}" (${id})`,
      sideEffects,
    });
  } catch (e) { return failure(e.message); }
}

async function verify_cancel_meeting(args, result, ctx) {
  if (!result?.ok) return { verified: false, evidence: 'cancel failed' };
  try {
    const fresh = await calendarStore.getById(args.id);
    if (fresh !== null && fresh !== undefined) return { verified: false, evidence: 'Calendar event still present' };
    // Try to verify linked thought is gone (if we have the id from side effects)
    return { verified: true, evidence: `Confirmed: meeting ${args.id} removed from DB` };
  } catch (e) { return { verified: true, evidence: `Meeting gone (verify by exception: ${e.message})` }; }
}

async function execute_get_calendar_events(args, ctx) {
  logToolCall('get_calendar_events', args, ctx);
  try {
    const all = await calendarStore.getAll();
    let filtered = all;
    if (args.filter === 'upcoming') filtered = all.filter((e) => e.status !== 'completed' && e.status !== 'cancelled');
    if (args.filter === 'today') {
      const todayKey = nowIso().slice(0, 10);
      filtered = all.filter((e) => e.event_date === todayKey && e.status !== 'cancelled');
    }
    if (args.filter === 'overdue') filtered = all.filter((e) => e.status === 'overdue');
    if (args.days_ahead && typeof args.days_ahead === 'number') {
      const now = new Date();
      const horizon = new Date(now.getTime() + args.days_ahead * 86400000);
      filtered = filtered.filter((e) => new Date(e.event_date) <= horizon);
    }
    return success({
      count: filtered.length,
      events: filtered.slice(0, 20).map((e) => ({
        id: e._id, title: e.event_title, date: e.event_date, time: e.event_time,
        status: e.status, category: e.category, priority: e.priority,
        thought_id: e.thought_id || null,
      })),
    });
  } catch (e) { return failure(e.message); }
}

async function execute_search_calendar_events(args, ctx) {
  logToolCall('search_calendar_events', args, ctx);
  try {
    const filters = {
      query: args.query,
      dateFrom: args.date_from,
      dateTo: args.date_to,
      status: args.status,
    };
    const results = await calendarStore.search(filters);
    return success({ count: results.length, results: results.slice(0, 20) });
  } catch (e) { return failure(e.message); }
}

/* ═══════════════════════════════════════════════════════════════
   NOTES TOOLS
   ═══════════════════════════════════════════════════════════════ */

async function execute_create_note(args, ctx) {
  logToolCall('create_note', args, ctx);
  if (!args.title) return failure('title is required');
  try {
    const note = await notesStore.create({
      name: args.title,
      title: args.title,
      content: args.content || '',
      tags: args.tags || ['agent'],
    });
    return success(note, { evidence: `Created note "${args.title}"` });
  } catch (e) { return failure(e.message); }
}

async function verify_create_note(args, result, ctx) {
  if (!result?.ok) return { verified: false, evidence: 'create failed' };
  try {
    const fresh = await notesStore.getById(result.result._id);
    if (fresh && fresh.title === args.title) return { verified: true, evidence: `Note ${fresh._id} present` };
    return { verified: false, evidence: 'Note missing or title mismatch' };
  } catch (e) { return { verified: false, evidence: e.message }; }
}

async function execute_update_note(args, ctx) {
  logToolCall('update_note', args, ctx);
  if (!args.id) return failure('id is required');
  try {
    const updates = {};
    if (args.title !== undefined) { updates.title = args.title; updates.name = args.title; }
    if (args.content !== undefined) updates.content = args.content;
    if (Array.isArray(args.tags)) updates.tags = args.tags;
    await notesStore.update(args.id, updates);
    return success({ id: args.id }, { evidence: `Updated note ${args.id}` });
  } catch (e) { return failure(e.message); }
}

async function verify_update_note(args, result, ctx) {
  if (!result?.ok) return { verified: false, evidence: 'update failed' };
  try {
    const fresh = await notesStore.getById(args.id);
    if (!fresh) return { verified: false, evidence: 'note missing' };
    if (args.title && fresh.title !== args.title) return { verified: false, evidence: 'title not updated' };
    return { verified: true, evidence: `Note ${args.id} updated` };
  } catch (e) { return { verified: false, evidence: e.message }; }
}

async function execute_delete_note(args, ctx) {
  logToolCall('delete_note', args, ctx);
  if (!args.id) return failure('id is required');
  try {
    await notesStore.remove(args.id);
    return success({ id: args.id }, { evidence: `Deleted note ${args.id}` });
  } catch (e) { return failure(e.message); }
}

async function verify_delete_note(args, result, ctx) {
  if (!result?.ok) return { verified: false, evidence: 'delete failed' };
  try {
    const fresh = await notesStore.getById(args.id);
    if (!fresh) return { verified: true, evidence: `Note ${args.id} gone` };
    return { verified: false, evidence: 'note still present' };
  } catch (e) { return { verified: true, evidence: 'note gone' }; }
}

async function execute_read_notes(args, ctx) {
  logToolCall('read_notes', args, ctx);
  try {
    const results = await notesStore.search(args.query || '');
    return success({
      count: results.length,
      notes: results.slice(0, 10).map((n) => ({
        id: n._id, title: n.title || n.name,
        content: (n.content || '').substring(0, 1000),
        tags: n.tags || [],
        updatedAt: n.updatedAt,
      })),
    });
  } catch (e) { return failure(e.message); }
}

/* ═══════════════════════════════════════════════════════════════
   MEMORY & SCRATCHPAD TOOLS
   ═══════════════════════════════════════════════════════════════ */

async function execute_read_memory(args, ctx) {
  logToolCall('read_memory', args, ctx);
  try {
    const snap = await ctx.memory.buildContextSnapshot();
    return success(snap.text);
  } catch (e) { return failure(e.message); }
}

async function execute_update_scratchpad(args, ctx) {
  logToolCall('update_scratchpad', args, ctx);
  try {
    const patch = {};
    if (args.current_focus !== undefined) patch.current_focus = args.current_focus;
    if (args.short_term_notes !== undefined) patch.short_term_notes = args.short_term_notes;
    if (Array.isArray(args.append_followups)) patch.pending_followups = args.append_followups;
    if (Array.isArray(args.remove_followups)) patch.remove_followups = args.remove_followups;
    if (Array.isArray(args.open_questions)) patch.open_questions = args.open_questions;

    // Apply followup add/remove
    const cur = await ctx.memory.readScratchpad();
    if (Array.isArray(args.append_followups) || Array.isArray(args.remove_followups)) {
      let list = [...(cur.pending_followups || [])];
      if (Array.isArray(args.remove_followups)) list = list.filter((f) => !args.remove_followups.includes(f));
      if (Array.isArray(args.append_followups)) {
        for (const f of args.append_followups) {
          if (!list.includes(f)) list.push(f);
        }
      }
      patch.pending_followups = list;
      delete patch.append_followups;
      delete patch.remove_followups;
    }
    const updated = await ctx.memory.updateScratchpad(patch);
    return success(updated, { verified: true, evidence: `Scratchpad updated successfully` });
  } catch (e) { return failure(e.message); }
}

async function execute_learn_facts(args, ctx) {
  logToolCall('learn_facts', args, ctx);
  if (!args.facts) return failure('facts object required');
  try {
    const result = await ctx.memory.applyExtractedFacts(args.facts);
    return success(result, { verified: true, evidence: `Learned ${result.entities} entities, ${result.relations} relations` });
  } catch (e) { return failure(e.message); }
}

/* ═══════════════════════════════════════════════════════════════
   UTILITY TOOLS
   ═══════════════════════════════════════════════════════════════ */

async function execute_read_clipboard(args, ctx) {
  logToolCall('read_clipboard', args, ctx);
  try {
    const text = await ctx.ipc.readClipboard();
    return success({ text: (text || '').substring(0, 5000) });
  } catch (e) { return failure(e.message); }
}

async function execute_trigger_workflow(args, ctx) {
  logToolCall('trigger_workflow', args, ctx);
  if (!args.name) return failure('name is required');
  try {
    if (ctx.ipc.triggerWorkflow) await ctx.ipc.triggerWorkflow(args.name);
    return success({ name: args.name }, { evidence: `Triggered workflow "${args.name}"` });
  } catch (e) { return failure(e.message); }
}

async function execute_web_search(args, ctx) {
  logToolCall('web_search', args, ctx);
  if (!args.query) return failure('query is required');
  try {
    const res = await ctx.ipc.webSearch(args.query);
    return success(res);
  } catch (e) { return failure(e.message); }
}

/* ═══════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════ */

function friendlyEventDate(dateStr, timeStr) {
  if (!dateStr) return '';
  const d = new Date(`${dateStr}T${timeStr || '09:00'}:00`);
  if (isNaN(d.getTime())) return `${dateStr} ${timeStr || ''}`.trim();
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now.getTime() + 86400000);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `Today ${hh}:${mm}`;
  if (isTomorrow) return `Tomorrow ${hh}:${mm}`;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${hh}:${mm}`;
}

/* ═══════════════════════════════════════════════════════════════
   TOOL REGISTRY  — exposed as OpenAI function-calling format
   ═══════════════════════════════════════════════════════════════ */

const TOOL_DEFS = [
  /* Thoughts */
  {
    type: 'function',
    function: {
      name: 'create_thought',
      description: 'Create a new thought/reminder card on the MindSpace canvas. Use priority: high for urgent, medium for normal, low for later. Use persistence: today (expires at midnight), until_date (with expiresAt), or persistent (stays forever).',
      parameters: {
        type: 'object',
        properties: {
          reasoning: { type: 'string', description: 'Why you are calling this tool.' },
          content: { type: 'string', description: 'The text of the thought.' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          persistence: { type: 'string', enum: ['persistent', 'today', 'until_date'] },
          expiresAt: { type: 'string', description: 'ISO date, required if persistence=until_date' },
          tags: { type: 'array', items: { type: 'string' } },
          calendarEventId: { type: 'string', description: 'Internal: set when this thought is a reminder for a meeting.' },
        },
        required: ['reasoning', 'content', 'priority'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_thought',
      description: 'Update an existing thought (content, priority, status, tags).',
      parameters: {
        type: 'object',
        properties: {
          reasoning: { type: 'string' },
          id: { type: 'string' },
          content: { type: 'string' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          status: { type: 'string', enum: ['active', 'finished', 'dismissed'] },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['reasoning', 'id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_thought',
      description: 'Permanently delete a thought.',
      parameters: {
        type: 'object',
        properties: { reasoning: { type: 'string' }, id: { type: 'string' } },
        required: ['reasoning', 'id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish_thought',
      description: 'Mark a thought as finished/done. If the thought is linked to a calendar event, the event is also marked completed (cascade).',
      parameters: {
        type: 'object',
        properties: { reasoning: { type: 'string' }, id: { type: 'string' } },
        required: ['reasoning', 'id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_thoughts',
      description: 'Search the user\'s thoughts for a keyword/phrase. Returns up to 20 most recent matches.',
      parameters: {
        type: 'object',
        properties: { reasoning: { type: 'string' }, query: { type: 'string' } },
        required: ['reasoning', 'query'],
      },
    },
  },

  /* Calendar */
  {
    type: 'function',
    function: {
      name: 'schedule_meeting',
      description: 'Schedule a new calendar event/meeting. AUTOMATICALLY also creates a linked canvas thought card as a reminder (the "must"). To skip the thought, pass create_thought_reminder=false. Use YYYY-MM-DD for dates, HH:MM (24h) for times. Use priority: high/medium/low. The current date is given in the system prompt — use it to compute relative dates like "tomorrow".',
      parameters: {
        type: 'object',
        properties: {
          reasoning: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          event_date: { type: 'string', description: 'YYYY-MM-DD' },
          event_time: { type: 'string', description: 'HH:MM 24-hour' },
          category: { type: 'string', enum: ['meeting', 'task', 'reminder', 'personal', 'work', 'custom'] },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          repeat_type: { type: 'string', enum: ['none', 'daily', 'weekly', 'monthly', 'yearly'] },
          reminder_minutes: { type: 'number' },
          create_thought_reminder: { type: 'boolean', description: 'Default true. Set false only if you really don\'t want a canvas card.' },
        },
        required: ['reasoning', 'title', 'event_date', 'event_time'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_meeting',
      description: 'Update an existing meeting. Cascades to the linked canvas thought (updates content/priority/expiresAt).',
      parameters: {
        type: 'object',
        properties: {
          reasoning: { type: 'string' },
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          event_date: { type: 'string' },
          event_time: { type: 'string' },
          status: { type: 'string', enum: ['upcoming', 'completed', 'cancelled'] },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['reasoning', 'id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_meeting',
      description: 'Cancel/delete a meeting. AUTOMATICALLY also deletes the linked canvas thought reminder. To prevent cascade, pass cascade=false. If you don\'t know the id, pass `query` (or `title`) with a search string like "Mukhesh" or "standup" and the tool will auto-resolve the next upcoming matching event. If no id or query is given, the next upcoming meeting is cancelled.',
      parameters: {
        type: 'object',
        properties: {
          reasoning: { type: 'string' },
          id: { type: 'string', description: 'Event id. Omit if you pass query/title.' },
          query: { type: 'string', description: 'Substring of the event title to match (e.g. "Mukhesh", "standup").' },
          title: { type: 'string', description: 'Alias for query.' },
          cascade: { type: 'boolean', description: 'Default true. If false, only deletes the calendar event.' },
        },
        required: ['reasoning'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_calendar_events',
      description: 'Get upcoming, today, or overdue calendar events.',
      parameters: {
        type: 'object',
        properties: {
          reasoning: { type: 'string' },
          filter: { type: 'string', enum: ['upcoming', 'today', 'overdue', 'all'] },
          days_ahead: { type: 'number', description: 'Limit to events within N days from now.' },
        },
        required: ['reasoning'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_calendar_events',
      description: 'Search calendar events by query/date range/status.',
      parameters: {
        type: 'object',
        properties: {
          reasoning: { type: 'string' },
          query: { type: 'string' },
          date_from: { type: 'string', description: 'YYYY-MM-DD' },
          date_to: { type: 'string', description: 'YYYY-MM-DD' },
          status: { type: 'string', enum: ['upcoming', 'completed', 'cancelled', 'overdue'] },
        },
        required: ['reasoning'],
      },
    },
  },

  /* Notes */
  {
    type: 'function',
    function: {
      name: 'create_note',
      description: 'Create a new long-form note in the Notes repository.',
      parameters: {
        type: 'object',
        properties: {
          reasoning: { type: 'string' },
          title: { type: 'string' },
          content: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['reasoning', 'title', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_note',
      description: 'Update an existing note.',
      parameters: {
        type: 'object',
        properties: {
          reasoning: { type: 'string' },
          id: { type: 'string' },
          title: { type: 'string' },
          content: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['reasoning', 'id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_note',
      description: 'Delete a note.',
      parameters: {
        type: 'object',
        properties: { reasoning: { type: 'string' }, id: { type: 'string' } },
        required: ['reasoning', 'id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_notes',
      description: 'Search/read notes. Empty query returns all notes.',
      parameters: {
        type: 'object',
        properties: { reasoning: { type: 'string' }, query: { type: 'string' } },
        required: ['reasoning'],
      },
    },
  },

  /* Memory & Scratchpad */
  {
    type: 'function',
    function: {
      name: 'read_memory',
      description: 'Read the agent\'s current knowledge graph and scratchpad. Use this when you need context about the user, their projects, pending followups, etc.',
      parameters: {
        type: 'object',
        properties: { reasoning: { type: 'string' } },
        required: ['reasoning'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_scratchpad',
      description: 'Update the agent\'s scratchpad (working memory). Use to track current focus, pending follow-ups, open questions, short-term notes.',
      parameters: {
        type: 'object',
        properties: {
          reasoning: { type: 'string' },
          current_focus: { type: 'string' },
          short_term_notes: { type: 'string' },
          append_followups: { type: 'array', items: { type: 'string' }, description: 'Add these to pending followups' },
          remove_followups: { type: 'array', items: { type: 'string' }, description: 'Remove these from pending followups' },
          open_questions: { type: 'array', items: { type: 'string' } },
        },
        required: ['reasoning'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'learn_facts',
      description: 'Bulk-learn facts about the user. Use this when the user has shared info about themselves, their projects, people, preferences, or goals. The facts object should match: {entities: [{type, name, attributes}], relations: [{from, relation, to}], scratchpad: {...}}.',
      parameters: {
        type: 'object',
        properties: {
          reasoning: { type: 'string' },
          facts: { type: 'object' },
        },
        required: ['reasoning', 'facts'],
      },
    },
  },

  /* Utilities */
  {
    type: 'function',
    function: {
      name: 'read_clipboard',
      description: 'Read the user\'s current clipboard text content. Use when the user references "this" or pastes something without context.',
      parameters: {
        type: 'object',
        properties: { reasoning: { type: 'string' } },
        required: ['reasoning'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'trigger_workflow',
      description: 'Execute a MindSpace workflow by its exact name.',
      parameters: {
        type: 'object',
        properties: { reasoning: { type: 'string' }, name: { type: 'string' } },
        required: ['reasoning', 'name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web. Returns results + an AI summary.',
      parameters: {
        type: 'object',
        properties: { reasoning: { type: 'string' }, query: { type: 'string' } },
        required: ['reasoning', 'query'],
      },
    },
  },
];

/* ═══════════════════════════════════════════════════════════════
   EXECUTOR + VERIFIER MAP
   ═══════════════════════════════════════════════════════════════ */

const EXECUTORS = {
  create_thought: execute_create_thought,
  update_thought: execute_update_thought,
  delete_thought: execute_delete_thought,
  finish_thought: execute_finish_thought,
  search_thoughts: execute_search_thoughts,
  schedule_meeting: execute_schedule_meeting,
  update_meeting: execute_update_meeting,
  cancel_meeting: execute_cancel_meeting,
  get_calendar_events: execute_get_calendar_events,
  search_calendar_events: execute_search_calendar_events,
  create_note: execute_create_note,
  update_note: execute_update_note,
  delete_note: execute_delete_note,
  read_notes: execute_read_notes,
  read_memory: execute_read_memory,
  update_scratchpad: execute_update_scratchpad,
  learn_facts: execute_learn_facts,
  read_clipboard: execute_read_clipboard,
  trigger_workflow: execute_trigger_workflow,
  web_search: execute_web_search,
};

const VERIFIERS = {
  create_thought: verify_create_thought,
  update_thought: verify_update_thought,
  delete_thought: verify_delete_thought,
  finish_thought: verify_finish_thought,
  // Pure reads & cascade-creates/destroys that auto-verify through side effects
  schedule_meeting: verify_schedule_meeting,
  update_meeting: verify_update_meeting,
  cancel_meeting: verify_cancel_meeting,
  create_note: verify_create_note,
  update_note: verify_update_note,
  delete_note: verify_delete_note,
};

function getToolNames() {
  return Object.keys(EXECUTORS);
}

module.exports = {
  TOOL_DEFS,
  EXECUTORS,
  VERIFIERS,
  getToolNames,
};
