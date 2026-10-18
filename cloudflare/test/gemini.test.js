import {test} from 'node:test';
import assert from 'node:assert/strict';
import {config,missing,retrievedUrls,validateJson} from '../src/core.js';
import {llm} from '../src/research.js';
import {resolveGroundingUrl,geminiEndpoint} from '../src/gemini.js';
import {fixture} from './helpers.js';

const resultSchema={type:'object',properties:{passed:{type:'boolean'}},required:['passed'],additionalProperties:false};
async function setup(){const {e,store}=await fixture();return {store,c:config({...e,AI_PROVIDER:'gemini',GEMINI_API_KEY:'offline-only'})};}
test('Gemini key auto-selects Gemini and does not require an OpenAI key or model',async()=>{
  const {c}=await setup();delete c.env.OPENAI_API_KEY;delete c.env.OPENAI_MODEL;
  assert.equal(c.model,'gemini-2.5-flash');assert.deepEqual(missing(c,true),[]);
  const auto=config({GEMINI_API_KEY:'test'});assert.equal(auto.provider,'gemini');
  assert.equal(auto.dailyRuns,1);assert.equal(auto.dailyCalls,12);
});
test('explicit Gemini without its key never silently selects OpenAI',async()=>{
  const {c}=await setup();delete c.env.GEMINI_API_KEY;
  assert.ok(missing(c,true).includes('GEMINI_API_KEY'));assert.equal(c.provider,'gemini');
});
test('Gemini JSON goes to Google with a header secret and is validated locally',async()=>{
  const {c,store}=await setup(),original=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    assert.ok(url.startsWith('https://generativelanguage.googleapis.com/'));
    assert.ok(!url.includes('offline-only'));assert.equal(options.headers['x-goog-api-key'],'offline-only');
    assert.deepEqual(JSON.parse(options.body).generationConfig.responseFormat.text.schema,resultSchema);
    assert.equal(JSON.parse(options.body).generationConfig.responseFormat.text.mimeType,'APPLICATION_JSON');
    return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'{"passed":true}'}]}}],
      usageMetadata:{promptTokenCount:10,candidatesTokenCount:5,thoughtsTokenCount:3}});
  };
  try{assert.deepEqual(await llm(c,store,'Check',{},resultSchema),{passed:true});
    assert.equal((await store.status()).usage.output_tokens,8);}
  finally{globalThis.fetch=original;}
});
test('free-tier 429 stops after one attempt, with no OpenAI fallback',async()=>{
  const {c,store}=await setup(),original=globalThis.fetch;let calls=0;
  globalThis.fetch=async(url)=>{calls++;assert.ok(url.includes('googleapis.com'));return Response.json({error:{}},{status:429});};
  try{await assert.rejects(llm(c,store,'Check',{},resultSchema),/quota reached/);assert.equal(calls,1);}
  finally{globalThis.fetch=original;}
});
test('Gemini 3.8 free-tier 429 gets one metered Google Flash-Lite fallback without a paid provider',async()=>{
  const {store}=await fixture();
  const c=config({... (await setup()).c.env,AI_PROVIDER:'gemini',GEMINI_MODEL:'gemini-3.8-flash',
    GEMINI_API_KEY:'offline-only',MAX_DAILY_CALLS:'15'});
  const original=globalThis.fetch,requested=[];
  globalThis.fetch=async url=>{
    requested.push(String(url));
    if(String(url).includes('gemini-3.8-flash'))return Response.json({error:{}},{status:429});
    assert.match(String(url),/gemini-3\.5-flash-lite/);
    return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'{"passed":true}'}]}}],
      usageMetadata:{promptTokenCount:11,candidatesTokenCount:7}});
  };
  try{
    assert.deepEqual(await llm(c,store,'Check',{},resultSchema),{passed:true});
    assert.deepEqual(requested.map(x=>x.match(/models\/(.*):generateContent/)?.[1]),
      ['gemini-3.8-flash','gemini-3.5-flash-lite']);
    assert.equal((await store.status()).usage.calls,2);
  }finally{globalThis.fetch=original;}
});
test('Gemini primary and Lite quota exhaustion never calls a third provider',async()=>{
  const {store}=await fixture(),c=config({... (await setup()).c.env,AI_PROVIDER:'gemini',
    GEMINI_MODEL:'gemini-3.8-flash',GEMINI_API_KEY:'offline-only',MAX_DAILY_CALLS:'15'});
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;return Response.json({error:{}},{status:429})};
  try {
    await assert.rejects(llm(c,store,'Check',{},resultSchema),/quota reached/);
    assert.equal(calls,2);
  }finally{globalThis.fetch=original;}
});
test('Google request errors identify malformed fields without exposing credentials or URLs',async()=>{
  const {c,store}=await setup(),original=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({error:{status:'INVALID_ARGUMENT',
    message:'Unknown field responseFormat; credential '+c.env.GEMINI_API_KEY+' at https://example.com/?key='+c.env.GEMINI_API_KEY}},{status:400});
  try {await assert.rejects(llm(c,store,'Check',{},resultSchema),error=>{
    assert.match(error.message,/INVALID_ARGUMENT.*Unknown field responseFormat/);
    assert.ok(!error.message.includes(c.env.GEMINI_API_KEY));assert.ok(!error.message.includes('https://'));return true;
  });}finally{globalThis.fetch=original;}
});
test('Gemini safety refusal and token truncation cannot yield a draft',async()=>{
  const {c,store}=await setup(),original=globalThis.fetch;
  try{for(const finishReason of ['SAFETY','MAX_TOKENS']){
    globalThis.fetch=async()=>Response.json({candidates:[{finishReason,content:{parts:[{text:'{"passed":true}'}]}}]});
    await assert.rejects(llm(c,store,'Check',{},resultSchema),/incomplete or refused/);
  }}finally{globalThis.fetch=original;}
});
test('memory-only output cannot masquerade as web research',async()=>{
  const {c,store}=await setup(),original=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'https://example.com/news https://example.org/news'}]}}]});
  try{await assert.rejects(llm(c,store,'Search',{},null,true),/actual search evidence/);}
  finally{globalThis.fetch=original;}
});
test('real grounding metadata is filtered to operator-allowed publisher URLs',async()=>{
  const {c,store}=await setup(),original=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'research'}]},
    groundingMetadata:{webSearchQueries:['politics'],groundingChunks:[{web:{uri:'https://example.com/news'}},
      {web:{uri:'https://example.org/news'}},{web:{uri:'https://evil.test/article'}}]}}]});
  try{const packet=await llm(c,store,'Search',{},null,true);
    assert.deepEqual([...retrievedUrls(packet,c.domains)],['https://example.com/news','https://example.org/news']);}
  finally{globalThis.fetch=original;}
});
test('only exact Google grounding redirects can resolve outside the allowlist',async()=>{
  const {c}=await setup(),original=globalThis.fetch;let requests=0;
  globalThis.fetch=async()=>{requests++;return new Response(null,{status:302,headers:{Location:'https://example.com/news'}});};
  try{
    assert.equal(await resolveGroundingUrl('https://vertexaisearch.cloud.google.com/grounding-api-redirect/test',c),'https://example.com/news');
    await assert.rejects(resolveGroundingUrl('https://evil.test/grounding-api-redirect/test',c));assert.equal(requests,1);
    globalThis.fetch=async()=>new Response(null,{status:302,headers:{Location:'https://127.0.0.1/secrets'}});
    await assert.rejects(resolveGroundingUrl('https://vertexaisearch.cloud.google.com/grounding-api-redirect/test',c));
  }finally{globalThis.fetch=original;}
});
test('provider JSON cannot smuggle unknown fields, wrong types or omitted fields',()=>{
  for(const value of [{passed:'true'},{passed:true,publish:true},{}])assert.throws(()=>validateJson(value,resultSchema));
});

