import {test} from 'node:test';
import assert from 'node:assert/strict';
import {config} from '../src/core.js';
import {ensureSchema} from '../src/schema.js';
import {handleFetch,authorizedUpdate} from '../src/worker.js';
import {parseMemberUpdate,saveMemberEvent,saveMemberCount,memberStatistics,memberAlert,memberReport} from '../src/members.js';
import {env,fixture,mockTelegram} from './helpers.js';

const memberEvent=(updateId=50,oldStatus='left',newStatus='member',actor=55,channel=-100555)=>({
  update_id:updateId,chat_member:{chat:{id:channel,type:'channel',username:'political_test_channel'},
    from:{id:actor},date:Math.floor(Date.now()/1000),
    old_chat_member:{status:oldStatus,user:{id:55,is_bot:false,first_name:'Test'}},
    new_chat_member:{status:newStatus,user:{id:55,is_bot:false,first_name:'Test'}}}
});
test('Membership events belong to the exact channel and ignore bots/promotions',()=>{
  const c=config(env());
  const join=parseMemberUpdate(memberEvent(),c);
  assert.deepEqual(join,{updateId:50,action:'joined',method:'joined'});
  assert.equal(parseMemberUpdate(memberEvent(51,'left','member',123),c).method,'added');
  assert.equal(parseMemberUpdate({...memberEvent(),chat_member:{...memberEvent().chat_member,invite_link:{invite_link:'test'}}},c).method,'invite');
  assert.equal(parseMemberUpdate(memberEvent(52,'member','left'),c).action,'left');
  assert.equal(parseMemberUpdate(memberEvent(53,'member','administrator'),c),null);
  assert.equal(parseMemberUpdate(memberEvent(54,'left','member',55,-100666),c),null);
  const forged=memberEvent(55);forged.chat_member.new_chat_member.user.id=99;
  assert.equal(parseMemberUpdate(forged,c),null);
  const bot=memberEvent(56);bot.chat_member.old_chat_member.user.is_bot=true;
  assert.equal(parseMemberUpdate(bot,c),null);
  assert.equal(authorizedUpdate(memberEvent(),c)?.membership.action,'joined');
  const publicChannel=config({...env(),CHANNEL_ID:'@political_test_channel'});
  assert.equal(parseMemberUpdate(memberEvent(),publicChannel)?.action,'joined');
  assert.equal(parseMemberUpdate({...memberEvent(),chat_member:{...memberEvent().chat_member,
    chat:{id:-100555,type:'channel',username:'other_channel'}}},publicChannel),null);
});
test('Member events idempotently persist totals and timezone-aware daily/weekly changes',async()=>{
  const {store}=await fixture();
  const time=Date.UTC(2026,9,17,20,20); // midnight October 18 in Georgia
  assert.equal(await saveMemberEvent(store,{updateId:1,action:'joined',method:'joined'},time),true);
  assert.equal(await saveMemberEvent(store,{updateId:1,action:'joined',method:'joined'},time),false);
  assert.equal(await saveMemberEvent(store,{updateId:2,action:'left',method:'left'},time),true);
  await saveMemberCount(store,118,time);
  const s=await memberStatistics(store,time);
  assert.equal(s.today,'2026-10-18');
  assert.equal(s.today_joined,1);
  assert.equal(s.today_left,1);
  assert.equal(s.week_joined,1);
  assert.equal(s.total_events,2);
  assert.equal(s.cached_member_count,118);
  assert.match(memberReport(s,119),/119/);
  assert.match(memberAlert({action:'joined',method:'added'},119),/დაამატეს/);
  assert.match(memberAlert({action:'left',method:'left'},119),/გავიდა/);
  const all=(await store.stmt('SELECT * FROM cf_member_events').all()).results;
  assert.deepEqual(Object.keys(all[0]).sort(),['action','at','day','method','update_id']);
});
test('Schema v2 upgrades without touching existing member-independent tables',async()=>{
  const {e,store}=await fixture();
  await store.stmt("INSERT INTO cf_meta(key,value) VALUES ('legacy_example','safe')").run();
  await store.stmt('DROP TABLE cf_member_events').run();
  await store.stmt('DROP TABLE cf_member_snapshots').run();
  await store.stmt("UPDATE cf_meta SET value='2' WHERE key='schema_version'").run();
  await ensureSchema(e.DB);
  assert.equal((await store.stmt("SELECT value FROM cf_meta WHERE key='schema_version'").first()).value,'3');
  assert.equal((await store.stmt("SELECT value FROM cf_meta WHERE key='legacy_example'").first()).value,'safe');
  assert.equal(await saveMemberEvent(store,{updateId:99,action:'joined',method:'invite'}),true);
});
test('Owner gets one join and one departure notification; /stats retrieves live count',async()=>{
  const {e,store}=await fixture(),messages=[],original=globalThis.fetch;
  globalThis.fetch=mockTelegram(async(method,data)=>{
    if(method==='getChatMemberCount')return Response.json({ok:true,result:101});
    if(method==='sendMessage'){messages.push(data);return Response.json({ok:true,result:{message_id:messages.length}});}
    throw new Error('Unexpected Telegram method '+method);
  });
  const push=async update=>{
    const tasks=[];
    const response=await handleFetch(new Request('https://test/telegram/webhook',{
      method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':e.WEBHOOK_SECRET},
      body:JSON.stringify(update)}),e,{waitUntil(p){tasks.push(p)}});
    assert.equal(response.status,200);
    await Promise.all(tasks);
  };
  try {
    await push(memberEvent(600));
    await push(memberEvent(600)); // Duplicate Telegram delivery
    assert.equal(messages.length,1);
    assert.match(messages[0].text,/ახალი გამომწერი/);
    assert.match(messages[0].text,/101/);
    const other=memberEvent(601,'left','member',55,-100999);
    await push(other);
    assert.equal(messages.length,1);
    await push(memberEvent(602,'member','left'));
    assert.equal(messages.length,2);
    assert.match(messages[1].text,/გამომწერი გავიდა/);
    await push({update_id:603,message:{from:{id:123},chat:{id:123,type:'private'},text:'/stats'}});
    assert.equal(messages.length,3);
    assert.match(messages[2].text,/გამომწერების სტატისტიკა/);
    assert.match(messages[2].text,/101/);
    const s=await memberStatistics(store);
    assert.equal(s.today_joined,1);
    assert.equal(s.today_left,1);
    assert.equal(s.total_events,2);
    assert.equal((await store.stmt("SELECT count(*) AS n FROM cf_updates").first()).n,3);
  }finally{globalThis.fetch=original;}
});
