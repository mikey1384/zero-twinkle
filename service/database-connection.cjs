'use strict';
// Shared by pools, standalone commands, stdin probes and Zero (byte-identical copy).
// Pure resolution: importing this module never loads env or opens a connection.
const fs = require('node:fs');
const classes = { runtime: 'RUNTIME', energy: 'ENERGY', operator: 'OPERATOR' };
const truthy = (value) => /^(1|true|yes)$/i.test((value || '').trim());
function splitCredentials(env) {
  return (
    env.MYSQL_CREDENTIAL_MODE === 'split' ||
    [env.MYSQL_USER, env.MYSQL_USER_PROXY].some((user) =>
      /^twinkle_(runtime|energy_jobs|operator|energy_retention)$/.test(
        user || ''
      )
    ) ||
    Object.keys(env).some((key) =>
      /^MYSQL_(RUNTIME|ENERGY|OPERATOR)_(USER|PASSWORD)(?:_PROXY)?$/.test(key)
    )
  );
}
function resolveMysqlUser({ directUser, proxyHost, proxyUser }) {
  return (proxyHost ? proxyUser : '') || directUser;
}
function resolveMysqlPoolUsers({
  directReaderHost,
  directUser,
  proxyUser,
  readerProxyHost,
  writerProxyHost
}) {
  const writer = resolveMysqlUser({
    directUser,
    proxyHost: writerProxyHost,
    proxyUser
  });
  const reader = readerProxyHost
    ? proxyUser || directUser
    : directReaderHost
      ? directUser
      : writer;
  return { reader, writer };
}
function resolveDatabaseConfig(
  env = process.env,
  credentialClass = 'runtime',
  route = 'writer',
  { defaultSslProfile } = {}
) {
  if (
    env.MYSQL_CREDENTIAL_MODE &&
    !['legacy', 'split'].includes(env.MYSQL_CREDENTIAL_MODE)
  )
    throw new Error('invalid_database_credential_mode');
  if (credentialClass === 'operator' && route !== 'writer')
    throw new Error('operator_requires_writer');
  if (!classes[credentialClass] || !['reader', 'writer'].includes(route))
    throw new Error('invalid_database_class_or_route');
  const prefix = `MYSQL_${classes[credentialClass]}_`;
  const explicit = Object.keys(env).some(
    (key) => key.startsWith(prefix) && /(?:USER|PASSWORD)(?:_PROXY)?$/.test(key)
  );
  const split = splitCredentials(env);
  if (credentialClass !== 'runtime' && split && !explicit)
    throw new Error(`missing_${credentialClass}_database_credentials`);
  const directUser = explicit ? env[prefix + 'USER'] : env.MYSQL_USER;
  const proxyUser = explicit
    ? (env[prefix + 'USER_PROXY'] || '').trim() || directUser
    : (env.MYSQL_USER_PROXY || '').trim();
  const password = explicit ? env[prefix + 'PASSWORD'] : env.MYSQL_PASSWORD;
  if (explicit && (!directUser || password === undefined))
    throw new Error(`incomplete_${credentialClass}_database_credentials`);
  // One password per class, never MYSQL_PASSWORD_PROXY. Canonical READER spelling only.
  const writerProxyHost = (env.MYSQL_HOST_PROXY || '').trim();
  const readerProxyHost = (env.MYSQL_HOST_READER_PROXY || '').trim();
  const directReaderHost = (env.MYSQL_HOST_READER || '').trim();
  const writerHost = writerProxyHost || env.MYSQL_HOST;
  const host =
    route === 'writer'
      ? writerHost
      : readerProxyHost || directReaderHost || writerHost;
  const users = resolveMysqlPoolUsers({
    directUser,
    proxyUser,
    writerProxyHost,
    readerProxyHost,
    directReaderHost
  });
  const user = users[route];
  const expectedUser =
    credentialClass === 'operator'
      ? 'twinkle_operator'
      : credentialClass === 'energy'
        ? 'twinkle_energy_jobs'
        : 'twinkle_runtime';
  if (explicit && user !== expectedUser)
    throw new Error(`invalid_${credentialClass}_database_user`);
  if (
    credentialClass === 'operator' &&
    !explicit &&
    /^twinkle_(runtime|energy_jobs|energy_retention)$/.test(user || '')
  )
    throw new Error('operator_credentials_required');
  const useIamAuth = truthy(env.MYSQL_USE_IAM_AUTH);
  if (useIamAuth && truthy(env.MYSQL_SSL_DISABLED))
    throw new Error('database_iam_requires_tls');
  let ssl;
  if (!truthy(env.MYSQL_SSL_DISABLED)) {
    const caPath = (env.MYSQL_SSL_CA_PATH || '').trim();
    ssl = caPath
      ? {
          ca: fs.readFileSync(caPath, 'utf8'),
          rejectUnauthorized: true,
          verifyIdentity: true,
          minVersion: 'TLSv1.2'
        }
      : (env.MYSQL_SSL_PROFILE || '').trim() ||
        defaultSslProfile ||
        (useIamAuth ? 'Amazon RDS' : undefined);
  }
  const rawPort = Number.parseInt(env.MYSQL_PORT || '3306', 10);
  return {
    options: {
      host,
      port: Number.isFinite(rawPort) && rawPort > 0 ? rawPort : 3306,
      user,
      password,
      database: env.MYSQL_DATABASE,
      ssl,
      connectTimeout: 10000,
      supportBigNumbers: true,
      bigNumberStrings: true,
      charset: 'utf8mb4',
      multipleStatements: false
    },
    credentialClass,
    legacy: !split,
    useIamAuth,
    expectedPrincipal: explicit || split ? `${expectedUser}@%` : null
  };
}
async function verifyDatabasePrincipal(conn, config) {
  const [rows] = await conn.query({ sql: 'SELECT CURRENT_USER() AS principal', timeout: 5000 });
  const principal = rows?.[0]?.principal;
  const expected = config.expectedPrincipal;
  if (
    typeof principal !== 'string' ||
    (expected
      ? principal !== expected
      : principal.split('@')[0] !== config.options.user)
  )
    throw new Error('database_principal_mismatch');
  if (
    config.credentialClass === 'operator' &&
    /^twinkle_(runtime|energy_jobs|energy_retention)@/.test(principal)
  )
    throw new Error('operator_credentials_required');
  return principal;
}
// This is defense in depth for accidental runtime DDL, not a SQL firewall or
// replacement for the database grants. Scan statement starts outside literals.
function sqlStatements(sql) {
  return String(sql)
    .replace(/'(?:\\.|''|[^'\\])*'|"(?:\\.|""|[^"\\])*"|`(?:``|[^`])*`/g, "''")
    .replace(/\/\*![0-9]*\s*([\s\S]*?)\*\//g, '$1')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--\s[^\n]*|#[^\n]*/g, ' ')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}
function assertDatabaseSql(sql, credentialClass = 'runtime') {
  if (credentialClass === 'operator') return;
  for (const statement of sqlStatements(sql)) {
    if (
      credentialClass === 'energy' &&
      /^(?:CREATE TEMPORARY TABLE(?: IF NOT EXISTS)?|DROP TEMPORARY TABLE(?: IF EXISTS)?) energy_shadow_reconcile_seen\b/i.test(
        statement
      )
    )
      continue;
    if (
      /^(?:CREATE|ALTER|DROP|TRUNCATE|RENAME|GRANT|REVOKE|INSTALL|UNINSTALL|PREPARE|EXECUTE|DEALLOCATE|LOAD|LOCK|UNLOCK|FLUSH|RESET|SHUTDOWN)\b/i.test(
        statement
      ) ||
      /^SET\s+(?:GLOBAL|PERSIST|@@(?:GLOBAL|PERSIST)\.)/i.test(statement)
    )
      throw new Error(`${credentialClass}_ddl_forbidden`);
    if (
      /^CALL\b/i.test(statement) &&
      !/^CALL\s+(?:runtime_capture_definitions|runtime_innodb_status)\s*\(\s*\)$/i.test(
        statement
      )
    )
      throw new Error(`${credentialClass}_routine_forbidden`);
  }
}
const guarded = new WeakMap();
function assertOperatorTarget(target) {
  const kind = guarded.get(target) || guarded.get(target.connection);
  if (kind && kind !== 'operator')
    throw new Error('operator_connector_required');
}
function guardDatabaseTarget(target, credentialClass = 'runtime') {
  if (guarded.has(target)) {
    if (guarded.get(target) !== credentialClass)
      throw new Error('database_class_cannot_change');
    return target;
  }
  guarded.set(target, credentialClass);
  for (const name of ['query', 'execute', 'prepare']) {
    if (typeof target[name] !== 'function') continue;
    const original = target[name];
    target[name] = function (sql, ...args) {
      assertDatabaseSql(
        typeof sql === 'string' ? sql : sql.sql,
        credentialClass
      );
      return original.call(this, sql, ...args);
    };
  }
  return target;
}
function guardDatabasePool(pool, credentialClass = 'runtime', config) {
  guardDatabaseTarget(pool, credentialClass);
  pool.on('connection', (connection) =>
    guardDatabaseTarget(connection, credentialClass)
  );
  // Keep today's pool behavior unchanged; once split credentials are selected,
  // no statement may run until the physical connection proves its principal.
  if (config?.expectedPrincipal) {
    const acquire = pool.getConnection.bind(pool);
    const verified = new WeakSet();
    pool.getConnection = (callback) => acquire((error, connection) => {
      if (error || verified.has(connection)) return callback(error, connection);
      verifyDatabasePrincipal(connection.promise(), config).then(() => {
        verified.add(connection);
        callback(null, connection);
      }, (failure) => {
        connection.destroy();
        callback(failure);
      });
    });
  }
  return pool;
}
async function createDatabaseConnection(
  credentialClass = 'runtime',
  route = 'writer',
  env = process.env
) {
  const config = resolveDatabaseConfig(env, credentialClass, route);
  // Standalone commands must not silently downgrade IAM to a password.
  const options = { ...config.options };
  if (config.useIamAuth) {
    const { Signer } = require('@aws-sdk/rds-signer');
    const signer = new Signer({
      hostname: options.host,
      port: options.port,
      username: options.user,
      region: env.MYSQL_IAM_REGION || env.AWS_REGION || 'ap-northeast-1'
    });
    options.password = await signer.getAuthToken();
    options.authPlugins = {
      mysql_clear_password: () => async () =>
        Buffer.from(`${options.password}\0`)
    };
  }
  const conn = await require('mysql2/promise').createConnection(options);
  try {
    await verifyDatabasePrincipal(conn, config);
    guardDatabaseTarget(conn, credentialClass);
    return conn;
  } catch (error) {
    await conn.end();
    throw error;
  }
}
module.exports = {
  assertOperatorTarget,
  splitCredentials,
  resolveMysqlUser,
  resolveMysqlPoolUsers,
  resolveDatabaseConfig,
  verifyDatabasePrincipal,
  assertDatabaseSql,
  guardDatabaseTarget,
  guardDatabasePool,
  createDatabaseConnection
};
async function createDatabasePool(
  credentialClass = 'runtime',
  env = process.env,
  connectionLimit = 2
) {
  const config = resolveDatabaseConfig(env, credentialClass, 'writer');
  const options = { ...config.options, connectionLimit };
  let signer;
  if (config.useIamAuth) {
    const { Signer } = require('@aws-sdk/rds-signer');
    signer = new Signer({
      hostname: options.host,
      port: options.port,
      username: options.user,
      region: env.MYSQL_IAM_REGION || env.AWS_REGION || 'ap-northeast-1'
    });
    options.authPlugins = {
      mysql_clear_password: () => async () =>
        Buffer.from(`${await signer.getAuthToken()}\0`)
    };
    options.password = await signer.getAuthToken();
  }
  const pool = require('mysql2/promise').createPool(options);
  const acquire = pool.getConnection.bind(pool);
  const checked = new WeakSet();
  pool.getConnection = async () => {
    if (signer)
      pool.pool.config.connectionConfig.password = await signer.getAuthToken();
    const conn = await acquire();
    try {
      if (!checked.has(conn.connection)) {
        await verifyDatabasePrincipal(conn, config);
        guardDatabaseTarget(conn.connection, credentialClass);
        checked.add(conn.connection);
      }
      return conn;
    } catch (error) {
      conn.destroy();
      throw error;
    }
  };
  for (const method of ['query', 'execute'])
    pool[method] = async (...args) => {
      const conn = await pool.getConnection();
      try {
        return await conn[method](...args);
      } finally {
        conn.release();
      }
    };
  return pool;
}
module.exports.createDatabasePool = createDatabasePool;
