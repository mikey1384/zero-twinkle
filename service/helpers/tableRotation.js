const SAFE_TABLE_IDENTIFIER = /^[A-Za-z0-9_]+$/;

function quoteTableIdentifier(value) {
  const normalized = String(value || "").trim();
  if (!SAFE_TABLE_IDENTIFIER.test(normalized)) {
    throw new Error(`Invalid table identifier: ${normalized || "[empty]"}`);
  }
  return `\`${normalized}\``;
}

async function rotatePersistentStagingTable({
  query,
  liveTable,
  stagingTable,
  swapTable,
}) {
  if (typeof query !== "function") {
    throw new Error("Table rotation requires a query function");
  }
  const tableNames = [liveTable, stagingTable, swapTable].map(
    quoteTableIdentifier,
  );
  if (new Set(tableNames).size !== tableNames.length) {
    throw new Error("Table rotation names must be distinct");
  }
  const [live, staging, swap] = tableNames;

  // MySQL performs this left-to-right as one atomic statement. On success the
  // former live table is the reusable staging table; on failure no name moves.
  await query(
    `RENAME TABLE ${live} TO ${swap},
                  ${staging} TO ${live},
                  ${swap} TO ${staging}`,
    null,
    true,
  );
}

module.exports = {
  rotatePersistentStagingTable,
};
