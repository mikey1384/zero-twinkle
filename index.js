require("dotenv").config();
const request = require("axios");
const io = require("socket.io-client");
const URL = process.env.TWINKLE_URL;
const socket = io.connect(URL);
const { Configuration, OpenAIApi } = require("openai");
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);
const { poolQuery } = require("./model");

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
let processingSave = false;
const myComment = `who made you?`;

async function queryAPI() {
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
    const {
      data: { comment, username, isReply, myPreviousComment, rootComment },
    } = await request.get(`${URL}/zero/profile`, auth);
    const effectiveUsername = username === "mikey" ? "Mikey" : username;
    if (!comment?.id) {
      processingQuery = false;
      return;
    }
    let context = "";
    if (myPreviousComment) {
      context = `${rootComment ? `${rootComment.content} \n\n` : ""}${
        myPreviousComment.content
      } \n\n`;
    }
    const zeroResponse = await openai.createCompletion({
      model: "text-davinci-003",
      prompt: `Hello ${effectiveUsername}. My name is Zero, and I am an AI robot made by Mikey in December 2022. My purpose is to help users like you reach your full potential. However, this is not related to the topic at hand. I am currently talking to you on Twinkle Website, a community website created by Mikey for students and teachers of the English academy Twin.kle. The academy was founded by twin brothers, Andrew and Brian, who are Mikey's friends. However, this is not related to the current conversation. Talk to me, and I will happily respond using words that even 7-year-olds can understand. If I need to use a difficult English word that may be too hard for non-English students under 7 to understand, I will explain its meaning in brackets. Your name is ${effectiveUsername}. ${
        effectiveUsername === "Mikey" ? "And you are my creator. " : ""
      }Let's chat! ${context}enter your prompt, ${effectiveUsername}: \n\n\n ${
        comment.content
      }\n\n\n`,
      temperature: 0.7,
      max_tokens: 3000,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    });
    const reply = `${zeroResponse.data.choices
      .map(({ text }) => text.trim())
      .join(" ")}`;
    await request.post(
      `${URL}/content/comments`,
      {
        content: reply,
        rootCommentId: isReply ? comment.commentId : null,
        targetCommentId: comment.id,
        parent: {
          contentId: comment.id,
          contentType: "comment",
          rootType: "user",
          rootId: user.id,
        },
      },
      auth
    );
    if (comment.id) {
      await poolQuery(
        `INSERT INTO comments (id, userId, prompt, response, timeStamp, imported) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE prompt = ?, response = ?, timeStamp = ?`,
        [
          comment.id,
          comment.userId,
          comment.content,
          reply,
          comment.timeStamp,
          1,
          comment.content,
          reply,
          comment.timeStamp,
        ]
      );
    }
    const message = {
      content: `Hello Mikey. I got this message on my profile "${comment.content}." This was the context, "${context}", and this was my response "${reply}"`,
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
    if (!messageId) {
      processingQuery = false;
      return;
    }
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

setInterval(queryAPI, 60 * 1000);
