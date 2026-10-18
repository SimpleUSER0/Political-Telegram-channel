import {test} from 'node:test';
import assert from 'node:assert/strict';
import {manualPostRequest,handleFetch} from '../src/worker.js';
import {env,fixture,mockTelegram} from './helpers.js';

test('owner can send plain Georgian text instead of slash command',()=>{
  const a=manualPostRequest('დამიწერე პოსტი ჩინეთისა და ტაივანის ურთიერთობებზე');
  assert.equal(a.query,'დამიწერე პოსტი ჩინეთისა და ტაივანის ურთიერთობებზე');
  assert.equal(a.format,'STANDARD');
  assert.equal(a.edition,'night');
  assert.deepEqual(manualPostRequest('ჩინეთი'),{query:'ჩინეთი',format:'STANDARD',edition:'night'});
  assert.equal(manualPostRequest('/stats'),null);
  assert.equal(manualPostRequest('/unknown something'),null);
  assert.equal(manualPostRequest('/edit abc:1'),null);
});
test('/post text supports format hints, several lines and a sensible default',()=>{
  const request=manualPostRequest('/post მოკლე პოსტი საქართველოს საგარეო პოლიტიკაზე\nმკითხველისთვის გასაგებად');
  assert.deepEqual(request,{query:'მოკლე პოსტი საქართველოს საგარეო პოლიტიკაზე\nმკითხველისთვის გასაგებად',
    format:'QUICK',edition:'night'});
  assert.equal(manualPostRequest('/post ვრცლად ჩინეთის დიპლომატიაზე').format,'DEEP');
  assert.equal(manualPostRequest('/draft სასწრაფო სამხედრო ამბავი').format,'FLASH');
  assert.ok(manualPostRequest('/post').query.includes('პოლიტიკური'));
  assert.match(manualPostRequest('a'.repeat(1001)).error,/2–1000/);
  assert.deepEqual(manualPostRequest('AI'),{query:'AI',format:'STANDARD',edition:'night'});
  assert.match(manualPostRequest('x').error,/2–1000/);
});
test('private manual requests queue draft generation without posting and do not affect the schedule',async()=>{
  const {e,store}=await fixture();
  const original=globalThis.fetch,sent=[];
  globalThis.fetch=mockTelegram(async (method,data)=>{
    if(method!=='sendMessage')throw Error('Manual request must not publish or fetch at control stage');
    sent.push(data);
    return Response.json({ok:true,result:{message_id:sent.length}});
  });
  const submit=async(update_id,user_id,text)=>{
    const tasks=[];
    const response=await handleFetch(new Request('https://test/telegram/webhook',{
      method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':e.WEBHOOK_SECRET},
      body:JSON.stringify({update_id,message:{from:{id:user_id},
        chat:{id:user_id,type:'private'},text}})}),e,{waitUntil(t){tasks.push(t)}});
    assert.equal(response.status,200);
    await Promise.allSettled(tasks);
  };
  try {
    await submit(700,123,'მოამზადე პოსტი ჩინეთზე');
    await submit(700,123,'მოამზადე პოსტი ჩინეთზე'); // deduplicated update
    await submit(701,123,'/post მოკლე პოსტი საქართველოს პოლიტიკაზე');
    await submit(702,999,'სხვა პირის პოსტი');
    await submit(703,123,'/unknown თემა');
    const jobs=(await store.stmt("SELECT id,payload FROM cf_jobs WHERE kind='research' ORDER BY id").all()).results;
    assert.equal(jobs.length,2);
    assert.ok(jobs.every(job=>job.id.startsWith('manual-telegram-')));
    assert.deepEqual(jobs.map(x=>JSON.parse(x.payload).format).sort(),['QUICK','STANDARD']);
    assert.equal(sent.length,3); // two accepted drafts plus unknown command help
    assert.ok(sent.slice(0,2).every(x=>x.chat_id==='123' && x.text.includes('Publish / Edit / Cancel')));
    assert.equal((await store.stmt('SELECT count(*) AS n FROM cf_slots').first()).n,0);
    assert.equal((await store.stmt("SELECT count(*) AS n FROM cf_drafts").first()).n,0);
  }finally{globalThis.fetch=original;}
});
