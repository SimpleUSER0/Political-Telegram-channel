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
test('one discovered URL is sufficient',()=>{
  for(const ids of [[]])
    assert.throws(()=>selectDiscoveredSources(ids,catalog),/one to six/);
  assert.throws(()=>selectDiscoveredSources([0,1,2,3,4,5,6],
    Array.from({length:7},(_,i)=>'https://civil.ge/archives/'+i)),/one to six/);
});

test('a same-publisher candidate is allowed',()=>{
  const urls=['https://civil.ge/a','https://civil.ge/b','https://www.bbc.co.uk/news/a',
    'https://www.theguardian.com/world/a'];
  const c={age:3600000,domains:['civil.ge','bbc.co.uk','theguardian.com'],origins:{}};
  const event={event_key:'meeting_today',topic:'Meeting today',event_at:new Date().toISOString()};
  const result=rankedCandidates([{...event,source_ids:[0,1]},
    {...event,event_key:'new_world_event',source_ids:[2,3]}],urls,c,[]);
  assert.equal(result.length,2);assert.equal(result[0].event_key,'meeting_today');
  assert.deepEqual(result[0].source_urls,[urls[0],urls[1]]);
});
test('one publisher is allowed but duplicates and invalid IDs still fail',()=>{
  const c={age:3600000,domains:['bbc.co.uk','bbc.com','civil.ge'],origins:{'bbc.co.uk':'bbc','bbc.com':'bbc'}};
  const urls=['https://www.bbc.co.uk/news/a','https://www.bbc.com/news/a','https://civil.ge/a'];
  assert.equal(publisherGroup(urls[0],c),publisherGroup(urls[1],c));
  const event={event_key:'world_meeting',topic:'World meeting',event_at:new Date().toISOString()};
  assert.equal(rankedCandidates([{...event,source_ids:[0]}],urls,c,[]).length,1);
  assert.throws(()=>rankedCandidates([{...event,source_ids:[0,2]}],urls,c,
    [{event_key:event.event_key,topic:'An earlier title'}]),/No eligible new event/);
  assert.throws(()=>rankedCandidates([{...event,source_ids:[0,99]}],urls,c,[]),/No eligible new event/);
  assert.throws(()=>rankedCandidates(Array(4).fill({...event,source_ids:[0,2]}),urls,c,[]),/Invalid candidate list/);
});
