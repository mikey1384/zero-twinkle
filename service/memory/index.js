const request = require("axios");
const io = require("socket.io-client");
const URL = process.env.URL;
const socket = io.connect(URL);
const config = require("../../config");
const { auth } = config;
const { encode } = require("gpt-3-encoder");
const { poolQuery } = require("../helpers");
const OpenAI = require("openai");
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const zeroId = Number(process.env.ZERO_TWINKLE_ID);
let user = null;
let channel = null;
const channelId = Number(process.env.ZERO_CHAT_ROOM_ID);
let processingQuery = false;

async function summarizeMemories() {
  let currentRowId = null;
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
    const [row] = await poolQuery(`
      SELECT id, prompt, response FROM ai_chatbot_prompts WHERE responseSummary IS NULL ORDER BY id DESC LIMIT 1;
    `);
    if (!row) {
      currentRowId = null;
      processingQuery = false;
      return;
    }
    currentRowId = row.id;
    const { prompt, response } = row;
    const isSummarizedPromptRes = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: `{"PhraseToMakeConcise": "Can you refactor this?
              const userJSON = JSON.stringify({
              username: data.username,
              realName: data.realName,
              email: data.email,
              bio: [
                (data.profileFirstRow || ""),
                (data.profileSecondRow || ""),
                (data.profileThirdRow || ""),
              ],
              greeting: (data.greeting || ""),
              twinkleXP: data.twinkleXP,
              joinDate: moment.unix(data.joinDate).format("lll"),
              userType: data.userType,
              statusMsg: (data.statusMsg || ""),
              profileTheme: data.profileTheme,
              youtubeUrl: data.youtubeUrl,
              website: data.website,
            });"}\n\nSuper Concise Version: `,
        },
        {
          role: "assistant",
          content: `Please refactor this code [code about making JSON object]`,
        },
        {
          role: "user",
          content: `{"PhraseToMakeConcise": "good now make it longer - about 500 words"}\n\nSuper Concise Version: `,
        },
        {
          role: "assistant",
          content: `Make it longer (500 words)`,
        },
        {
          role: "user",
          content: `{"PhraseToMakeConcise": "What is Twinkle?"}\n\nSuper Concise Version: `,
        },
        {
          role: "assistant",
          content: `What is Twinkle?`,
        },
        {
          role: "user",
          content: `{"PhraseToMakeConcise": "good! tell me 50 SAT level words and their definitions?"}\n\nSuper Concise Version: `,
        },
        {
          role: "assistant",
          content: `50 SAT words and definition?`,
        },
        {
          role: "user",
          content: `{"PhraseToMakeConcise": "make it longer"}\n\nSuper Concise Version: `,
        },
        {
          role: "assistant",
          content: `make it longer`,
        },
        {
          role: "user",
          content: `{"PhraseToMakeConcise": "${trimPrompt(
            prompt
          )}"}\n\nSuper Concise Version: `,
        },
      ],
      max_tokens: 50,
      top_p: 0.1,
    });
    const isSummarizedPrompt = isSummarizedPromptRes.choices
      .map(({ message: { content = "" } }) => content.trim())
      .join(" ");
    const isSummarizedResponseRes = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: `Original Version: "Sure, here's a possible refactored version:
              const userJSON = JSON.stringify({
              username: data.username,
              realName: data.realName,
              email: data.email,
              bio: [
                sanitize(data.profileFirstRow || ""),
                sanitize(data.profileSecondRow || ""),
                sanitize(data.profileThirdRow || ""),
              ],
              greeting: sanitize(data.greeting || ""),
              twinkleXP: data.twinkleXP,
              joinDate: moment.unix(data.joinDate).format("lll"),
              userType: data.userType,
              statusMsg: sanitize(data.statusMsg || ""),
              profileTheme: data.profileTheme,
              youtubeUrl: data.youtubeUrl,
              website: data.website,
            });\nFirst, I extracted the logic of replacing special characters into a new function called sanitize. Then, I used this function to sanitize all the relevant input fields, making the code more concise and easier to read."\n\nSuper Concise Version: `,
        },
        {
          role: "assistant",
          content: `Sure, [new code after sanitizing all the relevant input fields]. Extracted the logic to new function.`,
        },
        {
          role: "user",
          content: `Original Version: "I'm glad to hear that, Mikey! 😊"\n\nSuper Concise Version: `,
        },
        {
          role: "assistant",
          content: `Glad to hear, Mikey! 😊`,
        },
        {
          role: "user",
          content: `Original Version: "It is said that a long time ago, there was a small village nestled in the mountains. One day, a group of travelers passed through and decided to stay at the local inn. During the night, they reported hearing strange noises and seeing shadowy figures walking around their rooms. The next morning, the travelers were found dead. The townspeople claimed they had been killed by the spirits that haunted the inn. Even to this day, people avoid staying there, for fear of encountering the malevolent spirits. 👻🌲🏚️"\n\nSuper Concise Version: `,
        },
        {
          role: "assistant",
          content:
            "A haunted inn in a mountain village is avoided by people due to reports of malevolent spirits that killed travelers who stayed there.",
        },
        {
          role: "user",
          content: `🤖👦🎨\n\nSuper Concise Version: `,
        },
        {
          role: "assistant",
          content: "🤖👦🎨",
        },
        {
          role: "user",
          content: `Original Version: "${trimPrompt(
            response
          )}"\n\nSuper Concise Version: `,
        },
      ],
      max_tokens: 50,
      top_p: 0.1,
    });
    const isSummarizedResponse = isSummarizedResponseRes.choices
      .map(({ message: { content = "" } }) => content.trim())
      .join(" ");
    await poolQuery(
      `UPDATE ai_chatbot_prompts SET responseSummary = ?, promptSummary = ? WHERE id = ?`,
      [isSummarizedResponse, isSummarizedPrompt, row.id]
    );
    /*
    const message = {
      content: `Hello Mikey. I made this summary.\n\n${isSummarizedPrompt}\n\n${isSummarizedResponse}`,
      channelId,
      timeStamp: Math.floor(Date.now() / 1000),
      userId: zeroId,
      isNotification: true,
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
    */
    processingQuery = false;
  } catch (error) {
    try {
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
      if (currentRowId) {
        await poolQuery(
          `UPDATE ai_chatbot_prompts SET responseSummary = 'There was an error summarizing this memory.' WHERE id = ${currentRowId};`
        );
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
        userId: zeroId,
        isNotification: true,
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
      processingQuery = false;
    }
  }
}

function trimPrompt(finalPrompt) {
  let trimmedPrompt = finalPrompt || "";
  let encoded = encode(trimmedPrompt);
  let encodedLength = encoded.length;

  while (encodedLength > 500) {
    const trimAmount = 10;
    trimmedPrompt = trimmedPrompt.slice(0, -trimAmount);
    encoded = encode(trimmedPrompt);
    encodedLength = encoded.length;
  }

  return trimmedPrompt;
}

module.exports = { summarizeMemories };
