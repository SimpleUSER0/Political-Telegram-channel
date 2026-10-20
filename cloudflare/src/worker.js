import {Halt, articleText, config, equalSecret, id, json, missing, now, readText, nonScheduledCallLimit,
  validateArticle, validatePacket,outputText,retrievedUrls} from './core.js';
import {ensureSchema} from './schema.js';
import {Store} from './store.js';
import {checkSources, editDraft, fetchSource, generate, llm, sourceButtons} from './research.js';
import {discoverFeeds} from './feeds.js';
import {breakingCandidates,editionAtHour,localClock,REGULAR_QUERY} from './news-plan.js';
import {parseMemberUpdate,saveMemberEvent,saveMemberCount,memberStatistics,memberAlert,memberReport} from './members.js';
import {requireGeorgianQuality} from './georgian-quality.js';
import {lookupRequestedArticles} from './topic-search.js';
import {probeGemini} from './gemini.js';

export class TelegramFailure extends Error {
  constructor(message, definitive=false) { super(message); this.definitive=definitive; }
}
export async function telegram(c,method,data) {
  let response,raw;
  try {
    response=await fetch('https://api.telegram.org/bot'+c.env.TELEGRAM_BOT_TOKEN+'/'+method,{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),
      signal:AbortSignal.timeout(18000),
    });
    raw=await readText(response,100000);
  } catch { throw new TelegramFailure('Telegram response unknown'); }
  let packet;
  try { packet=JSON.parse(raw); } catch { throw new TelegramFailure('Telegram response unknown'); }
  if (!response.ok || packet.ok!==true) {
    // Only explicit Telegram 4xx rejections are known not to have published anything.
    // Server errors, gateways, timeouts and malformed packets remain unknown.
    const definitive=packet.ok===false && Number.isInteger(packet.error_code) &&
      packet.error_code>=400 && packet.error_code<500;
    throw new TelegramFailure('Telegram rejected request (HTTP '+response.status+')',definitive);
  }
  return packet.result;
}
export async function verifyIdentity(c) {
  const bot=await telegram(c,'getMe',{});
  const username=String(bot?.username || '').toLowerCase();
  if (!bot?.is_bot || !/^[a-z0-9_]+bot$/.test(username)) throw new Halt('Invalid Telegram bot identity');
  if (username==='digitalera_global_bot') throw new Halt('Existing technology bot @digitalera_global_bot cannot be used');
  if (username!==c.username)
    throw new Halt('Bot identity mismatch; token belongs to @'+username);
  return bot;
}
export async function verifyChannel(c) {
  const chat=await telegram(c,'getChat',{chat_id:c.channel});
  if (chat?.type!=='channel' || ['cifruli_era','digitalera101'].includes(String(chat.username).toLowerCase()))
    throw new Halt('A separate political channel is required');
  return chat;
}
export async function checkPublishing(c) {
  const bot=await verifyIdentity(c),channel=await verifyChannel(c);
  if(!Number.isSafeInteger(bot.id))throw new Halt('Invalid Telegram bot id');
  const member=await telegram(c,'getChatMember',{chat_id:c.channel,user_id:bot.id});
  return {available:member?.status==='creator' ||
    (member?.status==='administrator' && member.can_post_messages===true),
    bot:bot.username,channel:channel.username || String(channel.id),role:member?.status || 'unknown',
    can_post_messages:member?.can_post_messages===true,at:now()};
}
export async function registerWebhook(c) {
  if (missing(c).length) throw new Halt('Incomplete bot configuration');
  const publicUrl=new URL(c.env.PUBLIC_BASE_URL || '');
  if (publicUrl.protocol!=='https:' || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash ||
      !['','/'].includes(publicUrl.pathname)) throw new Halt('PUBLIC_BASE_URL must be a canonical HTTPS origin');
  const bot=await verifyIdentity(c), channel=await verifyChannel(c);
  const url=publicUrl.origin+'/telegram/webhook';
  await telegram(c,'setWebhook',{url,secret_token:c.env.WEBHOOK_SECRET,
    allowed_updates:['message','callback_query','chat_member'],drop_pending_updates:false});
  const info=await telegram(c,'getWebhookInfo',{});
  if (info?.url!==url || !info.allowed_updates?.includes('chat_member'))
    throw new Halt('Telegram webhook membership updates were not registered');
  return {registered:true,verified:true,subscriber_events:true,bot:bot.username,channel:channel.username || String(channel.id),at:now()};
}
async function liveChannelMembers(c,store) {
  try {
    const count=await telegram(c,'getChatMemberCount',{chat_id:c.channel});
    if(!Number.isInteger(count) || count<0)return null;
    await saveMemberCount(store,count);
    return count;
  }catch{return null;}
}
async function tell(c,text,reply_markup) {
  return telegram(c,'sendMessage',{chat_id:c.ownerChat,text:text.slice(0,4000),
    link_preview_options:{is_disabled:true},...(reply_markup?{reply_markup}:{})});
}
export async function notify(c,draft,store) {
  if (!draft) throw new Halt('Draft not found');
  const payload=JSON.parse(draft.payload), buttons=sourceButtons(payload);
  if (draft.state==='pending' && draft.expires_at>now()) buttons.unshift([
    {text:'Publish',callback_data:`pub:${draft.id}:${draft.version}`},
    {text:'Edit',callback_data:`edit:${draft.id}:${draft.version}`},
    {text:'Cancel',callback_data:`cancel:${draft.id}:${draft.version}`},
  ]);
  const claims=payload.verification.claims;
  const uncertainty=claims.some(x=>x.status!=='verified')?'\n⚠️ ტექსტი შეიცავს ატრიბუციას ან გაურკვევლობას.':'';
  if(payload.media) {
    const caption=articleText(payload.article);
    if(caption.length>1024)throw new Halt('ფოტოს ტექსტი მაქსიმუმ 1024 სიმბოლო უნდა იყოს.');
    const cached=store?await store.stmt('SELECT file_id FROM cf_media WHERE draft_id=?',draft.id).first():null;
    const sent=await telegram(c,'sendPhoto',{chat_id:c.ownerChat,photo:cached?.file_id || payload.media.url,
      caption,reply_markup:{inline_keyboard:buttons}});
    const fileId=sent?.photo?.at(-1)?.file_id;
    if(store && fileId)await store.stmt('INSERT OR IGNORE INTO cf_media(draft_id,file_id) VALUES (?,?)',draft.id,fileId).run();
    if(store && draft.state==='pending' && sent?.message_id)
      await store.audit('owner_draft_delivered',draft,c.ownerChat,String(sent.message_id));
    return sent;
  }
  const sent=await tell(c,`მონახაზი ${draft.id}:${draft.version} · ${draft.state}${uncertainty}\n\n${articleText(payload.article)}`,
    {inline_keyboard:buttons});
  if(store && draft.state==='pending' && sent?.message_id)
    await store.audit('owner_draft_delivered',draft,c.ownerChat,String(sent.message_id));
  return sent;
}

