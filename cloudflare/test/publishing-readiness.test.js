import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkPublishing} from '../src/worker.js';
import {fixture} from './helpers.js';

test('publishing readiness checks the verified political bot permission without sending a post',async()=>{
  const original=globalThis.fetch,{c}=await fixture();
  try {
    for(const [role,permission,expected] of [['administrator',true,true],
      ['administrator',false,false],['member',true,false],['creator',false,true]]) {
      const methods=[];
      globalThis.fetch=async(url,options)=>{
        const method=new URL(url).pathname.split('/').at(-1);methods.push(method);
        const body=JSON.parse(options.body);let result;
        if(method==='getMe')result={id:555,is_bot:true,username:'political_test_bot'};
        else if(method==='getChat')result={type:'channel',username:'political_test_channel'};
        else if(method==='getChatMember') {
          assert.deepEqual(body,{chat_id:c.channel,user_id:555});
          result={status:role,can_post_messages:permission};
        } else throw new Error('Unexpected Telegram mutation');
        return Response.json({ok:true,result});
      };
      const readiness=await checkPublishing(c);
      assert.equal(readiness.available,expected);
      assert.deepEqual(methods,['getMe','getChat','getChatMember']);
    }
  } finally {globalThis.fetch=original;}
});
