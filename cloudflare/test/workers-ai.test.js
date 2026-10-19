import {test} from 'node:test';
import assert from 'node:assert/strict';
import {config,missing} from '../src/core.js';
import {llm} from '../src/research.js';
import {projectSchemaFields} from '../src/workers-ai.js';
import {fixture} from './helpers.js';

const schema={type:'object',properties:{title:{type:'string'},
  accepted:{type:'boolean'}},required:['title','accepted'],additionalProperties:false};
test('Cloudflare AI is selected without any Google/OpenAI credentials',async()=>{
  const {e}=await fixture();
  delete e.GEMINI_API_KEY;delete e.OPENAI_API_KEY;
  e.AI={run:async()=>{}};
  e.DISCOVERY_MODE='feeds';
  const c=config({...e,AI_PROVIDER:'workers-ai'});
  assert.equal(c.model,'@cf/qwen/qwen3-30b-a3b-fp8');
  assert.deepEqual(missing(c,true),[]);
});
test('Cloudflare AI returns validated JSON and updates usage without Google network calls',async()=>{
  const {e,store}=await fixture();
  let calls=0;
  e.AI={run:async(model,payload)=>{
    calls++;assert.equal(model,'@cf/qwen/qwen3-30b-a3b-fp8');
    assert.equal(payload.response_format.type,'json_object');
    assert.ok(payload.messages[1].content.startsWith('/no_think'));
    return {choices:[{message:{content:'{"title":"საქართველოში დიპლომატიური შეხვედრა","accepted":true}'},
      finish_reason:'stop'}],usage:{prompt_tokens:120,completion_tokens:35}};
  }};
  const c=config({...e,AI_PROVIDER:'workers-ai',DISCOVERY_MODE:'feeds'});
  assert.deepEqual(await llm(c,store,'Return article',{},schema),{
    title:'საქართველოში დიპლომატიური შეხვედრა',accepted:true,
  });
  assert.equal(calls,1);
  const status=(await store.status()).usage;
  assert.equal(status.calls,1);assert.equal(status.input_tokens,120);assert.equal(status.output_tokens,35);
});
test('Gemini unsupported-location error uses bounded Workers AI fallback with the same schema',async()=>{
  const {e,store}=await fixture(),original=globalThis.fetch;
  let aiCalls=0;
  e.GEMINI_API_KEY='offline-gemini';e.AI_PROVIDER='gemini';e.GEMINI_MODEL='gemini-3.8-flash';
  e.AI={run:async(model,payload)=>{
    aiCalls++;assert.equal(model,'@cf/qwen/qwen3-30b-a3b-fp8');
    assert.equal(payload.response_format.type,'json_object');
    return {choices:[{message:{content:'{"title":"შუა აღმოსავლეთში მოლაპარაკებები განახლდა","accepted":true}'},
      finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:24}};
  }};
  globalThis.fetch=async()=>Response.json({error:{status:'FAILED_PRECONDITION',
    message:'User location is not supported for the API use.'}},{status:400});
  try {
    const c=config(e);
    assert.deepEqual(await llm(c,store,'Write a verified Georgian draft',{},schema),{
      title:'შუა აღმოსავლეთში მოლაპარაკებები განახლდა',accepted:true,
    });
    assert.equal(aiCalls,1);
    const usage=(await store.status()).usage;
    assert.equal(usage.calls,1);assert.equal(usage.input_tokens,100);assert.equal(usage.output_tokens,24);
  } finally {globalThis.fetch=original;}
});
test('Cloudflare AI schema mismatch or truncated output cannot become draft',async()=>{
  const {e,store}=await fixture();
  e.AI={run:async()=>({choices:[{message:{content:'{"accepted":"true"}'},finish_reason:'stop'}]})};
  const c=config({...e,AI_PROVIDER:'workers-ai',DISCOVERY_MODE:'feeds'});
  await assert.rejects(llm(c,store,'Make JSON',{},schema),/Model JSON/);
  e.AI.run=async()=>({choices:[{message:{content:'{"title":"x","accepted":true}'},finish_reason:'length'}]});
  await assert.rejects(llm(c,store,'Make JSON',{},schema),/truncated/);
});
test('Workers AI cannot invent grounded search and fails early without binding',async()=>{
  const {e,store}=await fixture();
  const c=config({...e,AI_PROVIDER:'workers-ai',DISCOVERY_MODE:'feeds'});
  assert.ok(missing(c,true).includes('Cloudflare Workers AI binding AI'));
  c.env.AI={run:async()=>({response:'{}'})};
  await assert.rejects(llm(c,store,'Web search',{},null,true),/grounded web search/);
});

test('Qwen extra commentary fields are stripped without weakening validation',()=>{
  const nested={type:'object',properties:{facts:{type:'array',items:{type:'object',
    properties:{text:{type:'string'},confirmed:{type:'boolean'}},
    required:['text','confirmed'],additionalProperties:false}}},
    required:['facts'],additionalProperties:false};
  const payload={facts:[{text:'Diplomatic talks occurred',confirmed:true,
    confidence:0.9,comment:'unneeded'}],debug:'model-added note'};
  assert.deepEqual(projectSchemaFields(payload,nested),{
    facts:[{text:'Diplomatic talks occurred',confirmed:true}]});
  assert.deepEqual(projectSchemaFields({facts:[{confirmed:true,extra:5}]},nested),
    {facts:[{confirmed:true}]});
});
test('Cloudflare model output with extra fields validates when required fields remain',async()=>{
  const {e,store}=await fixture();
  e.AI={run:async()=>({choices:[{message:{content:'{"title":"სამიტი გაიმართა","accepted":true,"analysis":"not for publication"}'},finish_reason:'stop'}]})};
  const c=config({...e,AI_PROVIDER:'workers-ai',DISCOVERY_MODE:'feeds'});
  assert.deepEqual(await llm(c,store,'Draft',{},schema),{title:'სამიტი გაიმართა',accepted:true});
  e.AI.run=async()=>({choices:[{message:{content:'{"accepted":true,"analysis":"missing required title"}'},finish_reason:'stop'}]});
  await assert.rejects(llm(c,store,'Draft',{},schema),/Model JSON missing property/);
});
