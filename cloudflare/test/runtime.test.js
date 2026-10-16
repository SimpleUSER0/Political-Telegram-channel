import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {payload} from './helpers.js';

function modules(extraMain) {
  const result={};
  for(const name of ['worker','core','store','schema','research','gemini'])result[name+'.js']={
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
    assert.equal((await db.prepare("SELECT value FROM cf_meta WHERE key='schema_version'").first()).value,'1');
  } finally {await runtime.dispose();}
});

for(const provider of ['openai','gemini'])
test('workerd runs '+provider+' research, real HTMLRewriter extraction, approval and single publication with mocked APIs',async()=>{
  let calls=0,sends=0;
  const p=payload(),time=new Date().toISOString();
  const runtime=instance({
    OWNER_USER_ID:'123',OWNER_CHAT_ID:'123',TELEGRAM_BOT_TOKEN:'555:test-only-token',
    EXPECTED_BOT_USERNAME:'political_test_bot',CHANNEL_ID:'-100555',
    WEBHOOK_SECRET:'w'.repeat(40),ADMIN_API_TOKEN:'a'.repeat(40),OPENAI_API_KEY:'test-only',
    OPENAI_MODEL:'test-only',SOURCE_DOMAINS:'example.com,example.org',
    AI_PROVIDER:provider,GEMINI_API_KEY:'gemini-test-only',GEMINI_MODEL:'gemini-2.5-flash',
    RESEARCH_ENABLED:'true',PUBLISH_ENABLED:'true',
  },async request=>{
    const url=new URL(request.url);
    if(['api.openai.com','generativelanguage.googleapis.com'].includes(url.hostname)) {
      const body=await request.json();
      let result;
      if(body.tools) result={output:[{type:'web_search_call',action:{sources:[
        {url:'https://example.com/news'},{url:'https://example.org/news'}]}},
        {type:'message',content:[{type:'output_text',text:'A recent independent meeting report.'}]}]};
      else {
        const properties=(body.text?.format.schema || body.generationConfig?.responseFormat.text.schema).properties;
        let data;
        if(properties.candidates)data={candidates:[{event_key:'meeting-'+time,topic:'Meeting',event_at:time,
          source_urls:['https://example.com/news','https://example.org/news']}]};
        else if(properties.publishable)data=p.verification;
        else if(properties.title)data=p.article;
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
    if(['example.com','example.org'].includes(url.hostname))return new Response(
      '<html><body><nav>UNTRUSTED NAVIGATION</nav><script>INJECTED SCRIPT</script><article>'+time+
      ' '+p.sources[0].text+' '+('The report provides context for the diplomatic meeting. '.repeat(8))+
      '</article></body></html>',{headers:{'Content-Type':'text/html'}});
    if(url.hostname==='api.telegram.org') {
      const method=url.pathname.split('/').at(-1);
      if(method==='getMe')return Response.json({ok:true,result:{is_bot:true,username:'political_test_bot'}});
      if(method==='getChat')return Response.json({ok:true,result:{type:'channel',username:'political_test_channel'}});
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
    const queued=await runtime.dispatchFetch('https://test/admin/generate',{method:'POST',
      headers:{Authorization:'Bearer '+'a'.repeat(40)},body:JSON.stringify({query:'Diplomatic meeting'})});
    assert.equal(queued.status,202);
    await runtime.dispatchFetch('https://test/__test/drain');
    const db=await runtime.getD1Database('DB');
    const draft=await db.prepare('SELECT * FROM cf_drafts').first();
    const jobs=await db.prepare('SELECT * FROM cf_jobs').all();
    assert.ok(draft,JSON.stringify(jobs.results));assert.equal(draft.state,'pending');
    const evidence=JSON.parse(draft.payload).sources[0].text;
    assert.ok(evidence.includes(p.sources[0].text));
    assert.ok(!evidence.includes('INJECTED SCRIPT'));
    assert.ok(!evidence.includes('UNTRUSTED NAVIGATION'));
    assert.equal(calls,5);assert.equal(sends,1); // Owner draft notification only.
    assert.equal((await runtime.dispatchFetch('https://test/__test/publish?id='+draft.id)).status,200);
    assert.equal((await runtime.dispatchFetch('https://test/__test/publish?id='+draft.id)).status,409);
    assert.equal(sends,2); // One owner notification and exactly one channel post.
    assert.equal((await db.prepare('SELECT state FROM cf_drafts').first()).state,'published');
  } finally {await runtime.dispose();}
});
