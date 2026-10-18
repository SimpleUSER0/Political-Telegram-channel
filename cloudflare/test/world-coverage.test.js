import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publisherCandidates} from '../src/research.js';
import {editorialTopic} from '../src/editorial.js';

test('worldwide scope remains global',()=>{
  assert.equal(editorialTopic('მნიშვნელოვანი ახალი ამბავი მსოფლიოში და საქართველოში'),null);
});
test('scheduled source mix avoids repeating a recently covered local source',()=>{
  const date=new Date().toISOString();
  const items=[
    {url:'https://civil.ge/archives/1',title:'Georgia cabinet meeting',source_id:0,published_at:date},
    {url:'https://www.bbc.co.uk/news/articles/2',title:'EU leaders summit',source_id:1,published_at:date},
  ];
  const history=[{topic:'Cabinet decision',url:'https://civil.ge/archives/9',state:'published'}];
  assert.deepEqual(publisherCandidates(items,history,3,'morning',true).map(x=>x.source_ids),[[1]]);
  assert.equal(publisherCandidates(items,history,3,'morning',false).length,2);
});
