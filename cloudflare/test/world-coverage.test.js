import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publisherCandidates} from '../src/research.js';
import {editorialTopic} from '../src/editorial.js';

test('worldwide scope remains global',()=>{
  assert.equal(editorialTopic('მნიშვნელოვანი ახალი ამბავი მსოფლიოში და საქართველოში'),null);
});
test('scheduled source mix avoids repeating a recently covered local source',()=>{
  const now=Date.now(),date=new Date(now).toISOString();
  const items=[
    {url:'https://civil.ge/archives/1',title:'Georgia cabinet meeting',source_id:0,published_at:date},
    {url:'https://www.bbc.co.uk/news/articles/2',title:'EU leaders summit',source_id:1,published_at:date},
  ];
  const history=[{topic:'Cabinet decision',url:'https://civil.ge/archives/9',state:'published',created_at:now}];
  assert.deepEqual(publisherCandidates(items,history,3,'morning',true).map(x=>x.source_ids),[[1]]);
  assert.equal(publisherCandidates(items,history,3,'morning',false).length,2);
});
test('scheduled mix allows at most one Georgian story per Tbilisi day and two per eight drafts',()=>{
  const time=Date.UTC(2026,9,18,12); // 16:00 Tbilisi
  const local={url:'https://civil.ge/archives/new',title:'Georgian Dream announces a new policy',source_id:0,published_at:new Date(time).toISOString()};
  const world={url:'https://www.bbc.co.uk/news/articles/new',title:'Japan and EU sign a security agreement',source_id:1,published_at:new Date(time).toISOString()};
  const olderLocal={topic:'Georgian Dream cabinet meeting',url:'https://civil.ge/archives/old',created_at:time-24*3600000,state:'pending',scheduled:true};
  const todayLocal={...olderLocal,created_at:time-3600000};
  assert.deepEqual(publisherCandidates([local,world],[todayLocal],3,'night',true,time).map(x=>x.source_ids),[[1]]);
  const twoLocal=Array.from({length:2},(_,i)=>({...olderLocal,event_key:'local-'+i,created_at:time-(i+1)*24*3600000}));
  assert.deepEqual(publisherCandidates([local,world],twoLocal,3,'night',true,time).map(x=>x.source_ids),[[1]]);
  assert.deepEqual(publisherCandidates([local,world],[olderLocal],3,'night',true,time).map(x=>x.source_ids),[[1],[0]]);
});
test('manual Georgian requests do not consume the scheduled balance quota',()=>{
  const time=Date.UTC(2026,9,18,12);
  const local={url:'https://civil.ge/archives/new',title:'Georgian Dream announces a new policy',source_id:0,published_at:new Date(time).toISOString()};
  const manual={topic:local.title,url:local.url,created_at:time-3600000,state:'pending',scheduled:false};
  assert.equal(publisherCandidates([local],[manual],3,'night',true,time).length,1);
});
