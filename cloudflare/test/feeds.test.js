import {test} from 'node:test';
import assert from 'node:assert/strict';
import {config} from '../src/core.js';
import {discoverFeeds,feedImage,feedPublication,parseFeed} from '../src/feeds.js';

const settings=()=>config({SOURCE_DOMAINS:'bbc.co.uk,theguardian.com,civil.ge',DISCOVERY_MODE:'feeds'});
const item=(url,date=new Date().toUTCString())=>`<item><title><![CDATA[Meeting &amp; diplomacy]]></title><link>${url}</link><pubDate>${date}</pubDate><description>&lt;b&gt;Context&lt;/b&gt;</description></item>`;
test('publisher RSS admits only dated allowlisted article URLs and deduplicates tracking variants',()=>{
  const c=settings(),url='https://www.bbc.co.uk/news/articles/abc';
  const xml='<rss><channel>'+item(url+'?utm_source=rss')+item(url)+
    item('https://evil.example/story')+item(url+'/stale','Sun, 01 Jan 2000 00:00:00 GMT')+
    item(url+'/future','Sun, 01 Jan 2099 00:00:00 GMT')+item(url+'/unknown','unknown')+'</channel></rss>';
  const entries=parseFeed(xml,c);assert.equal(entries.length,1);assert.equal(entries[0].url,url);
  assert.equal(entries[0].title,'Meeting & diplomacy');assert.equal(entries[0].summary,'Context');
});
test('feed discovery cannot follow a publisher redirect to a private or unrelated host',async()=>{
  const original=globalThis.fetch,seen=[];
  globalThis.fetch=async url=>{seen.push(url);return new Response(null,{status:302,headers:{Location:'https://127.0.0.1/private'}});};
  try {await assert.rejects(discoverFeeds(settings()),/No accessible recent articles/);assert.equal(seen.length,3);
    assert.ok(seen.every(url=>!url.includes('127.0.0.1')));
  }finally{globalThis.fetch=original;}
});
test('feed mode is an explicit configuration choice and rejects unknown feed targets',()=>{
  assert.equal(config({}).discovery,'web_search');
  assert.throws(()=>config({DISCOVERY_MODE:'feeds',SOURCE_FEEDS:'bbc-world,internal-metadata'}),/known publisher feed/);
  assert.deepEqual(config({DISCOVERY_MODE:'feeds',SOURCE_FEEDS:'bbc-world'}).feeds,['bbc-world']);
});
test('real photo metadata from the original publisher feed is accepted safely',()=>{
  const c=settings(),article='https://www.bbc.co.uk/news/articles/abc';
  const xml='<rss><item><title>Diplomatic agreement</title><link>'+article+'</link><pubDate>'+
    new Date().toUTCString()+'</pubDate><media:thumbnail url="https://ichef.bbci.co.uk/images/report.jpg" /></item></rss>';
  const [entry]=parseFeed(xml,c,'bbc-world');
  const linked={...entry,feed:'bbc-world',feed_url:'https://feeds.bbci.co.uk/news/world/rss.xml'};
  assert.equal(entry.image.kind,'publisher-feed-image');
  assert.equal(feedImage([linked],article,article).url,'https://ichef.bbci.co.uk/images/report.jpg');
  assert.equal(feedImage([linked],article,'https://civil.ge/archives/1'),null);
  const bad=xml.replace('ichef.bbci.co.uk','evil.example');
  assert.equal(parseFeed(bad,c,'bbc-world')[0].image,undefined);
});
test('Georgian publisher feed dates remain tied to their own discovered articles',()=>{
  const c=config({SOURCE_DOMAINS:'civil.ge,netgazeti.ge',DISCOVERY_MODE:'feeds',SOURCE_FEEDS:'civil-ge,netgazeti'});
  const url='https://netgazeti.ge/news/123456/',[article]=parseFeed('<rss>'+item(url)+'</rss>',c);
  const entry={...article,feed:'netgazeti',feed_url:'https://netgazeti.ge/feed/'};
  assert.equal(feedPublication([entry],url,url).published_at,article.published_at);
  assert.equal(feedPublication([entry],url,'https://civil.ge/news/123456'),null);
});


test('China news asks regional publisher RSS rather than treating world crime as a political story',async()=>{
  const c=config({SOURCE_DOMAINS:'bbc.co.uk,bbc.com,theguardian.com',DISCOVERY_MODE:'feeds',SOURCE_FEEDS:'bbc-world'});
  const original=globalThis.fetch,visited=[];
  globalThis.fetch=async url=>{
    visited.push(String(url));
    if(String(url).includes('/asia/'))return new Response('<rss><channel>'+
      item('https://www.bbc.co.uk/news/articles/china-summit')+
      '</channel></rss>',{headers:{'Content-Type':'application/rss+xml'}});
    return new Response('<rss><channel>'+
      item('https://www.bbc.co.uk/news/articles/world-story')+
      '</channel></rss>',{headers:{'Content-Type':'application/rss+xml'}});
  };
  try {
    const data=await discoverFeeds(c,'ჩინეთი');
    assert.ok(visited.some(url=>url.includes('/asia/rss.xml')));
    assert.ok(visited.some(url=>url.includes('/world/rss.xml')));
    assert.ok(data.articles.some(article=>article.feed==='bbc-asia'));
    assert.ok(data.articles.every(article=>article.url.startsWith('https://www.bbc.co.uk/')));
  } finally {globalThis.fetch=original;}
});
