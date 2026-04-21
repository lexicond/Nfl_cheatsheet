const express = require('express');
const path = require('path');
const cors = require('cors');
const compression = require('compression');
const { db } = require('./db');
const { fetchSleeper } = require('./scrapers/sleeper');
const { seedFallback } = require('./scrapers/seed');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(compression());
app.use(cors());
app.use(express.json());

// API routes
const playersRouter = require('./routes/players');
const refreshRouter = require('./routes/refresh');

app.use('/api/players', playersRouter);
app.use('/api/refresh', refreshRouter);

// Source status lives on the refresh router at /status
app.get('/api/source-status', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM source_metadata').all();
    const status = {};
    rows.forEach(r => { status[r.source] = r; });
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve frontend static build
const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(CLIENT_DIST));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(CLIENT_DIST, 'index.html'), err => {
    if (err) {
      res.status(200).json({
        message: 'NFL Cheatsheet API is running. Build the frontend with: npm run build',
        endpoints: ['/api/players', '/api/refresh/:source', '/api/source-status'],
      });
    }
  });
});

// Auto-seed on first startup
async function autoSeed() {
  const count = db.prepare('SELECT COUNT(*) as c FROM players').get().c;
  if (count > 0) return;

  console.log('[Startup] Players table is empty — fetching from Sleeper...');
  try {
    const result = await fetchSleeper();
    if (result.success && result.players_updated > 0) {
      console.log(`[Startup] Seeded ${result.players_updated} players from Sleeper`);
      return;
    }
  } catch (err) {
    console.warn('[Startup] Sleeper seed failed:', err.message);
  }

  console.log('[Startup] Sleeper failed — using hardcoded fallback seed');
  seedFallback(db);
}

app.listen(PORT, async () => {
  console.log(`NFL Cheatsheet running on port ${PORT}`);
  await autoSeed();
});
