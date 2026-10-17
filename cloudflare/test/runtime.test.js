import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {payload} from './helpers.js';

function modules(extraMain) {
  const result={};
  for(const name of ['worker','core','store','schema','research','gemini','feeds','editorial','workers-ai','news-plan','members'])result[name+'.js']={
    type:'esm',contents:readFileSync(new URL('../src/'+name+'.js',import.meta.url),'utf8'),
  };
  if(extraMain)result['harness.js']={type:'esm',contents:extraMain};
  return result;
}
function instance(env={},outbound,extraMain) {
  return new Miniflare({workers:[{config:{name:'political-runtime-test',compatibilityDate:'2026-10-16',
    manifest:{mainModule:extraMain?'harness.js':'worker.js',modules:modules(extraMain)},
    env:{DB:{type:'d1',id:'isolated-runtime-'+crypto.randomUUID()},
      ...Object.fromEntries(Object.entries(env).map(([key,value])=>[key,{type:'text',value}]))}},
    ...(outbound?{dev:{outboundService:{type:'fetcher',handler:outbound}}}:{}),
  }]});
}
test('workerd initializes real D1 schema, handles health and rejects unconfigured readiness',async()=>{
  const runtime=instance();
  try {
    const response=await runtime.dispatchFetch('https://test/health');assert.equal(response.status,200);
    assert.equal((await response.json()).runtime,'cloudflare-workers-d1');
    assert.equal((await runtime.dispatchFetch('https://test/ready')).status,503);
    const db=await runtime.getD1Database('DB');
    assert.equal((await db.prepare("SELECT value FROM cf_meta WHERE key='schema_version'").first()).value,'2');
  } finally {await runtime.dispose();}
});

for (const scenario of ['success','wrong bot','protected bot','wrong channel','wrong webhook'])
test('managed webhook setup: '+scenario,async()=>{
  let registrations=0,posts=0;
  const token='555:test-only-token', secret='w'.repeat(40), base='https://political.example.com';
  const runtime=instance({OWNER_USER_ID:'123',TELEGRAM_BOT_TOKEN:token,
    EXPECTED_BOT_USERNAME:scenario==='protected bot'?'digitalera_global_bot':'political_test_bot',CHANNEL_ID:'-100555',
    WEBHOOK_SECRET:secret,ADMIN_API_TOKEN:'a'.repeat(40),PUBLIC_BASE_URL:base,
  },async request=>{
    const method=new URL(request.url).pathname.split('/').at(-1);
    if(method==='getMe')return Response.json({ok:true,result:{is_bot:true,
      username:scenario==='protected bot'?'digitalera_global_bot':scenario==='wrong bot'?'another_bot':'political_test_bot'}});
    if(method==='getChat')return Response.json({ok:true,result:{type:scenario==='wrong channel'?'private':'channel',
      username:'political_test_channel'}});
    if(method==='setWebhook') {
      const body=await request.json();
      assert.equal(body.secret_token,secret);assert.equal(body.drop_pending_updates,false);
      assert.equal(body.url,base+'/telegram/webhook');registrations++;
      return Response.json({ok:true,result:true});
    }
    if(method==='getWebhookInfo')return Response.json({ok:true,result:{
      url:scenario==='wrong webhook'?'https://wrong.example.com/':base+'/telegram/webhook'}});
    if(method==='sendMessage'){posts++;return Response.json({ok:true,result:{message_id:1}});}
    throw new Error('Unexpected outbound method');
  },`
    import worker from './worker.js';
    export default {async fetch(request,env,ctx) {
      if(new URL(request.url).pathname==='/__test/cron') {
        const tasks=[];
        await worker.scheduled({scheduledTime:Date.now()},env,{waitUntil(p){tasks.push(p);}});
        await Promise.all(tasks);return Response.json({done:true});
      }
      return worker.fetch(request,env,ctx);
    }};`);
  try {
    await runtime.dispatchFetch('https://test/health');
    const db=await runtime.getD1Database('DB');
    await db.prepare("INSERT INTO cf_jobs(id,kind,payload,created_at) VALUES ('setup-test','setup',?,?)")
      .bind(JSON.stringify({action:'register_webhook'}),Date.now()).run();
    await runtime.dispatchFetch('https://test/__test/cron');
    await runtime.dispatchFetch('https://test/__test/cron');
    const job=await db.prepare("SELECT * FROM cf_jobs WHERE id='setup-test'").first();
    const result=await db.prepare("SELECT value FROM cf_meta WHERE key='webhook_registration'").first();
    assert.equal(job.status,scenario==='success'?'done':'failed');
    if(scenario==='wrong bot')assert.match(job.error,/@another_bot/);
    assert.equal(registrations,['success','wrong webhook'].includes(scenario)?1:0);
    if(scenario==='success') {
      assert.equal(JSON.parse(result.value).verified,true);
      assert.equal(posts,0);
      assert.ok(!result.value.includes(token));assert.ok(!result.value.includes(secret));
    } else {assert.equal(result,null);assert.equal(posts,0);} // Setup cannot send through an unverified identity.
  } finally {await runtime.dispose();}
});

