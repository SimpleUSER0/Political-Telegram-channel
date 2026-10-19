import {test} from 'node:test';
import assert from 'node:assert/strict';
import {topicLookupUrl,parseTopicIndex,rankRequestedArticles,guardianTopicLookup,bingTopicLookup,MANUAL_PUBLISHER_DOMAINS} from '../src/topic-search.js';

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
 assert.equal(rankRequestedArticles(docs,'Peru constitution').length,0); // never pick unrelated articles
});
test('Broad Middle East searches accept relevant regional reporting without matching East Asia noise',()=>{
 const docs=[
  {title:'Iran and Israel trade fire as ceasefire talks resume',url:'https://www.aljazeera.com/news/1',published_at:'2026-10-19T14:00:00Z'},
  {title:'East Asian leaders meet for regional summit',url:'https://www.dw.com/news/2',published_at:'2026-10-19T13:00:00Z'},
  {title:'Middle-class tax relief announced',url:'https://www.france24.com/news/3',published_at:'2026-10-19T12:00:00Z'},
 ];
 assert.deepEqual(rankRequestedArticles(docs,'Middle East current developments'),[docs[0]]);
});

test('Manual discovery allows broad international reporting while still rejecting arbitrary domains',()=>{
 for(const domain of ['www.reuters.com','www.bbc.com','www.aljazeera.com','www.haaretz.com',
   'www.middleeasteye.net','www.thenationalnews.com','www.dw.com'])
  assert.equal(parseTopicIndex({articles:[{url:`https://${domain}/story/1`,title:'Report on regional talks',
   seendate:'20261019T140000Z'}]},MANUAL_PUBLISHER_DOMAINS).length,1,domain);
 assert.equal(parseTopicIndex({articles:[{url:'https://unverified-blog.example/story/1',
   title:'Report on regional talks',seendate:'20261019T140000Z'}]},MANUAL_PUBLISHER_DOMAINS).length,0);
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

test('Owner-requested seven-day sources include recent real publisher stories excluded from breaking-news window',async()=>{
 const original=globalThis.fetch,day=new Date(Date.now()-72*3600000).toUTCString();
 globalThis.fetch=async()=>{
   const target='https://apnews.com/article/japan-takaichi-politics';
   const redirect='http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;url='+encodeURIComponent(target)+'&amp;c=123';
   return new Response('<rss><channel><item><title>Japan cabinet policy announcement</title>'+
     '<link>'+redirect+'</link><pubDate>'+day+'</pubDate></item></channel></rss>',
     {headers:{'Content-Type':'application/rss+xml'}});
 };
 try {
   const base={domains:['apnews.com'],age:48*3600000};
   const old=await bingTopicLookup(base,'Japan cabinet policy');
   assert.equal(old.length,0);
   const week=await bingTopicLookup({...base,age:168*3600000},'Japan cabinet policy');
   assert.equal(week.length,1);
   assert.equal(week[0].url,'https://apnews.com/article/japan-takaichi-politics');
 }finally{globalThis.fetch=original;}
});

test('Manual requests may concern physics, football, gaming and science without political restriction',()=>{
  const items=[
    {title:'Researchers explain quantum physics discovery',published_at:'2026-10-17T10:00:00Z'},
    {title:'New Xbox gaming console release',published_at:'2026-10-17T09:00:00Z'},
    {title:'Football world cup qualification',published_at:'2026-10-17T08:00:00Z'},
    {title:'Political talks between foreign ministers',published_at:'2026-10-17T07:00:00Z'},
  ];
  assert.deepEqual(rankRequestedArticles(items,'quantum physics').map(x=>x.title),[items[0].title]);
  assert.deepEqual(rankRequestedArticles(items,'Xbox gaming').map(x=>x.title),[items[1].title]);
  assert.deepEqual(rankRequestedArticles(items,'football cup').map(x=>x.title),[items[2].title]);
  assert.deepEqual(rankRequestedArticles(items,'physics quantum').some(x=>x===items[3]),false);
});
