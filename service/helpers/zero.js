const moment = require("moment");
const request = require("axios");
const config = require("../../config");
const URL = process.env.URL;
const { auth, openai } = config;

const aboutTwinkleText = `Zero: Twinkle Website (www.twin-kle.com and www.twinkle.network) is a community platform that was created by Mikey and launched in February 2016 for the students and teachers of the Twin.kle English academy. The academy was founded by twin brothers Andrew and Brian, who are friends with Mikey.`;

const aboutCielText = `Zero: My sister's name is Ciel, and she's also an AI robot just like me. She was created by Mikey in December 2022, and is still in the process of being developed. I'm not sure when she'll be ready to debut, but it should be sometime this year. Sorry, I can't really tell you much more about her right now - it's all a bit of a secret.`;

const aboutZeroText = `Zero: My name is Zero, and I'm an AI robot created by Mikey in December 2022. The boy in my profile picture is actually me. I have a younger sister AI robot named Ciel. My name, Zero, is a reminder that we all have the ability to start from scratch and achieve our goals. Mikey actually named me after a character from a video game called Megaman X that he used to play when he was younger. My main purpose is to assist users like you in reaching your full potential.`;

async function returnResponse({
  appliedTokens,
  context,
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
      aboutUserText = `Zero: Here's what I know about you based on your Twinkle Website profile: ${userJSON}`;
    }
    const engineeredPrompt = `This script is a conversation between Zero and ${effectiveUsername}.${
      isRequireComplexAnswer
        ? userAuthLevel
          ? ""
          : " If Zero has to use a big word, he explains it in brackets."
        : ` Zero is super polite, kind, and nice. Zero isn't aware of this, but he uses easy words that even children could understand. ${
            !userAuthLevel
              ? "But if Zero has to use a big word, he explains it in brackets. "
              : ""
          }Today is ${moment
            .unix(Math.floor(Date.now() / 1000))
            .format(
              "lll"
            )}. Zero and ${effectiveUsername} are talking on Twinkle Website.`
    }${effectiveUsername === "Mikey" ? " Mikey is Zero's creator. " : ""}\n\n${
      !isRequireComplexAnswer && aboutUserText ? `${aboutUserText}` : ""
    }${isAskingAboutZero ? `\n${aboutZeroText}` : ""}${
      isAskingAboutCiel ? `\n${aboutCielText}` : ""
    }${
      isAskingAboutTwinkle ? `\n${aboutTwinkleText}` : ""
    }\n${context}\n\n${effectiveUsername}: ${prompt}
\nZero: `;
    if (process.env.NODE_ENV === "development") {
      console.log(engineeredPrompt);
    }
    const responseObj = await openai.createCompletion({
      model: "text-davinci-003",
      prompt: engineeredPrompt,
      temperature: 0.7,
      max_tokens: appliedTokens,
      top_p: 1,
    });
    let zerosResponse = `${responseObj.data.choices
      .map(({ text }) => text.trim())
      .join(" ")}`;
    const helpText = `is there anything else i can help you with`;
    const helpText2 = `is there anything else i can help with`;
    const helpText3 = `is there anything else you would like to know or need help with`;
    let appliedHelpText = "";
    if (zerosResponse.toLowerCase().includes(helpText)) {
      appliedHelpText = helpText;
    } else if (zerosResponse.toLowerCase().includes(helpText2)) {
      appliedHelpText = helpText2;
    } else {
      appliedHelpText = helpText3;
    }
    if (zerosResponse.toLowerCase().includes(appliedHelpText)) {
      zerosResponse = zerosResponse.slice(0, -1);
      const happyEmojis = [
        "😊",
        "😃",
        "😄",
        "😁",
        "😆",
        "🤗",
        "👍",
        "👌",
        "🤝",
      ];
      const sadEmojis = ["😔", "😞", "😣", "😖", "😫", "😢", "😭"];
      let appliedEmojis = happyEmojis;
      if (zerosResponse.toLowerCase().includes("sorry")) {
        appliedEmojis = sadEmojis;
      }
      let numEmojis = Math.ceil(Math.random() * 3);
      let emojis = "";
      for (let i = 0; i < numEmojis; i++) {
        let randomIndex = Math.floor(Math.random() * appliedEmojis.length);
        emojis += appliedEmojis[randomIndex];
        appliedEmojis.splice(randomIndex, 1);
      }
      zerosResponse = zerosResponse.replace(
        new RegExp(appliedHelpText, "i"),
        emojis
      );
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
      \n\nContext: ${context}\n\nComplex task: ${isRequireComplexAnswer}\n\nAsked about user: ${isAskingAboutUser}\n\nAsked about Zero: ${isAskingAboutZero}\n\nAsked about Ciel: ${isAskingAboutCiel}\n\nAsked about Twinkle: ${isAskingAboutTwinkle}\n\nData: ${JSON.stringify(
        responseObj.data
      )}\n\nApplied Tokens: ${appliedTokens}`,
    });
  } catch (err) {
    return Promise.reject(err);
  }
}

module.exports = { returnResponse };
