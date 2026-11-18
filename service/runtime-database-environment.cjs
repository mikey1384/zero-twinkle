'use strict';
const fs = require('node:fs');
const dotenv = require('dotenv');
function isPrivateDatabaseKey(key) {
  return (
    /^MYSQL_(?:OPERATOR|ENERGY|RETENTION)_/.test(key) ||
    /^TWINKLE_(?:OPERATOR|ENERGY|RETENTION)_DB_ENV_FILE$/.test(key)
  );
}
function assertRuntimeDatabaseEnvironment(env) {
  if (Object.keys(env).some(isPrivateDatabaseKey))
    throw new Error('private_database_credentials_in_runtime_environment');
}
function validateRuntimeEnvironmentBytes(bytes) {
  assertRuntimeDatabaseEnvironment(dotenv.parse(bytes));
  return bytes; // No parse/re-serialization: preserve the fingerprint exactly.
}
module.exports = {
  isPrivateDatabaseKey,
  assertRuntimeDatabaseEnvironment,
  validateRuntimeEnvironmentBytes
};
if (require.main === module) {
  try {
    validateRuntimeEnvironmentBytes(fs.readFileSync(process.argv[2]));
  } catch {
    console.error(
      'Runtime configuration contains private DB settings or is unreadable'
    );
    process.exitCode = 1;
  }
}
