import {editorialRelevant} from './editorial.js';

// Editorial targets are aspirations, not permission to invent filler or repeat events.
// All clock hours are Asia/Tbilisi (UTC+4, no daylight-saving time).
export const EDITIONS=Object.freeze({
  morning:{hour:9,name:'დილის მთავარი ამბავი',beat:'world-politics',minWords:70,maxWords:90},
  midday:{hour:13,name:'საერთაშორისო პოლიტიკა',beat:'diplomacy-economy',minWords:80,maxWords:100},
  evening:{hour:18,name:'დღის მთავარი ისტორია',beat:'geopolitics',minWords:90,maxWords:115},
  night:{hour:21,name:'საღამოს გამოშვება',beat:null,minWords:75,maxWords:100},
  breaking:{hour:null,name:'განსაკუთრებული მნიშვნელოვანი მოვლენა',beat:null,minWords:45,maxWords:75},
});
export const REGULAR_HOURS=[9,13,18,21];
export const REGULAR_QUERY='მნიშვნელოვანი ახალი პოლიტიკური და გეოპოლიტიკური ამბავი მსოფლიოში და საქართველოში';

export function editionAtHour(hour) {
  return Object.keys(EDITIONS).find(key=>EDITIONS[key].hour===hour) || null;
}
export function editionDetails(name='night') {
  return EDITIONS[name] || EDITIONS.night;
}
export function localClock(utcMs) {
  const local=new Date(utcMs+4*3600000);
  return {day:local.toISOString().slice(0,10),hour:local.getUTCHours(),
    minute:local.getUTCMinutes(),slot:local.toISOString().slice(0,13)};
}
const GEORGIA=/საქართველ|თბილის|ქართულ|georgi(?:a|an)|tbilisi|ivanishvili|kobakhidze/iu;
const CONFLICT=/\b(?:war|invasion|military|nato|troops|nuclear|defen[cs]e|security|airstrike|border|missile|taiwan|ceasefire|sanction|conflict|army|forces|geopolitic)\b|სამხედრო|უსაფრთხოებ|ომი|ომის |კონფლიქტ|თავდასხმ|ნატო|ოკუპაცი|ბირთვულ|ტაივან|სანქცი/iu;
const DIPLOMACY=/\b(?:diplomac|diplomat|summit|negotiat|talks|agreement|treaty|tariff|trade|economic|eu commission|foreign minister|ambassador)\b|დიპლომატ|მოლაპარაკ|შეთანხმებ|სავაჭრო|ტარიფ|ეკონომიკ|ელჩ|სამიტ/iu;
const HIGH_VALUE=/\b(?:approves?|passes?|announces?|resigns?|elected|election|launches?|imposes?|agrees?|signed|summit|sanctions?|declares?|negotiations|parliament|government|president|minister)\b|გადაწყვეტილებ|დაამტკიც|პრეზიდენტ|არჩევნ|მთავრობ|მინისტრ|პარლამენტ|შეთანხმებ|სანქცი/iu;

export function newsroomBeat(entry) {
  const phrase=(entry.title||'')+' '+(entry.summary||'');
  const url=String(entry.url||'');
  if(/(?:^|\/\/)(?:www\.)?(?:civil\.ge|netgazeti\.ge)\//i.test(url) || GEORGIA.test(phrase))
    return 'georgia';
  if(CONFLICT.test(phrase))return 'geopolitics';
  if(DIPLOMACY.test(phrase))return 'diplomacy-economy';
  return 'world-politics';
}
const TARGETS={'world-politics':0.4,geopolitics:0.3,'diplomacy-economy':0.2,georgia:0.1};
export function rankEditorialEntries(entries,edition='night',history=[],time=Date.now()) {
  const plan=editionDetails(edition);
  const recent=history.slice(0,20),counts=Object.fromEntries(Object.keys(TARGETS).map(k=>[k,0]));
  for(const item of recent)counts[newsroomBeat({title:item.topic})]++;
  return [...entries].sort((a,b)=>score(b)-score(a)||Date.parse(b.published_at)-Date.parse(a.published_at));
  function score(entry) {
    const beat=newsroomBeat(entry),published=Date.parse(entry.published_at);
    const hours=Number.isFinite(published)?Math.max(0,(time-published)/3600000):48;
    const recency=Math.max(0,8-hours/4);
    const value=HIGH_VALUE.test((entry.title||'')+' '+(entry.summary||''))?2:0;
    const slot=plan.beat===beat?1.8:0;
    const underserved=Math.max(0,(TARGETS[beat]-(counts[beat]/Math.max(1,recent.length))))*4;
    return recency+value+slot+underserved+(entry.has_publisher_image?0.2:0);
  }
}
// A fifth, unscheduled draft needs a recent, unmistakably high-impact event.
// The check is local RSS metadata, not an LLM guess; it never publishes directly.
const SHOCK=/\b(?:coup(?: attempt)?|assassinat(?:ion|ed)|declares? war|war declared|invasion (?:begins|launched)|invades? (?:a|the|its|neighbor|neighbour)|nuclear (?:attack|strike)|ceasefire (?:signed|agreed|announced)|president (?:assassinated|killed|resigns|removed)|prime minister (?:assassinated|killed|resigns)|parliament dissolved|state of emergency declared|nato article 5|impeachment (?:approved|passed)|martial law declared)\b|სახელმწიფო გადატრიალებ|პრეზიდენტის მკვლელობ|პრეზიდენტი გადადგ|პრემიერი გადადგ|ომი გამოაცხად|ომის გამოცხადებ|ცეცხლის შეწყვეტის შეთანხმებ|ბირთვული თავდასხმ|საგანგებო მდგომარეობა გამოცხად/iu;
export function breakingEligible(entry,time=Date.now()) {
  const published=Date.parse(entry?.published_at||''),age=time-published;
  if(!Number.isFinite(published) || age<0 || age>90*60000)return false;
  return editorialRelevant(entry,'') && SHOCK.test((entry.title||'')+' '+(entry.summary||''));
}
export function breakingCandidates(entries,history=[],time=Date.now()) {
  return entries.filter(entry=>breakingEligible(entry,time) &&
    !history.some(x=>String(x.topic||'').normalize('NFKC').toLowerCase().trim()===
      String(entry.title||'').normalize('NFKC').toLowerCase().trim()))
    .sort((a,b)=>Date.parse(b.published_at)-Date.parse(a.published_at));
}
