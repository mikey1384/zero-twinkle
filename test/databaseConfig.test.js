const test=require('node:test');
const assert=require('node:assert/strict');
const {resolveDatabaseConfig,assertDatabaseSql}=require('../service/database-connection.cjs');
const {assertRuntimeDatabaseEnvironment}=require('../service/runtime-database-environment.cjs');
test('Zero resolves runtime proxy writer/direct reader with one password before and after cutover',()=>{
  const env={MYSQL_HOST:'writer',MYSQL_HOST_PROXY:'proxy',MYSQL_HOST_READER:'reader',MYSQL_USER:'direct',MYSQL_USER_PROXY:'proxied',MYSQL_PASSWORD:'current',MYSQL_PASSWORD_PROXY:'stale'};
  assert.equal(resolveDatabaseConfig(env).options.user,'proxied');
  assert.equal(resolveDatabaseConfig(env,'runtime','reader').options.user,'direct');
  assert.equal(resolveDatabaseConfig(env).options.password,'current');
  const split={...env,MYSQL_USER:'twinkle_runtime',MYSQL_USER_PROXY:'twinkle_runtime'};
  assert.equal(resolveDatabaseConfig(split).legacy,false);
  assert.throws(()=>resolveDatabaseConfig(split,'operator'),/missing_operator/);
});
test('Zero preserves its production TLS default and rejects private class material',()=>{
  assert.equal(resolveDatabaseConfig({},'runtime','writer',{defaultSslProfile:'Amazon RDS'}).options.ssl,'Amazon RDS');
  assert.throws(()=>assertRuntimeDatabaseEnvironment({MYSQL_OPERATOR_PASSWORD:'private'}),/private_database/);
  assert.throws(()=>assertRuntimeDatabaseEnvironment({MYSQL_USER:'twinkle_operator',MYSQL_PASSWORD:'private'}),/private_database/);
});
test('Zero runtime refuses DDL used by former leaderboard rotation',()=>{
  for(const sql of ['TRUNCATE TABLE x','RENAME TABLE x TO y','CREATE TEMPORARY TABLE x(id INT)'])assert.throws(()=>assertDatabaseSql(sql),/ddl_forbidden/);
});
test('every legacy credential class preserves writer and reader resolution in Zero', () => {
  const base = { MYSQL_HOST: 'writer', MYSQL_USER: 'Administrator', MYSQL_PASSWORD: 'fixture' };
  assert.equal(resolveDatabaseConfig({ ...base, MYSQL_HOST_PROXY: 'proxy', MYSQL_USER_PROXY: ' twinkle_runtime ' }).legacy, false);
  for (const kind of ['runtime', 'energy', 'operator']) {
    for (const topology of [{}, { MYSQL_HOST_PROXY: 'proxy' }, { MYSQL_HOST_PROXY: 'proxy', MYSQL_HOST_READER: 'reader' }, { MYSQL_HOST_READER_PROXY: 'reader-proxy' }]) {
      const env = { ...base, ...topology };
      const config = resolveDatabaseConfig(env, kind);
      assert.equal(config.legacy, true);
      assert.equal(config.options.user, 'Administrator');
      assert.equal(config.options.password, 'fixture');
      assert.equal(config.options.host, topology.MYSQL_HOST_PROXY || 'writer');
      if (kind !== 'operator') assert.equal(resolveDatabaseConfig(env, kind, 'reader').options.host, topology.MYSQL_HOST_READER_PROXY || topology.MYSQL_HOST_READER || topology.MYSQL_HOST_PROXY || 'writer');
    }
  }
});
