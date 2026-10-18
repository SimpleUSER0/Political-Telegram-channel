import {test} from 'node:test';
import assert from 'node:assert/strict';
import {config} from '../src/core.js';
import {env,fixture} from './helpers.js';
import {schedule,scheduleBreaking,retryScheduledFailures,retryFailedDeliveries,drain} from '../src/worker.js';
import {breakingCandidates,breakingEligible,editionAtHour,editionDetails,localClock,
  newsroomBeat,rankEditorialEntries,REGULAR_HOURS} from '../src/news-plan.js';

test('Four Tbilisi editions are exactly 09, 13, 18 and 21; optional breaking differs',()=>{
  assert.deepEqual(REGULAR_HOURS,[9,13,18,21]);
  assert.deepEqual([9,13,18,21].map(editionAtHour),['morning','midday','evening','night']);
  assert.equal(editionAtHour(12),null);
  assert.equal(editionAtHour(15),null);
  assert.equal(editionDetails('evening').minWords,90);
  assert.equal(editionDetails('evening').maxWords,115);
  assert.equal(editionDetails('breaking').hour,null);
  assert.deepEqual(localClock(Date.UTC(2026,9,17,5,0)),{
    day:'2026-10-17',hour:9,minute:0,slot:'2026-10-17T09'});
});
test('One deterministic regular research job per slot with correct editorial edition',async()=>{
  const {c,store}=await fixture();
  const active={...c,schedule:true,hours:REGULAR_HOURS};
  for(const hour of [9,13,18,21]) {
    const instant=Date.UTC(2026,9,17,hour-4,4);
    await schedule(active,store,instant);
    await schedule(active,store,instant);
  }
  await schedule(active,store,Date.UTC(2026,9,17,8,4)); // old 12:00 slot excluded
  await schedule(active,store,Date.UTC(2026,9,17,11,4)); // old 15:00 slot excluded
  const rows=(await store.stmt("SELECT id,payload FROM cf_jobs WHERE kind='research' ORDER BY id").all()).results;
  assert.equal(rows.length,4);
  assert.deepEqual(rows.map(row=>JSON.parse(row.payload).edition),['morning','midday','evening','night']);
  assert.ok(rows.every(row=>JSON.parse(row.payload).format==='STANDARD'));
});
test('Soft editorial category mix favors relevant editions but never fabricates content',()=>{
  const entries=[
    {title:'Government approves new election law',published_at:'2026-10-17T09:00:00Z'},
    {title:'Ukraine military security talks with NATO',published_at:'2026-10-17T09:00:00Z'},
    {title:'European Union agrees new trade tariffs',published_at:'2026-10-17T09:00:00Z'},
    {title:'Georgia parliament approves a law',published_at:'2026-10-17T09:00:00Z'},
  ];
  assert.deepEqual(entries.map(newsroomBeat),['world-politics','geopolitics','diplomacy-economy','georgia']);
  assert.equal(rankEditorialEntries(entries,'morning',[],Date.UTC(2026,9,17,9,5))[0].title,
    entries[0].title);
  assert.equal(rankEditorialEntries(entries,'evening',[],Date.UTC(2026,9,17,9,5))[0].title,
    entries[1].title);
  assert.equal(rankEditorialEntries(entries,'midday',[],Date.UTC(2026,9,17,9,5))[0].title,
    entries[2].title);
});
test('Breaking event requires both extraordinary politics and fresh publisher date',()=>{
  const time=Date.UTC(2026,9,17,12,30),fresh=new Date(time-5*60000).toISOString();
  const urgent={title:'President resigns after attempted coup',published_at:fresh};
  assert.equal(breakingEligible(urgent,time),true);
  assert.equal(breakingEligible({...urgent,published_at:new Date(time-100*60000).toISOString()},time),false);
  assert.equal(breakingEligible({...urgent,title:'President gives ordinary speech'},time),false);
  assert.equal(breakingEligible({...urgent,title:'Football coach assassinated'},time),false);
  assert.equal(breakingCandidates([urgent],[{topic:urgent.title}],time).length,0);
});
test('Automatic breaking scan creates at most one additional candidate per Tbilisi day',async()=>{
  const {e,store}=await fixture();
  const c=config({...e,DISCOVERY_MODE:'feeds',
    SOURCE_DOMAINS:'bbc.co.uk,bbc.com,theguardian.com,civil.ge',
    SOURCE_FEEDS:'bbc-world,guardian-world,civil-ge',SCHEDULE_ENABLED:'true'});
  const time=Date.UTC(2026,9,17,6,30),date=new Date(time-5*60000).toUTCString();
  const xml='<rss><channel><item><title>President resigns after attempted coup</title>'+
    '<link>https://www.bbc.co.uk/news/articles/high-impact-report</link>'+
    '<pubDate>'+date+'</pubDate></item></channel></rss>';
  const original=globalThis.fetch,requested=[];
  globalThis.fetch=async url=>{
    requested.push(String(url));
    return new Response(xml,{headers:{'Content-Type':'application/rss+xml'}});
  };
  try {
    await scheduleBreaking(c,store,time);
    await scheduleBreaking(c,store,time);
    await scheduleBreaking(c,store,time+3600000);
    const rows=(await store.stmt("SELECT id,payload FROM cf_jobs WHERE kind='research'").all()).results;
    assert.equal(rows.length,1);
    assert.equal(rows[0].id,'breaking-2026-10-17-auto');
    const payload=JSON.parse(rows[0].payload);
    assert.equal(payload.edition,'breaking');
    assert.equal(payload.preferredUrl,'https://www.bbc.co.uk/news/articles/high-impact-report');
    assert.ok(requested.length>=1);
    assert.equal((await store.stmt('SELECT count(*) AS n FROM cf_slots WHERE slot=?',
      'breaking-day-2026-10-17').first()).n,1);
  } finally {globalThis.fetch=original;}
});

