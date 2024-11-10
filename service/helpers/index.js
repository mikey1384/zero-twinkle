const { writePool, readPool } = require("../pool");

function poolQuery(query, params) {
  return new Promise((resolve, reject) => {
    const trimmedQuery = query.trim();
    if (trimmedQuery.substring(0, 6) === "SELECT") {
      readPool.query(trimmedQuery, params, (err, results) => {
        if (err) {
          return reject(err);
        }
        return resolve(results);
      });
    } else {
      writePool.query(trimmedQuery, params, (err, results) => {
        if (err) {
          return reject(err);
        }
        return resolve(results);
      });
    }
  });
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
