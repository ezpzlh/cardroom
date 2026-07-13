const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'cardroom.db');

// Ensure data directory exists
const fs = require('fs');
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'));
}

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ==================== Schema ====================

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'player',
    name TEXT NOT NULL,
    phone TEXT DEFAULT '',
    color TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS exclusions (
    player_id TEXT NOT NULL,
    excluded_player_id TEXT NOT NULL,
    PRIMARY KEY (player_id, excluded_player_id),
    FOREIGN KEY (player_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (excluded_player_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS records (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    time_range TEXT NOT NULL,
    count INTEGER DEFAULT 0,
    live_count INTEGER DEFAULT 0,
    offline_count INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS tables (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    time_range TEXT NOT NULL,
    tag TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS table_players (
    table_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    FOREIGN KEY (table_id) REFERENCES tables(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// ==================== Seed Admin ====================

const COLORS = ["#E94560","#4A90D9","#0FAA6B","#FF9500","#AF52DE","#FFCC00","#5AC8FA","#FF6B6B"];

const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
if (!adminExists) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare(`INSERT INTO users (id, username, password_hash, role, name, phone, color)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run('admin-001', 'admin', hash, 'admin', '管理员', '', COLORS[0]);
  console.log('[DB] 默认管理员已创建: admin / admin123');
}

// ==================== Query Functions ====================

// --- Users / Players ---

function getPlayers() {
  const players = db.prepare(`SELECT id, username, role, name, phone, color, created_at FROM users WHERE role = 'player' ORDER BY created_at ASC`).all();
  for (const p of players) {
    const ex = db.prepare(`SELECT excluded_player_id FROM exclusions WHERE player_id = ?`).all(p.id);
    p.exclusions = ex.map(e => e.excluded_player_id);
  }
  return players;
}

function getPlayerById(id) {
  const p = db.prepare(`SELECT id, username, role, name, phone, color, created_at FROM users WHERE id = ?`).get(id);
  if (p) {
    const ex = db.prepare(`SELECT excluded_player_id FROM exclusions WHERE player_id = ?`).all(p.id);
    p.exclusions = ex.map(e => e.excluded_player_id);
  }
  return p;
}

function createPlayer({ username, password, name, phone }) {
  const id = 'p' + Date.now();
  const hash = bcrypt.hashSync(password, 10);
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];
  db.prepare(`INSERT INTO users (id, username, password_hash, role, name, phone, color)
    VALUES (?, ?, ?, 'player', ?, ?, ?)`).run(id, username, hash, name, phone || '', color);
  return getPlayerById(id);
}

function updatePlayer(id, { name, phone, exclusions }) {
  const sets = [];
  const params = [];
  if (name !== undefined) { sets.push('name = ?'); params.push(name); }
  if (phone !== undefined) { sets.push('phone = ?'); params.push(phone); }
  if (sets.length) {
    params.push(id);
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }
  if (exclusions !== undefined) {
    db.prepare('DELETE FROM exclusions WHERE player_id = ?').run(id);
    const insertEx = db.prepare('INSERT OR IGNORE INTO exclusions (player_id, excluded_player_id) VALUES (?, ?)');
    for (const eid of exclusions) {
      insertEx.run(id, eid);
    }
  }
  return getPlayerById(id);
}

function deletePlayer(id) {
  db.prepare('DELETE FROM users WHERE id = ? AND role = ?').run(id, 'player');
}

// --- Auth ---

function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function getUserById(id) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (u) delete u.password_hash;
  return u;
}

// --- Tables ---

function getTables(date) {
  const tables = db.prepare('SELECT * FROM tables WHERE date = ? ORDER BY created_at ASC').all(date);
  for (const t of tables) {
    const players = db.prepare(`
      SELECT u.id, u.name, u.color, u.phone
      FROM table_players tp JOIN users u ON tp.user_id = u.id
      WHERE tp.table_id = ? ORDER BY tp.sort_order ASC
    `).all(t.id);
    t.players = players.map(p => ({ id: p.id, name: p.name, color: p.color }));
    t.player_count = t.players.length;
  }
  return tables;
}

function createTable({ date, time_range, tag, players }) {
  const id = 't' + Date.now();
  db.prepare('INSERT INTO tables (id, date, time_range, tag) VALUES (?, ?, ?, ?)').run(id, date, time_range, tag || '');
  const insertP = db.prepare('INSERT INTO table_players (table_id, user_id, sort_order) VALUES (?, ?, ?)');
  (players || []).forEach((p, i) => insertP.run(id, p.id, i));
  return getTableById(id);
}

function getTableById(id) {
  const t = db.prepare('SELECT * FROM tables WHERE id = ?').get(id);
  if (!t) return null;
  const players = db.prepare(`
    SELECT u.id, u.name, u.color, u.phone
    FROM table_players tp JOIN users u ON tp.user_id = u.id
    WHERE tp.table_id = ? ORDER BY tp.sort_order ASC
  `).all(t.id);
  t.players = players.map(p => ({ id: p.id, name: p.name, color: p.color }));
  return t;
}

function updateTable(id, { time_range, tag, players }) {
  if (time_range !== undefined || tag !== undefined) {
    const sets = [];
    const params = [];
    if (time_range !== undefined) { sets.push('time_range = ?'); params.push(time_range); }
    if (tag !== undefined) { sets.push('tag = ?'); params.push(tag); }
    params.push(id);
    db.prepare(`UPDATE tables SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }
  if (players !== undefined) {
    db.prepare('DELETE FROM table_players WHERE table_id = ?').run(id);
    const insertP = db.prepare('INSERT INTO table_players (table_id, user_id, sort_order) VALUES (?, ?, ?)');
    players.forEach((p, i) => insertP.run(id, p.id, i));
  }
  return getTableById(id);
}

function deleteTable(id) {
  db.prepare('DELETE FROM tables WHERE id = ?').run(id);
}

// --- Records ---

function getRecordsByMonth(year, month) {
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  return db.prepare(`SELECT * FROM records WHERE date LIKE ?`).all(prefix + '%');
}

function getRecordsByDate(date) {
  return db.prepare('SELECT * FROM records WHERE date = ?').all(date);
}

function upsertRecord({ id, date, time_range, count, live_count, offline_count }) {
  const recId = id || ('r' + Date.now());
  const existing = db.prepare('SELECT * FROM records WHERE date = ? AND time_range = ?').get(date, time_range);
  if (existing) {
    db.prepare(`UPDATE records SET count = ?, live_count = ?, offline_count = ? WHERE id = ?`)
      .run(count, live_count || 0, offline_count || 0, existing.id);
    return db.prepare('SELECT * FROM records WHERE id = ?').get(existing.id);
  } else {
    db.prepare('INSERT INTO records (id, date, time_range, count, live_count, offline_count) VALUES (?, ?, ?, ?, ?, ?)')
      .run(recId, date, time_range, count, live_count || 0, offline_count || 0);
    return db.prepare('SELECT * FROM records WHERE id = ?').get(recId);
  }
}

function deleteRecord(id) {
  db.prepare('DELETE FROM records WHERE id = ?').run(id);
}

// Sync records from tables (call after table changes)
function syncRecordsFromTables(date) {
  const tables = getTables(date);
  // Delete current day records, rebuild from tables
  db.prepare('DELETE FROM records WHERE date = ?').run(date);
  const byRange = {};
  for (const t of tables) {
    const tr = t.time_range;
    if (!byRange[tr]) byRange[tr] = { count: 0, live: 0, offline: 0 };
    byRange[tr].count++;
    if (t.tag === '直播') byRange[tr].live++;
    if (t.tag === '线下') byRange[tr].offline++;
  }
  for (const [tr, info] of Object.entries(byRange)) {
    db.prepare('INSERT INTO records (id, date, time_range, count, live_count, offline_count) VALUES (?, ?, ?, ?, ?, ?)')
      .run('r' + Date.now() + Math.random(), date, tr, info.count, info.live, info.offline);
  }
  return getRecordsByDate(date);
}

// --- Player-specific queries ---

function getPlayerTables(userId, date) {
  const query = date
    ? `SELECT DISTINCT t.* FROM tables t
       INNER JOIN table_players tp ON t.id = tp.table_id
       WHERE tp.user_id = ? AND t.date = ?
       ORDER BY t.created_at ASC`
    : `SELECT DISTINCT t.* FROM tables t
       INNER JOIN table_players tp ON t.id = tp.table_id
       WHERE tp.user_id = ?
       ORDER BY t.date DESC, t.created_at ASC`;
  const params = date ? [userId, date] : [userId];
  const tables = db.prepare(query).all(...params);
  for (const t of tables) {
    const players = db.prepare(`
      SELECT u.id, u.name, u.color, u.phone
      FROM table_players tp JOIN users u ON tp.user_id = u.id
      WHERE tp.table_id = ? ORDER BY tp.sort_order ASC
    `).all(t.id);
    t.players = players.map(p => ({ id: p.id, name: p.name, color: p.color }));
  }
  return tables;
}

function getPlayerGameDates(userId, year, month) {
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  const rows = db.prepare(`
    SELECT DISTINCT t.date FROM tables t
    INNER JOIN table_players tp ON t.id = tp.table_id
    WHERE tp.user_id = ? AND t.date LIKE ?
    ORDER BY t.date ASC
  `).all(userId, prefix + '%');
  return rows.map(r => r.date);
}

function updateProfile(userId, { name, phone, password, exclusions }) {
  const sets = [];
  const params = [];
  if (name !== undefined) { sets.push('name = ?'); params.push(name); }
  if (phone !== undefined) { sets.push('phone = ?'); params.push(phone); }
  if (password !== undefined) {
    sets.push('password_hash = ?');
    params.push(bcrypt.hashSync(password, 10));
  }
  if (sets.length > 0) {
    params.push(userId);
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }
  if (exclusions !== undefined) {
    db.prepare('DELETE FROM exclusions WHERE player_id = ?').run(userId);
    const insertEx = db.prepare('INSERT OR IGNORE INTO exclusions (player_id, excluded_player_id) VALUES (?, ?)');
    for (const eid of exclusions) {
      insertEx.run(userId, eid);
    }
  }
  return getUserById(userId);
}

module.exports = {
  db,
  getPlayers, getPlayerById, createPlayer, updatePlayer, deletePlayer,
  getUserByUsername, getUserById,
  getTables, createTable, getTableById, updateTable, deleteTable,
  getRecordsByMonth, getRecordsByDate, upsertRecord, deleteRecord,
  syncRecordsFromTables,
  getPlayerTables, getPlayerGameDates, updateProfile
};
