const axios = require("axios");

async function checkAndUpdateHints() {
  try {
    await axios.post(`${process.env.API_URL}/zero/vocabulary/hint`);
  } catch (error) {
    console.error("Failed to update hints:", error.message);
  }
}

module.exports = {
  checkAndUpdateHints,
};
