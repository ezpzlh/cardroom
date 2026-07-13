const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');

const db = require('./db');
const { signToken, requireAuth, requireAdmin } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ==================== Static Files ====================
app.use(express.static(path.join(__dirname, 'public')));

// Redirect root to admin or login
app.get('/', (req, res) => {
  res.redirect('/login.html');
});

// ==================== Auth Routes ====================

// Register (players only)
app.post('/api/auth/register', (req, res) => {
  try {
    const { username, password, name, phone } = req.body;
    const displayName = name || username;
    if (!username || !password) {
      return res.status(400).json({ error: '用户名、密码为必填' });
    }
    if (password.length < 4) {
      return res.status(400).json({ error: '密码至少4位' });
    }
    const existing = db.getUserByUsername(username);
    if (existing) {
      return res.status(400).json({ error: '用户名已存在' });
    }
    const player = db.createPlayer({ username, password, name: displayName, phone });
    res.json({ success: true, player });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ error: '注册失败: ' + e.message });
  }
});

// Login
app.post('/api/auth/login', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: '请输入用户名和密码' });
    }
    const user = db.getUserByUsername(username);
    if (!user) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    const valid = bcrypt.compareSync(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    const token = signToken(user);
    res.json({
      success: true,
      token,
      user: { id: user.id, username: user.username, role: user.role, name: user.name, phone: user.phone, color: user.color }
    });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: '登录失败: ' + e.message });
  }
});

// Get current user
app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = db.getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const { password_hash, ...rest } = user;
  res.json({ user: rest });
});

// Update own profile
app.put('/api/auth/profile', requireAuth, (req, res) => {
  try {
    const { name, phone, password } = req.body;
    const user = db.updateProfile(req.user.id, { name, phone, password });
    if (!user) return res.status(404).json({ error: '用户不存在' });
    res.json({ success: true, user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Player Routes ====================

// Get current player's tables
app.get('/api/player/tables', requireAuth, (req, res) => {
  try {
    const date = req.query.date || null;
    const tables = db.getPlayerTables(req.user.id, date);
    res.json({ tables });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get current player's game dates (for calendar)
app.get('/api/player/history', requireAuth, (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const month = parseInt(req.query.month) || (new Date().getMonth() + 1);
    const dates = db.getPlayerGameDates(req.user.id, year, month);
    res.json({ dates, year, month });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get other players list (for exclusion selection)
app.get('/api/player/others', requireAuth, (req, res) => {
  try {
    const all = db.getPlayers();
    const others = all.filter(p => p.id !== req.user.id).map(p => ({
      id: p.id, name: p.name, color: p.color
    }));
    res.json({ players: others });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get current player's exclusions
app.get('/api/player/exclusions', requireAuth, (req, res) => {
  try {
    const player = db.getPlayerById(req.user.id);
    res.json({ exclusions: player ? player.exclusions : [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update current player's exclusions
app.put('/api/player/exclusions', requireAuth, (req, res) => {
  try {
    const { exclusions } = req.body;
    if (!Array.isArray(exclusions)) return res.status(400).json({ error: '请提供排除列表' });
    db.updateProfile(req.user.id, { exclusions });
    const updated = db.getPlayerById(req.user.id);
    res.json({ success: true, exclusions: updated.exclusions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Player Routes (Admin only) ====================

app.get('/api/players', requireAuth, requireAdmin, (req, res) => {
  try {
    const players = db.getPlayers();
    res.json({ players });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/players', requireAuth, requireAdmin, (req, res) => {
  try {
    const { name, phone, username, password, exclusions } = req.body;
    if (!name) return res.status(400).json({ error: '姓名为必填' });
    const uname = username || ('player_' + Date.now());
    const pwd = password || '123456';
    const player = db.createPlayer({ username: uname, password: pwd, name, phone });
    if (exclusions && exclusions.length) {
      db.updatePlayer(player.id, { exclusions });
    }
    res.json({ success: true, player: db.getPlayerById(player.id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/players/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const { name, phone, exclusions } = req.body;
    const player = db.updatePlayer(req.params.id, { name, phone, exclusions });
    if (!player) return res.status(404).json({ error: '玩家不存在' });
    res.json({ success: true, player });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/players/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    db.deletePlayer(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Table Routes ====================

app.get('/api/tables', requireAuth, (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const tables = db.getTables(date);
    res.json({ tables, date });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/tables', requireAuth, (req, res) => {
  try {
    const { date, time_range, tag, players } = req.body;
    const d = date || new Date().toISOString().split('T')[0];
    if (!time_range) return res.status(400).json({ error: '请选择时间段' });
    if (!players || players.length !== 4) return res.status(400).json({ error: '需要4位玩家' });
    const table = db.createTable({ date: d, time_range, tag, players });
    db.syncRecordsFromTables(d);
    res.json({ success: true, table });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/tables/:id', requireAuth, (req, res) => {
  try {
    const { time_range, tag, players } = req.body;
    const table = db.updateTable(req.params.id, { time_range, tag, players });
    if (!table) return res.status(404).json({ error: '牌桌不存在' });
    db.syncRecordsFromTables(table.date);
    res.json({ success: true, table });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/tables/:id', requireAuth, (req, res) => {
  try {
    const existing = db.getTableById(req.params.id);
    if (!existing) return res.status(404).json({ error: '牌桌不存在' });
    db.deleteTable(req.params.id);
    db.syncRecordsFromTables(existing.date);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Record Routes ====================

app.get('/api/records', requireAuth, (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const month = parseInt(req.query.month) || (new Date().getMonth() + 1);
    const records = db.getRecordsByMonth(year, month);
    res.json({ records, year, month });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Start Server ====================

app.listen(PORT, () => {
  console.log(`🀄 棋牌室管理服务已启动: http://localhost:${PORT}`);
  console.log(`   管理员登录: admin / admin123`);
});
