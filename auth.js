const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'cardroom-secret-key-2024';

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

// Express middleware: require authentication
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录，请先登录' });
  }
  try {
    const payload = verifyToken(authHeader.split(' ')[1]);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

// Express middleware: require admin role
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: '权限不足，仅管理员可操作' });
  }
  next();
}

module.exports = { signToken, verifyToken, requireAuth, requireAdmin, JWT_SECRET };
