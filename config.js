const GPT4 = "chatgpt-4o-latest";

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
  yesNoMaxTokens: 1000,
  GPT4,
};
