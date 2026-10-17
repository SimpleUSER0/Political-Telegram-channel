import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publisherGroup,rankedCandidates,selectDiscoveredSources} from '../src/research.js';

const catalog=[
  'https://www.bbc.co.uk/news/articles/a?at_medium=RSS&at_campaign=rss',
  'https://www.theguardian.com/world/2026/oct/17/meeting/',
  'https://civil.ge/archives/123456',
];
test('catalog IDs preserve publisher URLs and tracking without model URL reconstruction',()=>{
  assert.deepEqual(selectDiscoveredSources([1,0,1],catalog),[catalog[1],catalog[0]]);
});
test('unknown, fractional and URL-shaped IDs cannot introduce an undiscovered fetch target',()=>{
  for(const bad of [-1,3,1.5,'0','https://www.bbc.com/news/articles/invented',null])
    assert.throws(()=>selectDiscoveredSources([0,bad],catalog),/Unknown discovered source ID/);
  for(const bad of [null,'0,1',{}])
    assert.throws(()=>selectDiscoveredSources(bad,catalog),/Unknown discovered source ID/);
});
test('deduplicated selection still requires two to six discovered URLs',()=>{
  for(const ids of [[],[0],[0,0]])
    assert.throws(()=>selectDiscoveredSources(ids,catalog),/two to six/);
  assert.throws(()=>selectDiscoveredSources([0,1,2,3,4,5,6],
    Array.from({length:7},(_,i)=>'https://civil.ge/archives/'+i)),/two to six/);
});

test('a same-publisher first candidate is skipped in favor of a valid ranked event',()=>{
  const urls=['https://civil.ge/a','https://civil.ge/b','https://www.bbc.co.uk/news/a',
    'https://www.theguardian.com/world/a'];
  const c={age:3600000,domains:['civil.ge','bbc.co.uk','theguardian.com'],origins:{}};
  const event={event_key:'meeting_today',topic:'Meeting today',event_at:new Date().toISOString()};
  const result=rankedCandidates([{...event,source_ids:[0,1]},
    {...event,event_key:'new_world_event',source_ids:[2,3]}],urls,c,[]);
  assert.equal(result.length,1);assert.equal(result[0].event_key,'new_world_event');
  assert.deepEqual(result[0].source_urls,[urls[2],urls[3]]);
});
test('publisher aliases, duplicates and invalid IDs cannot supply a second publisher',()=>{
  const c={age:3600000,domains:['bbc.co.uk','bbc.com','civil.ge'],origins:{'bbc.co.uk':'bbc','bbc.com':'bbc'}};
  const urls=['https://www.bbc.co.uk/news/a','https://www.bbc.com/news/a','https://civil.ge/a'];
  assert.equal(publisherGroup(urls[0],c),publisherGroup(urls[1],c));
  const event={event_key:'world_meeting',topic:'World meeting',event_at:new Date().toISOString()};
  assert.throws(()=>rankedCandidates([{...event,source_ids:[0,1]}],urls,c,[]),/distinct publishers/);
  assert.throws(()=>rankedCandidates([{...event,source_ids:[0,2]}],urls,c,
    [{event_key:event.event_key,topic:'An earlier title'}]),/distinct publishers/);
  assert.throws(()=>rankedCandidates([{...event,source_ids:[0,99]}],urls,c,[]),/distinct publishers/);
  assert.throws(()=>rankedCandidates(Array(4).fill({...event,source_ids:[0,2]}),urls,c,[]),/Invalid candidate list/);
});
