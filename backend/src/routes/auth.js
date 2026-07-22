const express = require('express');
const router = express.Router();

// Mock Admin Credentials (or configurable via ENV)
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

/**
 * POST /api/auth/login
 * Body: { username, password }
 */
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password are required.' });
  }

  // Accept configured admin credentials or default admin/admin123
  if ((username === ADMIN_USER && password === ADMIN_PASS) || password === 'admin' || password === 'admin123') {
    const token = `token_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const user = {
      id: 'admin_001',
      username: username,
      name: 'System Administrator',
      email: `${username}@recordx.com`,
      role: 'Administrator',
      avatar: 'https://api.dicebear.com/7.x/notionists/svg?seed=Admin&backgroundColor=10B981'
    };

    return res.json({
      success: true,
      token,
      user,
      message: 'Login successful'
    });
  }

  return res.status(401).json({
    success: false,
    message: 'Invalid username or password. Try admin / admin123'
  });
});

/**
 * GET /api/auth/me
 */
router.get('/me', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ success: false, message: 'Not authenticated' });
  }

  return res.json({
    success: true,
    user: {
      id: 'admin_001',
      username: 'admin',
      name: 'System Administrator',
      email: 'admin@startsays.com',
      role: 'Administrator',
      avatar: 'https://api.dicebear.com/7.x/notionists/svg?seed=Admin&backgroundColor=10B981'
    }
  });
});

module.exports = router;
