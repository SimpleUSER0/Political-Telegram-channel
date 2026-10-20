import {Halt,readText,sourceUrl,validateJson} from './core.js';

function groundingRedirect(raw) {
  const u=new URL(raw);
  return u.protocol==='https:' && u.hostname==='vertexaisearch.cloud.google.com' &&
    !u.username && !u.password && (!u.port || u.port==='443') &&
    u.pathname.startsWith('/grounding-api-redirect/');
}
export async function resolveGroundingUrl(raw,c) {
  try { return sourceUrl(raw,c.domains); } catch {}
  let url=raw;
  for(let hop=0;hop<3;hop++) {
    // The exception is limited to Google's exact grounding redirect endpoint,
    // never a model-written URL, arbitrary Google endpoint, or open proxy.
    if (!groundingRedirect(url)) throw new Halt('Grounding source URL rejected');
    const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(10000)});
    const location=response.headers.get('Location');
    await response.body?.cancel();
    if (![301,302,303,307,308].includes(response.status) || !location)
      throw new Halt('Grounding redirect unavailable');
    url=new URL(location,url).href;
    try {return sourceUrl(url,c.domains);} catch {}
  }
  throw new Halt('Grounding redirect limit reached');
}

// The configured BYOK gateway belongs to this account and is not an
// arbitrary user-supplied proxy. Cloudflare AI Gateway uses the real Gemini key.
export function geminiEndpoint(c,model,throughGateway=Boolean(c.env.GEMINI_GATEWAY_BASE_URL)) {
  const suffix='/v1beta/models/'+model+':generateContent';
  if(!throughGateway)return 'https://generativelanguage.googleapis.com'+suffix;
  const base=String(c.env.GEMINI_GATEWAY_BASE_URL||'');
  let u;
  try{u=new URL(base);}catch{throw new Halt('Gemini AI Gateway base URL invalid');}
  if(u.protocol!=='https:' || u.hostname!=='gateway.ai.cloudflare.com' ||
      u.username || u.password || u.search || u.hash ||
      !/^\/v1\/[a-f0-9]{32}\/world-focus-gemini\/google-ai-studio\/?$/.test(u.pathname))
    throw new Halt('Gemini AI Gateway endpoint not approved');
  return u.origin+u.pathname.replace(/\/$/,'')+suffix;
}
export async function probeGemini(c,throughGateway=false,model='gemini-3.8-flash') {
  if(!['gemini-3.8-flash','gemini-3.5-flash-lite'].includes(model))
    throw new Halt('Unapproved Gemini probe model');
  const url=geminiEndpoint(c,model,throughGateway);
  let response;
  try {
    response=await fetch(url,{method:'POST',headers:{'x-goog-api-key':c.env.GEMINI_API_KEY,
      'Content-Type':'application/json'},body:JSON.stringify({
      contents:[{parts:[{text:'Reply with exactly the Georgian word: გამარჯობა'}]}],
      generationConfig:{maxOutputTokens:140,temperature:0}}),signal:AbortSignal.timeout(20000)});
    const packet=await readText(response,15000);
    let parsed={};try{parsed=JSON.parse(packet)}catch{}
    const text=(parsed.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('').trim();
    return {gateway:throughGateway,http:response.status,success:response.ok&&Boolean(text),
      text:response.ok?text.slice(0,80):'',googleStatus:parsed.error?.status||null,
      googleError:response.ok?null:String(parsed.error?.message||'').slice(0,120)};
  }catch(e){return {gateway:throughGateway,success:false,error:String(e?.message||'Network error').slice(0,100)};}
}

export async function geminiCall(c,store,day,instruction,data,schema,search) {
  if (!/^gemini-[a-zA-Z0-9.\-]+$/.test(c.model)) throw new Halt('Invalid GEMINI_MODEL');
  const body={systemInstruction:{parts:[{text:instruction+(search?
    '\nUse Google Search to find articles ONLY on these allowed domains: '+c.domains.join(', ')+
    '. Do not provide a memory-only answer. Include direct publisher URLs for the search sources.':'')}]},
    contents:[{role:'user',parts:[{text:JSON.stringify(data)}]}],
    generationConfig:{maxOutputTokens:c.maxTokens}};
  if (schema) body.generationConfig.responseFormat={text:{mimeType:'APPLICATION_JSON',schema}};
  // Separate search and JSON calls work with Gemini 2.5; no search+schema combination.
  if (search) body.tools=[{google_search:{}}];
  const send=async(model,maxOutputTokens=c.maxTokens)=>{
    try{return await fetch(geminiEndpoint(c,model),{
      method:'POST',headers:{'x-goog-api-key':c.env.GEMINI_API_KEY,'Content-Type':'application/json'},
      body:JSON.stringify({...body,generationConfig:{...body.generationConfig,maxOutputTokens}}),signal:AbortSignal.timeout(110000),
    });}
    catch{throw new Halt('Gemini network request failed');}
  };
  let model=c.model,response=await send(model);
  // Gemini Flash and Flash-Lite have separate model quotas. If primary Flash
  // is exhausted or temporarily unavailable (429/503), retry ONCE on Google's
  // free Lite model; never paid tiers,
  // external providers, recursive retries or an unbounded fallback chain.
  if([429,503].includes(response.status) && c.model==='gemini-3.8-flash' && !search) {
    await response.body?.cancel();
    await store.reserve('calls',Number.isInteger(c.callLimit)?c.callLimit:c.dailyCalls);
    model='gemini-3.5-flash-lite';response=await send(model);
  }
  const readPacket=async response=>{
    let raw;
    try{raw=await readText(response,1000000);}
    catch(error){
      if(error instanceof Halt)throw error;
      throw new Halt('Gemini response transport interrupted');
    }
    if(response.status===429)throw new Halt('Gemini free-tier quota reached (429); no paid-provider fallback');
    if(!response.ok){
      let detail='';
      try{
        const error=JSON.parse(raw).error;
        const status=/^[A-Z_]{1,50}$/.test(error?.status)?error.status:'';
        const message=String(error?.message || '').replaceAll(c.env.GEMINI_API_KEY,'[redacted]')
          .replace(/AIza[A-Za-z0-9_-]{10,}/g,'[redacted]').replace(/https?:\/\/\S+/g,'[url]').slice(0,160);
        detail=[status,message].filter(Boolean).join(': ');
      }catch{}
      throw new Halt('Gemini request failed (HTTP '+response.status+')'+(detail?': '+detail:''));
    }
    let value;
    try{value=JSON.parse(raw);}catch{throw new Halt('Invalid Gemini response');}
    const grounding=value.candidates?.[0]?.groundingMetadata;
    await store.usage(day,{input_tokens:value.usageMetadata?.promptTokenCount || 0,
      output_tokens:(value.usageMetadata?.candidatesTokenCount || 0)+(value.usageMetadata?.thoughtsTokenCount || 0)},
      grounding?.webSearchQueries?.length || 0);
    return value;
  };
  let packet=await readPacket(response),candidate=packet.candidates?.[0];
  // Structured Georgian drafts and verification packets can exceed Gemini's
  // initial output cap. Retry once with a larger bounded cap; account for the
  // extra API call before sending it. Never retry policy/safety refusals.
  if(!packet.promptFeedback?.blockReason && candidate?.finishReason==='MAX_TOKENS' && c.maxTokens<8000){
    await store.reserve('calls',Number.isInteger(c.callLimit)?c.callLimit:c.dailyCalls);
    packet=await readPacket(await send(model,8000));
    candidate=packet.candidates?.[0];
  }
  if(packet.promptFeedback?.blockReason)
    throw new Halt('Gemini safety refusal ('+String(packet.promptFeedback.blockReason).slice(0,40)+')');
  if(candidate?.finishReason!=='STOP'){
    const reason=/^[A-Z_]{1,40}$/.test(candidate?.finishReason||'')?candidate.finishReason:'UNKNOWN';
    throw new Halt(reason==='MAX_TOKENS'?'Gemini output limit reached (8000 tokens)':`Gemini response incomplete (${reason})`);
  }
  const meta=candidate.groundingMetadata;
  const text=(candidate.content?.parts || []).filter(p=>typeof p.text==='string' && !p.thought)
    .map(p=>p.text).join('\n');
  if (!text.trim()) throw new Halt('Gemini returned no text');
  if (schema) {
    let value;
    try {value=JSON.parse(text);} catch {throw new Halt('Gemini JSON invalid');}
    return validateJson(value,schema);
  }
  const urls=new Set();
  if (search) {
    const chunks=meta?.groundingChunks;
    if (!Array.isArray(chunks) || !chunks.length) throw new Halt('Gemini returned no actual search evidence');
    for(const chunk of chunks.slice(0,12)) {
      if(typeof chunk.web?.uri!=='string') continue;
      try {urls.add(await resolveGroundingUrl(chunk.web.uri,c));} catch {}
    }
    if(!urls.size) throw new Halt('Gemini search returned no allowed source URLs');
  }
  // Normalize the transport only; every downstream evidence/attribution check remains intact.
  return {status:'completed',provider:'gemini',grounding:meta || null,
    output:[...(search?[{type:'web_search_call',action:{sources:[...urls].map(url=>({url}))}}]:[]),
      {type:'message',content:[{type:'output_text',text}]}]};
}
