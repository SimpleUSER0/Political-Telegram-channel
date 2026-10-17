import {test} from 'node:test';
import assert from 'node:assert/strict';
import {editorialTopic,editorialFeeds,editorialRelevant,editorialCandidates} from '../src/editorial.js';

test('World Focus interprets country requests as POLITICAL scope, not any country news',()=>{
  assert.equal(editorialTopic('ჩინეთი').id,'china');
  assert.equal(editorialTopic('China political situation').id,'china');
  assert.equal(editorialTopic('აშშ').id,'usa');
  assert.equal(editorialTopic('საქართველო').id,'georgia');
  assert.equal(editorialTopic('ახლო აღმოსავლეთი').id,'middle-east');
  assert.equal(editorialTopic('უკრაინა').id,'ukraine-russia');
  assert.equal(editorialTopic('მსოფლიოს ახალი ამბები'),null);
});
test('topic-specific RSS expands publishers rather than replacing global or Georgian feeds',()=>{
  assert.deepEqual(editorialFeeds('ჩინეთი',['bbc-world','civil-ge']),
    ['bbc-world','civil-ge','bbc-asia','guardian-china']);
  assert.deepEqual(editorialFeeds('აშშ',['bbc-world']),['bbc-world','guardian-us-politics']);
  assert.deepEqual(editorialFeeds('საქართველო',['bbc-world','civil-ge']),['bbc-world','civil-ge']);
  assert.deepEqual(editorialFeeds('ახლო აღმოსავლეთი',['guardian-world']),
    ['guardian-world','bbc-middle-east','guardian-middle-east']);
});
test('China criminal verdict and celebrity stories are not political news',()=>{
  const crime={title:'Nursery owner in China jailed for life after hundreds of children poisoned',summary:'Children poisoned after accidental exposure'};
  assert.equal(editorialRelevant(crime,'ჩინეთი'),false);
  assert.equal(editorialRelevant({title:'Famous Chinese movie actor hospitalised'},'China'),false);
  assert.equal(editorialRelevant({title:'Pope discharged from hospital after operation'},'მსოფლიო'),false);
});
test('actual political developments from requested regions pass metadata prefilter',()=>{
  assert.equal(editorialRelevant({title:'China and US hold security summit in Beijing'},'ჩინეთი'),true);
  assert.equal(editorialRelevant({title:'Beijing imposes new tariffs on US imports'},'China'),true);
  assert.equal(editorialRelevant({title:'Georgia parliament approves new election law'},'საქართველო'),true);
  assert.equal(editorialRelevant({title:'Israeli foreign minister announces ceasefire talks'},'ახლო აღმოსავლეთი'),true);
  assert.equal(editorialRelevant({title:'China and US hold security summit in Beijing'},'საქართველო'),false);
  assert.equal(editorialRelevant({title:'Trump meets foreign minister in Washington'},'ჩინეთი'),false);
});
test('global summaries keep political coverage but exclude routine unrelated news',()=>{
  const entries=[
    {title:'China nursery owner jailed after poisoning'},
    {title:'Georgian parliament convenes to discuss election law'},
    {title:'Russian foreign minister arrives at security summit'},
    {title:'Football cup final draws record crowd'},
  ];
  assert.deepEqual(editorialCandidates(entries,'მსოფლიო').map(x=>x.title),
    [entries[1].title,entries[2].title]);
});
