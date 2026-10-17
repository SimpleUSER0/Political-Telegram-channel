import {Halt,articleText} from './core.js';

// Block strong, verifiable symptoms of machine-translated Georgian. This is a
// high-precision quality gate, not a claim that all grammatical mistakes can
// be detected automatically. False negatives are possible: owner approval remains.
const BAD_PATTERNS=[
  /მასკირებულ[იიმა]*\s+სელჩ/iu,
  /სელჩებ/iu,
  /დასავლეთ[ი]?\s+ბანკ(?:ში|ზე|ის|ს)?/iu,
  /მოწინააღმდეგობას\s+უწყობს/iu,
  /საერთაშორისო\s+(?:საზღვარზე\s+)?დამოკიდებულების\s+გამოწვევ/iu,
  /(?:ბრიტანიის|ელექტრომანქან|ევ-ს|ეუ-ს|დატვირთული ინფორმაციით)/iu,
  /ამ\s+შემთხვევა(?:\s|,|\.|$)/iu,
  /საბაჟო\s+დასავლეთ/iu,
  /ატაკა\s+მოხდა/iu,
  /მოქმედებას\s+უწყობს/iu,
  /(?:საქმიანობს|მუშაობს)\s+(?:იმ\s+)?შესაძლებლობაზე/iu,
  /ბელგიის\s+(?:უცხო|საგარეო)\s+საქმეთა\s+მინისტრი\s+ამის\s+შესახებ\s+განაცხადა/iu,
];

function normalizedSentence(s) {
  return s.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
}
export function georgianQualityIssues(article) {
  if(!article || typeof article.title!=='string' || typeof article.body!=='string')
    return ['missing-georgian-article'];
  const text=articleText(article),issues=[];
  if(BAD_PATTERNS.some(pattern=>pattern.test(text)))issues.push('machine-translated-phrase');
  const sequences=article.body.split(/[.!?]+|[\n]+/u).map(normalizedSentence)
    .filter(x=>x.split(' ').length>=6);
  if(new Set(sequences).size!==sequences.length)issues.push('repeated-sentence');
  const words=normalizedSentence(article.body).split(' ').filter(Boolean);
  // Repetition of whole long phrases, even across different sentences.
  const ngrams=new Map();
  for(let i=0;i+5<=words.length;i++){
    const ngram=words.slice(i,i+5).join(' ');
    const last=ngrams.get(ngram);
    if(last!==undefined && i-last>=5){issues.push('repeated-phrase');break;}
    if(last===undefined)ngrams.set(ngram,i);
  }
  const letters=text.match(/\p{L}/gu)||[];
  const ka=text.match(/[\u10A0-\u10FF\u1C90-\u1CBF]/gu)||[];
  if(letters.length>50 && ka.length/letters.length<0.64)issues.push('georgian-language-share');
  if(article.title.split(/\s+/u).length>18)issues.push('headline-too-long');
  return issues;
}
export function requireGeorgianQuality(article) {
  const issues=georgianQualityIssues(article);
  if(issues.length)throw new Halt('ქართული ტექსტის ხარისხის შემოწმება ვერ გაიარა ('+issues.join(', ')+')');
  return article;
}

// Examples are journalism-style demonstrations, not evidence to be copied.
// Specific events are illustrative and MUST NOT be inserted into the real post.
export const GEORGIAN_STYLE_EXAMPLES=String.raw`NATIVE GEORGIAN JOURNALISM — POSITIVE STYLE EXAMPLES (fictional, do not copy facts):
BAD: "მასკირებული სელჩები დაარტყეს ევროპელი დიპლომატები დასავლეთ ბანკში"
GOOD: "იორდანეს დასავლეთ სანაპიროზე ნიღბიანი პირები ევროპელ დიპლომატებს თავს დაესხნენ."
BAD: "ბელგიის უცხო საქმეთა მინისტრი ამის შესახებ განაცხადა"
GOOD: "ამის შესახებ ბელგიის საგარეო საქმეთა მინისტრმა განაცხადა."
BAD: "ჩინული საელჩო ამ მოქმედებას მოწინააღმდეგობას უწყობს"
GOOD: "ჩინეთის საელჩო ამ გადაწყვეტილებას ეწინააღმდეგება."
BAD: "ბრიტანიის მიერ ჩინული ელექტრომანქანების ტარიფების შეტანა შესაძლოა"
GOOD: "დიდმა ბრიტანეთმა შესაძლოა ჩინურ ელექტრომობილებზე ტარიფები დააწესოს."
BAD: "ამ შემთხვევა საერთაშორისო საზღვარზე დამოკიდებულების გამოწვევას უწყობს"
GOOD: "ინციდენტის პოლიტიკური შედეგები ჯერ უცნობია." (only when explicitly true in evidence)
BAD: "აშშ-ის პრეზიდენტი ამის შესახებ განაცხადა"
GOOD: "აშშ-ის პრეზიდენტმა ამის შესახებ განაცხადა."
Use Georgian case endings (ვინ? რა გააკეთა? ვის? სად?), idiomatic verbs, names and
locations. No lazy literal translation, filler, invented implications, repeated
sentences, empty political commentary or nonsensical text. If only 1–2 supported
facts exist, write ONLY those facts in brief natural Georgian. Fewer sentences is
better than adding speculation to reach a length target.`;
