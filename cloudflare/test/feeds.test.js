import {test} from 'node:test';
import assert from 'node:assert/strict';
import {config} from '../src/core.js';
import {discoverFeeds,feedPublication,parseFeed} from '../src/feeds.js';

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
test('Georgian publisher feed dates remain tied to their own discovered articles',()=>{
  const c=config({SOURCE_DOMAINS:'civil.ge,netgazeti.ge',DISCOVERY_MODE:'feeds',SOURCE_FEEDS:'civil-ge,netgazeti'});
  const url='https://netgazeti.ge/news/123456/',[article]=parseFeed('<rss>'+item(url)+'</rss>',c);
  const entry={...article,feed:'netgazeti',feed_url:'https://netgazeti.ge/feed/'};
  assert.equal(feedPublication([entry],url,url).published_at,article.published_at);
  assert.equal(feedPublication([entry],url,'https://civil.ge/news/123456'),null);
});
