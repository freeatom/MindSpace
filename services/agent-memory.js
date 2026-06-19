/**
 * Agent Memory — Structured knowledge graph + scratchpad + fact extraction.
 *
 * Replaces the flat text `core_memory` blob with:
 *   • entities: [{ id, type, name, attributes, confidence, source, createdAt, updatedAt }]
 *   • relations: [{ id, from, relation, to, confidence, source, createdAt }]
 *   • scratchpad: { current_focus, pending_followups[], recent_context[], open_questions[], updatedAt }
 *   • history: append-only log of every fact/relation added (for audit + rollback)
 *
 * The graph is stored in `agent_memory.db` (NeDB). The scratchpad lives in
 * `agent_scratchpad.db` (a single doc) so it can be updated atomically.
 */
const path = require('path');
const fs = require('fs');
const Datastore = require('nedb-promises');
const crypto = require('crypto');

let entitiesDb = null;
let relationsDb = null;
let scratchpadDb = null;
let historyDb = null;

const SCRATCHPAD_ID = 'agent_scratchpad';

const DEFAULT_SCRATCHPAD = {
  _id: SCRATCHPAD_ID,
  current_focus: '',
  pending_followups: [],
  recent_context: [],
  open_questions: [],
  short_term_notes: '',
  updatedAt: null,
};

async function init(userDataPath) {
  const dir = path.join(userDataPath, 'mindspace-data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  entitiesDb = Datastore.create({
    filename: path.join(dir, 'agent_entities.db'),
    autoload: true,
  });
  relationsDb = Datastore.create({
    filename: path.join(dir, 'agent_relations.db'),
    autoload: true,
  });
  scratchpadDb = Datastore.create({
    filename: path.join(dir, 'agent_scratchpad.db'),
    autoload: true,
  });
  historyDb = Datastore.create({
    filename: path.join(dir, 'agent_memory_history.db'),
    autoload: true,
  });

  // Seed the scratchpad doc if missing
  const existing = await scratchpadDb.findOne({ _id: SCRATCHPAD_ID });
  if (!existing) {
    await scratchpadDb.insert(DEFAULT_SCRATCHPAD);
  }
}

function ensureReady() {
  if (!entitiesDb || !relationsDb || !scratchpadDb) {
    throw new Error('Agent memory not initialized. Call init(userDataPath) first.');
  }
}

