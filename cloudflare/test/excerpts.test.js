import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkSources,excerptCatalog,resolveEvidence} from '../src/research.js';
import {config,normalized,validatePacket} from '../src/core.js';
import {payload} from './helpers.js';

test('excerpt catalog contains only bounded verbatim passages and preserves publisher metadata',()=>{
  const text='The president announced a diplomatic meeting on Friday. '+
    Array.from({length:80},(_,i)=>'word'+i).join(' ')+'.';
  const source={id:2,url:'https://example.com/news',text,publication:{published_at:new Date().toISOString()}};
  const [catalog]=excerptCatalog([source]);
  assert.equal(catalog.publication,source.publication);
  assert.ok(catalog.excerpts.length>=4);
  assert.equal(catalog.text,undefined);
  for(const [i,quote] of catalog.excerpts.entries()) {
    assert.equal(quote.excerpt_id,i);assert.ok(quote.text.length>=20);
    assert.ok(quote.text.split(' ').length<=25);
    assert.ok(normalized(text).includes(normalized(quote.text)));
  }
});
test('resolved IDs pass the original evidence guard without trusting model-written quotations',()=>{
  const p=payload(),catalog=excerptCatalog(p.sources);
  const model={...p.verification,claims:p.verification.claims.map(claim=>({...claim,
    evidence:claim.evidence.map(({source_id})=>({source_id,excerpt_id:0})),
  }))};
  const result=resolveEvidence(model,catalog);
  validatePacket(result,p.sources,{age:3600000,origins:{}});
  assert.equal(result.claims[0].evidence[0].excerpt,p.sources[0].text);
  assert.equal(model.claims[0].evidence[0].excerpt,undefined);
  const altered=structuredClone(p.sources);altered[0].text='An unrelated report with no supporting quotation.';
  assert.throws(()=>validatePacket(result,altered,{age:3600000,origins:{}}),/quote not in retrieved source/);
});
test('unknown quote IDs and source IDs are withheld',()=>{
  const catalog=excerptCatalog(payload().sources);
  for(const evidence of [{source_id:99,excerpt_id:0},{source_id:0,excerpt_id:-1},
    {source_id:0,excerpt_id:999},{source_id:0,excerpt_id:0.5},{source_id:0,excerpt_id:'0'}])
    assert.throws(()=>resolveEvidence({claims:[{evidence:[evidence]}]},catalog),/Unknown source excerpt ID/);
  assert.throws(()=>excerptCatalog([{id:0,text:'Too short.'}]),/no citable excerpts/);
});

test('publisher probe reports actual fetch failures and feed-bound dates without an AI call',async()=>{
  const original=globalThis.fetch,requests=[];
  const c=config({SOURCE_DOMAINS:'bbc.co.uk,theguardian.com,civil.ge',DISCOVERY_MODE:'feeds'});
  globalThis.fetch=async raw=>{
    const url=new URL(raw);requests.push(url.href);
    const publisher=url.hostname==='feeds.bbci.co.uk'?'www.bbc.co.uk':url.hostname;
    if(['/news/world/rss.xml','/world/rss','/feed'].includes(url.pathname))return new Response(
      '<rss><channel><item><title>Recent political announcement</title><link>https://'+publisher+
      '/news/article</link><pubDate>'+new Date().toUTCString()+'</pubDate></item></channel></rss>');
    if(url.hostname==='www.bbc.co.uk')return new Response('',{status:403});
    return new Response('An independently retrieved publisher report. '.repeat(10),
      {headers:{'Content-Type':'text/plain'}});
  };
  try {
    const probe=await checkSources(c);
    assert.equal(requests.length,6);assert.equal(probe.results.length,3);
    assert.equal(probe.results.find(r=>r.feed==='bbc-world').error,'Source unavailable');
    for(const feed of ['guardian-world','civil-ge']) {
      const result=probe.results.find(r=>r.feed===feed);
      assert.ok(result.text_length>200);assert.equal(result.publication.via,'publisher-rss');
    }
    assert.ok(requests.every(url=>!url.includes('googleapis.com')));
  } finally {globalThis.fetch=original;}
});
