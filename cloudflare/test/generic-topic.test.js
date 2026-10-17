import {test} from 'node:test';
import assert from 'node:assert/strict';
import {config} from '../src/core.js';
import {generate} from '../src/research.js';
import {isConversation,handleFetch} from '../src/worker.js';
import {fixture,env,mockTelegram} from './helpers.js';

test('Any user topic is routed to a post or to Gemini conversation, with no country tables',()=>{
  assert.equal(isConversation('როგორ მუშაობს იაპონიის პარლამენტი?'),true);
  assert.equal(isConversation('რა არის გეოპოლიტიკა'),true);
  assert.equal(isConversation('მოამზადე პოსტი იაპონიის პარლამენტზე?'),false);
  assert.equal(isConversation('პოსტი ახალ ზელანდიაზე'),false);
  assert.equal(isConversation('რომის იმპერია'),false);
  assert.equal(isConversation('/news იაპონია'),false);
});
test('Manual unknown country uses Gemini grounded search and cannot silently fall back to unrelated RSS politics',async()=>{
  const {store}=await fixture();
  const c=config({...env(),AI_PROVIDER:'gemini',GEMINI_MODEL:'gemini-3.8-flash',
    GEMINI_API_KEY:'test-key',DISCOVERY_MODE:'feeds'});
  const original=globalThis.fetch,requests=[];
  globalThis.fetch=async (url,init)=>{
    requests.push(String(url));
    assert.match(String(url),/generativelanguage.googleapis.com/);
    const body=JSON.parse(init.body);
    assert.deepEqual(body.tools,[{google_search:{}}]);
    assert.match(body.contents[0].parts[0].text,/ახალ ზელანდიაში პოლიტიკური/);
    return Response.json({candidates:[{finishReason:'STOP',
      content:{parts:[{text:'No grounded article about this topic'}]}}],usageMetadata:{promptTokenCount:12,candidatesTokenCount:9}});
  };
  try{
    await assert.rejects(generate(c,store,'ახალ ზელანდიაში პოლიტიკური პროცესები','STANDARD','night',null,true),
      /Gemini returned no actual search evidence/);
    assert.equal(requests.length,1);
    assert.ok(requests.every(url=>!url.includes('feeds.bbci.co.uk')));
    assert.equal((await store.stmt('SELECT count(*) AS n FROM cf_drafts').first()).n,0);
  } finally {globalThis.fetch=original;}
});
test('/ask speaks with Gemini directly and never queues or publishes a post',async()=>{
  const {e,store}=await fixture();
  const configEnv={...e,AI_PROVIDER:'gemini',GEMINI_API_KEY:'test-key',GEMINI_MODEL:'gemini-3.8-flash'};
  const original=globalThis.fetch,sent=[];
  globalThis.fetch=async (url,init)=>{
    if(String(url).includes('generativelanguage.googleapis.com'))
      return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'იაპონიის საკანონმდებლო ორგანოა პარლამენტი.'}]}}],
        usageMetadata:{promptTokenCount:17,candidatesTokenCount:13}});
    return mockTelegram(async(method,data)=>{
      if(method==='sendMessage'){sent.push(data);return Response.json({ok:true,result:{message_id:sent.length}});}
      throw new Error('Unexpected Telegram method '+method);
    })(url,init);
  };
  try{
    const tasks=[];
    const res=await handleFetch(new Request('https://test/telegram/webhook',{
      method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':e.WEBHOOK_SECRET},
      body:JSON.stringify({update_id:98111,message:{from:{id:123},chat:{id:123,type:'private'},
        text:'/ask რა არის იაპონიის პარლამენტი?'}})}),configEnv,{waitUntil(x){tasks.push(x)}});
    assert.equal(res.status,200);
    await Promise.all(tasks);
    assert.ok(sent.some(x=>x.text.includes('იაპონიის საკანონმდებლო')));
    assert.equal((await store.stmt("SELECT count(*) AS n FROM cf_jobs WHERE kind='research'").first()).n,0);
    assert.equal((await store.stmt('SELECT count(*) AS n FROM cf_drafts').first()).n,0);
  } finally{globalThis.fetch=original;}
});
