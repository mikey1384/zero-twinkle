const request = require("axios");
const io = require("socket.io-client");
const URL = process.env.URL;
const socket = io.connect(URL);
const moment = require("moment");

const config = require("../../config");
const { auth } = config;
const { returnResponse } = require("../helpers/zero");
const { poolQuery, checkConditionsUsingGPT3 } = require("../helpers");

const zeroId = Number(process.env.ZERO_TWINKLE_ID);
const channelId = Number(process.env.ZERO_CHAT_ROOM_ID);

const contextAndPromptLengthLimit = 1000;

async function checkAndRespondToProfileMessages(appliedTokens) {
  let latestCommentId = "";
  try {
    const {
      data: {
        comment,
        username,
        userAuthLevel,
        isReply,
        myPreviousComment: zerosPreviousComment,
      },
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
    context = `
Zero: This is the JSON object of our previous conversation ${JSON.stringify(
      recentExchangeArr
    )}${
      zerosPreviousComment?.content
        ? `\n\nZero: ${zerosPreviousComment?.content}`
        : ""
    }`;
    const {
      isAskingAboutZero,
      isAskingAboutCiel,
      isAskingAboutTwinkle,
      isAskingAboutUser,
      isRequireComplexAnswer,
    } = await checkConditionsUsingGPT3({
      prompt: `Zero: let's talk!\n${
        zerosPreviousComment?.content
          ? `Zero: ${zerosPreviousComment?.content}\n`
          : ""
      }${effectiveUsername}: ${prompt}
Zero: 
    `,
      effectiveUsername,
    });
    const { zerosResponse, reportMessage } = await returnResponse({
      appliedTokens: isRequireComplexAnswer
        ? appliedTokens + 1000
        : appliedTokens,
      context,
      shorterContext: zerosPreviousComment?.content
        ? `\nZero: ${zerosPreviousComment?.content}`
        : "",
      effectiveUsername,
      isAskingAboutZero,
      isAskingAboutCiel,
      isAskingAboutTwinkle,
      isAskingAboutUser,
      isRequireComplexAnswer,
      userId: comment.userId,
      userAuthLevel,
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
          rootId: zeroId,
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
    const { data: zero } = await request.get(`${URL}/user/session`, auth);
    const { data: { channel } = {} } = await request.get(
      `${URL}/chat/channel?channelId=${channelId}`,
      auth
    );
    const messageToSend = {
      ...message,
      id: messageId,
      username: zero.username,
      profilePicUrl: zero.profilePicUrl,
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