test('Gemini transient 503 automatically retries a missed morning slot once, idempotently',async()=>{
  const {c,store}=await fixture();
  const active={...c,schedule:true};
  const start=Date.UTC(2026,9,18,5,0); // 09:00 Tbilisi
  await store.enqueue('research',{query:'მნიშვნელოვანი მსოფლიო პოლიტიკური მოვლენა',
    format:'STANDARD',edition:'morning'},'schedule-2026-10-18T09');
  await store.stmt("UPDATE cf_jobs SET status='failed',error=?,finished_at=? WHERE id=?",
    'Gemini request failed (HTTP 503): UNAVAILABLE',start+2*60000,
    'schedule-2026-10-18T09').run();
  await retryScheduledFailures(active,store,start+5*60000);
  await retryScheduledFailures(active,store,start+25*60000);
  const first=(await store.stmt("SELECT id,status,payload FROM cf_jobs WHERE id LIKE 'schedule-2026-10-18T09%' ORDER BY id").all()).results;
  assert.equal(first.length,2);
  assert.equal(first[1].id,'schedule-2026-10-18T09-retry-1');
  assert.equal(JSON.parse(first[1].payload).edition,'morning');
  // Retry failed again transiently: grant exactly one further attempt.
  await store.stmt("UPDATE cf_jobs SET status='failed',error=?,finished_at=? WHERE id=?",
    'Gemini request failed (HTTP 503): UNAVAILABLE',start+29*60000,
    'schedule-2026-10-18T09-retry-1').run();
  await retryScheduledFailures(active,store,start+41*60000);
  await retryScheduledFailures(active,store,start+50*60000);
  const second=(await store.stmt("SELECT id FROM cf_jobs WHERE id LIKE 'schedule-2026-10-18T09%' ORDER BY id").all()).results;
  assert.equal(second.length,3);
  assert.ok(second.some(x=>x.id==='schedule-2026-10-18T09-retry-2'));
  await store.stmt("UPDATE cf_jobs SET status='failed',error=?,finished_at=? WHERE id=?",
    'Gemini request failed (HTTP 503): UNAVAILABLE',start+51*60000,
    'schedule-2026-10-18T09-retry-2').run();
  await retryScheduledFailures(active,store,start+64*60000);
  assert.equal((await store.stmt("SELECT count(*) AS n FROM cf_jobs WHERE id LIKE 'schedule-2026-10-18T09%'").first()).n,3);
});
test('Permanent errors, quotas, other days and future scheduled jobs are not retried',async()=>{
  const {c,store}=await fixture();
  const active={...c,schedule:true},start=Date.UTC(2026,9,18,5,0);
  await store.enqueue('research',{query:'abc',format:'STANDARD'},'schedule-2026-10-18T09');
  await store.stmt("UPDATE cf_jobs SET status='failed',error=?,finished_at=? WHERE id=?",
    'Gemini free-tier quota reached (429)',start+60000,'schedule-2026-10-18T09').run();
  await retryScheduledFailures(active,store,start+3600000);
  assert.equal((await store.stmt("SELECT count(*) AS n FROM cf_jobs").first()).n,1);
  await store.stmt("UPDATE cf_jobs SET error=? WHERE id=?", 'Gemini request failed (HTTP 503)', 'schedule-2026-10-18T09').run();
  await retryScheduledFailures(active,store,start+13*3600000);
  assert.equal((await store.stmt("SELECT count(*) AS n FROM cf_jobs").first()).n,1);
});

test('Clock-time scheduled jobs are claimed before older manual research backlog',async()=>{
  const {store}=await fixture();
  await store.enqueue('research',{query:'manual',format:'STANDARD'},'manual-research-1');
  await store.enqueue('research',{query:'scheduled',format:'STANDARD'},'schedule-2026-10-18T18');
  const first=await store.claim('research');
  assert.equal(first.id,'schedule-2026-10-18T18');
  await store.finish(first);
  const second=await store.claim('research');
  assert.equal(second.id,'manual-research-1');
});
test('Failed owner preview delivery can be retried without reposting or regenerating article',async()=>{
  const {store}=await fixture(),start=Date.UTC(2026,9,18,14,0);
  const p=(await import('./helpers.js')).payload();
  const draft=await store.createDraft({event_key:'delivery-once',topic:'News'},p,3600000);
  const id='delivery-'+draft.id+'-1';
  await store.enqueue('delivery',{draftId:draft.id,version:1},id);
  await store.stmt('UPDATE cf_jobs SET status=?,finished_at=?,error=? WHERE id=?',
    'failed',start,'Temporary Telegram network problem',id).run();
  await retryFailedDeliveries(store,start+3*60000);
  await retryFailedDeliveries(store,start+4*60000);
  const rows=(await store.stmt("SELECT id,kind,status FROM cf_jobs WHERE kind='delivery' ORDER BY id").all()).results;
  assert.equal(rows.length,2);
  assert.ok(rows.some(row=>row.id===id+'-retry-1'&&row.status==='queued'));
  assert.equal((await store.draft(draft.id)).state,'pending');
});
