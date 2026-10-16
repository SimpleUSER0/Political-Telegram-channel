export class Halt extends Error {}
export const now = () => Date.now();
export const id = () => crypto.randomUUID().replaceAll('-', '').slice(0, 20);
export const json = (data, status = 200) => Response.json(data, {
  status, headers: {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'},
});
export const normalized = text => String(text).normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
export const enabled = value => String(value).toLowerCase() === 'true';
export function number(value, fallback, min, max) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Halt('Invalid numeric configuration');
  return n;
}
export function config(env) {
  const provider=String(env.AI_PROVIDER || (env.GEMINI_API_KEY?'gemini':'openai')).toLowerCase();
  if (!['gemini','openai'].includes(provider)) throw new Halt('AI_PROVIDER must be gemini or openai');
  let origins = {}, hours = [];
  try {
    origins = JSON.parse(env.SOURCE_ORIGIN_GROUPS || '{}');
    hours = JSON.parse(env.SCHEDULE_HOURS || '[]');
  } catch { throw new Halt('Invalid SOURCE_ORIGIN_GROUPS or SCHEDULE_HOURS JSON'); }
  if (!Array.isArray(hours) || hours.some(h => !Number.isInteger(h) || h < 0 || h > 23))
    throw new Halt('SCHEDULE_HOURS must be an array of hours in Asia/Tbilisi');
  if (!origins || Array.isArray(origins) || typeof origins !== 'object' ||
      Object.values(origins).some(v => typeof v !== 'string' || !v.trim()))
    throw new Halt('Invalid source origin groups');
  const domains = (env.SOURCE_DOMAINS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (domains.some(d => !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(d)))
    throw new Halt('Invalid SOURCE_DOMAINS');
  const discovery=env.DISCOVERY_MODE || 'web_search';
  if(!['web_search','feeds'].includes(discovery))throw new Halt('Invalid DISCOVERY_MODE');
  const feeds=[...new Set((env.SOURCE_FEEDS || 'bbc-world,guardian-world,civil-ge').split(',').map(s=>s.trim()).filter(Boolean))];
  if(discovery==='feeds' && (feeds.length<2 || feeds.some(f=>!['bbc-world','guardian-world','civil-ge'].includes(f))))
    throw new Halt('SOURCE_FEEDS requires at least two known publisher feeds');
  const channel = String(env.CHANNEL_ID || '');
  if (['@cifruli_era', '@digitalera101'].includes(channel.toLowerCase()))
    throw new Halt('An existing technology channel cannot be used');
  return {
    env, domains, origins, hours, discovery, feeds, owner: String(env.OWNER_USER_ID || ''),
    ownerChat: String(env.OWNER_CHAT_ID || env.OWNER_USER_ID || ''), channel,
    username: String(env.EXPECTED_BOT_USERNAME || '').replace(/^@/, '').toLowerCase(),
    research: enabled(env.RESEARCH_ENABLED), publish: enabled(env.PUBLISH_ENABLED),
    schedule: enabled(env.SCHEDULE_ENABLED), provider,
    model: provider==='gemini'?(env.GEMINI_MODEL || 'gemini-2.5-flash'):(env.OPENAI_MODEL || ''),
    dailyRuns: number(env.MAX_DAILY_RUNS, provider==='gemini'?1:4, 1, 24),
    dailyCalls: number(env.MAX_DAILY_CALLS, provider==='gemini'?12:40, 1, 200),
    maxTokens: number(env.MAX_OUTPUT_TOKENS, 4000, 512, 8000),
    age: number(env.MAX_SOURCE_AGE_HOURS, 48, 1, 168) * 3600000,
    ttl: number(env.DRAFT_TTL_HOURS, 12, 1, 48) * 3600000,
  };
}
export function missing(c, research = false) {
  const result = [];
  if (!/^\d+$/.test(c.owner) || !/^\d+$/.test(c.ownerChat)) result.push('OWNER_USER_ID / OWNER_CHAT_ID');
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(c.env.TELEGRAM_BOT_TOKEN || '')) result.push('TELEGRAM_BOT_TOKEN');
  if (!/^[a-z0-9_]+bot$/.test(c.username)) result.push('EXPECTED_BOT_USERNAME');
  if (String(c.env.WEBHOOK_SECRET || '').length < 32 ||
      !/^[A-Za-z0-9_-]+$/.test(c.env.WEBHOOK_SECRET || '')) result.push('WEBHOOK_SECRET (32+ URL-safe chars)');
  if (String(c.env.ADMIN_API_TOKEN || '').length < 32) result.push('ADMIN_API_TOKEN (32+ chars)');
  if (!/^(@[A-Za-z0-9_]{5,}|-100\d+)$/.test(c.channel)) result.push('CHANNEL_ID');
  if (research) {
    if (c.provider==='gemini') {
      if (!c.env.GEMINI_API_KEY) result.push('GEMINI_API_KEY');
      if (!/^gemini-[a-zA-Z0-9.\-]+$/.test(c.model)) result.push('GEMINI_MODEL');
    } else {
      if (!c.env.OPENAI_API_KEY) result.push('OPENAI_API_KEY');
      if (!c.model) result.push('OPENAI_MODEL');
    }
    if (c.domains.length < 2) result.push('SOURCE_DOMAINS (at least 2)');
  }
  return result;
}
// Enforce the small JSON Schema vocabulary used by this newsroom, including types
// and unknown properties; provider-side structured output is not a trust boundary.
export function validateJson(value,schema,depth=0) {
  if (depth>20) throw new Halt('Model JSON nesting limit exceeded');
  const type=value===null?'null':Array.isArray(value)?'array':typeof value;
  const types=Array.isArray(schema.type)?schema.type:[schema.type];
  if (!types.some(t=>t===type || (t==='integer' && Number.isInteger(value))))
    throw new Halt('Model JSON type mismatch');
  if (schema.enum && !schema.enum.includes(value)) throw new Halt('Model JSON enum mismatch');
  if (type==='object') {
    if ((schema.required || []).some(key=>!Object.hasOwn(value,key))) throw new Halt('Model JSON missing property');
    for (const [key,item] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties || {},key)) {
        if (schema.additionalProperties===false) throw new Halt('Model JSON unexpected property');
      } else validateJson(item,schema.properties[key],depth+1);
    }
  } else if (type==='array') {
    if (value.length>200) throw new Halt('Model JSON array limit exceeded');
    for (const item of value) validateJson(item,schema.items,depth+1);
  }
  return value;
}
export async function equalSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const enc = new TextEncoder();
  const aa = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(a)));
  const bb = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(b)));
  let difference = 0;
  for (let i = 0; i < aa.length; i++) difference |= aa[i] ^ bb[i];
  return difference === 0;
}
export async function readText(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Halt('Response too large');
      text += decoder.decode(value, {stream: true});
    }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
}
export function sourceUrl(raw, domains) {
  let u;
  try { u = new URL(raw); } catch { throw new Halt('Invalid source URL'); }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') ||
      !domains.some(d => host === d || host.endsWith('.' + d)) ||
      !/[a-z]/i.test(host) || host.endsWith('.local') || host === 'localhost' ||
      !u.pathname.replaceAll('/', '')) throw new Halt('Source URL rejected');
  u.hash = '';
  for (const key of [...u.searchParams.keys()])
    if (/^(utm_|fbclid|gclid)/i.test(key)) u.searchParams.delete(key);
  return u.href;
}
export function outputText(response) {
  return (response.output || []).flatMap(x => x.content || [])
    .filter(x => x.type === 'output_text').map(x => x.text).join('\n');
}
export function retrievedUrls(response, domains) {
  const urls = new Set();
  for (const item of response.output || []) {
    const raw = [...(item.action?.sources || []).map(x => x.url)];
    for (const part of item.content || []) for (const a of part.annotations || [])
      if (a.type === 'url_citation') raw.push(a.url);
    for (const url of raw) { try { urls.add(sourceUrl(url, domains)); } catch {} }
  }
  return urls;
}
export const articleText = a => `${a.title}\n\n${a.body}`;
export function validateArticle(a, packet, sources) {
  if (!a || typeof a.title !== 'string' || !a.title.trim() || a.title.length > 250 ||
      typeof a.body !== 'string' || !a.body.trim() || articleText(a).length > 3500 ||
      /https?:\/\/|t\.me\//i.test(articleText(a)) ||
      !Array.isArray(a.claim_ids) || !a.claim_ids.length ||
      !Array.isArray(a.source_ids) || !a.source_ids.length) throw new Halt('Invalid article');
  for (const i of a.claim_ids)
    if (!Number.isInteger(i) || !packet.claims[i]) throw new Halt('Unknown article claim');
  for (const i of a.source_ids)
    if (!Number.isInteger(i) || !sources.some(s => s.id === i)) throw new Halt('Unknown article source');
  const required = a.claim_ids.flatMap(i => packet.claims[i].evidence.map(e => e.source_id));
  if (required.some(i => !a.source_ids.includes(i))) throw new Halt('Missing evidence source link');
}
export function validatePacket(packet, sources, c, time = now()) {
  if (!packet?.publishable || !packet.claims?.length || !Array.isArray(packet.sources))
    throw new Halt('Insufficient evidence; draft withheld');
  const assessments = new Map(packet.sources.map(s => [s.source_id, s]));
  if (assessments.size !== sources.length || assessments.size !== packet.sources.length ||
      sources.some(s => !assessments.has(s.id))) throw new Halt('Incomplete source assessment');
  if (new Set(sources.map(s => new URL(s.url).hostname)).size < 2) throw new Halt('Two domains required');
  for (const source of sources) {
    const assessment = assessments.get(source.id);
    const date = Date.parse(assessment.published_at);
    if (!assessment.published_at || !/(Z|[+-]\d\d:\d\d)$/.test(assessment.published_at) ||
        !Number.isFinite(date) || date < time - c.age || date > time + 600000)
      throw new Halt('Unknown or stale source publication date');
    if(source.publication && Date.parse(source.publication.published_at)!==date)
      throw new Halt('Source publication date conflicts with publisher metadata');
    const host = new URL(source.url).hostname;
    const mapped = Object.entries(c.origins).find(([d]) => host === d || host.endsWith('.' + d));
    if (mapped && normalized(mapped[1]) !== normalized(assessment.origin_group))
      throw new Halt('Source origin mapping conflict');
  }
  for (const claim of packet.claims) {
    if (!['verified', 'attributed', 'unverified', 'disputed'].includes(claim.status) ||
        !claim.text?.trim() || !claim.evidence?.length) throw new Halt('Invalid claim');
    const groups = new Set();
    for (const e of claim.evidence) {
      const source = sources.find(s => s.id === e.source_id), excerpt = normalized(e.excerpt || '');
      if (!source || excerpt.length < 20 || excerpt.split(' ').length > 25 ||
          !normalized(source.text).includes(excerpt)) throw new Halt('Evidence quote not in retrieved source');
      groups.add(normalized(assessments.get(e.source_id).origin_group || ''));
    }
    if (groups.has('') || groups.size !== new Set(claim.origin_groups?.map(normalized)).size ||
        [...groups].some(g => !claim.origin_groups.map(normalized).includes(g)))
      throw new Halt('Inconsistent evidence origins');
    if (claim.status === 'verified' && groups.size < 2) throw new Halt('Independent corroboration missing');
    if (claim.status !== 'verified' && !claim.attribution?.trim()) throw new Halt('Attribution missing');
  }
}