function newId(prefix = 'mem') {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function nowIso() {
  return new Date().toISOString();
}

/* ═══════════════════════════════════════════════════════════════
   ENTITIES  — facts about the user, their world, projects, prefs
   ═══════════════════════════════════════════════════════════════ */

/**
 * Upsert an entity by (type, name). If it exists, merge attributes; else create.
 * Returns the resulting entity.
 */
async function upsertEntity({ type, name, attributes = {}, confidence = 0.8, source = 'agent' }) {
  ensureReady();
  if (!type || !name) throw new Error('upsertEntity: type and name are required');
  const key = `${type.toLowerCase()}::${name.toLowerCase()}`;
  const existing = await entitiesDb.findOne({ key });
  const ts = nowIso();

  if (existing) {
    const merged = { ...(existing.attributes || {}) };
    for (const [k, v] of Object.entries(attributes)) {
      // Last-write wins for attributes; new keys always added
      merged[k] = v;
    }
    await entitiesDb.update(
      { _id: existing._id },
      { $set: { attributes: merged, confidence: Math.max(existing.confidence || 0, confidence), updatedAt: ts } }
    );
    return await entitiesDb.findOne({ _id: existing._id });
  }

  const doc = {
    _id: newId('ent'),
    key,
    type: type.toLowerCase(),
    name,
    attributes,
    confidence,
    source,
    createdAt: ts,
    updatedAt: ts,
  };
  await entitiesDb.insert(doc);
  await logHistory({ kind: 'entity_added', entity: doc });
  return doc;
}

async function getEntity(id) {
  ensureReady();
  return entitiesDb.findOne({ _id: id });
}

async function getEntityByKey(key) {
  ensureReady();
  return entitiesDb.findOne({ key });
}

async function findEntities({ type, name, query } = {}) {
  ensureReady();
  let all = await entitiesDb.find({});
  if (type) all = all.filter((e) => e.type === type.toLowerCase());
  if (name) {
    const re = new RegExp(name, 'i');
    all = all.filter((e) => re.test(e.name));
  }
  if (query) {
    const re = new RegExp(query, 'i');
    all = all.filter(
      (e) => re.test(e.name) || re.test(e.type) || JSON.stringify(e.attributes || {}).match(re)
    );
  }
  return all.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

async function deleteEntity(id) {
  ensureReady();
  await entitiesDb.remove({ _id: id });
  await relationsDb.remove({ $or: [{ from: id }, { to: id }] }, { multi: true });
  await logHistory({ kind: 'entity_deleted', id });
}

/* ═══════════════════════════════════════════════════════════════
   RELATIONS  — directed edges between entities
   ═══════════════════════════════════════════════════════════════ */

async function upsertRelation({ from, relation, to, confidence = 0.7, source = 'agent' }) {
  ensureReady();
  if (!from || !relation || !to) throw new Error('upsertRelation: from, relation, to required');
  const key = `${from}::${relation.toLowerCase()}::${to}`;
  const existing = await relationsDb.findOne({ key });
  const ts = nowIso();

  if (existing) {
    await relationsDb.update(
      { _id: existing._id },
      { $set: { confidence: Math.max(existing.confidence || 0, confidence), updatedAt: ts } }
    );
    return await relationsDb.findOne({ _id: existing._id });
  }

  const doc = {
    _id: newId('rel'),
    key,
    from,
    relation: relation.toLowerCase(),
    to,
    confidence,
    source,
    createdAt: ts,
    updatedAt: ts,
  };
  await relationsDb.insert(doc);
  await logHistory({ kind: 'relation_added', relation: doc });
  return doc;
}

async function getRelationsFor(entityId) {
  ensureReady();
  return relationsDb.find({ $or: [{ from: entityId }, { to: entityId }] });
}

async function deleteRelation(id) {
  ensureReady();
  await relationsDb.remove({ _id: id });
}

/* ═══════════════════════════════════════════════════════════════
   SCRATCHPAD  — single doc, the agent's working memory
   ═══════════════════════════════════════════════════════════════ */

async function readScratchpad() {
  ensureReady();
  const doc = await scratchpadDb.findOne({ _id: SCRATCHPAD_ID });
  return doc || DEFAULT_SCRATCHPAD;
}

async function updateScratchpad(patch) {
  ensureReady();
  const current = await readScratchpad();
  const updated = {
    ...current,
    ...patch,
    pending_followups: patch.pending_followups ?? current.pending_followups,
    recent_context: patch.recent_context ?? current.recent_context,
    open_questions: patch.open_questions ?? current.open_questions,
    updatedAt: nowIso(),
  };
  await scratchpadDb.update({ _id: SCRATCHPAD_ID }, { $set: updated }, { upsert: true });
  await logHistory({ kind: 'scratchpad_updated', patch });
  return updated;
}

async function appendPendingFollowup(text) {
  if (!text || !text.trim()) return;
  const cur = await readScratchpad();
  const list = (cur.pending_followups || []).filter((s) => s !== text);
  list.push(text);
  return updateScratchpad({ pending_followups: list });
}

async function popPendingFollowup(text) {
  const cur = await readScratchpad();
  const list = (cur.pending_followups || []).filter((s) => s !== text);
  return updateScratchpad({ pending_followups: list });
}

async function appendRecentContext(text, max = 30) {
  if (!text || !text.trim()) return;
  const cur = await readScratchpad();
  const list = [...(cur.recent_context || []), { text, at: nowIso() }];
  while (list.length > max) list.shift();
  return updateScratchpad({ recent_context: list });
}

/* ═══════════════════════════════════════════════════════════════
   HISTORY  — audit log of every mutation
   ═══════════════════════════════════════════════════════════════ */

async function logHistory(entry) {
  if (!historyDb) return;
  try {
    await historyDb.insert({ _id: newId('hist'), ...entry, at: nowIso() });
  } catch (e) { /* never throw from logging */ }
}

async function getHistory(limit = 50) {
  ensureReady();
  const docs = await historyDb.find({}).sort({ at: -1 }).limit(limit);
  return docs;
}

/* ═══════════════════════════════════════════════════════════════
   COMPACT VIEW  — used to inject into the system prompt
   ═══════════════════════════════════════════════════════════════ */

function compactEntity(e) {
  const attrs = e.attributes && Object.keys(e.attributes).length
    ? ' ' + Object.entries(e.attributes).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')
    : '';
  return `[${e.type}] ${e.name}${attrs} (conf=${(e.confidence || 0).toFixed(2)})`;
}

function compactRelation(r, entities) {
  const from = entities.find((e) => e._id === r.from);
  const to = entities.find((e) => e._id === r.to);
  if (!from || !to) return null;
  return `${from.name} —[${r.relation}]→ ${to.name}`;
}

async function buildContextSnapshot({ maxEntities = 40, maxRelations = 60 } = {}) {
  ensureReady();
  const [entities, relations, scratchpad] = await Promise.all([
    entitiesDb.find({}).limit(maxEntities),
    relationsDb.find({}).limit(maxRelations),
    readScratchpad(),
  ]);
  const entityLines = entities.map(compactEntity).join('\n');
  const relationLines = relations
    .map((r) => compactRelation(r, entities))
    .filter(Boolean)
    .join('\n');

  const scratchpadLines = [];
  if (scratchpad.current_focus) scratchpadLines.push(`• Current focus: ${scratchpad.current_focus}`);
  if (scratchpad.short_term_notes) scratchpadLines.push(`• Notes: ${scratchpad.short_term_notes}`);
  if (scratchpad.pending_followups?.length)
    scratchpadLines.push(`• Pending: ${scratchpad.pending_followups.join(' | ')}`);
  if (scratchpad.open_questions?.length)
    scratchpadLines.push(`• Open Qs: ${scratchpad.open_questions.join(' | ')}`);
  if (scratchpad.recent_context?.length) {
    const last = scratchpad.recent_context.slice(-5);
    scratchpadLines.push(`• Recent: ${last.map((r) => r.text).join(' | ')}`);
  }

  return {
    entities,
    relations,
    scratchpad,
    text: [
      '=== KNOWLEDGE GRAPH (entities) ===',
      entityLines || '(no entities yet)',
      '',
      '=== RELATIONS ===',
      relationLines || '(no relations yet)',
      '',
      '=== SCRATCHPAD ===',
      scratchpadLines.join('\n') || '(empty)',
    ].join('\n'),
  };
}

/* ═══════════════════════════════════════════════════════════════
   FACT EXTRACTION  — given a conversation, ask the LLM to extract
   entities/relations/followups. Returns a structured "facts" object
   that the caller (agent.js) can apply via applyExtractedFacts().
   ═══════════════════════════════════════════════════════════════ */

const FACT_EXTRACTION_SYSTEM = `You are the MindSpace memory curator. Given a recent user-assistant conversation, extract a STRICT JSON object describing any new facts to remember.

Output JSON shape:
{
  "entities": [
    { "type": "person|project|preference|place|organization|tool|event|topic",
      "name": "short canonical name",
      "attributes": { "k": "v", ... }   // optional
    }
  ],
  "relations": [
    { "from": "<entity name>", "relation": "works_on|collaborates_with|prefers|is_a|part_of|owns|manages|lives_in|has_interest|has_goal|mentioned_with",
      "to": "<entity name>" }
  ],
  "scratchpad": {
    "current_focus": "what the user is focused on right now (string, can be empty)",
    "pending_followups": ["follow-up 1", "follow-up 2"],
    "short_term_notes": "free-text scratch note (can be empty)",
    "open_questions": ["question the user asked that we still need to answer"]
  }
}

Rules:
- Only include facts strongly implied or stated by the USER (not by the assistant).
- Keep entities concise and reusable (use "John" not "John the person I talked to").
- Keep relations short and lowercase.
- If a fact already exists, you may still include it to reinforce.
- ALWAYS return valid JSON, no markdown.
- Return {"entities":[],"relations":[],"scratchpad":{}} if nothing new.`;

async function applyExtractedFacts(facts) {
  ensureReady();
  if (!facts || typeof facts !== 'object') return { entities: 0, relations: 0 };

  // Map entity name → id (creating as we go)
  const nameToId = new Map();
  const existing = await entitiesDb.find({});
  for (const e of existing) nameToId.set(e.name.toLowerCase(), e._id);

  let created = 0;
  for (const ent of facts.entities || []) {
    if (!ent.name || !ent.type) continue;
    const id = await upsertEntity({
      type: ent.type,
      name: ent.name,
      attributes: ent.attributes || {},
      confidence: 0.75,
      source: 'fact_extractor',
    });
    nameToId.set(ent.name.toLowerCase(), id._id);
    created++;
  }

  let relCreated = 0;
  for (const rel of facts.relations || []) {
    if (!rel.from || !rel.to || !rel.relation) continue;
    let fromId = nameToId.get(rel.from.toLowerCase());
    let toId = nameToId.get(rel.to.toLowerCase());
    if (!fromId || !toId) continue; // skip dangling
    await upsertRelation({
      from: fromId,
      relation: rel.relation,
      to: toId,
      confidence: 0.7,
      source: 'fact_extractor',
    });
    relCreated++;
  }

  if (facts.scratchpad) {
    const patch = {};
    if (facts.scratchpad.current_focus !== undefined) patch.current_focus = facts.scratchpad.current_focus;
    if (facts.scratchpad.short_term_notes !== undefined) patch.short_term_notes = facts.scratchpad.short_term_notes;
    if (Array.isArray(facts.scratchpad.pending_followups))
      patch.pending_followups = facts.scratchpad.pending_followups;
    if (Array.isArray(facts.scratchpad.open_questions))
      patch.open_questions = facts.scratchpad.open_questions;
    if (Object.keys(patch).length) await updateScratchpad(patch);
  }

  return { entities: created, relations: relCreated };
}

function getFactExtractionSystemPrompt() {
  return FACT_EXTRACTION_SYSTEM;
}

module.exports = {
  init,
  upsertEntity,
  getEntity,
  getEntityByKey,
  findEntities,
  deleteEntity,
  upsertRelation,
  getRelationsFor,
  deleteRelation,
  readScratchpad,
  updateScratchpad,
  appendPendingFollowup,
  popPendingFollowup,
  appendRecentContext,
  getHistory,
  buildContextSnapshot,
  applyExtractedFacts,
  getFactExtractionSystemPrompt,
  DEFAULT_SCRATCHPAD,
};
