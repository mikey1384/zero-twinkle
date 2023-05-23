const request = require("axios");
const moment = require("moment");
const io = require("socket.io-client");
const URL = process.env.URL;
const socket = io.connect(URL);

const config = require("../../config");
const { auth } = config;
const { returnResponse } = require("../helpers/zero");
const { poolQuery, checkConditionsUsingGPT } = require("../helpers");

const zeroId = Number(process.env.ZERO_TWINKLE_ID);
const channelId = Number(process.env.ZERO_CHAT_ROOM_ID);

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
    let prompt = comment.content;
    const recentExchangeRows = await poolQuery(
      `
      SELECT prompt, response, timeStamp FROM zero_prompts WHERE response IS NOT NULL AND platform = 'twinkle' AND userId = ? AND timeStamp < ? ORDER BY timeStamp DESC LIMIT 5;
    `,
      [comment.userId, comment.timeStamp]
    );
    recentExchangeRows.reverse();
    let recentExchanges = "";
    for (let row of recentExchangeRows) {
      recentExchanges += `${effectiveUsername}: ${row.prompt.substring(
        0,
        200
      )} (${moment
        .unix(row.timeStamp)
        .format("lll")})\nZero: ${row.response.substring(0, 200)} (${moment
        .unix(row.timeStamp)
        .format("lll")})\n`;
    }
    if (zerosPreviousComment?.content) {
      recentExchanges += `Zero: ${zerosPreviousComment?.content} (${moment
        .unix(zerosPreviousComment?.timeStamp)
        .format("lll")})\n`;
    }
    const {
      isAskingWhoZeroIs,
      isRequestingSelfIntro,
      isAskingToTalkAboutUser,
      isZerosProfileRelated,
      isAskingZerosDesire,
      isTalkingZerosGender,
      isAskingZerosProperties,
      isAskingAboutCiel,
      isAskingAboutTwinkle,
      isAskingAboutUser,
      isAskingFactualQuestion,
      isAskingMathQuestion,
      isWantsSomethingExplained,
      isNotAskingQuestion,
      userIsCommandingZero,
      userIsRequestingZero,
      userWantsSomethingDone,
      isInterjection,
      isWrongJSONFormat,
    } = await checkConditionsUsingGPT({
      prompt: `Zero: Hello, ${effectiveUsername}. What can I do for you?\n\n${effectiveUsername}: ${prompt}`,
      effectiveUsername,
    });
    const { zerosResponse, reportMessage } = await returnResponse({
      appliedTokens,
      recentExchanges,
      effectiveUsername,
      isAskingWhoZeroIs:
        isAskingWhoZeroIs ||
        isRequestingSelfIntro ||
        isZerosProfileRelated ||
        isAskingZerosDesire ||
        isTalkingZerosGender ||
        isAskingZerosProperties,
      isAskingAboutCiel,
      isAskingAboutTwinkle,
      isAskingAboutUser: isAskingToTalkAboutUser || isAskingAboutUser,
      isWantsSomethingExplained:
        isAskingFactualQuestion || isWantsSomethingExplained,
      isAskingMathQuestion,
      isNotAskingQuestion,
      isNotRequestingAnything: !(
        userIsCommandingZero ||
        userIsRequestingZero ||
        userWantsSomethingDone
      ),
      isInterjection,
      isWrongJSONFormat,
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