test('managed AI check uses one budgeted call, no research run and no Telegram messages',async()=>{
  let calls=0;
  const runtime=instance({OWNER_USER_ID:'123',TELEGRAM_BOT_TOKEN:'555:test-only-token',
    EXPECTED_BOT_USERNAME:'political_test_bot',CHANNEL_ID:'-100555',WEBHOOK_SECRET:'w'.repeat(40),
    ADMIN_API_TOKEN:'a'.repeat(40),GEMINI_API_KEY:'test-only-key',AI_PROVIDER:'gemini',
    SOURCE_DOMAINS:'example.com,example.org'},async request=>{
      assert.equal(new URL(request.url).hostname,'generativelanguage.googleapis.com');calls++;
      return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'{"available":true}'}]}}]});
    },`import worker from './worker.js';export default {async fetch(request,env,ctx){
      if(new URL(request.url).pathname==='/__test/cron'){
        const tasks=[];await worker.scheduled({scheduledTime:Date.now()},env,{waitUntil(p){tasks.push(p);}});
        await Promise.all(tasks);return Response.json({done:true});
      }return worker.fetch(request,env,ctx);}};`);
  try {
    await runtime.dispatchFetch('https://test/health');const db=await runtime.getD1Database('DB');
    await db.prepare("INSERT INTO cf_jobs(id,kind,payload,created_at) VALUES ('ai-check','setup',?,?)")
      .bind(JSON.stringify({action:'check_ai'}),Date.now()).run();
    await runtime.dispatchFetch('https://test/__test/cron');await runtime.dispatchFetch('https://test/__test/cron');
    assert.equal(calls,1);assert.equal((await db.prepare("SELECT status FROM cf_jobs WHERE id='ai-check'").first()).status,'done');
    const usage=await db.prepare('SELECT runs,calls FROM cf_usage').first();assert.deepEqual(usage,{runs:0,calls:1});
    const result=JSON.parse((await db.prepare("SELECT value FROM cf_meta WHERE key='ai_diagnostic'").first()).value);
    assert.equal(result.available,true);assert.ok(!JSON.stringify(result).includes('test-only-key'));
  }finally{await runtime.dispose();}
});

