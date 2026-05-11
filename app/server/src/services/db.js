/**
 * Singleton SQLite (sql.js) facade. Both projects.js and probe.js write to
 * the same .db file on the mounted volume — keeping the init + helpers in
 * one place avoids two routers stepping on each other's writes.
 */
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'projects.db');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

let db;

async function getDb() {
  if (db) return db;
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      apiName TEXT,
      baseUrl TEXT,
      authConfig TEXT DEFAULT '{}',
      createdAt TEXT DEFAULT (datetime('now')),
      updatedAt TEXT DEFAULT (datetime('now'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projectId INTEGER NOT NULL,
      name TEXT NOT NULL,
      endpoint TEXT,
      config TEXT DEFAULT '{}',
      status TEXT DEFAULT 'draft',
      createdAt TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);
  // fixtures: captured API response payloads tied (optionally) to a project.
  // projectId NULLABLE because a user can probe from the wizard before
  // they've committed to creating a project.
  // redacted/redactedCount track whether PHI/PII scrubbing was applied so
  // a fixture can be re-identified as safe-to-share at a glance.
  db.run(`
    CREATE TABLE IF NOT EXISTS fixtures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projectId INTEGER,
      endpointName TEXT NOT NULL,
      fixturePath TEXT NOT NULL,
      capturedAt TEXT NOT NULL,
      statusCode INTEGER,
      recordCount INTEGER,
      elapsedMs INTEGER,
      bodyBytes INTEGER,
      fieldsJson TEXT,
      recordsPath TEXT,
      url TEXT,
      error TEXT,
      redacted INTEGER DEFAULT 1,
      redactedCount INTEGER DEFAULT 0,
      redactedKeyPaths TEXT,
      createdAt TEXT DEFAULT (datetime('now'))
    )
  `);
  // For pre-existing DBs from earlier deploys, add the new columns if missing.
  try { db.run(`ALTER TABLE fixtures ADD COLUMN redacted INTEGER DEFAULT 1`); } catch (e) { /* already exists */ }
  try { db.run(`ALTER TABLE fixtures ADD COLUMN redactedCount INTEGER DEFAULT 0`); } catch (e) { /* already exists */ }
  try { db.run(`ALTER TABLE fixtures ADD COLUMN redactedKeyPaths TEXT`); } catch (e) { /* already exists */ }
  db.run(`CREATE INDEX IF NOT EXISTS idx_fixtures_project_endpoint
          ON fixtures(projectId, endpointName, capturedAt DESC)`);

  saveDb();
  return db;
}

function saveDb() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows[0] || null;
}

function runSql(sql, params = []) {
  db.run(sql, params);
  const result = db.exec("SELECT last_insert_rowid() AS id");
  const lastId = result?.[0]?.values?.[0]?.[0];
  saveDb();
  return { lastId };
}

module.exports = { getDb, saveDb, queryAll, queryOne, runSql };
