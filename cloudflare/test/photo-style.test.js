import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publisherImage,sourceButtons,attributePublisherClaims,normalizePublisherEvidence} from '../src/research.js';
import {notify,publish} from '../src/worker.js';
import {ensureSchema} from '../src/schema.js';
import {fixture,payload,mockTelegram,D1Local} from './helpers.js';

test('one public source button retains all internal evidence',()=>{
  const p=payload();p.primary_source_id=1;
  assert.deepEqual(sourceButtons(p),[[{text:'🔗 წყარო',url:'https://example.org/news'}]]);
  assert.equal(p.sources.length,2);assert.equal(p.article.source_ids.length,2);
});
test('publisher image extraction supports reversed attributes, relative URLs and known CDNs',()=>{
  assert.equal(publisherImage('<meta content="/photo.jpg" property="og:image">','https://civil.ge/archives/1',{}).url,'https://civil.ge/photo.jpg');
  assert.equal(publisherImage('<meta property="og:image" content="https://i.guim.co.uk/img/a.jpg?a=1&amp;b=2">','https://www.theguardian.com/world/a',{}).url,'https://i.guim.co.uk/img/a.jpg?a=1&b=2');
  for(const url of ['http://civil.ge/a.jpg','https://evil.test/a.jpg','https://127.0.0.1/a.jpg','https://civil.ge/logo.jpg','https://civil.ge/a.svg'])
    assert.equal(publisherImage(`<meta property="og:image" content="${url}">`,'https://civil.ge/archives/1',{}),null);
});
test('one publisher report is attributed rather than falsely independently verified',()=>{
  const p=payload();p.verification.claims[0].evidence=p.verification.claims[0].evidence.slice(0,1);
  const reviewed=attributePublisherClaims(p.verification);
  assert.equal(reviewed.claims[0].status,'attributed');assert.equal(reviewed.claims[0].attribution,'Example A');
});
test('incorrect model publisher groups are corrected from trusted source URLs',()=>{
  const p=payload(),assessment=structuredClone(p.verification);
  assessment.sources[0].origin_group='made-up';
  assessment.claims[0].origin_groups=['made-up','b'];
  const fixed=normalizePublisherEvidence(assessment,p.sources,{domains:['example.com','example.org'],origins:{}});
  assert.deepEqual(fixed.sources.map(s=>s.origin_group),['example.com','example.org']);
  assert.deepEqual(fixed.claims[0].origin_groups,['example.com','example.org']);
});
test('v1 schema upgrades without deleting old records',async()=>{
  const db=new D1Local();await db.prepare('CREATE TABLE cf_meta(key TEXT PRIMARY KEY,value TEXT)').run();
  await db.prepare("INSERT INTO cf_meta VALUES ('schema_version','1')").run();
  await ensureSchema(db);await ensureSchema(db);
  assert.equal((await db.prepare("SELECT value FROM cf_meta WHERE key='schema_version'").first()).value,'2');
  await db.prepare("INSERT INTO cf_media VALUES ('draft','file')").run();
});
for(const unknown of [false,true])test('photo preview and publication preserve one image and never resend: '+unknown,async()=>{
  const {c,store}=await fixture(),p=payload();p.media={url:'https://example.com/picture.jpg',source_url:p.sources[0].url};
  const d=await store.createDraft({event_key:'photo',topic:'Photo'},p,3600000);
  const original=globalThis.fetch;let channelSends=0;
  globalThis.fetch=mockTelegram(async(method,data)=>{
    assert.equal(method,'sendPhoto');assert.equal(data.caption,p.article.title+'\n\n'+p.article.body);
    if(data.chat_id===c.ownerChat){assert.equal(data.photo,p.media.url);return Response.json({ok:true,result:{message_id:1,photo:[{file_id:'cached-photo'}]}});}
    channelSends++;assert.equal(data.photo,'cached-photo');assert.equal(data.reply_markup.inline_keyboard.length,1);
    if(unknown)throw new Error('connection lost');return Response.json({ok:true,result:{message_id:2}});
  });
  try {
    await assert.rejects(publish(c,store,d.id,1),/show/);
    await notify(c,d,store);
    if(unknown)await assert.rejects(publish(c,store,d.id,1),/გაურკვეველია/);else assert.equal(await publish(c,store,d.id,1),2);
    await assert.rejects(publish(c,store,d.id,1));assert.equal(channelSends,1);
    assert.equal((await store.draft(d.id)).state,unknown?'unknown':'published');
  } finally {globalThis.fetch=original;}
});
