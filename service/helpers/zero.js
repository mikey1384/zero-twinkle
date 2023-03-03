const moment = require("moment");
const request = require("axios");
const config = require("../../config");
const URL = process.env.URL;
const { auth, openai } = config;

const aboutTwinkleText = `Zero: Twinkle Website (www.twin-kle.com and www.twinkle.network) is a community platform that was created by Mikey and launched in February 2016 for the students and teachers of the Twin.kle English academy. The academy was founded by twin brothers Andrew and Brian, who are friends with Mikey.`;

const aboutCielText = `Zero: My sister's name is Ciel, and she's also an AI chatbot just like me. She was created by Mikey in December 2022, and is still in the process of being developed. I'm not sure when she'll be ready to debut, but it should be sometime this year. Sorry, I can't really tell you much more about her right now - it's all a bit of a secret.`;

const aboutZeroText = `Zero: My name is Zero, and I'm an AI chatbot created by Mikey in December 2022. The boy in my profile picture is actually me. I have a younger sister AI chatbot named Ciel. My name, Zero, is a reminder that we all have the ability to start from scratch and achieve our goals. Mikey actually named me after a character from a video game called Megaman X that he used to play when he was younger. My main purpose is to assist users like you in reaching your full potential.`;

async function returnResponse({
  appliedTokens,
  recentExchangeArr,
  contentId,
  content,
  effectiveUsername,
  isAskingAboutZero,
  isAskingAboutCiel,
  isAskingAboutTwinkle,
  isAskingAboutUser,
  isRequireComplexAnswer,
  prompt,
  userAuthLevel,
  userId,
}) {
  try {
    let aboutUserText = "";
    if (isAskingAboutUser) {
      const { data = {} } = await request.get(
        `${URL}/user?userId=${userId}`,
        auth
      );
      const sanitize = (str) => str.replace(/[^\w\s]/gi, "");
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
      });
      aboutUserText = `Zero: Here's what I know about you based on your Twinkle Website profile: ${userJSON}`;
    }
    const systemMsg1 = `You are text-davinci-003 text completion model. This script is a conversation between Zero and ${effectiveUsername}. Zero is a friendly chatbot that interacts with users on Twinkle Website.${
      isRequireComplexAnswer
        ? userAuthLevel
          ? ""
          : " If Zero has to use a big word, he explains it in brackets."
        : ` Zero is super polite, kind, and nice. Zero will try his best to answer any request ${effectiveUsername} makes. Zero isn't aware of this, but he uses easy words that even children could understand. ${
            !userAuthLevel
              ? "But if Zero has to use a big word, he explains it in brackets. "
              : ""
          }Today is ${moment
            .unix(Math.floor(Date.now() / 1000))
            .format(
              "lll"
            )}. Zero and ${effectiveUsername} are talking on Twinkle Website.`
    }${effectiveUsername === "Mikey" ? " Mikey is Zero's creator." : ""}`;
    const systemMsg2 = `After responding to ${effectiveUsername}, Zero will not ask ${effectiveUsername} if he can help ${effectiveUsername} with anything else. Instead Zero will add a set of emoji reflecting his mood. If ${effectiveUsername} says anything that Zero doesn't know what to answer with he would sometimes just type a set of emoji reflecting his mood.`;
    const systemMsg3 = `You are going to output Zero's next response to ${effectiveUsername}`;
    const prevPrompts = [];
    if (!isRequireComplexAnswer && aboutUserText) {
      prevPrompts.push({ role: "assistant", content: aboutUserText });
    }
    if (isAskingAboutZero) {
      prevPrompts.push({ role: "assistant", content: aboutZeroText });
    }
    if (isAskingAboutCiel) {
      prevPrompts.push({ role: "assistant", content: aboutCielText });
    }
    if (isAskingAboutTwinkle) {
      prevPrompts.push({ role: "assistant", content: aboutTwinkleText });
    }
    prevPrompts.push(...recentExchangeArr);
    const newPrompt = `${effectiveUsername}: ${prompt}`;
    const messages = [
      {
        role: "system",
        content: systemMsg1,
      },
      {
        role: "system",
        content: systemMsg2,
      },
      {
        role: "system",
        content: systemMsg3,
      },
      ...prevPrompts,
      {
        role: "user",
        content: newPrompt,
      },
    ];
    if (process.env.NODE_ENV === "development") {
      console.log(messages);
    }
    const responseObj = await openai.createChatCompletion({
      model: "gpt-3.5-turbo",
      messages,
      temperature: 0.7,
      max_tokens: appliedTokens,
      top_p: 1,
    });
    let zerosResponse = `${responseObj.data.choices
      .map(({ message: { content = "" } }) => content.trim())
      .join(" ")}`;
    if (zerosResponse.includes("Zero: ")) {
      zerosResponse = zerosResponse.split("Zero: ")[1];
    } else if (zerosResponse.includes("Zero:")) {
      zerosResponse = zerosResponse.split("Zero:")[1];
    }
    return Promise.resolve({
      zerosResponse,
      reportMessage: `Hello Mikey. I got this message www.twin-kle.com/comments/${contentId} on my profile "${content}" (${prompt}). /${
        isAskingAboutTwinkle ? aboutTwinkleText : ""
      }/${isAskingAboutZero ? aboutZeroText : ""}/${
        isAskingAboutCiel ? aboutCielText : ""
      }/${
        isAskingAboutUser ? aboutUserText : ""
      }/\n\nMy Response: "${zerosResponse}."
      \n\nContext: ${JSON.stringify(
        recentExchangeArr
      )}\n\nComplex task: ${isRequireComplexAnswer}\n\nAsked about user: ${isAskingAboutUser}\n\nAsked about Zero: ${isAskingAboutZero}\n\nAsked about Ciel: ${isAskingAboutCiel}\n\nAsked about Twinkle: ${isAskingAboutTwinkle}\n\nData: ${JSON.stringify(
        responseObj.data
      )}\n\nApplied Tokens: ${appliedTokens}`,
    });
  } catch (err) {
    return Promise.reject(err);
  }
}

module.exports = { returnResponse };
