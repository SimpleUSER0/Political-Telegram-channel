import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,draft,mockTelegram,payload} from './helpers.js';
import {publish} from '../src/worker.js';

test('competing Publish requests send exactly one channel message',async()=>{
  const {c,store}=await fixture(),d=await draft(store);let sends=0;
  const original=globalThis.fetch;
  globalThis.fetch=mockTelegram(async()=>{sends++;return Response.json({ok:true,result:{message_id:70}});});
  try {
    const results=await Promise.allSettled([publish(c,store,d.id,1),publish(c,store,d.id,1)]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(sends,1); assert.equal((await store.draft(d.id)).state,'published');
    assert.equal((await store.stmt("SELECT count(*) AS n FROM cf_audit WHERE action='approve'").first()).n,1);
  }finally{globalThis.fetch=original;}
});
test('a dropped Telegram response becomes unknown and cannot be sent again',async()=>{
  const {c,store}=await fixture(),d=await draft(store);let sends=0;const original=globalThis.fetch;
  globalThis.fetch=mockTelegram(async()=>{sends++;throw new Error('network disconnected');});
  try {
    await assert.rejects(publish(c,store,d.id,1),/გაურკვეველია/);
    assert.equal((await store.draft(d.id)).state,'unknown');
    await assert.rejects(publish(c,store,d.id,1));assert.equal(sends,1);
  }finally{globalThis.fetch=original;}
});
test('a Telegram 403 is a definitive failure',async()=>{
  const {c,store}=await fixture(),d=await draft(store);const original=globalThis.fetch;
  globalThis.fetch=mockTelegram(async()=>Response.json({ok:false,error_code:403},{status:403}));
  try {await assert.rejects(publish(c,store,d.id,1));assert.equal((await store.draft(d.id)).state,'failed');}
  finally{globalThis.fetch=original;}
});
test('a Telegram server error is unknown even with an error packet',async()=>{
  const {c,store}=await fixture(),d=await draft(store);const original=globalThis.fetch;
  globalThis.fetch=mockTelegram(async()=>Response.json({ok:false,error_code:500},{status:500}));
  try {await assert.rejects(publish(c,store,d.id,1));assert.equal((await store.draft(d.id)).state,'unknown');}
  finally{globalThis.fetch=original;}
});
test('loss of DB acknowledgement after send never causes another send',async()=>{
  const {c,store}=await fixture(),d=await draft(store);let sends=0;const original=globalThis.fetch;
  globalThis.fetch=mockTelegram(async()=>{sends++;return Response.json({ok:true,result:{message_id:5}});});
  const stmt=store.stmt.bind(store);
  store.stmt=(sql,...args)=>{
    if(sql.includes("SET state='published'"))return {run:async()=>{throw new Error('DB down');}};
    return stmt(sql,...args);
  };
  try {
    await assert.rejects(publish(c,store,d.id,1));assert.equal((await store.draft(d.id)).state,'publishing');
    await assert.rejects(publish(c,store,d.id,1));assert.equal(sends,1);
  }finally{globalThis.fetch=original;}
});
test('a failed approval audit blocks external publication',async()=>{
  const {c,store}=await fixture(),d=await draft(store);let sends=0;const original=globalThis.fetch;
  globalThis.fetch=mockTelegram(async()=>{sends++;return Response.json({ok:true,result:{message_id:5}});});
  store.audit=async()=>{throw new Error('DB write unavailable');};
  try{await assert.rejects(publish(c,store,d.id,1));assert.equal(sends,0);assert.equal((await store.draft(d.id)).state,'pending');}
  finally{globalThis.fetch=original;}
});
test('expired, cancelled and stale version buttons cannot publish',async()=>{
  const {c,store}=await fixture(),d=await draft(store);let sends=0;const original=globalThis.fetch;
  globalThis.fetch=mockTelegram(async()=>{sends++;return Response.json({ok:true,result:{message_id:5}});});
  try{
    await assert.rejects(publish(c,store,d.id,2));
    await store.stmt('UPDATE cf_drafts SET expires_at=0 WHERE id=?',d.id).run();
    await assert.rejects(publish(c,store,d.id,1));
    await store.stmt("UPDATE cf_drafts SET state='cancelled',expires_at=? WHERE id=?",Date.now()+10000,d.id).run();
    await assert.rejects(publish(c,store,d.id,1));assert.equal(sends,0);
  }finally{globalThis.fetch=original;}
});
test('editing locks publication and persists a new immutable revision',async()=>{
  const {store}=await fixture(),d=await draft(store);
  const locked=await store.claimDraft(d.id,1,'editing','123');
  assert.equal(await store.claimDraft(d.id,1,'publishing','123'),null);
  const updated=payload();updated.article.title='განახლებული სათაური';
  const replacement=await store.replaceDraft(locked,updated,'123');
  assert.equal(replacement.version,2);assert.equal(replacement.state,'pending');
  assert.equal((await store.stmt('SELECT count(*) AS n FROM cf_revisions WHERE draft_id=?',d.id).first()).n,2);
  await assert.rejects(store.replaceDraft(locked,updated,'123'));
  assert.equal(await store.claimDraft(d.id,1,'publishing','123'),null);
});
test('overlapping research jobs are serialized with edits',async()=>{
  const {store}=await fixture();await store.enqueue('research',{query:'one'});await store.enqueue('research',{query:'two'});
  await store.enqueue('edit',{});const first=await store.claim('research');assert.ok(first);
  assert.equal(await store.claim('research'),null);assert.equal(await store.claim('edit'),null);
  await store.finish(first);assert.ok(await store.claim('edit'));
});
test('usage reservations reject calls after the daily cap',async()=>{
  const {store}=await fixture();await store.reserve('calls',1);
  await assert.rejects(store.reserve('calls',1),/budget/);
  assert.equal((await store.status()).usage.calls,1);
});
test('redelivered update has exactly one durable job',async()=>{
  const {store}=await fixture();await store.acceptUpdate(7,{message:{text:'/start'}});await store.acceptUpdate(7,{message:{text:'/start'}});
  assert.equal((await store.stmt('SELECT count(*) AS n FROM cf_jobs').first()).n,1);
});
test('same event key is unique even if two attempts race',async()=>{
  const {store}=await fixture();const selection={event_key:'same-event',topic:'topic'};
  await store.createDraft(selection,payload(),3600000);
  await assert.rejects(store.createDraft(selection,payload(),3600000));
  assert.equal((await store.stmt('SELECT count(*) AS n FROM cf_drafts').first()).n,1);
});
test('interrupted publication becomes unknown and is never requeued',async()=>{
  const {store}=await fixture(),d=await draft(store);await store.claimDraft(d.id,1,'publishing','123');
  await store.stmt('UPDATE cf_drafts SET updated_at=0 WHERE id=?',d.id).run();
  await store.recover();assert.equal((await store.draft(d.id)).state,'unknown');
});
test('publication is disabled by default and rejects bot identity mismatch',async()=>{
  const {c,store}=await fixture(),d=await draft(store);const original=globalThis.fetch;
  await assert.rejects(publish({...c,publish:false},store,d.id,1),/გამორთულია/);
  globalThis.fetch=async()=>Response.json({ok:true,result:{is_bot:true,username:'another_bot'}});
  try{await assert.rejects(publish(c,store,d.id,1),/identity/);assert.equal((await store.draft(d.id)).state,'pending');}
  finally{globalThis.fetch=original;}
});
