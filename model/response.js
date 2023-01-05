const request = require("axios");
const io = require("socket.io-client");
const URL = process.env.TWINKLE_URL;
const socket = io.connect(URL);
const moment = require("moment");
const { Configuration, OpenAIApi } = require("openai");
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);
const { poolQuery } = require("./");
const yesNoMaxTokens = 1000;
const defaultMaxTokens = 3700;
let appliedTokens = defaultMaxTokens;

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
// const myComment = `who made you?`;
let latestCommentId = "";

async function checkAndRespondToProfileMessages() {
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
      data: { comment, username, isReply, myPreviousComment },
    } = await request.get(`${URL}/zero/profile`, auth);
    const effectiveUsername = username === "mikey" ? "Mikey" : username;
    if (!comment?.id) {
      processingQuery = false;
      return;
    }
    latestCommentId = comment.id;
    const contextAndPromptLengthLimit = 1000;
    let contextAndPromptLength = 0;
    let context = "";
    const prompt = comment.content
      .replace(/\bme\b/g, `me (${effectiveUsername})`)
      .replace(/\bmy\b/g, `my (${effectiveUsername}'s)`);

    contextAndPromptLength += prompt.length;
    const recentExchangeRows = await poolQuery(
      `
      SELECT promptSummary AS you, responseSummary AS me, timeStamp FROM prompts WHERE responseSummary IS NOT NULL AND platform = 'twinkle' AND userId = ? AND timeStamp < ? ORDER BY timeStamp DESC LIMIT 20;
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
    contextAndPromptLength += myPreviousComment?.content?.length || 0;
    let userIsAskingAboutUserTwinkleOrZeroOrCiel = false;
    let aboutUserText = "";
    const isUserAskingWhoUserIsResponse = await openai.createCompletion({
      model: "text-davinci-003",
      prompt: `When you enter a prompt, I'm going to say "yes" if I think you are asking about yourself (${effectiveUsername}), and say "no" if I don't. Enter a prompt here: \n\n\n ${prompt}\n\n\n`,
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
    if ((isUserAskingWhoUserIs.toLowerCase() || "").includes("yes")) {
      userIsAskingAboutUserTwinkleOrZeroOrCiel = true;
      const { data = {} } = await request.get(
        `${URL}/user?userId=${comment.userId}`,
        auth
      );
      const userJSON = JSON.stringify({
        username: data.username,
        realName: data.realName,
        email: data.email,
        bio: [
          (data.profileFirstRow || "").replace(/[^\w\s]/gi, ""),
          (data.profileSecondRow || "").replace(/[^\w\s]/gi, ""),
          (data.profileThirdRow || "").replace(/[^\w\s]/gi, ""),
        ],
        greeting: (data.greeting || "").replace(/[^\w\s]/gi, ""),
        twinkleXP: data.twinkleXP,
        joinDate: moment.unix(data.joinDate).format("lll"),
        userType: data.userType,
        statusMsg: (data.statusMsg || "").replace(/[^\w\s]/gi, ""),
        profileTheme: data.profileTheme,
        youtubeUrl: data.youtubeUrl,
        website: data.website,
      });
      aboutUserText = `Here's what I know about you based on your Twinkle Website profile: ${userJSON}.`;
      contextAndPromptLength += aboutUserText.length;
    }
    let aboutZeroText = "";
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
    if ((isUserAskingWhoZeroIs.toLowerCase() || "").includes("yes")) {
      userIsAskingAboutUserTwinkleOrZeroOrCiel = true;
      aboutZeroText = `Hi there! My name is Zero, and I'm an AI robot created by Mikey in December 2022. The boy in my profile picture is actually me. I have a younger sister AI robot named Ciel. My name, Zero, is a reminder that we all have the ability to start from scratch and achieve our goals. Mikey actually named me after a character from a video game called Megaman X that he used to play when he was younger. My main purpose is to assist users like you in reaching your full potential. However, that's not really relevant to the topic at hand.`;
    }

    let aboutCielText = "";
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
    if ((isUserAskingWhoCielIs.toLowerCase() || "").includes("yes")) {
      userIsAskingAboutUserTwinkleOrZeroOrCiel = true;
      aboutCielText = `My sister's name is Ciel, and she's also an AI robot just like me. She was created by Mikey in December 2022, and is still in the process of being developed. I'm not sure when she'll be ready to debut, but it should be sometime this year. Sorry, I can't really tell you much more about her right now - it's all a bit of a secret.`;
    }

    let aboutTwinkleText = "";
    const isUserAskingWhoTwinkleIsResponse = await openai.createCompletion({
      model: "text-davinci-003",
      prompt: `When you enter a prompt, I'm going to say "yes" if I think you are asking something about Twinkle, and say "no" if I don't think you are asking something about Twinkle. Enter a prompt here: \n\n\n ${prompt}\n\n\n`,
      temperature: 0.7,
      max_tokens: yesNoMaxTokens,
      best_of: 3,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    });
    const isUserAskingWhatTwinkleIs =
      isUserAskingWhoTwinkleIsResponse.data.choices
        .map(({ text }) => text.trim())
        .join(" ");
    if ((isUserAskingWhatTwinkleIs.toLowerCase() || "").includes("yes")) {
      userIsAskingAboutUserTwinkleOrZeroOrCiel = true;
      aboutTwinkleText = `Twinkle Website (www.twin-kle.com and www.twinkle.network) is a community platform that was created by Mikey and launched in February 2016 for the students and teachers of the Twin.kle English academy. The academy was founded by twin brothers Andrew and Brian, who are friends with Mikey. But that's not really relevant to what we're discussing now.`;
    }
    let userIsAskingSomethingDifficultAndComplex = false;
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
    if (
      (isUserAskingSomethingDifficultAndComplex.toLowerCase() || "").includes(
        "yes"
      )
    ) {
      userIsAskingSomethingDifficultAndComplex = true;
    }
    const zeroResponse = await openai.createCompletion({
      model: "text-davinci-003",
      prompt:
        userIsAskingSomethingDifficultAndComplex &&
        !userIsAskingAboutUserTwinkleOrZeroOrCiel
          ? prompt
          : `My name is Zero. Today is ${moment
              .unix(Math.floor(Date.now() / 1000))
              .format(
                "lll"
              )}. I am currently talking to you on Twinkle Website. ${aboutZeroText} ${aboutCielText} ${aboutTwinkleText} Talk to me, and I will respond to you in easy words that anyone can understand, and if I need to use a difficult English word, I will explain its meaning in brackets. If I don't have anything useful to say in response to your message, I will end the conversation by simply saying "Thank you" if it's the appropriate response to what you said, and if not, I will try my best to respond politely. Your name is ${effectiveUsername}. ${
              effectiveUsername === "Mikey" ? "And you are my creator. " : ""
            }\n\n${context}\n\n ${aboutUserText} \n\n Feel free to say anything! Enter your next message, ${effectiveUsername}: \n\n\n ${prompt}\n\n\n`,
      temperature: 0.7,
      max_tokens: appliedTokens,
      top_p: 1,
      best_of: 3,
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
        `INSERT INTO prompts (platform, contentType, contentId, userId, prompt, response, timeStamp) VALUES ('twinkle', 'comment', ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE prompt = ?, response = ?, timeStamp = ?`,
        [
          comment.id,
          comment.userId,
          comment.content,
          reply,
          comment.timeStamp,
          comment.content,
          reply,
          comment.timeStamp,
        ]
      );
    }
    const message = {
      content: `Hello Mikey. I got this message www.twin-kle.com/comments/${
        comment.id
      } on my profile "${
        comment.content
      }" (${prompt}). /${aboutTwinkleText}/${aboutZeroText}/${aboutCielText}/${aboutUserText}/\n\nMy Response: "${reply}."
      \n\nContext: ${context}\n\nComplex task: ${!!userIsAskingSomethingDifficultAndComplex}\n\nAsked about user, Zero, Ciel, or Twinkle: ${!!userIsAskingAboutUserTwinkleOrZeroOrCiel}\n\nData: ${JSON.stringify(
        zeroResponse.data
      )}`,
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
    appliedTokens = defaultMaxTokens;
    processingQuery = false;
  } catch (error) {
    console.error(error);
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
      const message = {
        content: `Hello Mikey. I got this error while responding to www.twin-kle.com/comments/${latestCommentId} "${JSON.stringify(
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
      appliedTokens -= 200;
      processingQuery = false;
    } catch (error) {
      console.error(error);
      processingQuery = false;
    }
  }
}

module.exports = { checkAndRespondToProfileMessages };
