// A separate D1 database; never imports or migrates the Python service's database.
export const schema = [
  `CREATE TABLE IF NOT EXISTS cf_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS cf_jobs (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued', lease TEXT, created_at INTEGER NOT NULL,
    started_at INTEGER, finished_at INTEGER, error TEXT)`,
  `CREATE INDEX IF NOT EXISTS cf_jobs_queue ON cf_jobs(status,kind,created_at)`,
  `CREATE TABLE IF NOT EXISTS cf_updates (id INTEGER PRIMARY KEY, received_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS cf_drafts (
    id TEXT PRIMARY KEY, event_key TEXT NOT NULL UNIQUE, topic TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'pending',
    payload TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, approved_by TEXT, message_id INTEGER, error TEXT)`,
  `CREATE TABLE IF NOT EXISTS cf_revisions (
    draft_id TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL,
    created_at INTEGER NOT NULL, actor TEXT NOT NULL,
    PRIMARY KEY(draft_id,version))`,
  `CREATE TABLE IF NOT EXISTS cf_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, draft_id TEXT,
    version INTEGER, actor TEXT NOT NULL, at INTEGER NOT NULL, detail TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS cf_usage (
    day TEXT PRIMARY KEY, runs INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    searches INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS cf_media (draft_id TEXT PRIMARY KEY, file_id TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS cf_slots (slot TEXT PRIMARY KEY, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS cf_member_events (
    update_id INTEGER PRIMARY KEY, action TEXT NOT NULL, method TEXT NOT NULL,
    day TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS cf_members_day ON cf_member_events(day)`,
  `CREATE TABLE IF NOT EXISTS cf_member_snapshots (
    day TEXT PRIMARY KEY, member_count INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `INSERT INTO cf_meta(key,value) VALUES ('schema_version','3') ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
];

export async function ensureSchema(db) {
  try {
    const row = await db.prepare("SELECT value FROM cf_meta WHERE key='schema_version'").first();
    if (row?.value === '3') return;
    if (row?.value === '2') {
      // Online migration: keep every existing article, job, audit and usage row.
      await db.batch(schema.slice(-4).map(sql => db.prepare(sql)));
      return;
    }
    if (row && row.value!=='1') throw new Error('Unsupported D1 schema version');
  } catch (error) {
    if (!/no such table/i.test(String(error))) throw error;
  }
  await db.batch(schema.map(sql => db.prepare(sql)));
}
