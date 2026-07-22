require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 4000;

// Ensure sessions directory exists
const SESSIONS_DIR = path.join(__dirname, '../sessions');
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// CORS — allow all origins & options preflight
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));

// Express request logger middleware
app.use((req, res, next) => {
  const start = Date.now();
  const origin = req.headers.origin || 'direct';
  console.log(`[${new Date().toISOString()}] 📥 ${req.method} ${req.originalUrl} (Origin: ${origin})`);
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${new Date().toISOString()}] 📤 ${req.method} ${req.originalUrl} -> Status ${res.statusCode} (${duration}ms)`);
  });

  next();
});

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Serve raw session files (HTML snapshots, video chunks)
app.use('/sessions-data', express.static(SESSIONS_DIR));

const authRoutes = require('./routes/auth');
const sessionRoutes = require('./routes/session');

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/session', sessionRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 404 handler
app.use((req, res) => {
  console.warn(`[404 Not Found] ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: 'Route not found' });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error(`💥 [Server Error] ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ error: err.message || 'Internal Server Error' });
});

app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║   Market Research Backend  v1.0.0   ║');
  console.log('╠══════════════════════════════════════╣');
  console.log(`║  Server  : http://localhost:${PORT}      ║`);
  console.log(`║  Sessions: ./sessions/               ║`);
  console.log('╚══════════════════════════════════════╝\n');
});
