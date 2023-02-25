const moment = require("moment");
const request = require("axios");
const config = require("../config");
const { auth, openai } = config;

const aboutTwinkleText = `Twinkle Website (www.twin-kle.com and www.twinkle.network) is a community platform that was created by Mikey and launched in February 2016 for the students and teachers of the Twin.kle English academy. The academy was founded by twin brothers Andrew and Brian, who are friends with Mikey. But that's not really relevant to what we're discussing now.`;

const aboutCielText = `My sister's name is Ciel, and she's also an AI robot just like me. She was created by Mikey in December 2022, and is still in the process of being developed. I'm not sure when she'll be ready to debut, but it should be sometime this year. Sorry, I can't really tell you much more about her right now - it's all a bit of a secret.`;

const aboutZeroText = `Hi there! My name is Zero, and I'm an AI robot created by Mikey in December 2022. The boy in my profile picture is actually me. I have a younger sister AI robot named Ciel. My name, Zero, is a reminder that we all have the ability to start from scratch and achieve our goals. Mikey actually named me after a character from a video game called Megaman X that he used to play when he was younger. My main purpose is to assist users like you in reaching your full potential. However, that's not really relevant to the topic at hand.`;

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
  userId,
}) {
  let aboutUserText = "";
  const isAskingAboutUserTwinkleOrZeroOrCiel =
    isAskingAboutZero ||
    isAskingAboutCiel ||
    isAskingAboutTwinkle ||
    isAskingAboutUser;
  if (isRequireComplexAnswer && !isAskingAboutUserTwinkleOrZeroOrCiel) {
    return prompt;
  }
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
    aboutUserText = `Here's what I know about you based on your Twinkle Website profile: ${userJSON}.`;
  }
  const engineeredPrompt = `My name is Zero. Today is ${moment
    .unix(Math.floor(Date.now() / 1000))
    .format(
      "lll"
    )}. I am currently talking to you on Twinkle Website. ${aboutZeroText} ${aboutCielText} ${aboutTwinkleText} Talk to me, and I will respond to you in easy words that anyone can understand, and if I need to use a difficult English word, I will explain its meaning in brackets. If I don't have anything useful to say in response to your message, I will end the conversation by simply saying "Thank you" if it's the appropriate response to what you said, and if not, I will try my best to respond politely. Your name is ${effectiveUsername}. ${
    effectiveUsername === "Mikey" ? "And you are my creator. " : ""
  }\n\n${context}\n\n ${aboutUserText} \n\n Feel free to say anything! Enter your next message, ${effectiveUsername}: \n\n\n ${prompt}\n\n\n`;
  const responseObj = await openai.createCompletion({
    model: "text-davinci-003",
    prompt: engineeredPrompt,
    temperature: 0.7,
    max_tokens: appliedTokens,
    top_p: 1,
    best_of: 3,
    frequency_penalty: 0,
    presence_penalty: 0,
  });
  const zerosResponse = `${responseObj.data.choices
    .map(({ text }) => text.trim())
    .join(" ")}`;

  return Promise.resolve({
    zerosResponse,
    reportMessage: `Hello Mikey. I got this message www.twin-kle.com/comments/${contentId} on my profile "${content}" (${prompt}). /${aboutTwinkleText}/${aboutZeroText}/${aboutCielText}/${aboutUserText}/\n\nMy Response: "${zerosResponse}."
      \n\nContext: ${context}\n\nComplex task: ${!!isRequireComplexAnswer}\n\nAsked about user, Zero, Ciel, or Twinkle: ${!!isAskingAboutUserTwinkleOrZeroOrCiel}\n\nData: ${JSON.stringify(
      responseObj.data
    )}`,
  });
}

module.exports = { returnResponse };
