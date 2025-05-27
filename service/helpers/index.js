const { writePool, readPool } = require("../pool");

async function poolQuery(query = "", params = null, fromWriter = false) {
  if (!query) {
    reportError({
      message: `poolQuery did not have a query. Params: ${JSON.stringify(
        params
      )}`,
    });
    return Promise.reject(new Error("Missing query"));
  }

  const retryCount = 3;
  const retryDelay = 500;

  const executeQuery = async (query, params, pool) => {
    return new Promise((resolve, reject) => {
      pool.query(query, params, (err, results) => {
        if (err) {
          reject(err);
        } else {
          resolve(results);
        }
      });
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
        query,
        params: JSON.stringify(params),
        error,
        errorMessage: error.message,
        errorCode: error.code,
        retryCount: 3 - retryCount,
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
  isImageFile,
  poolQuery,
};
