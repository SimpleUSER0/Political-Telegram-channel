import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requireDatedSources,generate} from '../src/research.js';
import {fixture} from './helpers.js';

const instant=Date.parse('2026-10-16T18:00:00Z');
const recent='2026-10-16T17:30:00Z';
const settings={age:48*3600000};
const story=(host,date,id)=>({id,url:'https://'+host+'/world/story',text:'Publisher article text',
  ...(date?{publication:{published_at:date,via:'publisher-rss'}}:{})});

test('only publisher-dated fresh articles reach paid verification; source IDs are compacted',()=>{
  const sources=[story('bbc.com',recent,10),story('theguardian.com',null,11),
    story('civil.ge',recent,12)];
  const eligible=requireDatedSources(sources,settings,instant);
  assert.deepEqual(eligible.map(s=>s.id),[0,1]);
  assert.deepEqual(eligible.map(s=>new URL(s.url).hostname),['bbc.com','civil.ge']);
  assert.equal(sources[0].id,10); // original records stay untouched
});

test('unknown, stale, future and single-domain evidence are withheld',()=>{
  const stale='2026-09-01T12:00:00Z',future='2026-10-17T12:00:00Z';
  for(const other of [null,stale,future]){
    assert.throws(()=>requireDatedSources([story('bbc.com',recent,0),
      story('civil.ge',other,1)],settings,instant),/dated sources/);
  }
  assert.throws(()=>requireDatedSources([story('bbc.com',recent,0),
    story('bbc.com',recent,1)],settings,instant),/dated sources/);
});

test('preflight rejects insufficient daily budget without consuming calls or runs',async()=>{
  const {c,store}=await fixture();
  await store.requireCallCapacity(4,4);
  await store.reserve('calls',2);
  await assert.rejects(store.requireCallCapacity(4,3),/Insufficient remaining/);
  await store.requireCallCapacity(4,2);
  const before=await store.status();
  assert.equal(before.usage.calls,2);
  assert.equal(before.usage.runs,0);
  await assert.rejects(generate({...c,dailyCalls:3},store,
    'International diplomatic meeting','QUICK'),/Insufficient remaining/);
  const after=await store.status();
  assert.equal(after.usage.calls,2);
  assert.equal(after.usage.runs,0);
});
