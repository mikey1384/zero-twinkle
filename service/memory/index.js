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
    const isSummarizedPromptRes = await openai.createChatCompletion({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content:
            "You are a summarizer. You don't answer the prompts on your own. Instead, you generate concise version of the text given following the instructions",
        },
        {
          role: "user",
          content: `Please make this as concise as possible: ${prompt}`,
        },
      ],
      temperature: 0.7,
      max_tokens: 2000,
      top_p: 1,
    });
    const isSummarizedPrompt = isSummarizedPromptRes.data.choices
      .map(({ message: { content = "" } }) => content.trim())
      .join(" ");
    const isSummarizedResponseRes = await openai.createChatCompletion({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content:
            "You are a summarizer. You don't answer the prompts on your own. Instead, you generate concise version of the text given following the instructions",
        },
        {
          role: "user",
          content: `Please make this as concise as possible: ${response}`,
        },
      ],
      temperature: 0.7,
      max_tokens: 2000,
      top_p: 1,
    });
    const isSummarizedResponse = isSummarizedResponseRes.data.choices
      .map(({ message: { content = "" } }) => content.trim())
      .join(" ");
    await poolQuery(
      `UPDATE zero_prompts SET responseSummary = ?, promptSummary = ? WHERE id = ?`,
      [isSummarizedResponse, row.id]
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
