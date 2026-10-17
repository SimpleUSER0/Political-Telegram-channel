import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publisherGroup,publisherCandidates,rankedCandidates,selectDiscoveredSources,publisherImage} from '../src/research.js';

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

test('RSS candidates use only genuine publisher title, date and source ID',()=>{
  const date='2026-10-17T12:00:00Z';
  const sources=[{url:'https://www.bbc.co.uk/news/articles/china-diplomacy',
    title:'China and EU hold diplomatic summit',published_at:date,source_id:0},
    {url:'https://www.theguardian.com/world/2026/oct/17/taiwan-security',
      title:'Taiwan security talks in Asia',published_at:'2026-10-17T13:00:00Z',source_id:1}];
  const result=publisherCandidates(sources);
  assert.equal(result[0].topic,sources[1].title);
  assert.equal(result[1].topic,sources[0].title);
  assert.deepEqual(result.map(e=>e.source_ids),[[1],[0]]);
  assert.match(result[0].event_key,/^rss_[a-z0-9]+_2026-10-17$/);
  const same=publisherCandidates(sources,[{event_key:result[0].event_key}]);
  assert.deepEqual(same.map(e=>e.topic),[sources[0].title]);
});

test('AP photo is accepted only from publisher-owned image CDN, not arbitrary image links',()=>{
 const url='https://apnews.com/article/japan-takaichi-politics';
 const c={domains:['apnews.com','bbc.co.uk']};
 const html='<meta property="og:image" content="https://dims.apnews.com/dims4/default/crop/1000x750/image.jpg">';
 assert.deepEqual(publisherImage(html,url,c),{
   url:'https://dims.apnews.com/dims4/default/crop/1000x750/image.jpg',
   source_url:url,kind:'publisher-image'});
 const fake='<meta property="og:image" content="https://images.attacker.example.com/fake.jpg">';
 assert.equal(publisherImage(fake,url,c),null);
 const jt='https://www.japantimes.co.jp/news/2026/10/17/japan/politics/report/';
 const image='<meta property="og:image" content="https://cdn-japantimes.com/photos/2026/10/japan.jpg">';
 assert.equal(publisherImage(image,jt,c)?.kind,'publisher-image');
});
