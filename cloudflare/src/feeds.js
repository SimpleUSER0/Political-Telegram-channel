import {Halt,now,readText,sourceUrl} from './core.js';

// Deliberately fixed publisher-operated feeds, never model-supplied fetch targets.
export const FEEDS=Object.freeze({
  'bbc-world':'https://feeds.bbci.co.uk/news/world/rss.xml',
  'guardian-world':'https://www.theguardian.com/world/rss',
  'civil-ge':'https://civil.ge/feed',
  'netgazeti':'https://netgazeti.ge/feed/',
});
const PUBLISHERS={'bbc-world':['bbc.co.uk','bbc.com'],'guardian-world':['theguardian.com'],'civil-ge':['civil.ge'],'netgazeti':['netgazeti.ge']};
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
export function parseFeed(xml,c) {
  const entries=[],seen=new Set();
  for(const match of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const item=match[1],date=field(item,'pubDate'),time=Date.parse(date);
    if(!Number.isFinite(time) || time<now()-c.age || time>now()+600000)continue;
    let url;
    try {url=sourceUrl(field(item,'link'),c.domains);}catch{continue;}
    if(seen.has(url))continue;
    const title=field(item,'title').slice(0,300);
    if(!title)continue;
    seen.add(url);entries.push({url,title,published_at:new Date(time).toISOString(),
      summary:field(item,'description').slice(0,500)});
    if(entries.length>=25)break;
  }
  return entries;
}
export async function discoverFeeds(c) {
  const articles=new Map(),used=[];
  for(const name of c.feeds) {
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
        const entries=parseFeed(xml,c);
        if(entries.length)used.push(name);
        for(const entry of entries)articles.set(entry.url,{...entry,feed:name,feed_url:initial});
        break;
      }
    }catch{ /* An unavailable feed cannot be replaced with model memory. */ }
  }
  const entries=[...articles.values()].sort((a,b)=>b.published_at.localeCompare(a.published_at));
  const origins=new Set(entries.map(e=>new URL(e.url).hostname.replace(/^www\./,'')));
  if(used.length<2 || origins.size<2)throw new Halt('Fewer than two accessible recent publisher feeds');
  return {provider:'publisher-rss',articles:entries,grounding:{kind:'publisher-rss',feeds:used},output:[
    {type:'feed_discovery',action:{sources:entries.map(e=>({url:e.url}))}},
    {type:'message',content:[{type:'output_text',text:JSON.stringify({articles:entries})}]},
  ]};
}