test('Gemini BYOK gateway URL allows only the exact account gateway, never arbitrary proxies',()=>{
  const c={env:{GEMINI_GATEWAY_BASE_URL:'https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/world-focus-gemini/google-ai-studio'}};
  assert.equal(geminiEndpoint(c,'gemini-3.8-flash'),c.env.GEMINI_GATEWAY_BASE_URL+'/v1beta/models/gemini-3.8-flash:generateContent');
  assert.equal(geminiEndpoint(c,'gemini-3.8-flash',false),'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  for(const bad of ['https://evil.example.com/v1/0123456789abcdef0123456789abcdef/world-focus-gemini/google-ai-studio',
    'https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/untrusted/google-ai-studio']){
      assert.throws(()=>geminiEndpoint({env:{GEMINI_GATEWAY_BASE_URL:bad}},'gemini-3.8-flash'),/not approved/);
  }
});

test('Temporary Gemini 3.8 HTTP 503 triggers one Google Flash-Lite retry, no third provider',async()=>{
  const {store}=await fixture();
  const c=config({... (await setup()).c.env,AI_PROVIDER:'gemini',
    GEMINI_MODEL:'gemini-3.8-flash',GEMINI_API_KEY:'offline-only',MAX_DAILY_CALLS:'15'});
  const original=globalThis.fetch,requests=[];
  globalThis.fetch=async url=>{
    requests.push(String(url));
    if(String(url).includes('gemini-3.8-flash'))
      return Response.json({error:{status:'UNAVAILABLE',message:'High demand'}},{status:503});
    return Response.json({candidates:[{finishReason:'STOP',
      content:{parts:[{text:'{"passed":true}'}]}}],
      usageMetadata:{promptTokenCount:12,candidatesTokenCount:5}});
  };
  try {
    assert.deepEqual(await llm(c,store,'Check',{},resultSchema),{passed:true});
    assert.equal(requests.length,2);
    assert.match(requests[1],/gemini-3\.5-flash-lite/);
  }finally{globalThis.fetch=original;}
});

