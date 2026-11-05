const axios = require('axios');
const { apiTransport } = require('../../helpers/apiTransport');
const { getTwinkleNewspaperRequestConfig } = require('../news');

const VISITOR_REVIEW_ENDPOINT = '/zero/minecraft/visitor-requests/process';

function safeRequestError(error) {
  const status = Number(error?.response?.status);
  const message = typeof error?.response?.data?.error === 'string' ? error.response.data.error.trim().slice(0, 200) : '';
  const code = typeof error?.code === 'string' ? error.code.trim().slice(0, 80) : '';
  const detail = [Number.isFinite(status) && status > 0 ? `HTTP ${status}` : '', message, !status ? code : ''].filter(Boolean).join(' - ');
  return new Error(`Minecraft visitor review check failed${detail ? `: ${detail}` : ''}`);
}

async function processVisitorBuildReviews({ post = axios.post, transport = apiTransport, config = getTwinkleNewspaperRequestConfig } = {}) {
  const auth = config();
  const target = transport(VISITOR_REVIEW_ENDPOINT);
  try {
    const response = await post(target.url, null, { ...auth, timeout: 25000, ...target.config });
    return response.data;
  } catch (error) {
    throw safeRequestError(error);
  }
}

module.exports = { VISITOR_REVIEW_ENDPOINT, processVisitorBuildReviews, safeRequestError };
