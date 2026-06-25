const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const sessionRoutes = require('./routes/session');

const app = express();
const PORT = process.env.PORT || 4000;

// Ensure sessions directory exists
const SESSIONS_DIR = path.join(__dirname, '../sessions');
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// CORS — allow bridge page + extension
app.use(cors({
  origin: (origin, callback) => {
    const allowed = [
      'http://localhost:5173',
      'http://localhost:3000',
      'http://localhost:4000',
    ];
    // Allow chrome-extension:// origins and null (file://)
    if (!origin || allowed.includes(origin) || origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')) {
      callback(null, true);
    } else {
      callback(null, true); // permissive for internal tool
    }
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Serve raw session files (HTML snapshots, video chunks)
app.use('/sessions-data', express.static(SESSIONS_DIR));

// Routes
app.use('/api/session', sessionRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║   Market Research Backend  v1.0.0   ║');
  console.log('╠══════════════════════════════════════╣');
  console.log(`║  Server  : http://localhost:${PORT}      ║`);
  console.log(`║  Sessions: ./sessions/               ║`);
  console.log('╚══════════════════════════════════════╝\n');
});
