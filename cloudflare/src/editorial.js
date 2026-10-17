// Neutral newsroom scope: global politics, geopolitics and material Georgian politics.
// This is a conservative metadata prefilter, not a factuality verdict.
const POLITICS = /\b(?:president|prime minister|government|minister|parliament|congress|senate|election|electoral|vote|voting|ballot|politic(?:s|al)?|diplomat(?:ic|s)?|summit|sanction|tariff|trade war|foreign polic(?:y|ies)|security council|nato|eu leaders|european union|ceasefire|peace talks|treaty|border dispute|military|troops|warfare|war|invasion|protest|legislation|white house|kremlin|cabinet|regime|referendum|party leader|defence|defense|foreign minister|state visit|ambassador|policy change|political prisoners)\b|არჩევნ|პოლიტიკ|მთავრობ|პრეზიდენტ|პრემი[ეე]რ|პარლამენტ|დეპუტატ|მინისტრ|დიპლომატ|სამიტ|სანქცი|ტარიფ|სავაჭრო ომ|უსაფრთხოებ|სამხედრო|ომი|ომის |საომარ|შეტაკებ|კონფლიქტ|მოლაპარაკ|შეთანხმებ|პროტესტ|აქციაზე|კანონ|რეფერენდუმ|ოპოზიცი|პარტი|საგარეო|საკანონმდებლო|ევროკავშირ|ნატო|ელჩ|სხდომ|თავდაცვ|თავდასხმ|ოკუპაცი/iu;
const ROUTINE = /\b(?:nursery|poison(?:ed|ing)?|celebrity|actor|actress|football|soccer|basketball|film|movie|music|album|fashion|restaurant|recipe|lottery|horoscope|wedding|divorce|influencer|arrested for theft|murder trial|stabbing|school exam|sports star|medical treatment|hospital discharge)\b|საბავშვო ბაღ|მოწამლ|მკვლელობ|ქურდობ|ავარი|კრიმინალ|მსახიობ|მომღერალ|ფეხბურთ|კალათბურთ|კინოფილმ|ქორწილ|ჯანმრთელობ|საავადმყოფო|კულინარი/iu;
const TOPICS = [
  {id:'china',question:/ჩინეთ|პეკინ|ტაივან|china|chinese|beijing|taiwan|xi jinping/i,
    article:/\b(?:china|chinese|beijing|taiwan|xi jinping|hong kong|south china sea)\b|ჩინეთ|პეკინ|ტაივან|სი ძინპინ/iu,
    feeds:['bbc-asia','guardian-china']},
  {id:'usa',question:/აშშ|ამერიკ|შეერთებულ შტატ|usa|united states|us politics|america|washington|ტრამპ/i,
    article:/\b(?:united states|american|america|washington|white house|us congress|trump|usa|u\.s\.)\b|აშშ|ამერიკ|ტრამპ/iu,
    feeds:['guardian-us-politics']},
  {id:'georgia',question:/საქართველ|ქართულ|თბილის|georgia|tbilisi/i,
    article:/\b(?:georgia|georgian|tbilisi|ivanishvili|kobakhidze)\b|საქართველ|ქართულ|თბილის|კობახიძ|ივანიშვილ/iu,
    feeds:[]},
  {id:'middle-east',question:/ახლო აღმოსავლეთ|ისრაელ|ირან|ღაზ|პალესტინ|middle east|israel|iran|gaza|palestin/i,
    article:/\b(?:middle east|israel|israeli|iran|iranian|gaza|palestin(?:e|ian)|lebanon|yemen|houthi|saudi arabia)\b|ახლო აღმოსავლეთ|ისრაელ|ირან|ღაზ|პალესტინ|ლიბან|იემენ/iu,
    feeds:['bbc-middle-east','guardian-middle-east']},
  {id:'ukraine-russia',question:/უკრაინ|რუსეთ|მოსკოვ|კიევ|ukraine|russia|moscow|kyiv/i,
    article:/\b(?:ukraine|ukrainian|russia|russian|moscow|kyiv|kremlin|putin|zelensky)\b|უკრაინ|რუსეთ|მოსკოვ|კიევ|პუტინ|ზელენსკ/iu,
    feeds:['guardian-ukraine']},
];
export function editorialTopic(query) {
  const value=String(query||'').trim();
  return TOPICS.find(topic=>topic.question.test(value)) || null;
}
export function editorialFeeds(query,configured) {
  const topic=editorialTopic(query);
  // For a broad briefing, use configured world + Georgian sources; targeted queries
  // add known publisher-operated specialist feeds, not model-invented URLs.
  return [...new Set([...(configured||[]),...(topic?.feeds||[])])];
}
export function editorialRelevant(article,query='') {
  const text=[article?.title||'',article?.summary||''].join(' ').trim();
  if(!text)return false;
  const topic=editorialTopic(query);
  if(topic && !topic.article.test(text))return false;
  if(!POLITICS.test(text))return false;
  // Bare geography + a routine criminal or entertainment article is not politics.
  if(ROUTINE.test(text) && !/\b(?:government|politic(?:s|al)|parliament|president|diplomat(?:ic|s)?|minister|sanctions?|security council|military|election|protest|state policy|foreign policy)\b|მთავრობ|პოლიტიკ|პარლამენტ|პრეზიდენტ|დიპლომატ|მინისტრ|სანქცი|სამხედრო|არჩევნ|პროტესტ|საგარეო/iu.test(text))return false;
  return true;
}
export function editorialCandidates(entries,query) {
  return entries.filter(entry=>editorialRelevant(entry,query));
}
