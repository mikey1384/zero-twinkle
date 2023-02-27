const request = require("axios");
const io = require("socket.io-client");
const URL = process.env.URL;
const socket = io.connect(URL);
const config = require("../../config");
const { auth, openai } = config;
const { poolQuery } = require("../helpers");
const userId = Number(process.env.ZERO_TWINKLE_ID);
let user = null;
let channel = null;
const channelId = Number(process.env.ZERO_CHAT_ROOM_ID);
let processingQuery = false;

async function summarizeMemories() {
  if (processingQuery) return;
  processingQuery = true;
  try {
    if (!user) {
      const { data } = await request.get(`${URL}/user/session`, auth);
      user = data;
    }
    if (!channel) {
      const { data = {} } = await request.get(
        `${URL}/chat/channel?channelId=${channelId}`,
        auth
      );
      channel = data.channel;
    }
    const [row] = await poolQuery(
      `
      SELECT id, prompt, response FROM zero_prompts WHERE responseSummary IS NULL ORDER BY id DESC LIMIT 1;
    `
    );
    if (!row) {
      processingQuery = false;
      return;
    }
    const { prompt, response } = row;
    const isSummarizedPromptRes = await openai.createCompletion({
      model: "text-davinci-003",
      prompt: `When you enter a message you said to me earlier, I'll first identify whether it was a question or not. If it was a question, I'll simply repeat the question and I will never answer your question. Otherwise I will not answer your message and I will shorten your message to 3 or fewer sentences, and present it in this format - Summary: [your shortened message goes here]. Enter your message here: \n\n"${prompt}"\n\n\n`,
      temperature: 0.7,
      max_tokens: 2000,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    });
    const isSummarizedPrompt = isSummarizedPromptRes.data.choices
      .map(({ text }) => text.trim())
      .join(" ");

    const isSummarizedResponseRes = await openai.createCompletion({
      model: "text-davinci-003",
      prompt: `I am an AI named Zero. We have spoken before but I forgot what my response was. When you remind me of my previous response to your prompt, I am going to shorten it to 3 or fewer sentences, and say it in this format - Summary: [my shortened response goes here]. Enter my previous response here: \n\n"${response}"\n\n\n`,
      temperature: 0.7,
      max_tokens: 2000,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    });
    const isSummarizedResponse = isSummarizedResponseRes.data.choices
      .map(({ text }) => text.trim())
      .join(" ");
    await poolQuery(
      `UPDATE zero_prompts SET responseSummary = ?, promptSummary = ? WHERE id = ?`,
      [
        isSummarizedResponse.replace(/Summary: /g, ""),
        isSummarizedPrompt.replace(/Summary: /g, "").replace(/Question: /g, ""),
        row.id,
      ]
    );
    const message = {
      content: `Hello Mikey. I made this summary.\n\n${isSummarizedPrompt}\n\n${isSummarizedResponse}`,
      channelId,
      timeStamp: Math.floor(Date.now() / 1000),
      userId,
    };
    const {
      data: { messageId },
    } = await request.post(
      `${URL}/chat`,
      {
        message,
      },
      auth
    );
    const messageToSend = {
      ...message,
      id: messageId,
      username: user.username,
      profilePicUrl: user.profilePicUrl,
      isNewMessage: true,
    };
    socket.emit("new_chat_message", {
      message: messageToSend,
      channel,
    });
    processingQuery = false;
  } catch (error) {
    console.error(error);
    if (!user) {
      const { data } = await request.get(`${URL}/user/session`, auth);
      user = data;
    }
    if (!channel) {
      const { data = {} } = await request.get(
        `${URL}/chat/channel?channelId=${channelId}`,
        auth
      );
      channel = data.channel;
    }
    const message = {
      content: `Hello Mikey. I got this error "${JSON.stringify(
        error?.response?.data ||
          error?.response?.statusText ||
          error?.response ||
          error
      )}."`,
      channelId,
      timeStamp: Math.floor(Date.now() / 1000),
      userId,
    };
    const {
      data: { messageId },
    } = await request.post(
      `${URL}/chat`,
      {
        message,
      },
      auth
    );
    const messageToSend = {
      ...message,
      id: messageId,
      username: user.username,
      profilePicUrl: user.profilePicUrl,
      isNewMessage: true,
    };
    socket.emit("new_chat_message", {
      message: messageToSend,
      channel,
    });
    processingQuery = false;
  }
}

module.exports = { summarizeMemories };
