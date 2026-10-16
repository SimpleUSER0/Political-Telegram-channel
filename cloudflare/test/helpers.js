import {DatabaseSync} from 'node:sqlite';
import {config} from '../src/core.js';
import {ensureSchema} from '../src/schema.js';
import {Store} from '../src/store.js';

// Exercises the exact production SQL against SQLite, not an in-memory JS approximation.
export class D1Local {
  constructor() { this.db=new DatabaseSync(':memory:'); }
  prepare(sql) {
    const db=this.db;
    const make=args=>({
      bind(...values){return make(values);},
      async first(){return db.prepare(sql).get(...args) || null;},
      async all(){return {results:db.prepare(sql).all(...args),success:true};},
      async run(){
        const statement=db.prepare(sql);
        if(statement.columns().length) return {results:statement.all(...args),success:true};
        const result=statement.run(...args);
        return {results:[],meta:{changes:Number(result.changes)},success:true};
      },
    });
    return make([]);
  }
  async batch(statements){
    this.db.exec('BEGIN');
    try { const results=[]; for(const stmt of statements) results.push(await stmt.run()); this.db.exec('COMMIT'); return results; }
    catch(error){this.db.exec('ROLLBACK'); throw error;}
  }
}
export const env = () => ({DB:new D1Local(),OWNER_USER_ID:'123',OWNER_CHAT_ID:'123',
  TELEGRAM_BOT_TOKEN:'555:fictional-test-token',EXPECTED_BOT_USERNAME:'political_test_bot',
  CHANNEL_ID:'-100555',WEBHOOK_SECRET:'w'.repeat(40),ADMIN_API_TOKEN:'a'.repeat(40),
  OPENAI_API_KEY:'offline-test-key',OPENAI_MODEL:'offline-model',SOURCE_DOMAINS:'example.com,example.org',
  SOURCE_ORIGIN_GROUPS:'{}',RESEARCH_ENABLED:'true',PUBLISH_ENABLED:'true'});
export async function fixture(){
  const e=env(),c=config(e); await ensureSchema(e.DB);
  return {e,c,store:new Store(e.DB)};
}
export function payload(){
  const excerpt='The official meeting took place on Friday.';
  return {
    article:{title:'შეხვედრა გაიმართა',body:'ოფიციალური შეხვედრა პარასკევს გაიმართა.',claim_ids:[0],source_ids:[0,1]},
    sources:[{id:0,url:'https://example.com/news',text:excerpt},{id:1,url:'https://example.org/news',text:excerpt}],
    verification:{publishable:true,reason:'Corroborated',contradictions:[],
      sources:[{source_id:0,published_at:new Date().toISOString(),origin_group:'a',publisher:'Example A',kind:'independent'},
        {source_id:1,published_at:new Date().toISOString(),origin_group:'b',publisher:'Example B',kind:'independent'}],
      claims:[{text:'Meeting held',status:'verified',attribution:'',origin_groups:['a','b'],
        evidence:[{source_id:0,excerpt},{source_id:1,excerpt}]}]},
    fact_check:{passed:true,unsupported_claims:[],missing_attributions:[]},
  };
}
export async function draft(store){
  return store.createDraft({event_key:'meeting-2026-'+crypto.randomUUID(),topic:'Meeting'},payload(),3600000);
}
export const mockTelegram = send => async(url,options)=>{
  const method=new URL(url).pathname.split('/').at(-1);
  if(method==='getMe')return Response.json({ok:true,result:{is_bot:true,username:'political_test_bot'}});
  if(method==='getChat')return Response.json({ok:true,result:{type:'channel',username:'political_test_channel'}});
  return send(method,JSON.parse(options.body));
};
