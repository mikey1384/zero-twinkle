const axios = require("axios");
const { apiTransport } = require("../../helpers/apiTransport");

const ZERO_TWINKLE_TOKEN_HEADER = "x-zero-twinkle-token";
const NEWSPAPER_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const NEWSPAPER_RESPONSE_MAX_BYTES = 1024 * 1024;

function getTwinkleNewspaperRequestConfig() {
  const token = process.env.ZERO_TWINKLE_TOKEN;
  if (!token || !token.trim()) {
    throw new Error("ZERO_TWINKLE_TOKEN is not configured");
  }

  return {
    timeout: NEWSPAPER_REQUEST_TIMEOUT_MS,
    maxBodyLength: 16 * 1024,
    maxContentLength: NEWSPAPER_RESPONSE_MAX_BYTES,
    headers: {
      "User-Agent": "AI-Zero",
      [ZERO_TWINKLE_TOKEN_HEADER]: token,
      // Keep the previous API rollback target compatible during this
      // cross-service transition. Request errors are sanitized below.
      authorization: token,
    },
  };
}

function createTwinkleNewspaperRequestError(error) {
  const status = Number(error?.response?.status);
  const responseError =
    typeof error?.response?.data?.error === "string"
      ? error.response.data.error.trim().slice(0, 200)
      : "";
  const networkCode =
    typeof error?.code === "string" ? error.code.trim().slice(0, 80) : "";

  const details = [
    Number.isFinite(status) && status > 0 ? `HTTP ${status}` : "",
    responseError,
    !status && networkCode ? networkCode : "",
  ].filter(Boolean);

  return new Error(
    `Twinkle newspaper worker request failed${
      details.length ? `: ${details.join(" - ")}` : ""
    }`,
  );
}

async function processTwinkleNewspaper() {
  const apiUrl = process.env.API_URL;
  if (!apiUrl || !apiUrl.trim()) {
    throw new Error("API_URL is not configured");
  }
  const requestConfig = getTwinkleNewspaperRequestConfig();

  try {
    const transport = apiTransport("/zero/news/process");
    await axios.post(transport.url, null, { ...requestConfig, ...transport.config });
  } catch (error) {
    throw createTwinkleNewspaperRequestError(error);
  }
}

module.exports = {
  createTwinkleNewspaperRequestError,
  getTwinkleNewspaperRequestConfig,
  processTwinkleNewspaper,
};
