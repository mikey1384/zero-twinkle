const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const vm = require('node:vm');

function fixture(env) {
  let selected = 'primary';
  const host = { role: 'primary', primaryAddress: '172.31.2.3', targetAddress: '172.31.2.4' };
  const module = { exports: {} };
  let verified = 0;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../helpers/apiTransport.js'), 'utf8'), {
    module, process: { env },
    require(name) {
      if (name === 'node:https') return https;
      if (name === 'node:path') return path;
      assert.equal(name, '/home/ec2-user/server/.runtime-current/dist/runtimeHostConfig.js');
      return {
        readRuntimeHostConfig: () => host,
        verifyConfiguredHostIdentity: () => { verified++; },
        readRuntimeServingHost: () => selected,
      };
    },
  });
  return { transport: module.exports.apiTransport, host, select: value => { selected = value; }, verified: () => verified };
}

test('without bootstrap opt-in both requests preserve the existing public transport', () => {
  const { transport, verified } = fixture({ API_URL: 'https://api.twinkle.network:8443' });
  for (const endpoint of ['/zero/news/process', '/zero/reward/card']) {
    const result = transport(endpoint);
    assert.equal(result.url, `https://api.twinkle.network:8443${endpoint}`);
    assert.deepEqual(Object.keys(result.config), []);
  }
  assert.equal(verified(), 0);
});

test('private routing rechecks host identity and selected address on every bounded TLS request', () => {
  const fixtureState = fixture({ TWINKLE_API_HOST_DIRECTORY: '/home/ec2-user/server' });
  for (const selected of ['primary', 'target']) {
    fixtureState.select(selected);
    for (const endpoint of ['/zero/news/process', '/zero/reward/card']) {
      const { url, config } = fixtureState.transport(endpoint);
      assert.equal(url, `https://api.twinkle.network:8443${endpoint}`);
      assert.equal(config.proxy, false);
      assert.equal(config.maxRedirects, 0);
      const agent = config.httpsAgent;
      try {
        assert.equal(agent.options.rejectUnauthorized, true);
        assert.equal(agent.options.keepAlive, false);
        assert.equal(agent.options.servername, 'api.twinkle.network');
        for (const all of [true, false]) {
          agent.options.lookup('api.twinkle.network', { all }, (error, address, family) => {
            assert.equal(error, null);
            const expected = selected === 'primary' ? '172.31.2.3' : '172.31.2.4';
            assert.equal(all ? address[0].address : address, expected);
            assert.equal(all ? address[0].family : family, 4);
          });
        }
        agent.options.lookup('foreign.invalid', {}, error => assert.match(error.message, /Invalid API destination/));
      } finally { agent.destroy(); }
    }
  }
  assert.equal(fixtureState.verified(), 4);
  fixtureState.host.role = 'api-only';
  assert.throws(() => fixtureState.transport('/zero/news/process'), /primary host/);
  assert.throws(() => fixtureState.transport('/other'), /Unsupported/);
  assert.throws(() => fixture({ TWINKLE_API_HOST_DIRECTORY: '/other' }).transport('/zero/news/process'), /Invalid Zero API host directory/);
});
