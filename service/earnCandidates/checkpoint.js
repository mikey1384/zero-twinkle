const fs = require("node:fs");
const path = require("node:path");

const checkpointFile = () =>
  process.env.EARN_CANDIDATE_CHECKPOINT_FILE ||
  path.resolve(__dirname, "../../logs/earn-candidate-reconcile.json");

function readCheckpoint() {
  try {
    const file = checkpointFile();
    if (fs.statSync(file).size > 4096)
      throw new Error("Earn reconciliation checkpoint exceeds limit");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function writeCheckpoint(state) {
  const file = checkpointFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const next = `${file}.${process.pid}.next`;
  const fd = fs.openSync(next, "w", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(state));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(next, file);
}

module.exports = { readCheckpoint, writeCheckpoint };
