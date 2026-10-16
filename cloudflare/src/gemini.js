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

export async function geminiCall(c,store,day,instruction,data,schema,search) {
  if (!/^gemini-[a-zA-Z0-9.\-]+$/.test(c.model)) throw new Halt('Invalid GEMINI_MODEL');
  const body={systemInstruction:{parts:[{text:instruction+(search?
    '\nUse Google Search to find articles ONLY on these allowed domains: '+c.domains.join(', ')+
    '. Do not provide a memory-only answer. Include direct publisher URLs for the search sources.':'')}]},
    contents:[{role:'user',parts:[{text:JSON.stringify(data)}]}],
    generationConfig:{maxOutputTokens:c.maxTokens}};
  if (schema) body.generationConfig.responseFormat={text:{mimeType:'application/json',schema}};
  // Separate search and JSON calls work with Gemini 2.5; no search+schema combination.
  if (search) body.tools=[{google_search:{}}];
  const response=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+c.model+':generateContent',{
    method:'POST',headers:{'x-goog-api-key':c.env.GEMINI_API_KEY,'Content-Type':'application/json'},
    body:JSON.stringify(body),signal:AbortSignal.timeout(110000),
  });
  const raw=await readText(response,1000000);
  if (response.status===429) throw new Halt('Gemini free-tier quota reached (429); no paid-provider fallback');
  if (!response.ok) {
    let detail='';
    try {
      const error=JSON.parse(raw).error;
      const status=/^[A-Z_]{1,50}$/.test(error?.status)?error.status:'';
      const message=String(error?.message || '').replaceAll(c.env.GEMINI_API_KEY,'[redacted]')
        .replace(/AIza[A-Za-z0-9_-]{10,}/g,'[redacted]').replace(/https?:\/\/\S+/g,'[url]').slice(0,160);
      detail=[status,message].filter(Boolean).join(': ');
    }catch{}
    throw new Halt('Gemini request failed (HTTP '+response.status+')'+(detail?': '+detail:''));
  }
  let packet;
  try {packet=JSON.parse(raw);} catch {throw new Halt('Invalid Gemini response');}
  const candidate=packet.candidates?.[0], meta=candidate?.groundingMetadata;
  await store.usage(day,{input_tokens:packet.usageMetadata?.promptTokenCount || 0,
    output_tokens:(packet.usageMetadata?.candidatesTokenCount || 0)+(packet.usageMetadata?.thoughtsTokenCount || 0)},
    meta?.webSearchQueries?.length || 0);
  if (packet.promptFeedback?.blockReason || candidate?.finishReason!=='STOP')
    throw new Halt('Gemini response incomplete or refused');
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
    if(urls.size<2) throw new Halt('Gemini search has fewer than two allowed source URLs');
  }
  // Normalize the transport only; every downstream evidence/attribution check remains intact.
  return {status:'completed',provider:'gemini',grounding:meta || null,
    output:[...(search?[{type:'web_search_call',action:{sources:[...urls].map(url=>({url}))}}]:[]),
      {type:'message',content:[{type:'output_text',text:text+'\nAllowed publisher URLs: '+[...urls].join('\n')}]}]};
}
