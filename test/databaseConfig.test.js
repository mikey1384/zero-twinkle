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
});
test('Zero runtime refuses DDL used by former leaderboard rotation',()=>{
  for(const sql of ['TRUNCATE TABLE x','RENAME TABLE x TO y','CREATE TEMPORARY TABLE x(id INT)'])assert.throws(()=>assertDatabaseSql(sql),/ddl_forbidden/);
});
