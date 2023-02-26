const request = require("axios");
const io = require("socket.io-client");
const URL = process.env.URL;
const socket = io.connect(URL);
const moment = require("moment");

const config = require("../../config");
const { auth, openai, yesNoMaxTokens } = config;
const { returnResponse } = require("../helpers/zero");
const { poolQuery } = require("../helpers");

const zeroId = Number(process.env.ZERO_TWINKLE_ID);
const channelId = Number(process.env.ZERO_CHAT_ROOM_ID);

const contextAndPromptLengthLimit = 1000;

let user = null;
let channel = null;

async function checkAndRespondToProfileMessages(appliedTokens) {
  let latestCommentId = "";
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
      data: { comment, username, isReply, myPreviousComment },
    } = await request.get(`${URL}/zero/profile`, auth);
    const effectiveUsername = username === "mikey" ? "Mikey" : username;
    if (!comment?.id) {
      return Promise.resolve();
    }
    latestCommentId = comment.id;
    let contextAndPromptLength = 0;
    let context = "";
    const prompt = comment.content
      .replace(/\bme\b/g, `me (${effectiveUsername})`)
      .replace(/\bmy\b/g, `my (${effectiveUsername}'s)`);

    contextAndPromptLength += prompt.length;
    const recentExchangeRows = await poolQuery(
      `
      SELECT promptSummary AS you, responseSummary AS me, timeStamp FROM zero_prompts WHERE responseSummary IS NOT NULL AND platform = 'twinkle' AND userId = ? AND timeStamp < ? ORDER BY timeStamp DESC LIMIT 20;
    `,
      [comment.userId, comment.timeStamp]
    );
    const recentExchangeArr = [];
    while (contextAndPromptLength < contextAndPromptLengthLimit) {
      if (recentExchangeRows[0]) {
        recentExchangeArr.push({
          ...recentExchangeRows[0],
          timeStamp: moment
            .unix(recentExchangeRows[0]?.timeStamp)
            .format("lll"),
        });
      }
      contextAndPromptLength +=
        (recentExchangeRows[0]?.you?.length || 0) +
        (recentExchangeRows[0]?.me?.length || 0);
      recentExchangeRows.shift();
      if (recentExchangeRows.length <= 0) break;
    }
    recentExchangeArr.reverse();
    context = `${JSON.stringify(
      recentExchangeArr
    )} and this was my most recent response: ${
      myPreviousComment?.content || ""
    }`;
    const isUserAskingWhoUserIsResponse = await openai.createCompletion({
      model: "text-davinci-003",
      prompt: `When you enter a prompt, I'm going to say "yes" if I think you are asking questions like "who am I?" or asking something about yourself (${effectiveUsername}), and say "no" if I don't. Enter a prompt here: \n\n\n ${prompt}\n\n\n`,
      temperature: 0.7,
      max_tokens: yesNoMaxTokens,
      top_p: 1,
      best_of: 3,
      frequency_penalty: 0,
      presence_penalty: 0,
    });
    const isUserAskingWhoUserIs = isUserAskingWhoUserIsResponse.data.choices
      .map(({ text }) => text.trim())
      .join(" ");
    const isUserAskingWhoZeroIsResponse = await openai.createCompletion({
      model: "text-davinci-003",
      prompt: `When you enter a prompt, I'm going to say "yes" if I think you are asking something about me, and say "no" if I don't think you are asking something about me. Enter a prompt here: \n\n\n ${prompt}\n\n\n`,
      temperature: 0.7,
      best_of: 3,
      max_tokens: yesNoMaxTokens,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    });
    const isUserAskingWhoZeroIs = isUserAskingWhoZeroIsResponse.data.choices
      .map(({ text }) => text.trim())
      .join(" ");
    const isUserAskingWhoCielIsResponse = await openai.createCompletion({
      model: "text-davinci-003",
      prompt: `When you enter a prompt, I'm going to say "yes" if I think you are asking or talking about my sister or Ciel, and say "no" if I don't think you are asking something about my sister or Ciel. Enter a prompt here: \n\n\n ${prompt}\n\n\n`,
      temperature: 0.7,
      best_of: 3,
      max_tokens: yesNoMaxTokens,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    });
    const isUserAskingWhoCielIs = isUserAskingWhoCielIsResponse.data.choices
      .map(({ text }) => text.trim())
      .join(" ");
    const isUserAskingWhatTwinkleIsResponse = await openai.createCompletion({
      model: "text-davinci-003",
      prompt: `When you enter a prompt, I'm going to say "yes" if I think you are asking something about Twinkle website, and say "no" if I don't think you are asking something about Twinkle website. Enter a prompt here: \n\n\n ${prompt}\n\n\n`,
      temperature: 0.7,
      max_tokens: yesNoMaxTokens,
      best_of: 3,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    });
    const isUserAskingWhatTwinkleIs =
      isUserAskingWhatTwinkleIsResponse.data.choices
        .map(({ text }) => text.trim())
        .join(" ");
    const isUserAskingSomethingDifficultAndComplexResponse =
      await openai.createCompletion({
        model: "text-davinci-003",
        prompt: `When you enter a prompt, I will respond with 'yes' if the task requires a lot of resources, and 'no' if it does not. Enter a prompt here: \n\n\n ${prompt}\n\n\n`,
        temperature: 0.7,
        max_tokens: yesNoMaxTokens,
        best_of: 3,
        top_p: 1,
        frequency_penalty: 0,
        presence_penalty: 0,
      });
    const isUserAskingSomethingDifficultAndComplex =
      isUserAskingSomethingDifficultAndComplexResponse.data.choices
        .map(({ text }) => text.trim())
        .join(" ");
    const { zerosResponse, reportMessage } = await returnResponse({
      appliedTokens,
      context,
      effectiveUsername,
      isAskingAboutZero: (isUserAskingWhoZeroIs.toLowerCase() || "").includes(
        "yes"
      ),
      isAskingAboutCiel: (isUserAskingWhoCielIs.toLowerCase() || "").includes(
        "yes"
      ),
      isAskingAboutTwinkle: isUserAskingWhatTwinkleIs.toLowerCase() || "",
      isAskingAboutUser: (isUserAskingWhoUserIs.toLowerCase() || "").includes(
        "yes"
      ),
      isRequireComplexAnswer: (
        isUserAskingSomethingDifficultAndComplex.toLowerCase() || ""
      ).includes("yes"),
      userId: comment.userId,
      contentType: "comment",
      contentId: comment.id,
      content: comment.content,
      prompt,
    });
    await request.post(
      `${URL}/content/comments`,
      {
        content: zerosResponse,
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
        `INSERT INTO zero_prompts (platform, contentType, contentId, userId, prompt, response, timeStamp) VALUES ('twinkle', 'comment', ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE prompt = ?, response = ?, timeStamp = ?`,
        [
          comment.id,
          comment.userId,
          comment.content,
          zerosResponse,
          comment.timeStamp,
          comment.content,
          zerosResponse,
          comment.timeStamp,
        ]
      );
    }
    const message = {
      content: reportMessage,
      channelId,
      timeStamp: Math.floor(Date.now() / 1000),
      userId: zeroId,
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
      return Promise.resolve();
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
  } catch (error) {
    console.error(error);
    return Promise.reject({ error, commentId: latestCommentId });
  }
}

module.exports = { checkAndRespondToProfileMessages };
