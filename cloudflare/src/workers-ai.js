import {Halt,validateJson} from './core.js';

const MODEL='@cf/qwen/qwen3-30b-a3b-fp8';

// The hosted model sometimes adds descriptive fields even in JSON mode.
// Discard fields absent from the strictly defined schema, never infer missing
// mandatory data or transform types; validateJson still enforces all constraints.
export function projectSchemaFields(value,schema) {
  if(Array.isArray(value) && schema?.type==='array')
    return value.map(item=>projectSchemaFields(item,schema.items));
  if(value && typeof value==='object' && !Array.isArray(value) && schema?.type==='object') {
    const props=schema.properties||{};
    return Object.fromEntries(Object.entries(value).filter(([key])=>Object.hasOwn(props,key))
      .map(([key,item])=>[key,projectSchemaFields(item,props[key])]));
  }
  return value;
}

// Runs on the user's own Cloudflare Workers AI account. No Google egress,
// third-party API key or paid-provider fallback is needed.
export async function workersAICall(c,store,day,instruction,data,schema,search) {
  if(search)throw new Halt('Workers AI has no grounded web search; use publisher RSS discovery');
  if(!c.env.AI || typeof c.env.AI.run!=='function')
    throw new Halt('Cloudflare Workers AI binding missing');
  const guidance=schema?
    '\nReturn only one complete JSON object. It must exactly match this JSON Schema: '+
      JSON.stringify(schema)+'. No markdown, explanations or extra keys.':'\nReturn a concise plain-text answer.';
  const payload={
    messages:[{role:'system',content:instruction+guidance},
      {role:'user',content:'/no_think\n'+JSON.stringify(data)}],
    max_tokens:Math.min(c.maxTokens,6000),temperature:0.1,
    ...(schema?{response_format:{type:'json_object'}}:{}),
  };
  let raw;
  try {raw=await c.env.AI.run(MODEL,payload);}
  catch(error){
    // Do not expose provider payloads or account details in Telegram errors.
    if(/quota|daily|neurons|limit|budget|exceeded/i.test(String(error?.message||'')))
      throw new Halt('Cloudflare Workers AI free daily quota reached');
    throw new Halt('Cloudflare Workers AI request failed; inspect Worker logs');
  }
  const response=raw?.choices?.[0]?.message?.content??raw?.response;
  if(typeof response!=='string' || !response.trim())
    throw new Halt('Cloudflare Workers AI returned no complete text');
  if(raw?.choices?.[0]?.finish_reason && raw.choices[0].finish_reason!=='stop')
    throw new Halt('Cloudflare Workers AI response was truncated');
  const usage=raw?.usage || {};
  await store.usage(day,{
    input_tokens:usage.prompt_tokens || usage.input_tokens || 0,
    output_tokens:usage.completion_tokens || usage.output_tokens || 0,
  },0);
  if(!schema)return {status:'completed',output:[{type:'message',
    content:[{type:'output_text',text:response}]}]};
  let decoded;
  try {decoded=JSON.parse(response);}catch{throw new Halt('Cloudflare Workers AI JSON invalid');}
  return validateJson(projectSchemaFields(decoded,schema),schema);
}
