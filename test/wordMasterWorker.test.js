const assert = require('node:assert/strict');
const test = require('node:test');
const { refreshWordMasterRankings } = require('../service/leaderboards/wordMaster');
const { fixture } = require('./rollupFixture');
test('Word Master refresh atomically replaces complete generations across repeated runs', async () => {
  const f=fixture();
  await refreshWordMasterRankings(f.pool);assert.equal(f.state(),'next');
  await refreshWordMasterRankings(f.pool);assert.equal(f.state(),'next');
  assert.equal(f.commits(),2);
});
test('Word Master population failure leaves the canonical live table unchanged', async () => {
  const f=fixture(true);
  await assert.rejects(refreshWordMasterRankings(f.pool),/population failed/);
  assert.equal(f.state(),'old');assert.equal(f.commits(),0);assert.equal(f.releases(),1);
});
