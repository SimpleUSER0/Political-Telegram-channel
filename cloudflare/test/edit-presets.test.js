import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleFetch} from '../src/worker.js';
import {config} from '../src/core.js';
import {editDraft} from '../src/research.js';
import {env,fixture,draft,payload,mockTelegram} from './helpers.js';

test('Edit opens a private preset menu and queues a version-bound choice without publishing',async()=>{
  const {e,store}=await fixture(),saved=payload();
  saved.scheduled=true;saved.edition='evening';
  saved.article={title:'სათაური',body:Array(89).fill('ამბავი').join(' '),claim_ids:[0],source_ids:[0,1]};
  const item=await draft(store);
  await store.stmt('UPDATE cf_drafts SET payload=? WHERE id=?',JSON.stringify(saved),item.id).run();
  const original=globalThis.fetch,sent=[],channel=[];
  globalThis.fetch=mockTelegram(async(method,data)=>{
    if(method==='sendMessage')sent.push(data);
    if(method==='sendMessage' && data.chat_id==='-100555')channel.push(data);
    return Response.json({ok:true,result:{message_id:sent.length+1}});
  });
  const submit=async(updateId,data)=>{
    const tasks=[];
    const response=await handleFetch(new Request('https://test/telegram/webhook',{method:'POST',
      headers:{'X-Telegram-Bot-Api-Secret-Token':e.WEBHOOK_SECRET},
      body:JSON.stringify({update_id:updateId,callback_query:{id:'callback-'+updateId,from:{id:123},
        message:{chat:{id:123,type:'private'}},data}})}),e,{waitUntil(task){tasks.push(task)}});
    assert.equal(response.status,200);await Promise.all(tasks);
  };
  try{
    await submit(810,`edit:${item.id}:1`);
    const menu=sent.find(x=>x.reply_markup?.inline_keyboard?.some(row=>row.some(button=>button.callback_data?.startsWith('editopt:'))));
    assert.ok(menu);
    assert.match(menu.text,/შეთანხმებულ დიაპაზონში/);
    const options=menu.reply_markup.inline_keyboard.flat();
    assert.deepEqual(options.map(button=>button.text),['შეამოკლე','გააფართოვე','უფრო გასაგებად','ქართული ენა']);
    assert.ok(options.every(button=>button.callback_data.length<=64));
    assert.equal(channel.length,0);
    await submit(811,`editopt:${item.id}:1:shorter`);
    const job=await store.stmt("SELECT payload FROM cf_jobs WHERE kind='edit'").first();
    assert.deepEqual(JSON.parse(job.payload),{draftId:item.id,version:1,mode:'shorter'});
    assert.equal((await store.draft(item.id)).state,'pending');
    await submit(812,`editopt:${item.id}:1:longer`);
    assert.match(sent.at(-1).text,/უკვე რიგშია/);
    assert.equal((await store.stmt("SELECT count(*) AS n FROM cf_jobs WHERE kind='edit' AND status='queued'").first()).n,1);
    const failed=await store.claim('edit');await store.finish(failed,'mock failure');
    await submit(813,`editopt:${item.id}:1:longer`);
    assert.equal((await store.stmt("SELECT count(*) AS n FROM cf_jobs WHERE kind='edit' AND status='queued'").first()).n,1);
    assert.equal(channel.length,0);
  }finally{globalThis.fetch=original;}
});

test('preset editing uses the selected instruction, preserves evidence IDs and creates a new version',async()=>{
  const {e,store}=await fixture(),p=payload();
  const item=await store.createDraft({event_key:'preset-edit-test',topic:'Meeting'},p,3600000);
  const c=config({...e,AI_PROVIDER:'gemini',GEMINI_API_KEY:'offline-edit-test',MAX_DAILY_CALLS:'20'});
  const original=globalThis.fetch,prompts=[];
  globalThis.fetch=async(_url,options)=>{
    const request=JSON.parse(options.body),instruction=request.systemInstruction.parts[0].text;
    prompts.push(instruction);
    const schema=request.generationConfig.responseFormat.text.schema;
    const result=schema.properties.title
      ? {title:'ოფიციალური შეხვედრა',body:'პარასკევს ოფიციალური შეხვედრა გაიმართა.',claim_ids:[0],source_ids:[0,1]}
      : {passed:true,unsupported_claims:[],missing_attributions:[]};
    return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(result)}]}}],
      usageMetadata:{promptTokenCount:10,candidatesTokenCount:10}});
  };
  try{
    const claimed=await store.claimDraft(item.id,1,'editing','123');
    const edited=await editDraft(c,store,claimed,null,null,'clearer');
    assert.equal(edited.version,2);assert.equal(edited.state,'pending');
    const revised=JSON.parse(edited.payload);
    assert.deepEqual(revised.article.claim_ids,[0]);assert.deepEqual(revised.article.source_ids,[0,1]);
    assert.match(prompts[0],/Make the Georgian post easier to understand/);
    assert.equal(prompts.length,2); // revision plus independent fact/attribution check
    assert.equal((await store.status()).usage.calls,2);
  }finally{globalThis.fetch=original;}
});

test('manual replacement cannot break the agreed length of a scheduled edition',async()=>{
  const {e,store}=await fixture(),p=payload();p.scheduled=true;p.edition='evening';
  const item=await store.createDraft({event_key:'scheduled-edit-length-test',topic:'Meeting'},p,3600000);
  const claimed=await store.claimDraft(item.id,1,'editing','123');
  await assert.rejects(editDraft(config(e),store,claimed,'ახალი სათაური','ახალი ტექსტი'),/90-115 სიტყვა/);
});
