const test = require('node:test');
const assert = require('node:assert/strict');
const { VISITOR_REVIEW_ENDPOINT, processVisitorBuildReviews, safeRequestError } = require('../service/minecraft/visitorReviews');

test('the worker checks only the fixed review endpoint using the existing worker credential', async () => {
  const calls = [];
  const value = await processVisitorBuildReviews({
    config: () => ({ headers: { 'x-zero-twinkle-token': 'test-token' } }),
    transport: path => { assert.equal(path, VISITOR_REVIEW_ENDPOINT); return { url: 'https://example.test/reviews', config: { proxy: false } }; },
    post: async (...args) => { calls.push(args); return { data: { pending: 1, notified: 1 } }; }
  });
  assert.deepEqual(value, { pending: 1, notified: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://example.test/reviews');
  assert.equal(calls[0][1], null);
  assert.equal(calls[0][2].timeout, 25000);
  assert.equal(calls[0][2].headers['x-zero-twinkle-token'], 'test-token');
});

test('worker failures discard request configuration and secrets', () => {
  const e = safeRequestError({ code: 'ERR_BAD_REQUEST', config: { headers: { authorization: 'secret' } }, response: { status: 401, data: { error: 'Unauthorized' } } });
  assert.equal(e.message, 'Minecraft visitor review check failed: HTTP 401 - Unauthorized');
  assert(!JSON.stringify(e).includes('secret'));
  assert.equal(Object.hasOwn(e, 'config'), false);
});
