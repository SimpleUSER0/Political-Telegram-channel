import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publicationFromHtml} from '../src/research.js';
import {FEEDS,feedPublication} from '../src/feeds.js';
import {config,validatePacket} from '../src/core.js';
import {payload} from './helpers.js';

test('publisher publication metadata survives header/script removal and is not replaced by modification time',()=>{
  const html=`<meta property="article:modified_time" content="2026-10-16T20:00:00Z">
    <meta content='2026-10-15T08:00:00+04:00' property='article:published_time'>`;
  assert.equal(publicationFromHtml(html,'https://example.com/news').published_at,'2026-10-15T04:00:00.000Z');
  assert.equal(publicationFromHtml('<meta property="article:published_time" content="2026-10-16">','https://example.com/news'),null);
});
test('publisher JSON-LD uses datePublished rather than an event or modification timestamp',()=>{
  const html='<script type="application/ld+json">'+JSON.stringify({'@graph':[
    {'@type':'Event',datePublished:'2026-10-16T10:00:00Z'},
    {'@type':'NewsArticle',datePublished:'2026-10-15T12:00:00Z',dateModified:'2026-10-16T10:00:00Z'}]})+'</script>';
  assert.equal(publicationFromHtml(html,'https://example.com/news').published_at,'2026-10-15T12:00:00.000Z');
});
test('RSS date provenance remains bound to the publisher and its discovered article',()=>{
  const entry={url:'https://www.bbc.co.uk/news/articles/abc',feed:'bbc-world',feed_url:FEEDS['bbc-world'],
    published_at:'2026-10-16T10:00:00.000Z'};
  assert.equal(feedPublication([entry],entry.url,'https://www.bbc.com/news/articles/abc').published_at,entry.published_at);
  assert.equal(feedPublication([entry],entry.url,'https://www.theguardian.com/world/story'),null);
  assert.equal(feedPublication([{...entry,feed_url:'https://evil.example/feed'}],entry.url,entry.url),null);
});
test('publisher metadata cannot make a stale article pass the age guard or accept a conflicting model date',()=>{
  const p=payload(),c=config({SOURCE_DOMAINS:'example.com,example.org'});
  p.sources[0].publication={published_at:'2000-01-01T00:00:00.000Z'};
  assert.throws(()=>validatePacket(p.verification,p.sources,c),/conflicts with publisher metadata/);
  p.verification.sources[0].published_at=p.sources[0].publication.published_at;
  assert.throws(()=>validatePacket(p.verification,p.sources,c),/stale source publication date/);
});
