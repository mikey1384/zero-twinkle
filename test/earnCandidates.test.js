const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("nightly reward reconciliation refreshes the teacher eligibility hint", () => {
  const source = readFileSync(
    path.join(__dirname, "../service/earnCandidates/index.js"),
    "utf8",
  );

  assert.match(source, /teacherEligible/);
  assert.match(source, /rewardDisabled = '0'/);
  assert.match(source, /COALESCE\(u\.achievementPoints, 0\) >=/);
  assert.match(
    source,
    /ON DUPLICATE KEY UPDATE[\s\S]*?teacherEligible = VALUES\(teacherEligible\)/,
  );
  assert.match(source, /JOIN users u ON u\.id = r\.userId/);
  assert.match(source, /LEFT JOIN users_types ut ON ut\.label = u\.userType/);
});
