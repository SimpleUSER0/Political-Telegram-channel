import {test} from 'node:test';
import assert from 'node:assert/strict';
import {topicLookupUrl,parseTopicIndex,rankRequestedArticles} from '../src/topic-search.js';

test('News index search URL has fixed HTTPS origin and properly escaped arbitrary query',()=>{
 const url=new URL(topicLookupUrl('New Zealand elections and policy'));
 assert.equal(url.origin,'https://api.gdeltproject.org');
 assert.equal(url.pathname,'/api/v2/doc/doc');
 assert.equal(url.searchParams.get('mode'),'artlist');
 assert.equal(url.searchParams.get('query'),'New Zealand elections and policy');
 assert.match(topicLookupUrl('Japan? & dangerous_domain:example.com'),/api.gdeltproject.org/);
});
test('Public index metadata is not publisher-reported publication proof',()=>{
 const data={articles:[
  {url:'https://www.bbc.co.uk/news/articles/1',title:'Japan election policy announced',seendate:'20261017T200000Z'},
  {url:'https://www.theguardian.com/world/2026/oct/17/unrelated',title:'Russia sanctions expanded',seendate:'20261017203000'},
  {url:'https://malicious.example.com/article',title:'Japan election policy',seendate:'20261017213000'},
 ]};
 const docs=parseTopicIndex(data,['bbc.co.uk','theguardian.com']);
 assert.equal(docs.length,2);
 assert.equal(docs[0].published_at,'2026-10-17T20:00:00.000Z');
 assert.deepEqual(rankRequestedArticles(docs,'Japan election'),[docs[0]]);
 assert.deepEqual(rankRequestedArticles(docs,'Peru constitution'),[]);
});
test('Topic candidates cannot fall back to unrelated politics to satisfy a post quota',()=>{
 const docs=[
   {title:'US sanctions on Russia',url:'https://www.bbc.co.uk/news/articles/1',published_at:'2026-10-17T20:00:00.000Z'},
   {title:'Ecuador parliament election',url:'https://www.bbc.co.uk/news/articles/2',published_at:'2026-10-17T19:00:00.000Z'},
 ];
 assert.deepEqual(rankRequestedArticles(docs,'Ecuador election'),[docs[1]]);
 assert.deepEqual(rankRequestedArticles(docs,'Japan government'),[]);
});

test('Index-selected topical articles without literal country name remain candidates for actual-source AI verification',()=>{
 const docs=[{title:'Takaichi approves new trade measure',feed:'gdelt-index',
  published_at:'2026-10-17T19:00:00Z'}];
 assert.deepEqual(rankRequestedArticles(docs,'Japan trade'),docs);
});
