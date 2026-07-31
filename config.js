const GPT = "gpt-5.6-luna";

module.exports = {
  mailAuth: {
    type: "OAuth2",
    user: process.env.MAIL_USER,
    serviceClient: process.env.MAIL_CLIENT_ID,
    privateKey: process.env.MAIL_PRIVATE_KEY.replace(/\\n/gm, "\n"),
  },
  yesNoMaxTokens: 1000,
  GPT,
};