test('Gemini fallback also obeys the reserved-slot call limit',async()=>{
  const {store}=await fixture();
  const c=config({... (await setup()).c.env,AI_PROVIDER:'gemini',
    GEMINI_MODEL:'gemini-3.8-flash',GEMINI_API_KEY:'offline-only',MAX_DAILY_CALLS:'15'});
  c.callLimit=1;
  const original=globalThis.fetch;let requests=0;
  globalThis.fetch=async()=>{requests++;return Response.json({error:{status:'UNAVAILABLE'}},{status:503});};
  try {
    await assert.rejects(llm(c,store,'Check',{},resultSchema),/budget/);
    assert.equal(requests,1);
    assert.equal((await store.status()).usage.calls,1);
  }finally{globalThis.fetch=original;}
});

test('Free-text science and sport posts use a subject-neutral Gemini editorial policy',async()=>{
  const {store}=await fixture();
  const c=config({... (await setup()).c.env,AI_PROVIDER:'gemini',
    GEMINI_MODEL:'gemini-3.8-flash',GEMINI_API_KEY:'offline-only',
    MAX_DAILY_CALLS:'15'});
  const original=globalThis.fetch;
  globalThis.fetch=async(_url,options)=>{
    const body=JSON.parse(options.body);
    const policy=body.systemInstruction.parts[0].text;
    assert.match(policy,/ANY lawful subject/);
    assert.match(policy,/science, culture/);
    assert.doesNotMatch(policy,/Cover world politics, diplomacy/);
    return Response.json({candidates:[{finishReason:'STOP',
      content:{parts:[{text:'{"passed":true}'}]}}],
      usageMetadata:{promptTokenCount:12,candidatesTokenCount:3}});
  };
  try {
    assert.deepEqual(await llm({...c,manualTopic:true},store,
      'Check evidence for quantum physics, not politics',{},resultSchema),
      {passed:true});
  }finally{globalThis.fetch=original;}
});
