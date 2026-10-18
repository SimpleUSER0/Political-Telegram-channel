import {Halt, id, now} from './core.js';

export class Store {
  constructor(db) { this.db = db; }
  stmt(sql, ...args) { return this.db.prepare(sql).bind(...args); }
  async audit(action, draft, actor, detail = '') {
    await this.stmt('INSERT INTO cf_audit(action,draft_id,version,actor,at,detail) VALUES (?,?,?,?,?,?)',
      action, draft?.id || null, draft?.version || null, String(actor), now(), detail).run();
  }
  async requireCallCapacity(limit,needed) {
    if (!Number.isInteger(needed) || needed<1 || needed>limit)
      throw new Halt('Daily AI budget cannot cover a complete research run');
    const day=new Date().toISOString().slice(0,10);
    const usage=await this.stmt('SELECT calls FROM cf_usage WHERE day=?',day).first();
    if (Number(usage?.calls || 0)+needed>limit)
      throw new Halt('Insufficient remaining daily AI calls for a complete research run');
  }
  async reserve(field, limit) {
    if (!['runs','calls'].includes(field)) throw new Halt('Unknown usage counter');
    const day = new Date().toISOString().slice(0,10);
    await this.stmt('INSERT OR IGNORE INTO cf_usage(day) VALUES (?)', day).run();
    const row = await this.stmt(`UPDATE cf_usage SET ${field}=${field}+1 WHERE day=? AND ${field}<? RETURNING day`, day, limit).first();
    if (!row) throw new Halt('Daily API budget reached');
    return day;
  }
  async usage(day, usage, searches) {
    await this.stmt('UPDATE cf_usage SET input_tokens=input_tokens+?,output_tokens=output_tokens+?,searches=searches+? WHERE day=?',
      Number(usage?.input_tokens || 0), Number(usage?.output_tokens || 0), searches, day).run();
  }
  async enqueue(kind, payload, jobId = id()) {
    await this.stmt('INSERT OR IGNORE INTO cf_jobs(id,kind,payload,created_at) VALUES (?,?,?,?)',
      jobId, kind, JSON.stringify(payload), now()).run();
    return jobId;
  }
  async acceptUpdate(updateId, payload) {
    // Both insertions commit together. Re-delivery can never create a second job.
    await this.db.batch([
      this.stmt('INSERT OR IGNORE INTO cf_updates(id,received_at) VALUES (?,?)', updateId, now()),
      this.stmt('INSERT OR IGNORE INTO cf_jobs(id,kind,payload,created_at) VALUES (?,\'control\',?,?)',
        'telegram-' + updateId, JSON.stringify(payload), now()),
    ]);
  }
  async claim(kind) {
    const lease = id();
    const researchLock = ['research','edit'].includes(kind)
      ? " AND NOT EXISTS (SELECT 1 FROM cf_jobs WHERE status='running' AND kind IN ('research','edit'))"
      : '';
    return this.stmt(`UPDATE cf_jobs SET status='running',lease=?,started_at=?
      WHERE id=(SELECT id FROM cf_jobs WHERE status='queued' AND kind=? ORDER BY CASE WHEN kind='research' AND id LIKE 'schedule-%' THEN 0 ELSE 1 END,created_at,id LIMIT 1)
      AND status='queued'${researchLock} RETURNING *`, lease, now(), kind).first();
  }
  async finish(job, error = null) {
    await this.stmt('UPDATE cf_jobs SET status=?,finished_at=?,error=? WHERE id=? AND lease=? AND status=\'running\'',
      error ? 'failed' : 'done', now(), error, job.id, job.lease).run();
  }
  async recover() {
    // Never replay side effects whose outcome was lost. Owner can inspect /status.
    const cutoff = now() - 15 * 60000;
    await this.db.batch([
      this.stmt("UPDATE cf_jobs SET status='failed',error='Interrupted job; not retried',finished_at=? WHERE status='running' AND started_at<?", now(), cutoff),
      this.stmt("UPDATE cf_drafts SET state='unknown',error='Interrupted publication; inspect channel before reconciliation',updated_at=? WHERE state='publishing' AND updated_at<?", now(), cutoff),
      this.stmt("UPDATE cf_drafts SET state='pending',updated_at=? WHERE state='editing' AND updated_at<?", now(), cutoff),
      this.stmt('DELETE FROM cf_updates WHERE received_at<?', now() - 30*86400000),
    ]);
  }
  async history() {
    return (await this.stmt("SELECT event_key,topic,created_at,state,json_extract(payload,'$.sources[0].url') AS url,json_extract(payload,'$.scheduled') AS scheduled FROM cf_drafts WHERE created_at>? ORDER BY created_at DESC LIMIT 100", now()-7*86400000).all()).results;
  }
  async draft(draftId) { return this.stmt('SELECT * FROM cf_drafts WHERE id=?', draftId).first(); }
  async createDraft(selection, payload, ttl) {
    const draftId = id(), time = now(), encoded = JSON.stringify(payload);
    await this.db.batch([
      this.stmt('INSERT INTO cf_drafts(id,event_key,topic,payload,created_at,expires_at,updated_at) VALUES (?,?,?,?,?,?,?)',
        draftId, selection.event_key, selection.topic, encoded, time, time+ttl, time),
      this.stmt('INSERT INTO cf_revisions(draft_id,version,payload,created_at,actor) VALUES (?,1,?,?,?)',
        draftId, encoded, time, 'research'),
    ]);
    return this.draft(draftId);
  }
  async claimDraft(draftId, version, state, actor) {
    return this.stmt(`UPDATE cf_drafts SET state=?,updated_at=?,approved_by=?
      WHERE id=? AND version=? AND state='pending' AND expires_at>? RETURNING *`,
      state, now(), String(actor), draftId, version, now()).first();
  }
  async replaceDraft(draft, payload, actor) {
    const text = JSON.stringify(payload), time = now();
    // An editing lease is never returned to pending without a new version. A stale editor
    // cannot overwrite a later edit because both version and editing timestamp must match.
    const results = await this.db.batch([
      this.stmt(`UPDATE cf_drafts SET payload=?,version=version+1,state='pending',updated_at=?
        WHERE id=? AND version=? AND state='editing' AND updated_at=? AND expires_at>? RETURNING id`,
        text, time, draft.id, draft.version, draft.updated_at, time),
      this.stmt(`INSERT INTO cf_revisions(draft_id,version,payload,created_at,actor)
        SELECT id,version,payload,?,? FROM cf_drafts WHERE id=? AND version=? AND updated_at=?`,
        time, String(actor), draft.id, draft.version+1, time),
    ]);
    if (!results[0].results?.length) throw new Halt('Draft changed or expired during edit');
    return this.draft(draft.id);
  }
  async restoreEdit(draft) {
    await this.stmt("UPDATE cf_drafts SET state='pending',updated_at=? WHERE id=? AND version=? AND state='editing' AND updated_at=?",
      now(), draft.id, draft.version, draft.updated_at).run();
  }
  async pending() {
    return (await this.stmt("SELECT id,version,state,topic FROM cf_drafts WHERE state IN ('pending','editing','publishing','unknown') ORDER BY created_at DESC LIMIT 20").all()).results;
  }
  async status() {
    const [jobs, drafts, usage, heartbeat] = await Promise.all([
      this.stmt('SELECT kind,status,count(*) AS count FROM cf_jobs GROUP BY kind,status').all(),
      this.stmt('SELECT state,count(*) AS count FROM cf_drafts GROUP BY state').all(),
      this.stmt('SELECT * FROM cf_usage WHERE day=?', new Date().toISOString().slice(0,10)).first(),
      this.stmt("SELECT value FROM cf_meta WHERE key='cron_heartbeat'").first(),
    ]);
    return {jobs: jobs.results, drafts: drafts.results, usage, cron_heartbeat:heartbeat?.value || null};
  }
}
