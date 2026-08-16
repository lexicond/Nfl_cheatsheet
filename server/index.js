const express = require('express');
const path = require('path');
const cors = require('cors');
const compression = require('compression');
const { db } = require('./db');
const { fetchSleeper } = require('./scrapers/sleeper');
const { fetchUnderdog } = require('./scrapers/underdog');
const { seedFallback } = require('./scrapers/seed');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(compression());
app.use(cors());
app.use(express.json());

// API routes
const playersRouter = require('./routes/players');
const refreshRouter = require('./routes/refresh');
const { recomputeDerived } = refreshRouter;
const healthRouter = require('./routes/health');

app.use('/api/players', playersRouter);
app.use('/api/refresh', refreshRouter);
app.use('/api/health', healthRouter);

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

// Unknown API paths get a JSON 404 rather than the SPA shell, which otherwise
// reaches the client as a parse error with no hint about the real cause.
app.use('/api', (req, res) => {
  res.status(404).json({ error: `Unknown API route: ${req.method} ${req.originalUrl}` });
});

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

  console.log('[Startup] Players table is empty — fetching live data...');

  // Sleeper first (it owns the roster), then Underdog ADP so a fresh board has a
  // usable ordering rather than an alphabetical list of names.
  for (const [label, fn] of [['Sleeper', fetchSleeper], ['Underdog', fetchUnderdog]]) {
    try {
      const result = await fn();
      if (result.success && result.players_updated > 0) {
        console.log(`[Startup] ${label}: ${result.players_updated} players`);
      }
    } catch (err) {
      console.warn(`[Startup] ${label} seed failed:`, err.message);
    }
  }

  if (db.prepare('SELECT COUNT(*) as c FROM players').get().c > 0) {
    recomputeDerived();
    return;
  }

  console.log('[Startup] All live sources failed — using hardcoded fallback seed');
  seedFallback(db);
}

app.listen(PORT, async () => {
  console.log(`NFL Cheatsheet running on port ${PORT}`);
  await autoSeed();
});
