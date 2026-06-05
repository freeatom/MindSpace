const fs = require('fs');
const path = require('path');

function getSettingsDbPath(userDataPath) {
  return path.join(userDataPath, 'mindspace-data', 'settings.db');
}

function readAllSettings(userDataPath) {
  const dbPath = getSettingsDbPath(userDataPath);
  if (!fs.existsSync(dbPath)) return {};
  const map = {};
  const lines = fs.readFileSync(dbPath, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const doc = JSON.parse(line);
      if (doc.key) map[doc.key] = doc.value;
    } catch (_) { /* skip malformed */ }
  }
  return map;
}

function getSetting(userDataPath, key) {
  const all = readAllSettings(userDataPath);
  return all[key] ?? null;
}

function setSetting(userDataPath, key, value) {
  const dbPath = getSettingsDbPath(userDataPath);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let docs = [];
  if (fs.existsSync(dbPath)) {
    const lines = fs.readFileSync(dbPath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const doc = JSON.parse(line);
        if (doc.key !== key) docs.push(doc);
      } catch (_) { /* skip */ }
    }
  }
  docs.push({ key, value });
  fs.writeFileSync(dbPath, docs.map((d) => JSON.stringify(d)).join('\n') + '\n', 'utf8');
}

function removeSetting(userDataPath, key) {
  const dbPath = getSettingsDbPath(userDataPath);
  if (!fs.existsSync(dbPath)) return;
  const lines = fs.readFileSync(dbPath, 'utf8').split('\n').filter(Boolean);
  const kept = [];
  for (const line of lines) {
    try {
      const doc = JSON.parse(line);
      if (doc.key !== key) kept.push(line);
    } catch (_) {
      kept.push(line);
    }
  }
  fs.writeFileSync(dbPath, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
}

module.exports = { getSetting, setSetting, removeSetting, readAllSettings, getSettingsDbPath };
