import {test} from 'node:test';
import assert from 'node:assert/strict';
import {config} from '../src/core.js';
import {env,fixture} from './helpers.js';
import {schedule,scheduleBreaking,retryScheduledFailures,retryFailedDeliveries,recoverUndeliveredDrafts,drain} from '../src/worker.js';
import {repairScheduledLengthOnce,validateScheduledDraft,isEditorialCandidateFailure,draftLengthGuidance} from '../src/research.js';
import {breakingCandidates,breakingEligible,editionAtHour,editionDetails,editionWordCount,meetsEditionWordTarget,localClock,
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
test('scheduled post word targets match each agreed edition and count title plus body',()=>{
  const specs=[['morning',70,90],['midday',80,100],['evening',90,115],['night',75,100]];
  for(const [edition,min,max] of specs){
    const article={title:Array(min?1:0).fill('სათაური').join(' '),body:Array(min-1).fill('ამბავი').join(' ')};
    assert.equal(editionWordCount(article),min);
    assert.equal(meetsEditionWordTarget(article,edition),true);
    const short={...article,body:Array(min-2).fill('ამბავი').join(' ')};
    const long={...article,body:Array(max).fill('ამბავი').join(' ')};
    assert.equal(meetsEditionWordTarget(short,edition),false);
    assert.equal(meetsEditionWordTarget(long,edition),false);
  }
});
test('one length correction preserves original evidence IDs and a second miss fails locally',async()=>{
  const makeArticle=(count,claimIds=[0],sourceIds=[0])=>({title:'სათაური',body:Array(count-1).fill('ამბავი').join(' '),claim_ids:claimIds,source_ids:sourceIds});
  let calls=0;
  const corrected=await repairScheduledLengthOnce(makeArticle(20),'evening',async(_article,{target,wordCount})=>{
    calls++;assert.equal(wordCount,20);assert.deepEqual([target.minWords,target.maxWords],[90,115]);
    return makeArticle(100,[99],[42]);
  });
  assert.equal(calls,1);
  assert.deepEqual(corrected.claim_ids,[0]);
  assert.deepEqual(corrected.source_ids,[0]);
  assert.equal(validateScheduledDraft(corrected,'evening'),corrected);
  calls=0;
  await assert.rejects(repairScheduledLengthOnce(makeArticle(20),'evening',async()=>{
    calls++;return makeArticle(20,[999],[888]);
  }),error=>{
    assert.match(error.message,/Scheduled draft length outside 90-115 words/);
    assert.equal(isEditorialCandidateFailure(error),true);
    return true;
  });
  assert.equal(calls,1);
});
test('one scheduled correction runs when a word-count-valid draft exceeds Telegram caption size',async()=>{
  const long={title:'სათაური',body:Array(99).fill('ზ'.repeat(12)).join(' '),claim_ids:[0],source_ids:[0]};
  assert.equal(meetsEditionWordTarget(long,'evening'),true);
  assert.ok((long.title+'\n\n'+long.body).length>1024);
  const withinApiLimit={title:'სათაური',body:Array(99).fill('abcdefghi').join(' '),claim_ids:[0],source_ids:[0]};
  assert.equal(meetsEditionWordTarget(withinApiLimit,'evening'),true);
  assert.ok((withinApiLimit.title+'\n\n'+withinApiLimit.body).length>950);
  assert.ok((withinApiLimit.title+'\n\n'+withinApiLimit.body).length<=1024);
  let unnecessaryCorrection=0;
  assert.equal(await repairScheduledLengthOnce(withinApiLimit,'evening',async()=>{
    unnecessaryCorrection++;return withinApiLimit;
  }),withinApiLimit);
  assert.equal(unnecessaryCorrection,0);
  let calls=0;
  const corrected=await repairScheduledLengthOnce(long,'evening',async()=>{
    calls++;
    return {title:'სათაური',body:Array(99).fill('ამბავი').join(' '),claim_ids:[77],source_ids:[88]};
  });
  assert.equal(calls,1);
  assert.equal(meetsEditionWordTarget(corrected,'evening'),true);
  assert.ok((corrected.title+'\n\n'+corrected.body).length<=1024);
  assert.deepEqual(corrected.claim_ids,[0]);
  assert.deepEqual(corrected.source_ids,[0]);
  calls=0;
  await assert.rejects(repairScheduledLengthOnce(long,'evening',async()=>{
    calls++;return long;
  }),/Draft exceeds the photo caption limit/);
  assert.equal(calls,1);
});
test('scheduled draft instructions specify one midpoint and bounded correction',()=>{
  const scheduled=draftLengthGuidance('evening',true),manual=draftLengthGuidance('evening',false);
  assert.match(scheduled,/90-115 whitespace-separated words/);
  assert.match(scheduled,/One correction is available if either limit is missed/);
  assert.match(scheduled,/1024 UTF-16 units for Telegram's photo caption/);
  assert.match(manual,/1-3 very short clear Georgian sentences/);
  assert.doesNotMatch(scheduled,/1-3 very short clear Georgian sentences/);
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
  const localNow=new Date(Date.now()+4*3600000);
  localNow.setUTCMinutes(30,0,0);
  if(new Date(Date.now()+4*3600000).getUTCMinutes()<30)localNow.setUTCHours(localNow.getUTCHours()-1);
  const time=localNow.getTime()-4*3600000,date=new Date(time-5*60000).toUTCString(),day=localClock(time).day;
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
    assert.equal(rows[0].id,'breaking-'+day+'-auto');
    const payload=JSON.parse(rows[0].payload);
    assert.equal(payload.edition,'breaking');
    assert.equal(payload.preferredUrl,'https://www.bbc.co.uk/news/articles/high-impact-report');
    assert.ok(requested.length>=1);
    assert.equal((await store.stmt('SELECT count(*) AS n FROM cf_slots WHERE slot=?',
      'breaking-day-'+day).first()).n,1);
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
  assert.equal((await store.stmt("SELECT count(*) AS n FROM cf_jobs WHERE id LIKE 'schedule-2026-10-18T09%'").first()).n,4);
  await store.stmt("UPDATE cf_jobs SET status='failed',error=?,finished_at=? WHERE id=?",
    'Gemini request failed (HTTP 503): UNAVAILABLE',start+65*60000,
    'schedule-2026-10-18T09-retry-3').run();
  await retryScheduledFailures(active,store,start+82*60000);
  assert.equal((await store.stmt("SELECT count(*) AS n FROM cf_jobs WHERE id LIKE 'schedule-2026-10-18T09%'").first()).n,5);
  await store.stmt("UPDATE cf_jobs SET status='failed',error=?,finished_at=? WHERE id=?",
    'Gemini request failed (HTTP 503): UNAVAILABLE',start+83*60000,
    'schedule-2026-10-18T09-retry-4').run();
  await retryScheduledFailures(active,store,start+100*60000);
  assert.equal((await store.stmt("SELECT count(*) AS n FROM cf_jobs WHERE id LIKE 'schedule-2026-10-18T09%'").first()).n,5);
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

test('one incomplete scheduled Gemini response is retried once, while a second failure stops',async()=>{
  const {c,store}=await fixture(),active={...c,schedule:true},start=Date.UTC(2026,9,18,5,0);
  const id='schedule-2026-10-18T09';
  await store.enqueue('research',{query:'scheduled',format:'STANDARD'},id);
  await store.stmt("UPDATE cf_jobs SET status='failed',error=?,finished_at=? WHERE id=?",
    'Gemini response incomplete (OTHER)',start+60000,id).run();
  await retryScheduledFailures(active,store,start+3*60000);
  assert.equal((await store.stmt("SELECT status FROM cf_jobs WHERE id=?",id+'-retry-1').first()).status,'queued');
  await store.stmt("UPDATE cf_jobs SET status='failed',error=?,finished_at=? WHERE id=?",
    'Gemini response incomplete (OTHER)',start+4*60000,id+'-retry-1').run();
  await retryScheduledFailures(active,store,start+8*60000);
  assert.equal((await store.stmt("SELECT count(*) AS n FROM cf_jobs WHERE id LIKE ?",id+'%').first()).n,2);
});

test('scheduled editorial length misses do not launch another paid full run',async()=>{
  const {c,store}=await fixture(),active={...c,schedule:true},start=Date.UTC(2026,9,18,9,0); // 13:00 Tbilisi
  const id='schedule-2026-10-18T13';
  await store.enqueue('research',{query:'world politics',format:'STANDARD',edition:'midday'},id);
  await store.stmt("UPDATE cf_jobs SET status='failed',error=?,finished_at=? WHERE id=?",
    'No supported photo-backed political story for the requested topic: Scheduled draft length outside 80-100 words',
    start+60000,id).run();
  await retryScheduledFailures(active,store,start+4*60000);
  assert.equal((await store.stmt("SELECT count(*) AS n FROM cf_jobs WHERE id LIKE ?",id+'%').first()).n,1);
});
test('draft transport interruptions get at most two bounded retries',async()=>{
  const {c,store}=await fixture(),active={...c,schedule:true},start=Date.UTC(2026,9,18,9,0);
  const id='schedule-2026-10-18T13-retry-1';
  const payload={query:'world politics',format:'STANDARD',edition:'midday'};
  await store.enqueue('research',payload,id);
  await store.stmt("UPDATE cf_jobs SET status='failed',error=?,finished_at=? WHERE id=?",
    'Research execution failed at draft (Error); no automatic retry',start+4*60000,id).run();
  await retryScheduledFailures(active,store,start+7*60000);
  const retry=await store.stmt("SELECT id,status,payload FROM cf_jobs WHERE id=?",id.replace('-retry-1','-retry-2')).first();
  assert.equal(retry.status,'queued');
  assert.deepEqual(JSON.parse(retry.payload),payload);
  await store.stmt("UPDATE cf_jobs SET status='failed',error=?,finished_at=? WHERE id=?",
    'Gemini response transport interrupted',start+8*60000,id.replace('-retry-1','-retry-2')).run();
  await retryScheduledFailures(active,store,start+14*60000);
  const lastId=id.replace('-retry-1','-retry-3');
  assert.equal((await store.stmt("SELECT status FROM cf_jobs WHERE id=?",lastId).first()).status,'queued');
  await store.stmt("UPDATE cf_jobs SET status='failed',error=?,finished_at=? WHERE id=?",
    'Gemini network request failed',start+15*60000,lastId).run();
  await retryScheduledFailures(active,store,start+20*60000);
  assert.equal((await store.stmt("SELECT count(*) AS n FROM cf_jobs WHERE id LIKE 'schedule-2026-10-18T13%' ").first()).n,3);
});

test('a truncated Workers AI fallback gets one final bounded scheduled retry',async()=>{
  const {c,store}=await fixture(),active={...c,schedule:true},start=Date.UTC(2026,9,18,14,0);
  const id='schedule-2026-10-18T18-retry-3',payload={query:'world politics',format:'STANDARD',edition:'evening'};
  await store.enqueue('research',payload,id);
  await store.stmt("UPDATE cf_jobs SET status='failed',error=?,finished_at=? WHERE id=?",
    'Cloudflare Workers AI response was truncated',start+60000,id).run();
  await retryScheduledFailures(active,store,start+3*60000);
  const last=await store.stmt("SELECT id,status,payload FROM cf_jobs WHERE id=?",id.replace('-retry-3','-retry-4')).first();
  assert.equal(last.status,'queued');
  assert.deepEqual(JSON.parse(last.payload),payload);
  await store.stmt("UPDATE cf_jobs SET status='failed',error=?,finished_at=? WHERE id=?",
    'Cloudflare Workers AI response was truncated',start+4*60000,last.id).run();
  await retryScheduledFailures(active,store,start+8*60000);
  assert.equal((await store.stmt("SELECT count(*) AS n FROM cf_jobs WHERE id LIKE 'schedule-2026-10-18T18%' ").first()).n,2);
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

test('Cron catches missed edition in full hour and up to 90 minutes, but never duplicates',async()=>{
  const {c,store}=await fixture();
  const active={...c,schedule:true,hours:REGULAR_HOURS};
  const start=Date.UTC(2026,9,19,5,0);
  await schedule(active,store,start+30*60000);
  await schedule(active,store,start+80*60000);
  await schedule(active,store,start+91*60000);
  const jobs=(await store.stmt("SELECT id FROM cf_jobs WHERE id LIKE 'schedule-2026-10-19T09%'").all()).results;
  assert.deepEqual(jobs.map(x=>x.id),['schedule-2026-10-19T09']);
  const {store:missed}=await fixture();
  await schedule(active,missed,start+91*60000);
  assert.equal((await missed.stmt('SELECT COUNT(*) AS n FROM cf_jobs').first()).n,0);
});

test('Cron reconstructs interrupted owner photo delivery but never resends a proved preview',async()=>{
  const {store}=await fixture();
  const moment=Date.now();
  const a=await store.createDraft({event_key:'unsent-'+crypto.randomUUID(),topic:'News'},(await import('./helpers.js')).payload(),3600000);
  await store.stmt('UPDATE cf_drafts SET created_at=? WHERE id=?',moment-3*60000,a.id).run();
  await recoverUndeliveredDrafts(store,moment);
  await recoverUndeliveredDrafts(store,moment);
  assert.equal((await store.stmt("SELECT count(*) AS n FROM cf_jobs WHERE kind='delivery'").first()).n,1);
  const b=await store.createDraft({event_key:'sent-'+crypto.randomUUID(),topic:'Sent'},(await import('./helpers.js')).payload(),3600000);
  await store.stmt('UPDATE cf_drafts SET created_at=? WHERE id=?',moment-3*60000,b.id).run();
  await store.audit('owner_draft_delivered',b,'123','42');
  const c=await store.createDraft({event_key:'cached-'+crypto.randomUUID(),topic:'Cached'},(await import('./helpers.js')).payload(),3600000);
  await store.stmt('UPDATE cf_drafts SET created_at=? WHERE id=?',moment-3*60000,c.id).run();
  await store.stmt('INSERT INTO cf_media(draft_id,file_id) VALUES (?,?)',c.id,'photo-ok').run();
  await recoverUndeliveredDrafts(store,moment);
  assert.equal((await store.stmt("SELECT count(*) AS n FROM cf_jobs WHERE kind='delivery'").first()).n,1);
});
