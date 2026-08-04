const { writePool, readPool } = require("../pool");
const crypto = require("crypto");

const DB_QUERY_TIMEOUT_MS = 10 * 60 * 1000;

function describeQuery(query) {
  const normalized = String(query || "")
    .trim()
    .replace(/\s+/g, " ");
  return {
    queryOperation: normalized.split(" ", 1)[0]?.toUpperCase() || "UNKNOWN",
    queryFingerprint: crypto
      .createHash("sha256")
      .update(normalized)
      .digest("hex")
      .slice(0, 16),
  };
}

async function poolQuery(query = "", params = null, fromWriter = false) {
  if (!query) {
    throw new Error("Missing query");
  }

  const retryCount = 3;
  const retryDelay = 500;

  const executeQuery = async (query, params, pool) => {
    return new Promise((resolve, reject) => {
      pool.query(
        { sql: query, timeout: DB_QUERY_TIMEOUT_MS },
        params,
        (err, results) => {
          if (err) {
            reject(err);
          } else {
            resolve(results);
          }
        },
      );
    });
  };

  const doQuery = async (retryCount, retryDelay) => {
    try {
      if (process.env.NODE_ENV === "production" && !fromWriter) {
        if (query.trim().substring(0, 6) === "SELECT") {
          return await executeQuery(query, params, readPool);
        } else {
          return await executeQuery(query, params, writePool);
        }
      } else {
        return await executeQuery(query, params, writePool);
      }
    } catch (error) {
      console.error({
        message: "Database query error",
        ...describeQuery(query),
        parameterCount: Array.isArray(params) ? params.length : params ? 1 : 0,
        errorName: error?.name || "Error",
        errorMessage: String(error?.message || error).slice(0, 300),
        errorCode: error?.code || null,
        failedAttempt: 4 - retryCount,
        retriesRemaining: error?.code === "ER_LOCK_DEADLOCK" ? retryCount : 0,
      });

      if (error.code === "ER_LOCK_DEADLOCK" && retryCount > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        return doQuery(retryCount - 1, retryDelay * 2);
      } else {
        return Promise.reject(error);
      }
    }
  };

  try {
    return doQuery(retryCount, retryDelay);
  } catch (error) {
    console.error("Transaction management error:", error);
    throw error;
  }
}

function isImageFile(fileName) {
  const imageExtensions = [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"];
  const extension = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  return imageExtensions.includes(extension);
}

module.exports = {
  DB_QUERY_TIMEOUT_MS,
  describeQuery,
  isImageFile,
  poolQuery,
};
