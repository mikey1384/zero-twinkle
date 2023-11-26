const { Configuration, OpenAIApi } = require("openai");
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);
const GPT4 = "gpt-4-1106-preview";

module.exports = {
  auth: {
    headers: {
      "User-Agent": "AI-Zero",
      authorization: process.env.ZERO_TWINKLE_TOKEN,
    },
  },
  mailAuth: {
    type: "OAuth2",
    user: process.env.MAIL_USER,
    serviceClient: process.env.MAIL_CLIENT_ID,
    privateKey: process.env.MAIL_PRIVATE_KEY.replace(/\\n/gm, "\n"),
  },
  openai,
  yesNoMaxTokens: 1000,
  GPT4,
};
