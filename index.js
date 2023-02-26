require("dotenv").config();
const request = require("axios");
const {
  checkAndRespondToProfileMessages,
  summarizeMemories,
  tagVideosToPlaylist,
} = require("./service");
const config = require("./config");
const { auth } = config;
const io = require("socket.io-client");
const URL = process.env.URL;
const socket = io.connect(URL);
const zeroId = Number(process.env.ZERO_TWINKLE_ID);
const channelId = Number(process.env.ZERO_CHAT_ROOM_ID);

const respondProfileMsgInterval = 30;
const summarizeMemoriesInterval = 20;
const tagVideosToPlaylistInterval = 60;
const defaultMaxTokens = 3300;

async function runCheckAndRespondToProfileMessages({
  appliedTokens = defaultMaxTokens,
  nextInterval = respondProfileMsgInterval,
} = {}) {
  try {
    await checkAndRespondToProfileMessages(appliedTokens);
    nextInterval = respondProfileMsgInterval;
    appliedTokens = defaultMaxTokens;
  } catch (error) {
    const { commentId } = error;
    const { data: zero } = await request.get(`${URL}/user/session`, auth);
    const { data: { channel = {} } = {} } = await request.get(
      `${URL}/chat/channel?channelId=${channelId}`,
      auth
    );
    const message = {
      content: `Hello Mikey. I got this error while responding to www.twin-kle.com/comments/${commentId} (applied token: ${appliedTokens}) "${JSON.stringify(
        error?.response?.data
      )}."`,
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
    appliedTokens = Math.floor(appliedTokens * 0.8);
    nextInterval = nextInterval * 2;
  } finally {
    setTimeout(
      () =>
        runCheckAndRespondToProfileMessages({
          appliedTokens: Math.max(appliedTokens, 0),
          nextInterval,
        }),
      nextInterval * 1000
    );
  }
}

setInterval(summarizeMemories, summarizeMemoriesInterval * 1000);
setInterval(tagVideosToPlaylist, tagVideosToPlaylistInterval * 1000);
runCheckAndRespondToProfileMessages();
