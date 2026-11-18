const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const {replaceTableContents}=require('../service/helpers/tableRotation');
const {fixture}=require('./rollupFixture');
test('persistent rollup replacement publishes only a complete generation',async()=>{
  const f=fixture();
  await replaceTableContents({pool:f.pool,table:'live_table',populate:async conn=>{
    assert.equal(f.state(),'old');await conn.query('INSERT INTO live_table VALUES (1)');assert.equal(f.state(),'old');
  }});
  assert.equal(f.state(),'next');assert.equal(f.releases(),1);
});
test('persistent rollup rejects unsafe names before acquiring a connection',async()=>{
  await assert.rejects(replaceTableContents({pool:{getConnection(){throw new Error('must not connect');}},table:'live; DROP TABLE users',populate:async()=>{}}),/Invalid table identifier/);
});
test('recurring rollup workers use DML replacement without runtime DDL',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../service/leaderboards/wordMaster.js'),'utf8');
  assert.match(source,/replaceTableContents/);assert.doesNotMatch(source,/\b(?:CREATE|DROP|ALTER|TRUNCATE|RENAME)\s+TABLE\b/i);
});
test('AI Story chapter maintenance remains event driven without runtime schema changes',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../service/aiStories/chapterStats.js'),'utf8');
  assert.match(source,/ai_story_chapter_dirty_events/);assert.doesNotMatch(source,/TRUNCATE|RENAME TABLE|\b(?:CREATE|DROP|ALTER)\s+TABLE\b/i);
});
test('a busy rollup refuses mutations and releases its unowned connection',async()=>{
  let calls=0,released=0;
  const pool={getConnection:async()=>({query:async()=>{calls++;return [[{owned:0}]];},release(){released++;}})};
  await assert.rejects(replaceTableContents({pool,table:'live_table',populate:async()=>{throw new Error('must not populate');}}),/rollup_busy/);
  assert.equal(calls,1);assert.equal(released,1);
});
test('an uncertain lock release destroys the connection instead of pooling a held lock',async()=>{
  let destroyed=0,released=0;
  const pool={getConnection:async()=>({query:async sql=>sql.includes('GET_LOCK')?[[{owned:1}]]:sql.includes('RELEASE_LOCK')?[[{released:null}]]:[{}],beginTransaction:async()=>{},commit:async()=>{},release(){released++;},destroy(){destroyed++;}})};
  await replaceTableContents({pool,table:'live_table',populate:async()=>{}});
  assert.equal(destroyed,1);assert.equal(released,0);
});
