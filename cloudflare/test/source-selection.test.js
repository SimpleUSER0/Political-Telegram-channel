import {test} from 'node:test';
import assert from 'node:assert/strict';
import {selectDiscoveredSources} from '../src/research.js';

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
