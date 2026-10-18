import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requireDatedSources,generate} from '../src/research.js';
import {config,nonScheduledCallLimit} from '../src/core.js';
import {fixture} from './helpers.js';

const instant=Date.parse('2026-10-16T18:00:00Z');
const recent='2026-10-16T17:30:00Z';
const settings={age:48*3600000};
const story=(host,date,id)=>({id,url:'https://'+host+'/world/story',text:'Publisher article text',
  ...(date?{publication:{published_at:date,via:'publisher-rss'}}:{})});

test('ad-hoc API calls preserve four calls for each not-yet-passed Tbilisi edition',()=>{
  const c=config({MAX_DAILY_CALLS:'120',SCHEDULE_ENABLED:'true',SCHEDULE_HOURS:'[9,13,18,21]'});
  assert.equal(nonScheduledCallLimit(c,Date.parse('2026-10-18T08:30:00Z')),108); // 12:30 Tbilisi
  assert.equal(nonScheduledCallLimit(c,Date.parse('2026-10-18T13:30:00Z')),112); // 17:30 Tbilisi
  assert.equal(nonScheduledCallLimit(c,Date.parse('2026-10-18T18:30:00Z')),120); // 22:30 Tbilisi
});

test('daily call cap remains hard when a conversation is given a reserved-slot budget',async()=>{
  const {c,store}=await fixture();
  await store.reserve('calls',1);
  const {llm}=await import('../src/research.js');
  await assert.rejects(llm({...c,dailyCalls:10,callLimit:1},store,'No API request should run',{}),/budget/);
  assert.equal((await store.status()).usage.calls,1);
});

test('only publisher-dated fresh articles reach paid verification; source IDs are compacted',()=>{
  const sources=[story('bbc.com',recent,10),story('theguardian.com',null,11),
    story('civil.ge',recent,12)];
  const eligible=requireDatedSources(sources,settings,instant);
  assert.deepEqual(eligible.map(s=>s.id),[0,1]);
  assert.deepEqual(eligible.map(s=>new URL(s.url).hostname),['bbc.com','civil.ge']);
  assert.equal(sources[0].id,10); // original records stay untouched
});

test('one fresh source is sufficient; unknown, stale and future sources are filtered',()=>{
  const stale='2026-09-01T12:00:00Z',future='2026-10-17T12:00:00Z';
  for(const other of [null,stale,future]){
    assert.throws(()=>requireDatedSources([story('civil.ge',other,1)],settings,instant),/No recent readable publisher/);
  }
  assert.equal(requireDatedSources([story('bbc.com',recent,0)],settings,instant).length,1);
});

test('preflight rejects insufficient daily budget without consuming calls or runs',async()=>{
  const {c,store}=await fixture();
  await store.requireCallCapacity(4,4);
  await store.reserve('calls',4);
  await store.reserve('calls',4);
  await assert.rejects(store.requireCallCapacity(4,3),/Insufficient remaining/);
  await store.requireCallCapacity(4,2);
  const before=await store.status();
  assert.equal(before.usage.calls,2);
  assert.equal(before.usage.runs,0);
  await assert.rejects(generate({...c,dailyCalls:3},store,
    'International diplomatic meeting','QUICK'),/budget cannot cover|Insufficient remaining/);
  const after=await store.status();
  assert.equal(after.usage.calls,2);
  assert.equal(after.usage.runs,0);
});

test('unexpected errors name the failed stage without revealing raw secret-like messages',async()=>{
  const {c,store}=await fixture();
  store.history=async()=>{throw new TypeError('SECRET=untrusted-sensitive-value');};
  await assert.rejects(generate(c,store,'International meeting','QUICK'),error=>{
    assert.match(error.message,/Research execution failed at budget \(TypeError\)/);
    assert.ok(!error.message.includes('untrusted-sensitive-value'));
    return true;
  });
  const status=await store.status();
  assert.equal(status.usage,null);
});