for(const variant of ['openai','gemini','gemini-feeds','gemini-feeds-fallback','gemini-feeds-photo-fallback','gemini-feeds-history','gemini-feeds-duplicate']) {
const provider=variant==='openai'?'openai':'gemini';
const feedMode=variant.startsWith('gemini-feeds'),fallback=variant==='gemini-feeds-fallback',
  photoFallback=variant==='gemini-feeds-photo-fallback';
const withHistory=['gemini-feeds-history','gemini-feeds-duplicate'].includes(variant),duplicate=variant==='gemini-feeds-duplicate';
test('workerd runs '+variant+' research, real HTMLRewriter extraction, approval and single publication with mocked APIs',async()=>{
  let calls=0,sends=0;
  const p=payload(),time=new Date().toISOString();
  const runtime=instance({
    OWNER_USER_ID:'123',OWNER_CHAT_ID:'123',TELEGRAM_BOT_TOKEN:'555:test-only-token',
    EXPECTED_BOT_USERNAME:'political_test_bot',CHANNEL_ID:'-100555',
    WEBHOOK_SECRET:'w'.repeat(40),ADMIN_API_TOKEN:'a'.repeat(40),OPENAI_API_KEY:'test-only',
    OPENAI_MODEL:'test-only',SOURCE_DOMAINS:'example.com,example.org',
    AI_PROVIDER:provider,GEMINI_API_KEY:'gemini-test-only',GEMINI_MODEL:'gemini-2.5-flash',
    DISCOVERY_MODE:feedMode?'feeds':'web_search',SOURCE_FEEDS:'bbc-world,guardian-world',
    RESEARCH_ENABLED:'true',PUBLISH_ENABLED:'true',
  },async request=>{
    const url=new URL(request.url);
    if(['feeds.bbci.co.uk','www.theguardian.com'].includes(url.hostname))return new Response(
      '<rss><channel><item><title>A diplomatic meeting</title><pubDate>'+new Date(Date.now()+(photoFallback&&url.hostname==='www.theguardian.com'?60000:0)).toUTCString()+
      '</pubDate><link>https://'+(url.hostname==='feeds.bbci.co.uk'?'example.com':'example.org')+
      '/news</link><description>A recent independently reported meeting.</description></item>'+
      (fallback && url.hostname==='feeds.bbci.co.uk'?'<item><title>A different diplomatic event report</title><pubDate>'+
        new Date(Date.now()+60000).toUTCString()+'</pubDate><link>https://example.com/unavailable</link></item>':'')+'</channel></rss>',
      {headers:{'Content-Type':'application/rss+xml'}});
    if(['api.openai.com','generativelanguage.googleapis.com'].includes(url.hostname)) {
      const body=await request.json();
      let result;
      if(body.tools) result={output:[{type:'web_search_call',action:{sources:[
        {url:'https://example.com/news'},{url:'https://example.org/news'}]}},
        {type:'message',content:[{type:'output_text',text:'A recent independent meeting report.'}]}]};
      else {
        const properties=(body.text?.format.schema || body.generationConfig?.responseFormat.text.schema).properties;
        let data;
        if(properties.candidates) {
          const input=JSON.parse(body.input || body.contents[0].parts[0].text),catalog=input.source_catalog;
          const first=catalog.find(x=>x.url==='https://example.com/news').source_id;
          const second=catalog.find(x=>x.url==='https://example.org/news').source_id;
          const selected={event_key:'meeting-'+time,topic:'Meeting',event_at:time,source_ids:[first,second]};
          data={candidates:fallback?[{...selected,event_key:'unavailable-event-'+time,
            source_ids:[catalog.find(x=>x.url.endsWith('/unavailable')).source_id]},selected]:
            photoFallback?[{...selected,event_key:'missing-photo-'+time,source_ids:[second]},
              {...selected,source_ids:[first]}]:[selected]};
        }
        else if(properties.publishable) {
          const input=JSON.parse(body.input || body.contents[0].parts[0].text);
          if(withHistory)assert.equal(input.history[0].event_key,'prior-diplomatic-event');
          // Model can mislabel the publisher; the Worker corrects it from the actual URL.
          data={...p.verification,duplicate_event:duplicate,
            sources:[{...p.verification.sources[0],origin_group:'wrong-ai-group',
              ...(feedMode?{published_at:null}:{})}],
            claims:p.verification.claims.map(claim=>({...claim,status:'verified',
              origin_groups:['wrong-ai-group'],evidence:[{
                source_id:0,excerpt_id:input.sources[0].excerpts
                  .find(q=>q.text.includes(claim.evidence[0].excerpt)).excerpt_id,
              }]})),
          };
        }
        else if(properties.title)data={...p.article,source_ids:[0]};
        else if(properties.passed)data=p.fact_check;
        else throw new Error('Unexpected mock model call');
        result={output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(data)}]}]};
      }
      calls++;
      if(provider==='gemini') {
        const text=result.output.find(x=>x.type==='message').content[0].text;
        return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text}]},
          ...(body.tools?{groundingMetadata:{webSearchQueries:['meeting news'],groundingChunks:[
            {web:{uri:'https://example.com/news'}},{web:{uri:'https://example.org/news'}}]}}:{})}],
          usageMetadata:{promptTokenCount:10,candidatesTokenCount:20}});
      }
      return Response.json({...result,status:'completed',usage:{input_tokens:10,output_tokens:20}});
    }
    if(url.pathname==='/unavailable')return new Response('',{status:403});
    if(['example.com','example.org'].includes(url.hostname))return new Response(
      '<html><head><meta property="og:image" content="https://example.com/news-photo.jpg"><meta property="article:published_time" content="'+time+'"></head><body><nav>UNTRUSTED NAVIGATION</nav><script>INJECTED SCRIPT</script><article>'+time+
      ' '+p.sources[0].text+' '+('The report provides context for the diplomatic meeting. '.repeat(8))+
      '</article></body></html>',{headers:{'Content-Type':'text/html'}});
    if(url.hostname==='api.telegram.org') {
      const method=url.pathname.split('/').at(-1);
      if(method==='getMe')return Response.json({ok:true,result:{id:555,is_bot:true,username:'political_test_bot'}});
      if(method==='getChat')return Response.json({ok:true,result:{type:'channel',username:'political_test_channel'}});
      if(method==='getChatMember')return Response.json({ok:true,result:{status:'administrator',can_post_messages:true}});
      if(method==='sendPhoto'){const data=await request.json();assert.ok(data.caption.length<=1024);assert.equal(data.reply_markup.inline_keyboard.filter(row=>row.some(b=>b.url)).length,1);sends++;return Response.json({ok:true,result:{message_id:88,photo:[{file_id:'test-photo-id'}]}});}
      if(method==='sendMessage'){sends++;return Response.json({ok:true,result:{message_id:88}});}
    }
    throw new Error('Unexpected outbound request');
  },`
    import worker, {drain,publish} from './worker.js';
    import {config} from './core.js'; import {Store} from './store.js';
    export default {async fetch(request,env,ctx) {
      const url=new URL(request.url),store=new Store(env.DB),c=config(env);
      if(url.pathname==='/__test/drain') {await drain(c,store,'research',1);return Response.json({done:true});}
      if(url.pathname==='/__test/publish') {try{return Response.json({message_id:await publish(c,store,url.searchParams.get('id'),1)});}
        catch{return Response.json({blocked:true},{status:409});}}
      return worker.fetch(request,env,ctx);
    }};`);
  try {
    assert.equal((await runtime.dispatchFetch('https://test/health')).status,200);
    const db=await runtime.getD1Database('DB');
    if(withHistory)await db.prepare("INSERT INTO cf_drafts(id,event_key,topic,payload,created_at,expires_at,updated_at,state) VALUES ('prior-event','prior-diplomatic-event','Prior diplomatic event',?,?,?,?, 'published')")
      .bind(JSON.stringify(p),Date.now()-1000,Date.now()+3600000,Date.now()-1000).run();
    const queued=await runtime.dispatchFetch('https://test/admin/generate',{method:'POST',
      headers:{Authorization:'Bearer '+'a'.repeat(40)},body:JSON.stringify({query:'Diplomatic meeting'})});
    assert.equal(queued.status,202);
    await runtime.dispatchFetch('https://test/__test/drain');
    const draft=await db.prepare("SELECT * FROM cf_drafts WHERE id!='prior-event'").first();
    const jobs=await db.prepare('SELECT * FROM cf_jobs').all();
    if(duplicate) {
      assert.equal(draft,null);assert.match(jobs.results[0].error,/Duplicate underlying event|No supported photo-backed political story/);
      assert.equal(calls,feedMode?1:2);assert.equal(sends,1);return;
    }
    assert.ok(draft,JSON.stringify(jobs.results));assert.equal(draft.state,'pending');
    const evidence=JSON.parse(draft.payload).sources[0].text;
    assert.ok(evidence.includes(p.sources[0].text));
    assert.ok(!evidence.includes('INJECTED SCRIPT'));
    assert.ok(!evidence.includes('UNTRUSTED NAVIGATION'));
    assert.equal(JSON.parse(draft.payload).sources[0].publication.published_at,time);
    assert.equal(calls,feedMode?2:4);assert.equal(sends,1); // Owner draft notification only.
    if(feedMode)assert.equal(JSON.parse(draft.payload).grounding.kind,'publisher-rss');
    if(fallback || photoFallback) {
      const diagnostic=JSON.parse((await db.prepare("SELECT value FROM cf_meta WHERE key='research_source_diagnostic'").first()).value);
      assert.equal(diagnostic.attempts.length,2);
      if(fallback)assert.equal(diagnostic.attempts[0].failures[0].error,'Source unavailable');
      if(photoFallback)assert.equal(diagnostic.attempts[0].rejected,'No usable publisher photo');
    }
    assert.equal((await runtime.dispatchFetch('https://test/__test/publish?id='+draft.id)).status,200);
    assert.equal((await runtime.dispatchFetch('https://test/__test/publish?id='+draft.id)).status,409);
    assert.equal(sends,2); // One owner notification and exactly one channel post.
    assert.equal((await db.prepare('SELECT state FROM cf_drafts WHERE id=?').bind(draft.id).first()).state,'published');
  } finally {await runtime.dispose();}
});
}
