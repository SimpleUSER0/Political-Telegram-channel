import {test} from 'node:test';
import assert from 'node:assert/strict';
import {editorialRelevant,editorialCandidates} from '../src/editorial.js';

test('A fatal blaze at a military base is not a geopolitics headline',()=>{
  const story={
    title:'Multiple people killed as Canadian authorities tackle active blaze at Alberta military base',
    summary:'Prime minister joins authorities as military emergency crews respond',
  };
  assert.equal(editorialRelevant(story,''),false);
  assert.deepEqual(editorialCandidates([story],'მსოფლიო პოლიტიკა'),[]);
});
test('International military conflict and substantive policy decisions remain eligible',()=>{
  const stories=[
    {title:'Russian missile attack sparks blaze in Kyiv during war'},
    {title:'EU parliament approves new sanctions on Russian companies'},
    {title:'Government declares state of emergency after catastrophic wildfire'},
    {title:'Israel and Iran begin ceasefire negotiations after military strikes'},
  ];
  assert.ok(stories.every(x=>editorialRelevant(x,'')));
});
test('Routine nonpolitical emergency cannot be promoted by politician reaction in summary',()=>{
  const event={
    title:'Factory fire damages buildings at military base',
    summary:'Prime minister says government officials are informed',
  };
  assert.equal(editorialRelevant(event,''),false);
});
