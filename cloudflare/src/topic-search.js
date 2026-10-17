import {Halt,readText,sourceUrl} from './core.js';
import {discoverFeeds} from './feeds.js';

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
    const date=/^\d{14}$/.test(rawSeen)?
      Date.UTC(Number(rawSeen.slice(0,4)),Number(rawSeen.slice(4,6))-1,
        Number(rawSeen.slice(6,8)),Number(rawSeen.slice(8,10)),
        Number(rawSeen.slice(10,12)),Number(rawSeen.slice(12,14))):
      Date.parse(rawSeen);
    if(!Number.isFinite(date))continue;
    seen.add(url);
    articles.push({url,title,summary:'',first_seen_at:new Date(date).toISOString(),
      published_at:new Date(date).toISOString(),feed:'gdelt-index'});
    if(articles.length>=60)break;
  }
  return articles;
}
export function rankRequestedArticles(articles,searchTerms,max=3) {
  // Never select a random world-politics story as a substitute.
  const tokens=String(searchTerms).toLowerCase().split(/\W+/u)
    .filter(x=>x.length>3 && !['news','latest','about','from','with','politics','political'].includes(x));
  if(!tokens.length)return [];
  return articles.map(article=>{
    const title=String(article.title||'').toLowerCase();
    const matched=tokens.filter(word=>title.includes(word)).length;
    return {article,matched};
  }).filter(x=>x.matched>0 || x.article.feed==='gdelt-index').sort((a,b)=>b.matched-a.matched||
    Date.parse(b.article.published_at)-Date.parse(a.article.published_at))
    .slice(0,max).map(x=>x.article);
}
export async function lookupRequestedArticles(c,englishKeywords) {
  const url=topicLookupUrl(englishKeywords);
  let external=[];
  try{
    const response=await fetch(url,{signal:AbortSignal.timeout(10000),
      headers:{Accept:'application/json'}});
    if(response.ok){
      const raw=await readText(response,600000);
      external=parseTopicIndex(JSON.parse(raw),c.domains);
    }else await response.body?.cancel();
  }catch{ /* Public news index is best-effort. RSS remains a fallback. */ }
  // Even if GDELT is unavailable, search the current publisher feed catalog.
  let feed=[];
  if(!external.length){
    try{
      const rss=await discoverFeeds(c,'');
      feed=rss.articles.map(({url,title,summary,published_at,image,feed})=>
        ({url,title,summary,published_at,image,feed}));
    }catch{}
  }
  const articles=[...external,...feed];
  if(!articles.length)throw new Halt('No accessible articles for requested topic');
  return {articles,provider:external.length?'gdelt-public-index':'publisher-rss-fallback',
    grounding:{kind:'independent-news-index',index:external.length?'gdelt':'publisher-rss'},
    output:[{type:'topic_discovery',action:{sources:articles.map(({url})=>({url}))}}]};
}
