import {Halt,now,readText,sourceUrl} from './core.js';
import {editorialFeeds} from './editorial.js';

// Deliberately fixed publisher-operated feeds, never model-supplied fetch targets.
export const FEEDS=Object.freeze({
  'bbc-world':'https://feeds.bbci.co.uk/news/world/rss.xml',
  'guardian-world':'https://www.theguardian.com/world/rss',
  'civil-ge':'https://civil.ge/feed',
  'netgazeti':'https://netgazeti.ge/feed/',
  'bbc-asia':'https://feeds.bbci.co.uk/news/world/asia/rss.xml',
  'bbc-middle-east':'https://feeds.bbci.co.uk/news/world/middle_east/rss.xml',
  'guardian-china':'https://www.theguardian.com/world/china/rss',
  'guardian-japan':'https://www.theguardian.com/world/japan/rss',
  'japan-times':'https://www.japantimes.co.jp/news/feed/',
  'guardian-us-politics':'https://www.theguardian.com/us-news/us-politics/rss',
  'guardian-middle-east':'https://www.theguardian.com/world/middleeast/rss',
  'guardian-ukraine':'https://www.theguardian.com/world/ukraine/rss',
});
const PUBLISHERS={'bbc-world':['bbc.co.uk','bbc.com'],'guardian-world':['theguardian.com'],'civil-ge':['civil.ge'],'netgazeti':['netgazeti.ge'],
  'bbc-asia':['bbc.co.uk','bbc.com'],'bbc-middle-east':['bbc.co.uk','bbc.com'],
  'guardian-china':['theguardian.com'],'guardian-japan':['theguardian.com'],'japan-times':['japantimes.co.jp'],'guardian-us-politics':['theguardian.com'],
  'guardian-middle-east':['theguardian.com'],'guardian-ukraine':['theguardian.com']};
export function feedPublication(entries,discoveredUrl,finalUrl) {
  const entry=entries?.find(e=>e.url===discoveredUrl);
  if(!entry || entry.feed_url!==FEEDS[entry.feed])return null;
  const domains=PUBLISHERS[entry.feed] || [];
  const belongs=url=>domains.some(d=>new URL(url).hostname===d || new URL(url).hostname.endsWith('.'+d));
  if(!belongs(entry.url) || !belongs(finalUrl))return null;
  return {published_at:entry.published_at,via:'publisher-rss',evidence_url:entry.feed_url,article_url:entry.url};
}
function text(value) {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1')
    .replace(/&#(x[0-9a-f]+|\d+);/gi,(_,n)=>{
      const code=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n);
      return code>0 && code<=0x10ffff?String.fromCodePoint(code):'';
    }).replace(/&(?:amp|lt|gt|quot|apos);/g,s=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"}[s]))
    .replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
}
function field(item,name) {
  return text(new RegExp('<'+name+'(?:\\s[^>]*)?>([\\s\\S]*?)</'+name+'>','i').exec(item)?.[1] || '');
}
const IMAGE_DOMAINS={
  'bbc-world':['bbc.co.uk','bbc.com','ichef.bbci.co.uk'],
  'guardian-world':['theguardian.com','i.guim.co.uk','media.guim.co.uk'],
  'civil-ge':['civil.ge'], 'netgazeti':['netgazeti.ge'],
  'bbc-asia':['bbc.co.uk','bbc.com','ichef.bbci.co.uk'],
  'bbc-middle-east':['bbc.co.uk','bbc.com','ichef.bbci.co.uk'],
  'guardian-china':['theguardian.com','i.guim.co.uk','media.guim.co.uk'],
  'guardian-japan':['theguardian.com','i.guim.co.uk','media.guim.co.uk'],
  'japan-times':['japantimes.co.jp','cdn-japantimes.com'],
  'guardian-us-politics':['theguardian.com','i.guim.co.uk','media.guim.co.uk'],
  'guardian-middle-east':['theguardian.com','i.guim.co.uk','media.guim.co.uk'],
  'guardian-ukraine':['theguardian.com','i.guim.co.uk','media.guim.co.uk'],
};
function rssPhoto(item,name,articleUrl) {
  if(!IMAGE_DOMAINS[name])return null;
  for(const tag of item.matchAll(/<(?:media:thumbnail|media:content|enclosure)\b[^>]{0,1500}>/gi)) {
    const value=/\burl\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(tag[0]);
    if(!value)continue;
    const raw=(value[1]||value[2]).replaceAll('&amp;','&');
    try {
      const url=sourceUrl(raw,IMAGE_DOMAINS[name]);
      if(/\.(?:svg|gif)(?:[?#]|$)/i.test(url) || /(?:logo|placeholder|default[-_]image)/i.test(new URL(url).pathname))continue;
      return {url,source_url:articleUrl,kind:'publisher-feed-image'};
    } catch {}
  }
  return null;
}
export function feedImage(entries,discoveredUrl,finalUrl) {
  // Only an image provided by the exact publisher's original RSS entry.
  if(!feedPublication(entries,discoveredUrl,finalUrl))return null;
  return entries.find(entry=>entry.url===discoveredUrl)?.image || null;
}
export function parseFeed(xml,c,name=null) {
  const entries=[],seen=new Set();
  for(const match of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const item=match[1],date=field(item,'pubDate'),time=Date.parse(date);
    if(!Number.isFinite(time) || time<now()-c.age || time>now()+600000)continue;
    let url;
    try {url=sourceUrl(field(item,'link'),c.domains);}catch{continue;}
    if(seen.has(url))continue;
    const title=field(item,'title').slice(0,300);
    if(!title)continue;
    const image=rssPhoto(item,name,url);
    seen.add(url);entries.push({url,title,published_at:new Date(time).toISOString(),
      summary:field(item,'description').slice(0,500),...(image?{image}:{})});
    if(entries.length>=25)break;
  }
  return entries;
}
export async function discoverFeeds(c,query='') {
  const articles=new Map(),used=[];
  for(const name of editorialFeeds(query,c.feeds)) {
    const initial=FEEDS[name];
    if(!initial)throw new Halt('Unknown source feed');
    let url=initial;
    try {
      for(let hop=0;hop<3;hop++) {
        const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(10000)});
        if([301,302,303,307,308].includes(response.status)) {
          const location=response.headers.get('Location');await response.body?.cancel();
          const next=new URL(location || '',url);
          if(!location || next.origin!==new URL(initial).origin || next.username || next.password)
            throw new Halt('Feed redirect rejected');
          url=next.href;continue;
        }
        if(!response.ok){await response.body?.cancel();throw new Halt('Feed unavailable');}
        const xml=await readText(response,500000);
        if(!/<rss[\s>]/i.test(xml))throw new Halt('Invalid publisher feed');
        const entries=parseFeed(xml,c,name);
        if(entries.length)used.push(name);
        for(const entry of entries)articles.set(entry.url,{...entry,feed:name,feed_url:initial});
        break;
      }
    }catch{ /* An unavailable feed cannot be replaced with model memory. */ }
  }
  const entries=[...articles.values()].sort((a,b)=>b.published_at.localeCompare(a.published_at));
  if(!entries.length)throw new Halt('No accessible recent articles from configured publisher feeds');
  return {provider:'publisher-rss',articles:entries,grounding:{kind:'publisher-rss',feeds:used},output:[
    {type:'feed_discovery',action:{sources:entries.map(e=>({url:e.url}))}},
    {type:'message',content:[{type:'output_text',text:JSON.stringify({articles:entries})}]},
  ]};
}
