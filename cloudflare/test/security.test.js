import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker,{authorizedUpdate,handleFetch,schedule} from '../src/worker.js';
import {config,equalSecret,missing,retrievedUrls,sourceUrl,validateArticle,validatePacket} from '../src/core.js';
import {env,fixture,payload,mockTelegram} from './helpers.js';

test('unconfigured health reports missing D1 and ready remains false',async()=>{
  const response=await worker.fetch(new Request('https://test/health'),{},{});assert.equal(response.status,503);
  const e=env();e.RESEARCH_ENABLED='false';
  const ready=await handleFetch(new Request('https://test/ready'),e,{});assert.equal(ready.status,503);
});
test('schema initialization is idempotent and health works without secrets',async()=>{
  const e=env();for(let i=0;i<2;i++) assert.equal((await worker.fetch(new Request('https://test/health'),{DB:e.DB},{})).status,200);
});
test('webhook forgery and absent secrets are rejected before DB use',async()=>{
  const e=env();e.DB={prepare(){throw new Error('DB must not be accessed');}};
  const response=await worker.fetch(new Request('https://test/telegram/webhook',{method:'POST',body:'{}'}),e,{});
  assert.equal(response.status,401);
});
test('admin status cannot be read without the long bearer token',async()=>{
  const e=env();assert.equal((await worker.fetch(new Request('https://test/admin/status'),e,{})).status,401);
  const response=await worker.fetch(new Request('https://test/admin/status',{headers:{Authorization:'Bearer '+e.ADMIN_API_TOKEN}}),e,{});
  assert.equal(response.status,200);
});
test('only the configured owner in their private chat may control the bot',()=>{
  const c=config(env());const update={update_id:4,message:{from:{id:123},chat:{id:123,type:'private'},text:'/start'}};
  assert.ok(authorizedUpdate(update,c));update.message.from.id=456;assert.equal(authorizedUpdate(update,c),null);
  update.message.from.id=123;update.message.chat.type='group';assert.equal(authorizedUpdate(update,c),null);
});
test('callback sender and callback chat are both checked',()=>{
  const c=config(env()),u={update_id:5,callback_query:{id:'q',from:{id:123},message:{chat:{id:123,type:'private'}},data:'pub:x:1'}};
  assert.ok(authorizedUpdate(u,c));u.callback_query.message.chat.id=999;assert.equal(authorizedUpdate(u,c),null);
});
test('existing technology channels cannot be configured',()=>{
  for(const channel of ['@Cifruli_Era','@DigitalEra101'])assert.throws(()=>config({...env(),CHANNEL_ID:channel}));
});
test('source URL validation rejects private hosts, deceptive domains and cross-site redirects',()=>{
  const domains=['example.com'];
  for(const url of ['http://example.com/a','https://example.com.evil.com/a','https://127.0.0.1/a','https://[::1]/a',
    'https://u:p@example.com/a','https://example.com:999/a','https://example.com/'])assert.throws(()=>sourceUrl(url,domains));
  assert.equal(sourceUrl('https://www.example.com/a?utm_source=x#y',domains),'https://www.example.com/a');
});
test('only actual search sources and citations enter the allowed URL set',()=>{
  const urls=retrievedUrls({output:[{type:'message',content:[{text:'https://example.com/invented',
    annotations:[{type:'url_citation',url:'https://example.com/real'}]}]}]},['example.com']);
  assert.deepEqual([...urls],['https://example.com/real']);
});
test('evidence quotes must occur in the retrieved source',()=>{
  const c=config(env()),p=payload();validatePacket(p.verification,p.sources,c);
  p.verification.claims[0].evidence[0].excerpt='This quote was entirely invented by the model.';
  assert.throws(()=>validatePacket(p.verification,p.sources,c),/quote/);
});
test('syndicated sources cannot corroborate a verified claim',()=>{
  const c=config(env()),p=payload();p.verification.sources[1].origin_group='a';
  p.verification.claims[0].origin_groups=['a'];
  assert.throws(()=>validatePacket(p.verification,p.sources,c),/corroboration/);
});
test('unverified allegations require attribution',()=>{
  const c=config(env()),p=payload();p.verification.claims[0].status='unverified';
  assert.throws(()=>validatePacket(p.verification,p.sources,c),/Attribution/);
});
test('unknown, stale and future publication dates block draft approval',()=>{
  const c=config(env());
  for(const date of [null,'2020-01-01T00:00:00Z','2999-01-01T00:00:00Z','2026-01-01']){
    const p=payload();p.verification.sources[0].published_at=date;
    assert.throws(()=>validatePacket(p.verification,p.sources,c),/publication date/);
  }
});
test('source group operator mapping overrides model guesses',()=>{
  const c=config({...env(),SOURCE_ORIGIN_GROUPS:'{"example.com":"wire"}'}),p=payload();
  assert.throws(()=>validatePacket(p.verification,p.sources,c),/mapping/);
});
test('article cannot omit a supporting source or invent a claim index',()=>{
  const p=payload();p.article.source_ids=[0];assert.throws(()=>validateArticle(p.article,p.verification,p.sources));
  p.article.source_ids=[0,1];p.article.claim_ids=[99];assert.throws(()=>validateArticle(p.article,p.verification,p.sources));
});
test('embedded source URLs and excessive Telegram message length are rejected',()=>{
  const p=payload();p.article.body='Visit https://malicious.example';assert.throws(()=>validateArticle(p.article,p.verification,p.sources));
  p.article.body='🙂'.repeat(2000);assert.throws(()=>validateArticle(p.article,p.verification,p.sources));
});
test('webhook delivery is persisted before returning success',async()=>{
  const {e,store}=await fixture();const tasks=[];
  const original=globalThis.fetch;
  globalThis.fetch=mockTelegram(async()=>Response.json({ok:true,result:{message_id:1}}));
  try {
  const response=await handleFetch(new Request('https://test/telegram/webhook',{method:'POST',
    headers:{'X-Telegram-Bot-Api-Secret-Token':e.WEBHOOK_SECRET},
    body:JSON.stringify({update_id:9,message:{from:{id:123},chat:{id:123,type:'private'},text:'/start'}})}),e,
    {waitUntil(task){tasks.push(task);}});
  assert.equal(response.status,200);
  assert.equal((await store.stmt('SELECT count(*) AS n FROM cf_jobs').first()).n,1);
  // Worker uses a fake Telegram endpoint here; no live credential is ever available in tests.
  await Promise.allSettled(tasks);
  } finally {globalThis.fetch=original;}
});
test('schedule catch-up is unique and disabled by default',async()=>{
  const {c,store}=await fixture();const time=Date.UTC(2026,9,16,5,3);
  await schedule(c,store,time);assert.equal((await store.stmt('SELECT count(*) AS n FROM cf_jobs').first()).n,0);
  const active={...c,schedule:true,hours:[9]};await schedule(active,store,time);await schedule(active,store,time);
  assert.equal((await store.stmt('SELECT count(*) AS n FROM cf_jobs').first()).n,1);
});
test('secrets require exact equality and safe defaults disable research and publishing',async()=>{
  assert.equal(await equalSecret('abc','abc'),true);assert.equal(await equalSecret('abc','abd'),false);
  assert.equal(await equalSecret('',''),false);
  const c=config({});assert.equal(c.research,false);assert.equal(c.publish,false);assert.ok(missing(c,true).length);
});
