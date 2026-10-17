import {test} from 'node:test';
import assert from 'node:assert/strict';
import {georgianQualityIssues,requireGeorgianQuality,GEORGIAN_STYLE_EXAMPLES} from '../src/georgian-quality.js';
import {publish} from '../src/worker.js';
import {fixture,payload,mockTelegram} from './helpers.js';

test('reject actual gibberish seen in pending political news draft',()=>{
  const bad={title:'მასკირებული სელჩები დაარტყეს ევროპელი დიპლომატები დასავლეთ ბანკში',
    body:'მასკირებული სელჩები დაარტყეს ევროპელი დიპლომატები დასავლეთ ბანკში, რამაც გამოიწვია საერთაშორისო პოლიტიკური დამოკიდებულების გამოწვევა. ბელგიის უცხო საქმეთა მინისტრი ამის შესახებ განაცხადა. დატვირთული ინფორმაციით, ატაკა მოხდა საბაჟო დასავლეთ ბანკში, სადაც ევროპელი დიპლომატები იმყოფებოდნენ. ამ შემთხვევა საერთაშორისო საზღვარზე დამოკიდებულების გამოწვევას უწყობს, რადგან ევროპელი დიპლომატები საერთაშორისო საზღვარზე მოქმედებას უწყობს. ამ შემთხვევა საერთაშორისო საზღვარზე დამოკიდებულების გამოწვევას უწყობს, რადგან ევროპელი დიპლომატები საერთაშორისო საზღვარზე მოქმედებას უწყობს.'};
  const failures=georgianQualityIssues(bad);
  assert.ok(failures.includes('machine-translated-phrase'));
  assert.ok(failures.includes('repeated-sentence')||failures.includes('repeated-phrase'));
  assert.throws(()=>requireGeorgianQuality(bad),/ქართული ტექსტის ხარისხის/);
});
test('reject recurring long phrases even when sentences have different endings',()=>{
  const bad={title:'პოლიტიკური შეხვედრა',body:'ოფიციალურ შეხვედრაზე საერთაშორისო საგარეო პოლიტიკური თანამშრომლობის ახალი შესაძლებლობა განიხილეს. ამის შემდეგ საერთაშორისო საგარეო პოლიტიკური თანამშრომლობის ახალი შესაძლებლობა კვლავ განიხილეს.'};
  assert.ok(georgianQualityIssues(bad).includes('repeated-phrase'));
});
test('allow concise, meaningful Georgian news and unchanged verified claim IDs',()=>{
  const good={title:'ევროპელ დიპლომატებზე თავდასხმა იორდანეს დასავლეთ სანაპიროზე',
    body:'The Guardian-ის ცნობით, იორდანეს დასავლეთ სანაპიროზე ნიღბიანი პირები ევროპელ დიპლომატებს თავს დაესხნენ.\n\nბელგიის საგარეო საქმეთა მინისტრმა თავდასხმასთან დაკავშირებით განცხადება გააკეთა.',
    claim_ids:[0,1],source_ids:[0]};
  assert.deepEqual(georgianQualityIssues(good),[]);
  assert.strictEqual(requireGeorgianQuality(good),good);
  assert.match(GEORGIAN_STYLE_EXAMPLES,/დიდმა ბრიტანეთმა/);
});
test('reject English-only, very long titles and known machine calques',()=>{
  assert.ok(georgianQualityIssues({title:'News',body:'The minister announced diplomatic talks with foreign leaders during the parliamentary session in the country.'}).includes('georgian-language-share'));
  assert.ok(georgianQualityIssues({title:'საინტერესო სიტყვა '.repeat(20),body:'ოფიციალური შეხვედრის შესახებ ინფორმაცია გავრცელდა.'}).includes('headline-too-long'));
  assert.ok(georgianQualityIssues({title:'ევროკავშირის მოლაპარაკება',body:'ბრიტანიის მიერ გადაწყვეტილების მიღება მოხდა.'}).includes('machine-translated-phrase'));
});

test('Publish rejects previously generated broken Georgian without touching channel or draft state',async()=>{
  const {c,store}=await fixture(),p=payload();
  p.article.title='მასკირებული სელჩები დაარტყეს ევროპელი დიპლომატები დასავლეთ ბანკში';
  const draft=await store.createDraft({event_key:'bad-georgian-old-draft',topic:'Politics'},p,3600000);
  const original=globalThis.fetch;
  let channelSends=0;
  globalThis.fetch=mockTelegram(async method=>{
    if(method==='getChatMember')return Response.json({ok:true,result:{status:'administrator',can_post_messages:true}});
    if(method==='sendMessage'||method==='sendPhoto')channelSends++;
    return Response.json({ok:true,result:{message_id:42}});
  });
  try {
    await assert.rejects(publish(c,store,draft.id,1),/ქართული ტექსტის ხარისხის/);
    assert.equal(channelSends,0);
    assert.equal((await store.draft(draft.id)).state,'pending');
    assert.equal((await store.stmt('SELECT count(*) AS n FROM cf_audit').first()).n,0);
  } finally {globalThis.fetch=original;}
});
