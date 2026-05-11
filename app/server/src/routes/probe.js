/**
 * Probe + fixture-diff bridge.
 *
 * Forwards POST /api/probe and POST /api/probe/compare to the Java engine,
 * then persists the resulting fixture metadata to SQLite so the UI can
 * later list captures and pick which two to diff.
 *
 * Routes:
 *   POST /api/probe                      — run one probe (optional projectId)
 *   POST /api/probe/compare              — diff two fixture file paths
 *   GET  /api/probe/fixtures?projectId=N — list fixtures for a project
 *   GET  /api/probe/fixtures/:id         — fetch a single fixture body
 */
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const logger = require('../logger');
const { mapAuthConfig } = require('../services/authMapper');
const { getDb, queryAll, queryOne, runSql } = require('../services/db');

const ENGINE_URL = process.env.ENGINE_URL || 'http://localhost:8081';
const router = express.Router();

// Ensure DB is ready before handling requests
router.use(async (req, res, next) => {
  try { await getDb(); next(); }
  catch (err) {
    logger.error({ err }, 'DB init failed for /api/probe');
    res.status(500).json({ error: 'Database not available' });
  }
});

/**
 * POST /api/probe
 * Body: {
 *   projectId?: number,            // when present, persist fixture metadata
 *   endpoint:   DiscoveredEndpoint,
 *   authConfig: <frontend auth shape>,
 *   baseUrl:    string,
 * }
 * Returns the engine's ProbeResponse plus { fixtureId } if persisted.
 */
router.post('/', async (req, res) => {
  const { projectId, endpoint, authConfig, baseUrl, redact } = req.body || {};
  if (!endpoint || !baseUrl) {
    return res.status(400).json({ error: 'endpoint and baseUrl are required' });
  }

  // Build a stable fixture key so repeated probes for the same project stack
  // under one directory. Pre-project probes use a discovery-scoped key.
  const fixtureKey = projectId
    ? `project-${projectId}`
    : `discovery-${Date.now()}`;

  try {
    const engineResp = await axios.post(`${ENGINE_URL}/api/engine/probe`, {
      endpoint,
      auth: mapAuthConfig(authConfig),
      baseUrl,
      saveFixture: true,
      fixtureKey,
      // Default: ON. Caller can disable for synthetic-data sandboxes only.
      redact: redact !== false,
    }, { timeout: 60_000 });

    const probe = engineResp.data;

    // Record fixture metadata only when the user has an associated project.
    // Pre-project probes still get saved on disk; they just aren't indexed.
    let fixtureId = null;
    if (projectId && probe && probe.fixturePath) {
      const ins = runSql(
        `INSERT INTO fixtures
           (projectId, endpointName, fixturePath, capturedAt,
            statusCode, recordCount, elapsedMs, bodyBytes,
            fieldsJson, recordsPath, url, error,
            redacted, redactedCount, redactedKeyPaths)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          projectId,
          probe.endpointName || endpoint.name,
          probe.fixturePath,
          probe.capturedAt,
          probe.statusCode || null,
          probe.recordCount,
          probe.elapsedMs || null,
          probe.bodyBytes || null,
          JSON.stringify(probe.fields || []),
          endpoint.recordsPath || null,
          probe.url || null,
          probe.error || null,
          probe.redacted ? 1 : 0,
          probe.redactedCount || 0,
          JSON.stringify(probe.redactedKeyPaths || []),
        ],
      );
      fixtureId = ins.lastId;
    }

    res.json({ ...probe, fixtureId });
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data || err.message;
    logger.error({ msg: detail, status }, 'Probe bridge failed');
    res.status(502).json({ error: 'Probe failed', detail });
  }
});

/**
 * POST /api/probe/compare
 * Body: { fixtureAId | fixtureAPath, fixtureBId | fixtureBPath, recordsPath? }
 *
 * When IDs are supplied, the bridge looks up file paths in SQLite so the UI
 * doesn't need to know on-disk paths.
 */
router.post('/compare', async (req, res) => {
  const { fixtureAId, fixtureBId, fixtureAPath, fixtureBPath, recordsPath } = req.body || {};

  let pathA = fixtureAPath;
  let pathB = fixtureBPath;
  let resolvedRecordsPath = recordsPath;

  if (!pathA && fixtureAId) {
    const a = queryOne('SELECT fixturePath, recordsPath FROM fixtures WHERE id = ?', [fixtureAId]);
    if (!a) return res.status(404).json({ error: `fixture ${fixtureAId} not found` });
    pathA = a.fixturePath;
    resolvedRecordsPath = resolvedRecordsPath || a.recordsPath;
  }
  if (!pathB && fixtureBId) {
    const b = queryOne('SELECT fixturePath, recordsPath FROM fixtures WHERE id = ?', [fixtureBId]);
    if (!b) return res.status(404).json({ error: `fixture ${fixtureBId} not found` });
    pathB = b.fixturePath;
    resolvedRecordsPath = resolvedRecordsPath || b.recordsPath;
  }
  if (!pathA || !pathB) {
    return res.status(400).json({ error: 'two fixtures required (by id or path)' });
  }

  try {
    const engineResp = await axios.post(`${ENGINE_URL}/api/engine/probe/compare`, {
      fixtureAPath: pathA,
      fixtureBPath: pathB,
      recordsPath: resolvedRecordsPath,
    }, { timeout: 30_000 });
    res.json(engineResp.data);
  } catch (err) {
    const detail = err.response?.data || err.message;
    logger.error({ detail }, 'Compare bridge failed');
    res.status(502).json({ error: 'Compare failed', detail });
  }
});

/** GET /api/probe/fixtures?projectId=N — list fixtures (newest first). */
router.get('/fixtures', (req, res) => {
  const projectId = req.query.projectId ? parseInt(req.query.projectId, 10) : null;
  const baseCols = `id, projectId, endpointName, fixturePath, capturedAt,
                    statusCode, recordCount, elapsedMs, bodyBytes, recordsPath,
                    url, error, redacted, redactedCount`;
  const sql = projectId
    ? `SELECT ${baseCols} FROM fixtures WHERE projectId = ? ORDER BY capturedAt DESC LIMIT 200`
    : `SELECT ${baseCols} FROM fixtures ORDER BY capturedAt DESC LIMIT 200`;
  const rows = queryAll(sql, projectId ? [projectId] : []);
  res.json(rows);
});

/** GET /api/probe/fixtures/:id — fetch the raw fixture body. */
router.get('/fixtures/:id', (req, res) => {
  const row = queryOne('SELECT * FROM fixtures WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'fixture not found' });
  if (!fs.existsSync(row.fixturePath)) {
    return res.status(410).json({ error: 'fixture file missing from disk', row });
  }
  res.set('Content-Type', 'application/json');
  res.send(fs.readFileSync(row.fixturePath));
});

module.exports = router;