const EDIT_PRESETS=[
  {id:'shorter',label:'შეამოკლე'},
  {id:'longer',label:'გააფართოვე'},
  {id:'clearer',label:'უფრო გასაგებად'},
  {id:'proofread',label:'ქართული ენა'},
];
function editMenu(draftId,version) {
  return {inline_keyboard:[
    EDIT_PRESETS.slice(0,2).map(option=>({text:option.label,callback_data:`editopt:${draftId}:${version}:${option.id}`})),
    EDIT_PRESETS.slice(2).map(option=>({text:option.label,callback_data:`editopt:${draftId}:${version}:${option.id}`})),
  ]};
}

export async function publish(c,store,draftId,version) {
  if (!c.publish) throw new Halt('გამოქვეყნება გამორთულია: PUBLISH_ENABLED=false');
  if (missing(c,true).length) throw new Halt('კონფიგურაცია არასრულია');
  // Permission checks happen BEFORE claiming. The owner can fix Telegram rights
  // and press Publish again on the same pending draft without losing the version.
  if(!(await checkPublishing(c)).available)
    throw new Halt('ბოტს არხში Post Messages უფლება აკლია. ჩართე არხის ადმინისტრატორების პარამეტრებში და კვლავ დააჭირე Publish-ს.');
  const existing=await store.draft(draftId);
  if (!existing) throw new Halt('Draft not found');
  const payload=JSON.parse(existing.payload);
  validatePacket(payload.verification,payload.sources,c);
  validateArticle(payload.article,payload.verification,payload.sources);
  // Enforce quality for old pending drafts, manual edits and new generations alike.
  // Quality failures must never claim the draft or send anything to the channel.
  requireGeorgianQuality(payload.article);
  if (!payload.fact_check?.passed || payload.fact_check.unsupported_claims?.length ||
      payload.fact_check.missing_attributions?.length) throw new Halt('Draft has no valid fact check');
  let photo=null;
  if(payload.media) {
    if(articleText(payload.article).length>1024)throw new Halt('ფოტოს ტექსტი მაქსიმუმ 1024 სიმბოლო უნდა იყოს.');
    // Publish exactly the image previewed to the owner, not a mutable publisher URL.
    photo=(await store.stmt('SELECT file_id FROM cf_media WHERE draft_id=?',draftId).first())?.file_id;
    if(!photo)throw new Halt('ჯერ გახსენი /show '+draftId+' — ფოტოს გადახედვა საჭიროა.');
  }
  // Atomic compare-and-set on exact version and state. All competing Publish/Edit/Cancel
  // requests lose this race; timeout recovery NEVER returns publishing to pending.
  const draft=await store.claimDraft(draftId,version,'publishing',c.owner);
  if (!draft) throw new Halt('ეს ვერსია შეიცვალა, გაუქმდა, ვადაგასულია ან უკვე მუშავდება');
  try {
    await store.audit('approve',draft,c.owner);
  } catch (error) {
    // No external publication was attempted. A failed durable approval blocks publication.
    await store.stmt("UPDATE cf_drafts SET state='pending',updated_at=? WHERE id=? AND state='publishing' AND version=?",
      now(),draft.id,draft.version).run();
    throw error;
  }
  let result;
  try {
    result=await telegram(c,photo?'sendPhoto':'sendMessage',{chat_id:c.channel,
      ...(photo?{photo,caption:articleText(payload.article)}:{text:articleText(payload.article),link_preview_options:{is_disabled:true}}),
      reply_markup:{inline_keyboard:sourceButtons(payload)}});
    if (!Number.isInteger(result?.message_id)) throw new TelegramFailure('Telegram result missing message id');
  } catch (error) {
    const state=error instanceof TelegramFailure && error.definitive?'failed':'unknown';
    await store.stmt('UPDATE cf_drafts SET state=?,error=?,updated_at=? WHERE id=? AND state=\'publishing\'',
      state,state==='unknown'?'Telegram result unknown; inspect channel before reconciliation':'Telegram explicitly rejected publication',now(),draft.id).run();
    throw new Halt(state==='unknown'?'გაგზავნის შედეგი გაურკვეველია. შეამოწმე არხი; ბოტი ავტომატურად აღარ გაგზავნის.':'Telegram-მა პოსტი უარყო. შეამოწმე ბოტის არხის უფლებები.');
  }
  // A DB failure here leaves publishing, later -> unknown. NEVER call Telegram again.
  await store.stmt("UPDATE cf_drafts SET state='published',message_id=?,updated_at=? WHERE id=? AND state='publishing' AND version=?",
    result.message_id,now(),draft.id,draft.version).run();
  await store.audit('published',draft,c.owner,String(result.message_id));
  return result.message_id;
}

export function authorizedUpdate(update,c) {
  if (!Number.isSafeInteger(update?.update_id) || update.update_id<0) return null;
  const membership=parseMemberUpdate(update,c);
  if(membership)return {membership};
  const callback=update.callback_query;
  if (callback) {
    if (String(callback.from?.id)!==c.owner || String(callback.message?.chat?.id)!==c.ownerChat ||
        callback.message?.chat?.type!=='private' || typeof callback.data!=='string' || callback.data.length>64)
      return null;
    return {callback:{id:callback.id,data:callback.data}};
  }
  const message=update.message;
  if (!message || String(message.from?.id)!==c.owner || String(message.chat?.id)!==c.ownerChat ||
      message.chat?.type!=='private' || typeof message.text!=='string' || message.text.length>6000) return null;
  return {message:{text:message.text}};
}

