const path = require('path');
const fs = require('fs');
const Datastore = require('nedb-promises');

let notesDb = null;

async function init(userDataPath) {
  const dir = path.join(userDataPath, 'mindspace-data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  notesDb = Datastore.create({
    filename: path.join(dir, 'notes.db'),
    autoload: true,
  });
}

function ensureReady() {
  if (!notesDb) throw new Error('Notes database not initialized');
}

async function create({ name, content }) {
  ensureReady();
  const now = new Date().toISOString();
  return notesDb.insert({
    name: (name || 'Untitled').trim(),
    content: content || '',
    createdAt: now,
    updatedAt: now,
  });
}

async function update(id, { name, content }) {
  ensureReady();
  const updates = { updatedAt: new Date().toISOString() };
  if (name !== undefined) updates.name = name.trim() || 'Untitled';
  if (content !== undefined) updates.content = content;
  await notesDb.update({ _id: id }, { $set: updates });
  return getById(id);
}

async function remove(id) {
  ensureReady();
  return notesDb.remove({ _id: id });
}

async function getById(id) {
  ensureReady();
  return notesDb.findOne({ _id: id });
}

async function getAll() {
  ensureReady();
  return notesDb.find({}).sort({ updatedAt: -1 });
}

async function search(query) {
  ensureReady();
  if (!query || !query.trim()) return getAll();
  const regex = new RegExp(query.trim(), 'i');
  const all = await notesDb.find({});
  return all
    .filter((n) => regex.test(n.name) || regex.test(n.content))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

module.exports = { init, create, update, remove, getById, getAll, search };
