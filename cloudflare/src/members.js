import {localClock} from './news-plan.js';

export function parseMemberUpdate(update,c) {
  const event=update?.chat_member;
  if(!Number.isSafeInteger(update?.update_id) || update.update_id<0 ||
     !event || event.chat?.type!=='channel')return null;
  const configured=String(c.channel||'').toLowerCase();
  const channelMatch=configured.startsWith('@')
    ? '@'+String(event.chat?.username||'').toLowerCase()===configured
    : String(event.chat?.id)===configured;
  if(!channelMatch)return null;
  const old=event.old_chat_member,newer=event.new_chat_member;
  const member=old?.user;
  if(!member || !Number.isSafeInteger(member.id) || member.is_bot ||
     newer?.user?.id!==member.id)return null;
  const active=x=>['creator','administrator','member'].includes(x?.status) ||
    (x?.status==='restricted' && x.is_member===true);
  const was=active(old),is=active(newer);
  if(was===is)return null;
  const action=is?'joined':'left';
  const method=action==='left'?'left':
    event.via_join_request?'request':
    event.invite_link?'invite':
    event.from?.id && event.from.id!==member.id?'added':'joined';
  return {updateId:update.update_id,action,method};
}
export function memberLocalDay(time=Date.now()) {
  return localClock(time).day;
}
export async function saveMemberEvent(store,event,time=Date.now()) {
  const day=memberLocalDay(time);
  const inserted=await store.stmt(
    'INSERT OR IGNORE INTO cf_member_events(update_id,action,method,day,at) VALUES (?,?,?,?,?)',
    event.updateId,event.action,event.method,day,time).run();
  return Number(inserted.meta?.changes||0)>0;
}
export async function saveMemberCount(store,count,time=Date.now()) {
  if(!Number.isInteger(count) || count<0)return;
  await store.stmt(
    'INSERT INTO cf_member_snapshots(day,member_count,updated_at) VALUES (?,?,?) ON CONFLICT(day) DO UPDATE SET member_count=excluded.member_count,updated_at=excluded.updated_at',
    memberLocalDay(time),count,time).run();
}
export async function memberStatistics(store,time=Date.now()) {
  const today=memberLocalDay(time);
  const sevenStart=memberLocalDay(time-6*86400000);
  const rows=(await store.stmt(
    "SELECT COALESCE(SUM(CASE WHEN action='joined' AND day=? THEN 1 ELSE 0 END),0) AS today_joined,"+
    " COALESCE(SUM(CASE WHEN action='left' AND day=? THEN 1 ELSE 0 END),0) AS today_left,"+
    " COALESCE(SUM(CASE WHEN action='joined' AND day>=? THEN 1 ELSE 0 END),0) AS week_joined,"+
    " COALESCE(SUM(CASE WHEN action='left' AND day>=? THEN 1 ELSE 0 END),0) AS week_left,"+
    " COUNT(*) AS total_events FROM cf_member_events",
    today,today,sevenStart,sevenStart).first())||{};
  const snapshot=await store.stmt('SELECT member_count,updated_at FROM cf_member_snapshots ORDER BY updated_at DESC LIMIT 1').first();
  return {today,sevenStart,today_joined:Number(rows.today_joined||0),
    today_left:Number(rows.today_left||0),week_joined:Number(rows.week_joined||0),
    week_left:Number(rows.week_left||0),total_events:Number(rows.total_events||0),
    cached_member_count:snapshot?.member_count??null};
}
export function memberAlert(event,count) {
  const title=event.action==='left'?'📉 გამომწერი გავიდა არხიდან':
    event.method==='added'?'👤 არხში გამომწერი დაამატეს':
    event.method==='request'?'✅ ახალი გამომწერი — მოთხოვნით':
    event.method==='invite'?'📈 ახალი გამომწერი — მოწვევით':
    '📈 ახალი გამომწერი';
  const suffix=Number.isInteger(count)?'\n👥 სულ გამომწერი: '+count:
    '\n👥 მიმდინარე რაოდენობა დროებით მიუწვდომელია';
  return title+suffix;
}
export function memberReport(summary,liveCount) {
  const today=summary.today_joined-summary.today_left;
  const week=summary.week_joined-summary.week_left;
  const count=Number.isInteger(liveCount)?liveCount:
    Number.isInteger(summary.cached_member_count)?summary.cached_member_count:null;
  return [
    '📊 მსოფლიო ფოკუსი — გამომწერების სტატისტიკა',
    '👥 მიმდინარე რაოდენობა: '+(count??'მიუწვდომელია')+
      (!Number.isInteger(liveCount)&&count!==null?' (ბოლო შენახული)':''),
    '📅 დღეს ('+summary.today+'): +'+summary.today_joined+
      ' / -'+summary.today_left+' | ცვლილება: '+(today>=0?'+':'')+today,
    '🗓 ბოლო 7 დღე: +'+summary.week_joined+' / -'+summary.week_left+
      ' | ცვლილება: '+(week>=0?'+':'')+week,
    '🔔 დაფიქსირებული წევრობის ცვლილებები: '+summary.total_events,
    'ℹ️ ცვლილებები ითვლება მონიტორინგის ჩართვის მომენტიდან; ძველი ისტორია არ აღდგება.',
  ].join('\n');
}
