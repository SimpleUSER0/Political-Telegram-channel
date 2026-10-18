import {Halt,readText,sourceUrl} from './core.js';
import {discoverFeeds} from './feeds.js';

// Topic posts can use established reporting across domains, not just four
// political RSS feeds. All returned URLs still pass sourceUrl's domain guard.
export const MANUAL_PUBLISHER_DOMAINS=Object.freeze([
 'apnews.com','reuters.com','japantimes.co.jp','theverge.com','techcrunch.com',
 'arstechnica.com','nature.com','science.org','sciencedaily.com',
 'nasa.gov','britannica.com','smithsonianmag.com','nationalgeographic.com',
 'who.int','un.org','phys.org','ign.com','espn.com',
]);
// Public GDELT DOC 2.0 indexes publisher URLs. It does not establish the article's
// publication date or factual claims: these come from fetching the real publisher.
// This fixed-origin, keyless lookup allows any owner-specified topic and does not
// consume Gemini paid Google Search grounding (unavailable on the free tier).
export function topicLookupUrl(englishKeywords) {
  const words=String(englishKeywords||'').trim()
    .replace(/[^\p{L}\p{N}\s'.,-]/gu,' ').replace(/\s+/gu,' ').slice(0,125);
  if(words.length<3)throw new Halt('Topic search terms missing');
  const url=new URL('https://api.gdeltproject.org/api/v2/doc/doc');
  url.searchParams.set('query',words);
  url.searchParams.set('mode','artlist');
  url.searchParams.set('format','json');
  url.searchParams.set('maxrecords','75');
  url.searchParams.set('sort','datedesc');
  url.searchParams.set('timespan','2d');
  return url.href;
}
export function parseTopicIndex(response,domains) {
  if(!response || !Array.isArray(response.articles))return [];
  const seen=new Set(),articles=[];
  for(const record of response.articles.slice(0,100)){
    let url;
    try{url=sourceUrl(record.url,domains)}catch{continue}
    if(seen.has(url)||typeof record.title!=='string')continue;
    const title=record.title.trim().slice(0,180);
    if(title.length<7)continue;
    // First seen is NOT publisher publication time; use it for ranking only.
    const rawSeen=String(record.seendate||'');
    const digits=rawSeen.replace(/^([0-9]{8})T([0-9]{6})Z$/,'$1$2');
    const date=/^\d{14}$/.test(digits)?
      Date.UTC(Number(digits.slice(0,4)),Number(digits.slice(4,6))-1,
        Number(digits.slice(6,8)),Number(digits.slice(8,10)),
        Number(digits.slice(10,12)),Number(digits.slice(12,14))):
      Date.parse(rawSeen);
    if(!Number.isFinite(date))continue;
    seen.add(url);
    articles.push({url,title,summary:'',first_seen_at:new Date(date).toISOString(),
      published_at:new Date(date).toISOString(),feed:'gdelt-index'});
    if(articles.length>=60)break;
  }
  return articles;
}
const RELATED_TOPIC_WORDS={
  japan:['japan','japanese','tokyo','takaichi','ishiba','kishida','yasukuni'],
  china:['china','chinese','beijing','xi','taiwan'],
  ukraine:['ukraine','ukrainian','kyiv','zelensky'],
  russia:['russia','russian','moscow','putin','kremlin'],
  georgia:['georgia','georgian','tbilisi','kobakhidze','ivanishvili'],
  ai:['ai','artificial intelligence','openai','gemini','chatgpt'],
  gaming:['game','gaming','playstation','xbox','nintendo','sony'],
  physics:['physics','quantum','particle','scientist'],
};
export function rankRequestedArticles(articles,searchTerms,max=3) {
  // Never select a random world-politics story as a substitute.
  const tokens=String(searchTerms).toLowerCase().split(/\W+/u)
    .filter(x=>x.length>3 && !['news','latest','about','from','with','politics','political'].includes(x));
  if(!tokens.length)return [];
  const words=new Set(tokens.flatMap(word=>[word,...(RELATED_TOPIC_WORDS[word]||[])]));
  const ranked=articles.map(article=>{
    const title=String(article.title||'').toLowerCase();
    const matched=[...words].filter(word=>title.includes(word)).length;
    return {article,matched};
  });
  // The index is NOT an instruction to invent relevance. Without even one
  // headline match, reject the topic rather than selecting random politics.
  return ranked.filter(x=>x.matched>0)
    .sort((a,b)=>b.matched-a.matched||
      Date.parse(b.article.published_at)-Date.parse(a.article.published_at))
    .slice(0,max).map(x=>x.article);
}
// Publisher-owned content API: real Guardian titles/URLs/publication times.
// 'test' is the publicly documented low-rate demonstration key.
export async function guardianTopicLookup(c,englishKeywords) {
  const u=new URL('https://content.guardianapis.com/search');
  if(!c.env.GUARDIAN_API_KEY)return [];
  u.searchParams.set('api-key',c.env.GUARDIAN_API_KEY);
  u.searchParams.set('q',String(englishKeywords).slice(0,140));
  u.searchParams.set('order-by','newest');
  u.searchParams.set('page-size','35');
  const response=await fetch(u.href,{signal:AbortSignal.timeout(8500),
    headers:{Accept:'application/json'}});
  if(!response.ok){await response.body?.cancel();return [];}
  const packet=JSON.parse(await readText(response,300000));
  const items=packet?.response?.results||[];
  if(!Array.isArray(items))return [];
  const results=[];
  for(const item of items){
    let url;try{url=sourceUrl(item.webUrl,c.domains)}catch{continue}
    const published=Date.parse(String(item.webPublicationDate||''));
    if(!Number.isFinite(published)||published<Date.now()-c.age||
       published>Date.now()+600000||typeof item.webTitle!=='string')continue;
    results.push({url,title:item.webTitle.slice(0,180),summary:'',
      published_at:new Date(published).toISOString(),feed:'guardian-api'});
  }
  return results;
}
function rssField(item,name) {
  const raw=new RegExp('<'+name+'(?:\\s[^>]*)?>([\\s\\S]*?)</'+name+'>','i')
    .exec(item)?.[1]||'';
  return raw.replace(/^<!\[CDATA\[|\]\]>$/g,'').replace(/&amp;/g,'&')
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"')
    .replace(/<[^>]+>/g,'').trim();
}
// Bing's public RSS supports arbitrary search queries. Some items use Bing's
// news/apiclick redirect; accept ONLY a publisher URL inside a named query arg,
// validate it against the existing allowed publisher domains.
export async function bingTopicLookup(c,englishKeywords) {
  const u=new URL('https://www.bing.com/news/search');
  u.searchParams.set('q',String(englishKeywords).slice(0,140));
  u.searchParams.set('format','rss');
  const response=await fetch(u.href,{signal:AbortSignal.timeout(8500),
    headers:{Accept:'application/rss+xml'}});
  if(!response.ok){await response.body?.cancel();return [];}
  const xml=await readText(response,400000);
  if(!/<rss[\s>]/i.test(xml))return [];
  const results=[],seen=new Set();
  for(const match of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)){
    const item=match[1],raw=rssField(item,'link'),headline=rssField(item,'title');
    // Bing emits HTTP apiclick links with XML-escaped ampersands. Decode ONLY
    // the fixed Bing redirect's named destination; never request Bing redirects
    // or accept arbitrary URL hosts as publisher evidence.
    let direct=raw.replaceAll('&amp;','&').replaceAll('&#38;','&');
    try{
      const link=new URL(direct);
      if(['www.bing.com','bing.com'].includes(link.hostname)){
        if(!/^\/news\/apiclick\.aspx$/i.test(link.pathname))continue;
        direct=link.searchParams.get('url')||'';
      }
    }catch{continue}
    let url;try{url=sourceUrl(direct,c.domains)}catch{continue}
    const when=Date.parse(rssField(item,'pubDate'));
    if(!headline||!Number.isFinite(when)||when<Date.now()-c.age||
       when>Date.now()+600000||seen.has(url))continue;
    results.push({url,title:headline.slice(0,180),summary:'',
      published_at:new Date(when).toISOString(),feed:'bing-index'});
    seen.add(url);
    if(results.length>=50)break;
  }
  return results;
}
export async function lookupRequestedArticles(c,englishKeywords) {
  // Live production probe: Bing News RSS returns original publisher URLs;
  // public GDELT frequently times out and Guardian requires a developer API key.
  // Prefer the tested public provider to avoid 10-20s of failed requests.
  let external=[],channel=null;
  try {
    external=await bingTopicLookup(c,englishKeywords);
    if(external.length)channel='bing-news-rss';
  }catch{}
  if(!external.length){
    try{
      const response=await fetch(topicLookupUrl(englishKeywords),{
        signal:AbortSignal.timeout(4500),headers:{Accept:'application/json'}});
      if(response.ok){
        external=parseTopicIndex(JSON.parse(await readText(response,600000)),c.domains);
        if(external.length)channel='gdelt-public-index';
      }else await response.body?.cancel();
    }catch{}
  }
  // Optional publisher API, only when a valid developer key is configured.
  if(!external.length && c.env.GUARDIAN_API_KEY){
    try{
      external=await guardianTopicLookup(c,englishKeywords);
      if(external.length)channel='guardian-open-platform';
    }catch{}
  }
  // Fallback publisher feeds must STILL be matched to the owner's English
  // subject. A generic world-politics headline is never a valid substitute.
  if(!external.length){
    try{
      const rss=await discoverFeeds(c,'');
      external=rss.articles.map(({url,title,summary,published_at,image,feed})=>
        ({url,title,summary,published_at,image,feed}));
      if(external.length)channel='publisher-rss-fallback';
    }catch{}
  }
  if(!external.length)throw new Halt('No accessible articles for requested topic');
  const articles=[...new Map(external.map(a=>[a.url,a])).values()];
  return {articles,provider:channel,
    grounding:{kind:'independent-news-index',index:channel},
    output:[{type:'topic_discovery',action:{sources:articles.map(({url})=>({url}))}}]};
}
