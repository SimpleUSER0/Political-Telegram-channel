import {test} from 'node:test';
import assert from 'node:assert/strict';
import {topicLookupUrl,parseTopicIndex,rankRequestedArticles,guardianTopicLookup,bingTopicLookup} from '../src/topic-search.js';

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
 assert.equal(rankRequestedArticles(docs,'Peru constitution').length,2); // full-text index fallback; AI must verify actual article relevance
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

test('Guardian topic search uses publisher-owned dated URLs without relying on fixed countries',async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=async url=>{
   const u=new URL(url);
   assert.equal(u.origin,'https://content.guardianapis.com');
   assert.equal(u.searchParams.get('q'),'Japan politics');
   return Response.json({response:{results:[
     {webUrl:'https://www.theguardian.com/world/2026/oct/17/japan-trade-summit',
       webTitle:'Tokyo government holds trade summit',webPublicationDate:new Date().toISOString()},
     {webUrl:'https://attacker.invalid/missing',webTitle:'Fake',webPublicationDate:new Date().toISOString()},
   ]}});
 };
 try {
   const articles=await guardianTopicLookup({domains:['theguardian.com'],age:172800000,env:{GUARDIAN_API_KEY:'test-local-key'}},'Japan politics');
   assert.equal(articles.length,1);
   assert.equal(articles[0].feed,'guardian-api');
   assert.ok(rankRequestedArticles(articles,'Japan politics').length===1);
 }finally{globalThis.fetch=original}
});
test('Bing topic news requires original publisher links, discards search-engine URLs',async()=>{
 const original=globalThis.fetch,now=new Date().toUTCString();
 globalThis.fetch=async url=>{
   assert.match(String(url),/bing.com\/news\/search/);
   const item=(link,title)=>'<item><title>'+title+'</title><link><![CDATA['+link+
     ']]></link><pubDate>'+now+'</pubDate></item>';
   const click='http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;aid=&amp;tid=123&amp;url='+
     encodeURIComponent('https://www.bbc.co.uk/news/articles/japan-policy')+'&amp;mkt=en-us';
   return new Response('<rss><channel>'+
     item(click,'Japan parliament approves new agreement')+
     item('https://www.bing.com/news/articles/not-a-publisher','Bing index')+
     item('https://attacker.invalid/x','Spoofed headline')+
     '</channel></rss>',{headers:{'Content-Type':'application/rss+xml'}});
 };
 try{
   const articles=await bingTopicLookup({domains:['bbc.co.uk'],age:172800000},'Japan politics');
   assert.equal(articles.length,1);
   assert.equal(articles[0].url,'https://www.bbc.co.uk/news/articles/japan-policy');
 }finally{globalThis.fetch=original}
});