/**
 * Authenticated private owner messages can request one reviewed, source-backed draft.
 * Slash commands unknown to the bot do not create an unexpected AI bill.
 */
export function isConversation(text) {
  const s=String(text||'').trim();
  if(!s || s.startsWith('/'))return false;
  // Content-creation requests take precedence even when phrased as questions or
  // written with a Georgian typo/inflection (e.g. "შექმენი პოსტო ...?").
  // Otherwise the question-mark shortcut sends them to chat, where Gemini asks
  // the owner to supply sources instead of running the newsroom search.
  if(/(?:პოსტ\p{L}{0,6}|სტატი\p{L}{0,8}|დაპოსტ\p{L}{0,7}|გამოსაქვეყნ\p{L}{0,10}|მოამზადე|მომიმზადე|დამიწერე|დაწერე|შექმენი|შექმნე|დამიგენერირე)/iu.test(s))return false;
  return /[?？]$/.test(s) || /^(?:რა |რას |როდის |სად |როგორ |რატომ |ვინ |ვის |რომელი |რამდენი |შეიძლება |შეგიძლია |მითხარი |ამიხსენი |გამარჯობა|ჰეი\b)/iu.test(s);
}
async function conversation(c,store,question) {
  if(question.length<2 || question.length>1800)
    throw new Halt('საუბრის ტექსტი უნდა იყოს 2–1800 სიმბოლო.');
  if(!c.research || missing(c,true).length)
    throw new Halt('Gemini საუბრისთვის მიუწვდომელია.');
  // Conversation-only history; nothing is published, not inserted into article drafts.
  const key='owner_chat_history';
  const previous=await store.stmt('SELECT value FROM cf_meta WHERE key=?',key).first();
  let history=[];
  try {
    const parsed=JSON.parse(previous?.value || '[]');
    if(Array.isArray(parsed))history=parsed.filter(x=>['user','assistant'].includes(x.role)&&
      typeof x.content==='string').slice(-6);
  }catch{}
  const answer=await llm({...c,manualTopic:true,callLimit:nonScheduledCallLimit(c)},store,
    'You are a helpful conversational assistant speaking natural Georgian. Reply to the owner\'s actual question, on ANY lawful subject. Do NOT compose or publish a Telegram news post. Use conversational Georgian and acknowledge uncertainty about current facts; never invent sources or breaking news. Be concise.',
    {history,question,now:new Date().toISOString()});
  const reply=outputText(answer).trim();
  if(!reply)throw new Halt('Gemini-მ საუბრის პასუხი ვერ დააბრუნა.');
  history=[...history,{role:'user',content:question},{role:'assistant',content:reply}].slice(-6);
  await store.stmt('INSERT INTO cf_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    key,JSON.stringify(history)).run();
  return tell(c,reply.slice(0,3500));
}

export function manualPostRequest(text) {
  const raw=String(text || '').trim();
  if(!raw)return null;
  const [first,...remaining]=raw.split('\n');
  const firstToken=first.trim().split(/\s+/)[0];
  const command=firstToken.split('@')[0].toLowerCase();
  const explicit=command==='/post'||command==='/draft';
  if(raw.startsWith('/') && !explicit)return null;
  let query=explicit?
    [first.trim().slice(firstToken.length).trim(),...remaining].join('\n').trim():
    raw;
  if(explicit && !query)query=REGULAR_QUERY;
  if(query.length<2 || query.length>1000)
    return {error:'პოსტის თემა უნდა იყოს 2–1000 სიმბოლო.'};
  const format=/(?:მოკლე|მოკლედ|კონსპექტურად|brief|short)/iu.test(query)?'QUICK':
    /(?:ვრცლად|დეტალურად|დეტალური|ღრმად|in.depth|detailed)/iu.test(query)?'DEEP':
    /(?:სასწრაფო|მყისიერი|breaking|flash)/iu.test(query)?'FLASH':'STANDARD';
  return {query,format,edition:'night'};
}

async function handleControl(c,store,payload,job) {
  if (payload.membership) {
    const event=payload.membership;
    if(!await saveMemberEvent(store,event))return;
    const count=await liveChannelMembers(c,store);
    return tell(c,memberAlert(event,count));
  }
  if (payload.callback) {
    const {id:callbackId,data}=payload.callback;
    // Acknowledgement is best effort and never controls whether publication succeeds.
    try { await telegram(c,'answerCallbackQuery',{callback_query_id:callbackId}); } catch {}
    const match=/^(pub|edit|cancel):([a-f0-9]{20}):([1-9]\d{0,5})$/.exec(data);
    const optionMatch=/^editopt:([a-f0-9]{20}):([1-9]\d{0,5}):(shorter|longer|clearer|proofread)$/.exec(data);
    if(!match && !optionMatch)throw new Halt('Unknown callback');
    if(optionMatch){
      const [,draftId,rawVersion,mode]=optionMatch,version=Number(rawVersion);
      const pending=await store.draft(draftId);
      if(!pending || pending.version!==version || pending.state!=='pending' || pending.expires_at<=now())
        throw new Halt('ეს ვერსია უკვე შეიცვალა ან ვადაგასულია');
      const queued=await store.enqueueEdit(draftId,version,mode,`edit-option-${job.id}`);
      if(!queued)return tell(c,'ამ მონახაზის ეს ვერსია უკვე რიგშია. დაელოდე დასრულებულ ვერსიას.');
      return tell(c,'არჩეული ცვლილება რიგშია. დაგეგმილი პოსტის მოცულობა შეთანხმებულ დიაპაზონში დარჩება. დასრულებული ვერსია ხელახლა გამოჩნდება დასადასტურებლად.');
    }
    const [,action,draftId,rawVersion]=match, version=Number(rawVersion);
    if (action==='pub') {
      await publish(c,store,draftId,version);
      return tell(c,'გამოქვეყნდა.');
    }
    if (action==='edit') return tell(c,`აირჩიე სასურველი ცვლილება. ფაქტები და წყაროები უცვლელი დარჩება; დაგეგმილი პოსტის მოცულობა შეთანხმებულ დიაპაზონში დარჩება.\n\nთავისუფალი ჩასწორება: /edit ${draftId}:${version} და შემდეგ ახალი სათაური და ტექსტი.`,editMenu(draftId,version));
    const draft=await store.claimDraft(draftId,version,'cancelled',c.owner);
    if (!draft) throw new Halt('ეს ვერსია უკვე შეიცვალა ან დამუშავდა');
    await store.audit('cancel',draft,c.owner);
    return tell(c,'მონახაზი გაუქმდა.');
  }
  const text=payload.message?.text || '', [first,...lines]=text.split('\n');
  const [rawCommand,...args]=first.trim().split(/\s+/), command=rawCommand.split('@')[0];
  if (command==='/start' || command==='/help') return tell(c,
    'მსოფლიო ფოკუსი — პოლიტიკური რედაქცია\n/news თემა — დამატებითი კვლევა\n/post თემა — პოსტი ხელით\n/ask კითხვა — ჩვეულებრივი საუბარი Gemini-სთან\nმომწერე თემა — პოსტი; დასვი კითხვა — საუბარი\n/breaking თემა — დღის განსაკუთრებული ამბავი (მაქს. 1)\n/stats — გამომწერები და ზრდა\n/pending — მონახაზები\n/show ID — მონახაზი\n/status — სტატუსი\n/edit ID:VERSION — სათაური, ცარიელი ხაზი, ტექსტი\n\nდაგეგმილი მონახაზები: 09:00 / 13:00 / 18:00 / 21:00 (საქართველო). გამოქვეყნება მხოლოდ შენი Publish-ით.');
  if (command==='/status') return tell(c,JSON.stringify({provider:c.provider,model:c.model,research:c.research,publish:c.publish,schedule_hours_tbilisi:c.hours,
    missing:missing(c,true),...await store.status()},null,2));
  if (command==='/stats' || command==='/subscribers') {
    const count=await liveChannelMembers(c,store);
    const stats=await memberStatistics(store);
    return tell(c,memberReport(stats,count));
  }
  if (command==='/pending') {
    const drafts=await store.pending();
    return tell(c,drafts.length?drafts.map(d=>`${d.id}:${d.version} · ${d.state}\n${d.topic}`).join('\n\n'):'მოლოდინში მონახაზი არ არის.');
  }
  if (command==='/show') return notify(c,await store.draft(args[0]),store);
  if (command==='/news') {
    const query=args.join(' ');
    if (!c.research || missing(c,true).length) throw new Halt('კვლევა ჯერ გამორთულია ან კონფიგურაცია აკლია. /status');
    if (query.length<3 || query.length>1000) throw new Halt('გამოიყენე /news და მიუთითე თემა (3–1000 სიმბოლო)');
    // Deterministic id: re-running a control job cannot enqueue another paid research run.
    await store.enqueue('research',{query,format:'STANDARD',manual:true},'research-'+job.id);
    return tell(c,'კვლევა რიგშია. მომზადებული მონახაზი აქ მოვა.');
  }
  if (command==='/breaking') {
    const query=args.join(' ');
    if(!c.research || missing(c,true).length)throw new Halt('განსაკუთრებული კვლევა გამორთულია');
    if(query.length<3 || query.length>1000)throw new Halt('გამოიყენე /breaking და მიუთითე თემა');
    const day=localClock(now()).day;
    const slot=await store.stmt('INSERT OR IGNORE INTO cf_slots(slot,created_at) VALUES (?,?)',
      'breaking-day-'+day,now()).run();
    if(!slot.meta?.changes)return tell(c,'დღევანდელი დამატებითი Breaking News უკვე გამოყენებულია. ჩვეულებრივი /news კვლავ მუშაობს.');
    await store.enqueue('research',{query,format:'QUICK',edition:'breaking',manual:true},'breaking-'+day+'-manual');
    return tell(c,'Breaking News-ის მონახაზი რიგშია. გამოქვეყნება შენს დადასტურებას მოითხოვს.');
  }
  if(command==='/ask' || command==='/chat'){
    const query=[args.join(' '),...lines].filter(Boolean).join('\n').trim();
    if(!query)return tell(c,'მომწერე /ask და შეკითხვა ნებისმიერი თემის შესახებ.');
    return conversation(c,store,query);
  }
  if(isConversation(text))return conversation(c,store,text);
  if (command==='/edit') {
    const match=/^([a-f0-9]{20}):([1-9]\d{0,5})$/.exec(args[0] || '');
    const title=lines.shift()?.trim(), body=lines.join('\n').trim();
    if (!match || !title || !body || title.length>250 || body.length>3500)
      throw new Halt('ფორმატი: /edit ID:VERSION\nსათაური\n\nტექსტი');
    if (!c.research || missing(c,true).length) throw new Halt('რედაქტირებას ჩართული ფაქტების გადამოწმება სჭირდება');
    await store.enqueue('edit',{draftId:match[1],version:Number(match[2]),title,body},'edit-'+job.id);
    return tell(c,'რედაქტირება რიგშია; ტექსტი ხელახლა გადამოწმდება.');
  }
  const manual=manualPostRequest(text);
  if(manual) {
    if(manual.error)throw new Halt(manual.error);
    if(!c.research || missing(c,true).length)
      throw new Halt('პოსტის მომზადება გამორთულია ან კონფიგურაცია აკლია. /status');
    // Stable job ID per authorized Telegram update; the regular 4 slots and
    // optional extraordinary breaking slot remain independent.
    await store.enqueue('research',{...manual,manual:true},'manual-'+job.id);
    return tell(c,'✅ ხელით მოთხოვნილი პოსტი რიგშია. წყაროსა და ფოტოს მოძიების შემდეგ მონახაზი მოვა Publish / Edit / Cancel ღილაკებით. ავტომატურად არ გამოქვეყნდება.');
  }
  return tell(c,'გამოიყენე /help ბრძანებების სანახავად.');
}

export async function drain(c,store,kind,limit=1) {
  for (let i=0;i<limit;i++) {
    const job=await store.claim(kind);
    if (!job) break;
    let draft;
    try {
      const payload=JSON.parse(job.payload);
      if (kind==='control') await handleControl(c,store,payload,job);
      else if (kind==='setup') {
        // Only authenticated infrastructure administration can insert this job kind.
        // Public webhook payloads are normalized into control jobs and cannot request setup.
        if(payload.action==='preview_style') {
          // Private visual preview of an existing article; never a publication or new research.
          const existing=await store.draft(payload.draftId);
          if(!existing)throw new Halt('Draft not found');
          const preview=JSON.parse(existing.payload);
          for(const source of preview.sources) {
            try {
              const fetched=await fetchSource(source.url,c);
              if(fetched.image){preview.media=fetched.image;preview.primary_source_id=source.id;break;}
            }catch{}
          }
          if(!preview.media)throw new Halt('No publisher image available for preview');
          const sent=await notify(c,{...existing,state:'preview',payload:JSON.stringify(preview)});
          await store.stmt("INSERT INTO cf_meta(key,value) VALUES ('style_diagnostic',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            JSON.stringify({at:now(),owner_message_id:sent.message_id,photo:Boolean(sent.photo?.length),source_buttons:1})).run();
          await store.finish(job);continue;
        }
        if(payload.action==='diagnose_topic_sources') {
          const query=String(payload.query||'Japan politics').slice(0,100);
          const targets=[
            ['gdelt','https://api.gdeltproject.org/api/v2/doc/doc?query='+encodeURIComponent(query)+'&mode=artlist&format=json&maxrecords=5&timespan=2d'],
            ['guardian','https://content.guardianapis.com/search?api-key=test&q='+encodeURIComponent(query)+'&page-size=3'],
            ['bing','https://www.bing.com/news/search?q='+encodeURIComponent(query)+'&format=rss'],
            ['google-news','https://news.google.com/rss/search?q='+encodeURIComponent(query)+'&hl=en-US&gl=US&ceid=US:en']
          ];
          const results=await Promise.all(targets.map(async ([name,url])=>{
            try{
              const res=await fetch(url,{redirect:'follow',signal:AbortSignal.timeout(7500)});
              const body=(await res.text()).slice(0,35000);
              return {name,http:res.status,content_type:res.headers.get('content-type'),
                length:body.length,valid_rss:/<rss[\s>]/i.test(body),
                rss_items:(body.match(/<item(?:\s|>)/gi)||[]).length,
                has_articles:/"articles"\s*:/i.test(body),has_results:/"results"\s*:/i.test(body),
                sample_items:name==='bing'?[...body.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].slice(0,5).map(it=>{
                  const raw=it[1],match=tag=>new RegExp('<'+tag+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/'+tag+'>','i').exec(raw)?.[1]||'';
                  return {title:match('title').slice(0,180),link:match('link').slice(0,700),
                    date:match('pubDate').slice(0,100)};
                }):undefined,
                start:body.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').slice(0,160)};
            }catch(e){return {name,error:String(e?.message||e).slice(0,120)};}
          }));
          await store.stmt("INSERT INTO cf_meta(key,value) VALUES ('topic_sources_diagnostic',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            JSON.stringify({at:now(),query,results})).run();
          await store.finish(job);continue;
        }
        if(payload.action==='probe_any_topic_search') {
          const query=String(payload.query||'').trim();
          if(query.length<3 || query.length>120)throw new Halt('Invalid test topic');
          // No Gemini request or research run is consumed by this connectivity test.
          const result=await lookupRequestedArticles({...c,age:Math.max(c.age,7*86400000)},query);
          const urls=result.articles.slice(0,12).map(a=>a.url);
          await store.stmt("INSERT INTO cf_meta(key,value) VALUES ('generic_search_diagnostic',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            JSON.stringify({at:now(),query,provider:result.provider,urls,count:result.articles.length,success:urls.length>0})).run();
          await store.finish(job);continue;
        }
        if(payload.action==='check_gemini_lite') {
          if(!c.env.GEMINI_API_KEY)throw new Halt('Existing Gemini API key missing');
          const result=await probeGemini(c,false,'gemini-3.5-flash-lite');
          await store.stmt("INSERT INTO cf_meta(key,value) VALUES ('gemini_lite_diagnostic',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            JSON.stringify({at:now(),model:'gemini-3.5-flash-lite',...result})).run();
          await store.finish(job);continue;
        }
        if(payload.action==='check_gemini') {
          if(!c.env.GEMINI_API_KEY)throw new Halt('Existing Gemini API key missing');
          const direct=await probeGemini(c,false);
          const gateway=await probeGemini(c,true);
          const diagnosis={at:now(),model:'gemini-3.8-flash',direct,gateway};
          await store.stmt("INSERT INTO cf_meta(key,value) VALUES ('gemini_diagnostic',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            JSON.stringify(diagnosis)).run();
          await store.finish(job);continue;
        }
        if(payload.action==='check_members') {
          const count=await liveChannelMembers(c,store);
          if(count===null)throw new Halt('Telegram member count unavailable; check channel admin permissions');
          await store.stmt("INSERT INTO cf_meta(key,value) VALUES ('members_diagnostic',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            JSON.stringify({at:now(),count,available:true})).run();
          await store.finish(job);continue;
        }
        if(payload.action==='check_publishing') {
          const result=await checkPublishing(c);
          await store.stmt("INSERT INTO cf_meta(key,value) VALUES ('publishing_diagnostic',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            JSON.stringify(result)).run();
          await store.finish(job);
          continue;
        }
        if(payload.action==='check_sources') {
          const result=await checkSources(c);
          await store.stmt("INSERT INTO cf_meta(key,value) VALUES ('source_diagnostic',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            JSON.stringify(result)).run();
          await store.finish(job);
          continue;
        }
        if (payload.action==='check_ai') {
          const result=await llm(c,store,'Return available=true to confirm structured API access.',{},
            {type:'object',properties:{available:{type:'boolean'}},required:['available'],additionalProperties:false});
          if(!result.available)throw new Halt('AI diagnostic did not pass');
          await store.stmt("INSERT INTO cf_meta(key,value) VALUES ('ai_diagnostic',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            JSON.stringify({available:true,provider:c.provider,model:c.model,at:now()})).run();
          await store.finish(job);
          continue;
        }
        if (payload.action!=='register_webhook') throw new Halt('Unknown setup action');
        await store.audit('webhook_setup_requested',null,'cloudflare-admin',job.id);
        let result;
        try { result=await registerWebhook(c); }
        catch (error) {
          if (error instanceof TelegramFailure) throw new Halt(error.message);
          throw error;
        }
        await store.stmt("INSERT INTO cf_meta(key,value) VALUES ('webhook_registration',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          JSON.stringify(result)).run();
        await store.audit('webhook_setup_verified',null,'cloudflare-admin',job.id);
      }
      else if (kind==='research') {
        const created=await generate(c,store,payload.query,payload.format,payload.edition||'night',payload.preferredUrl||null,Boolean(payload.manual),job.id.startsWith('schedule-'));
        // A notification error must not delete a completed draft or repeat paid research.
        try { await notify(c,created,store); }
        catch {
          // A generated draft is never lost just because Telegram temporarily
          // rejects a photo/file: retry OWNER PREVIEW ONLY, never publication.
          await store.enqueue('delivery',{draftId:created.id,version:created.version},
            'delivery-'+created.id+'-'+created.version);
          try {await tell(c,'⚠️ მონახაზი მომზადდა, მაგრამ ფოტოს/შეტყობინების გაგზავნა შეფერხდა. სისტემა ავტომატურად გაიმეორებს მცდელობას. ID: '+created.id+' — /show '+created.id);}
          catch {}
          console.warn('Draft delivery pending retry');
        }
      } else if (kind==='delivery') {
        const saved=await store.draft(payload.draftId);
        if(!saved || saved.version!==payload.version || saved.state!=='pending' || saved.expires_at<=now()) {
          await store.finish(job);continue;
        }
        await notify(c,saved,store);
      } else if (kind==='edit') {
        draft=await store.claimDraft(payload.draftId,payload.version,'editing',c.owner);
        if (!draft) throw new Halt('მონახაზის ვერსია შეიცვალა ან ვადაგასულია');
        const edited=payload.mode
          ? await editDraft(c,store,draft,null,null,payload.mode)
          : await editDraft(c,store,draft,payload.title,payload.body);
        try { await notify(c,edited,store); }
        catch {
          await store.enqueue('delivery',{draftId:edited.id,version:edited.version},
            'delivery-'+edited.id+'-'+edited.version);
          console.warn('Edited draft delivery pending retry');
        }
      }
      await store.finish(job);
    } catch (error) {
      if (draft) await store.restoreEdit(draft);
      // Persist only controlled errors; network exception strings can contain credential URLs.
      const reason=error instanceof Halt?error.message.slice(0,250):'Internal failure; inspect Worker logs';
      await store.finish(job,reason);
      // Setup may fail because the credential belongs to a different bot. Never send
      // even a private failure notification through an unverified setup identity.
      if (kind!=='setup') { try { await tell(c,'დავალება შეჩერდა: '+reason); } catch {} }
      console.warn('Newsroom job stopped',kind,error instanceof Halt?'validation':'runtime');
    }
  }
}

export async function schedule(c,store,time) {
  if (!c.research || !c.schedule || !c.hours.length || missing(c,true).length) return;
  // Catch an hour boundary or a delayed cron: every missed scheduled slot
  // from the last 90 minutes is recovered once. The DB slot/job IDs are stable.
  for(const candidateTime of [time-3600000,time]) {
    const clock=localClock(candidateTime);
    if(!c.hours.includes(clock.hour))continue;
    const start=Date.parse(clock.slot+':00:00+04:00');
    if(!Number.isFinite(start) || time<start || time-start>90*60000)continue;
    const slot=clock.slot,edition=editionAtHour(clock.hour)||'night';
    await store.db.batch([
      store.stmt('INSERT OR IGNORE INTO cf_slots(slot,created_at) VALUES (?,?)',slot,now()),
      store.stmt("INSERT OR IGNORE INTO cf_jobs(id,kind,payload,created_at) VALUES (?,'research',?,?)",
        'schedule-'+slot,JSON.stringify({query:REGULAR_QUERY,format:'STANDARD',edition}),now()),
    ]);
  }
}



/**
 * Restore an unattended edition after temporary Gemini outages or one
 * incomplete model response. HTTP outages get bounded retries; malformed,
 * safety-blocked and quota-denied results are never retried.
 * Stable IDs make 1-minute overlapping Cloudflare cron executions harmless.
 */
export async function retryScheduledFailures(c,store,time) {
  if (!c.research || !c.schedule || missing(c,true).length) return;
  const clock=localClock(time);
  const prefix='schedule-'+clock.day+'T';
  const failures=(await store.stmt(
    "SELECT id,payload,error,finished_at FROM cf_jobs WHERE kind='research' AND status='failed' AND id LIKE ? ORDER BY finished_at LIMIT 12",
    prefix+'%').all()).results||[];
  for(const job of failures) {
    const match=/^schedule-(\d{4}-\d{2}-\d{2}T\d{2})(?:-retry-(\d))?$/.exec(job.id);
    if(!match)continue;
    const previous=Number(match[2]||0);
    const httpOutage=/Gemini request failed \(HTTP (?:502|503|504)\)/.test(job.error||'');
    const incomplete=/^Gemini (?:output limit reached \(8000 tokens\)|response incomplete \((?:OTHER|UNKNOWN|UNSPECIFIED)\))$/.test(job.error||'');
    // A scheduled post can exhaust its two evidence-preserving length edits
    // even when the story itself is sound. Give the slot one whole-run retry
    // so it can select another candidate or get a fresh bounded resize. This
    // is deliberately separate from the per-draft correction budget and is
    // capped at one to protect the daily Gemini call limit.
    const lengthMiss=/Scheduled draft length outside \d+-\d+ words/.test(job.error||'');
    if((!httpOutage && !incomplete && !lengthMiss) ||
       previous>=(lengthMiss?1:incomplete?1:4))continue;
    const original=new Date(match[1]+':00:00+04:00').getTime();
    const backoff=lengthMiss?180000:[90000,180000,300000,900000][previous];
    if(!Number.isFinite(original)||time-original>12*3600000 ||
       time-original<90000 || time-Number(job.finished_at)<backoff)continue;
    const retryId='schedule-'+match[1]+'-retry-'+(previous+1);
    await store.enqueue('research',JSON.parse(job.payload),retryId);
  }
}

/**
 * Repair an owner notification lost after the draft was saved but before
 * notify()/enqueue('delivery') completed. A cached Telegram file_id or a
 * delivery audit proves the preview was already sent. Never publish to channel.
 */
export async function recoverUndeliveredDrafts(store,time) {
  const rows=(await store.stmt(
    `SELECT d.id,d.version FROM cf_drafts d
      LEFT JOIN cf_media m ON m.draft_id=d.id
      WHERE d.state='pending' AND d.created_at BETWEEN ? AND ?
        AND d.expires_at>?
        AND m.file_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM cf_audit a
          WHERE a.action='owner_draft_delivered' AND a.draft_id=d.id AND a.version=d.version)
        AND NOT EXISTS (SELECT 1 FROM cf_jobs j
          WHERE j.kind='delivery' AND j.id LIKE 'delivery-'||d.id||'-'||d.version||'%')
      ORDER BY d.created_at LIMIT 8`,
    time-3*3600000,time-2*60000,time).all()).results||[];
  for(const row of rows)
    await store.enqueue('delivery',{draftId:row.id,version:row.version},
      'delivery-'+row.id+'-'+row.version);
}

/**
 * Photo previews only: retry a transient owner Telegram delivery failure
 * up to twice. A duplicate owner preview is safer than losing an approval
 * message; channel publication is NEVER retried here.
 */
export async function retryFailedDeliveries(store,time) {
  const rows=(await store.stmt(
    "SELECT id,payload,finished_at FROM cf_jobs WHERE kind='delivery' AND status='failed' ORDER BY finished_at DESC LIMIT 20"
  ).all()).results||[];
  for(const job of rows) {
    const m=/^delivery-([a-f0-9]{20})-(\d+)(?:-retry-(\d))?$/.exec(job.id);
    if(!m || Number(m[3]||0)>=2 || time-Number(job.finished_at)<2*60000)continue;
    const saved=await store.draft(m[1]);
    if(!saved || saved.version!==Number(m[2]) || saved.state!=='pending' || saved.expires_at<=time)continue;
    await store.enqueue('delivery',JSON.parse(job.payload),
      'delivery-'+m[1]+'-'+m[2]+'-retry-'+(Number(m[3]||0)+1));
  }
}

/**
 * At most one exceptional fifth draft per Tbilisi day.
 * Check at hh:30 only; never spend AI calls during headline screening.
 * The candidate must come from a dated publisher RSS feed, be <=90 minutes
 * old, and match explicit extraordinary political-event patterns.
 */
export async function scheduleBreaking(c,store,time) {
  const clock=localClock(time);
  if(!c.research || !c.schedule || missing(c,true).length ||
     clock.hour<8 || clock.hour>22 || clock.minute!==30)return;
  const daily='breaking-day-'+clock.day;
  if(await store.stmt('SELECT slot FROM cf_slots WHERE slot=?',daily).first())return;
  const scan=await store.stmt('INSERT OR IGNORE INTO cf_slots(slot,created_at) VALUES (?,?)',
    'breaking-scan-'+clock.slot,now()).run();
  if(!scan.meta?.changes)return;
  let news;
  try {news=await discoverFeeds({...c,feeds:c.feeds.slice(0,3)},'');}
  catch{return;} // A temporarily unavailable publisher is not breaking news.
  const candidates=breakingCandidates(news.articles,await store.history(),time);
  if(!candidates.length)return;
  const claimed=await store.stmt('INSERT OR IGNORE INTO cf_slots(slot,created_at) VALUES (?,?)',
    daily,now()).run();
  if(!claimed.meta?.changes)return;
  await store.enqueue('research',{query:REGULAR_QUERY,format:'QUICK',
    edition:'breaking',preferredUrl:candidates[0].url},'breaking-'+clock.day+'-auto');
}

async function admin(request,url,c,store) {
  if (String(c.env.ADMIN_API_TOKEN || '').length<32 ||
      !await equalSecret(request.headers.get('Authorization'), 'Bearer '+c.env.ADMIN_API_TOKEN))
    return json({error:'Unauthorized'},401);
  if (request.method==='GET' && url.pathname==='/admin/status')
    return json({provider:c.provider,model:c.model,missing:missing(c,true),research:c.research,publish:c.publish,...await store.status()});
  if (request.method==='GET' && url.pathname==='/admin/stats') {
    const count=await liveChannelMembers(c,store);
    return json({subscriber_count:count,...await memberStatistics(store)});
  }
  if (request.method==='GET' && url.pathname==='/admin/drafts') return json(await store.pending());
  const detail=/^\/admin\/drafts\/([a-f0-9]{20})$/.exec(url.pathname);
  if (request.method==='GET' && detail) {
    const draft=await store.draft(detail[1]);
    return draft?json({...draft,payload:JSON.parse(draft.payload)}):json({error:'Draft not found'},404);
  }
  const jobDetail=/^\/admin\/jobs\/([a-zA-Z0-9_:.\-]+)$/.exec(url.pathname);
  if (request.method==='GET' && jobDetail) {
    const job=await store.stmt('SELECT id,kind,status,created_at,started_at,finished_at,error FROM cf_jobs WHERE id=?',jobDetail[1]).first();
    return job?json(job):json({error:'Job not found'},404);
  }
  if (request.method==='POST' && url.pathname==='/admin/register-webhook') {
    if (missing(c).length) return json({error:'Incomplete bot configuration',missing:missing(c)},503);
    return json(await registerWebhook(c));
  }
  if (request.method==='POST' && url.pathname==='/admin/generate') {
    if (!c.research || missing(c,true).length) return json({error:'Research disabled or not configured'},503);
    let body;
    try { body=JSON.parse(await readText(request,10000)); } catch { return json({error:'Invalid JSON'},400); }
    if (typeof body.query!=='string' || body.query.length<3 || body.query.length>1000 ||
        !['FLASH','QUICK','STANDARD','DEEP'].includes(body.post_format || 'STANDARD')) return json({error:'Invalid query or format'},400);
    const jobId=await store.enqueue('research',{query:body.query,format:body.post_format || 'STANDARD'});
    return json({job_id:jobId},202);
  }
  const reconciliation=/^\/admin\/drafts\/([a-f0-9]{20})\/reconcile$/.exec(url.pathname);
  if (request.method==='POST' && reconciliation) {
    let body;
    try { body=JSON.parse(await readText(request,10000)); } catch { return json({error:'Invalid JSON'},400); }
    if (!Number.isInteger(body.message_id) || body.message_id<=0 || body.confirmed_in_channel!==true)
      return json({error:'A positive message_id and confirmed_in_channel=true are required'},400);
    const draft=await store.stmt("UPDATE cf_drafts SET state='published',message_id=?,updated_at=? WHERE id=? AND state='unknown' RETURNING *",
      body.message_id,now(),reconciliation[1]).first();
    if (!draft) return json({error:'Only unknown publications can be reconciled'},409);
    await store.audit('reconcile',draft,c.owner,String(body.message_id));
    return json({reconciled:true});
  }
  return json({error:'Not found'},404);
}

export async function handleFetch(request,env,ctx) {
  const url=new URL(request.url);
  if (request.method==='GET' && url.pathname==='/health') {
    if (!env.DB) return json({ok:false,error:'D1 binding DB missing'},503);
    try { await ensureSchema(env.DB); return json({ok:true,runtime:'cloudflare-workers-d1'}); }
    catch { return json({ok:false,error:'D1 initialization failed'},503); }
  }
  if (!env.DB) return json({error:'D1 binding DB missing'},503);
  const c=config(env);
  // Authenticate BEFORE initializing or querying D1 for non-health routes.
  if (url.pathname==='/telegram/webhook') {
    if (request.method!=='POST') return json({error:'Method not allowed'},405);
    if (String(env.WEBHOOK_SECRET || '').length<32 ||
        !await equalSecret(request.headers.get('X-Telegram-Bot-Api-Secret-Token'),env.WEBHOOK_SECRET))
      return json({error:'Unauthorized'},401);
    if (missing(c).length) return json({error:'Bot configuration incomplete'},503);
    let update;
    try { update=JSON.parse(await readText(request,64000)); } catch { return json({error:'Invalid update'},400); }
    const accepted=authorizedUpdate(update,c);
    if (!accepted) return json({ok:true});
    await ensureSchema(env.DB);
    const store=new Store(env.DB);
    await store.acceptUpdate(update.update_id,accepted);
    // Respond promptly; durable control jobs are also drained by cron if this task is interrupted.
    ctx.waitUntil(drain(c,store,'control',1).catch(()=>console.warn('Control queue interrupted')));
    return json({ok:true});
  }
  if (request.method==='GET' && url.pathname==='/ready') {
    const issues=missing(c,true);
    await ensureSchema(env.DB);
    const heartbeat=await env.DB.prepare("SELECT value FROM cf_meta WHERE key='cron_heartbeat'").first();
    const cronReady=heartbeat && now()-Number(heartbeat.value)<5*60000;
    const ready=!issues.length && c.research && Boolean(cronReady);
    return json({ready,missing:issues,research:c.research,publish:c.publish,cron_ready:Boolean(cronReady)},ready?200:503);
  }
  if (url.pathname.startsWith('/admin/')) {
    if (String(env.ADMIN_API_TOKEN || '').length<32 ||
        !await equalSecret(request.headers.get('Authorization'),'Bearer '+env.ADMIN_API_TOKEN))
      return json({error:'Unauthorized'},401);
    await ensureSchema(env.DB);
    return admin(request,url,c,new Store(env.DB));
  }
  return json({service:'Political Telegram Newsroom',health:'/health',ready:'/ready'});
}

export default {
  async fetch(request,env,ctx) {
    try { return await handleFetch(request,env,ctx); }
    catch (error) {
      console.warn('Newsroom request failed',error instanceof Halt?'validation':'runtime');
      return json({error:error instanceof Halt?error.message:'Internal service error'},error instanceof Halt?400:500);
    }
  },
  async scheduled(event,env,ctx) {
    if (!env.DB) return;
    const work=async()=>{
      const c=config(env);
      if (missing(c).length) return;
      await ensureSchema(env.DB);
      const store=new Store(env.DB);
      await store.recover();
      await store.stmt("INSERT INTO cf_meta(key,value) VALUES ('cron_heartbeat',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(now())).run();
      // Never let slow setup, webhook commands or publisher-breaking scans
      // delay the 09/13/18/21 research slot.
      await schedule(c,store,event.scheduledTime);
      await retryScheduledFailures(c,store,event.scheduledTime);
      await recoverUndeliveredDrafts(store,event.scheduledTime);
      await retryFailedDeliveries(store,event.scheduledTime);
      await drain(c,store,'delivery',2);
      await drain(c,store,'research',1);
      await drain(c,store,'edit',1);
      await drain(c,store,'control',3);
      await drain(c,store,'setup',1);
      await scheduleBreaking(c,store,event.scheduledTime);
    };
    ctx.waitUntil(work().catch(()=>console.warn('Scheduled queue interrupted')));
  },
};
