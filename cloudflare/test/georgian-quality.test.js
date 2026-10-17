import {test} from 'node:test';
import assert from 'node:assert/strict';
import {georgianQualityIssues,requireGeorgianQuality,GEORGIAN_STYLE_EXAMPLES} from '../src/georgian-quality.js';

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
