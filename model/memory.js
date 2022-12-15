const request = require("axios");
const io = require("socket.io-client");
const URL = process.env.TWINKLE_URL;
const socket = io.connect(URL);
const { Configuration, OpenAIApi } = require("openai");
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);
const { poolQuery } = require("./");

const userId = Number(process.env.ZERO_TWINKLE_ID);
let user = null;
let channel = null;
const channelId = Number(process.env.ZERO_CHAT_ROOM_ID);
const auth = {
  headers: {
    "User-Agent": "AI-Zero",
    authorization: process.env.ZERO_TWINKLE_TOKEN,
  },
};
let processingQuery = false;

async function summarizeMemories() {
  if (processingQuery) return;
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
      SELECT id, prompt, response FROM prompts WHERE responseSummary IS NULL ORDER BY id DESC LIMIT 1;
    `
    );
    if (!row) return;
    const { prompt, response } = row;
    const isSummarizedPromptRes = await openai.createCompletion({
      model: "text-davinci-003",
      prompt: `When you enter a prompt, I am going to summarize it to 3 or fewer sentences. Enter your prompt here: \n\n${prompt}\n\n\n`,
      temperature: 0.7,
      max_tokens: 3000,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    });
    const isSummarizedPrompt = isSummarizedPromptRes.data.choices
      .map(({ text }) => text.trim())
      .join(" ");

    const isSummarizedResponseRes = await openai.createCompletion({
      model: "text-davinci-003",
      prompt: `When you enter my previous response, I am going to summarize it to 3 or fewer sentences. Enter my previous response here: \n\n${response}\n\n\n`,
      temperature: 0.7,
      max_tokens: 3000,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    });
    const isSummarizedResponse = isSummarizedResponseRes.data.choices
      .map(({ text }) => text.trim())
      .join(" ");
    await poolQuery(
      `UPDATE prompts SET responseSummary = ?, promptSummary = ? WHERE id = ?`,
      [isSummarizedResponse, isSummarizedPrompt, row.id]
    );
    const message = {
      content: `Hello Mikey. I made this summary.\n\nPrompt: ${isSummarizedPrompt}\n\nResponse: ${isSummarizedResponse}`,
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
        error?.response?.data
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
