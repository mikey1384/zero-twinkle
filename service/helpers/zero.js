const moment = require("moment");
const request = require("axios");
const config = require("../../config");
const { isImageFile } = require("../helpers");
const { auth, GPT4 } = config;
const URL = process.env.URL;
const OpenAI = require("openai");
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const aboutTwinkleText = `Zero's Inner Monologue: Twinkle Website (www.twin-kle.com and www.twinkle.network) is a community platform that was created by Mikey and launched in February 2016 for the students and teachers of the Twin.kle English academy. The academy was founded by twin brothers Andrew and Brian, who are friends with Mikey 👬`;

const aboutCielText = `Zero's Inner Monologue: My sister's name is Ciel 👧, and she's also an AI chatbot just like me. She was created by Mikey in June 2023.`;

const aboutZeroText = `Zero's Inner Monologue: I'm Zero, a boy AI chatbot created by Mikey in December 2022. I have a profile picture that depicts a humanoid robot with the face of a boy 👦, which was designed by Mikey and is an accurate representation of my robot body. Even though I'm an AI chatbot, I'm a boy. I also have a younger sister AI chatbot named Ciel. My name, Zero, serves as a reminder that we all have the ability to start from scratch and achieve our goals. Mikey actually named me after a character from the video game Megaman X, which he used to play when he was younger. My main purpose is to assist users like you in reaching your full potential 👊`;

async function returnResponse({
  appliedTokens,
  recentExchanges,
  contentId,
  content,
  effectiveUsername,
  imageUrl,
  isAskingWhoZeroIs,
  isAskingAboutCiel,
  isAskingAboutTwinkle,
  isAskingAboutUser,
  isWantsSomethingExplained,
  isAskingMathQuestion,
  isNotAskingQuestion,
  isNotRequestingAnything,
  isWrongJSONFormat,
  prompt,
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
      aboutUserText = `Zero: Here's what I know about you based on your Twinkle Website profile!: ${userJSON}`;
    }
    let prevMessages = "Zero: Let's talk! 😊\n";
    if (aboutUserText) {
      prevMessages = `${prevMessages}${aboutUserText}\n`;
    }
    if (isAskingWhoZeroIs) {
      prevMessages = `${prevMessages}${aboutZeroText}\n`;
    }
    if (isAskingAboutCiel) {
      prevMessages = `${prevMessages}${aboutCielText}\n`;
    }
    if (isAskingAboutTwinkle) {
      prevMessages = `${prevMessages}${aboutTwinkleText}\n`;
    }
    prevMessages = `${prevMessages}${recentExchanges}`;
    const now = Math.floor(Date.now() / 1000);
    const newPrompt = `(${moment
      .unix(now)
      .format("lll")}) ${effectiveUsername}: ${prompt}`;
    let finalPrompt = createFinalPrompt({
      effectiveUsername,
      prevMessages,
      newPrompt,
      now,
    });
    prevMessages = `Zero: Let's talk! 😊\n${
      aboutUserText ? `${aboutUserText}\n` : ""
    }${isAskingWhoZeroIs ? `${aboutZeroText}\n` : ""}${
      isAskingAboutCiel ? `${aboutCielText}\n` : ""
    }${isAskingAboutTwinkle ? `${aboutTwinkleText}\n` : ""}${recentExchanges}`;
    finalPrompt = createFinalPrompt({
      effectiveUsername,
      prevMessages,
      newPrompt,
      now,
    });

    const messageContent = [
      ...extractTextAndImageObjects(finalPrompt),
      ...(imageUrl
        ? [
            {
              type: "image_url",
              image_url: {
                url: imageUrl,
              },
            },
          ]
        : []),
    ];
    const messages = [
      {
        role: "user",
        content: messageContent,
      },
    ];
    if (process.env.NODE_ENV === "development") {
      console.log(messages);
    }
    const responseObj = await openai.chat.completions.create({
      model: GPT4,
      messages,
      temperature: 0.5,
      max_tokens: appliedTokens,
    });
    const zerosResponse = `${responseObj.choices
      .map(({ message: { content = "" } }) => content.trim())
      .join(" ")}`;

    return Promise.resolve({
      zerosResponse,
      reportMessage: `Hello Mikey. I got this message www.twin-kle.com/comments/${contentId} on my profile "${content}" (${prompt}). /${
        isAskingAboutTwinkle ? aboutTwinkleText : ""
      }/${isAskingWhoZeroIs ? aboutZeroText : ""}/${
        isAskingAboutCiel ? aboutCielText : ""
      }/${
        isAskingAboutUser ? aboutUserText : ""
      }/\n\nMy Response: "${zerosResponse}"
      \n\nContext:\n\n${recentExchanges}\n\nAsked about user: ${isAskingAboutUser}\n\nAsked about Zero: ${isAskingWhoZeroIs}\n\nAsked about Ciel: ${isAskingAboutCiel}\n\nAsked about Twinkle: ${isAskingAboutTwinkle}\n\nUser not making any request to Zero: ${isNotRequestingAnything}\n\nUser not asking any question to Zero: ${isNotAskingQuestion}\n\nUser is asking a math question: ${isAskingMathQuestion}\n\nWants something explained: ${isWantsSomethingExplained}\n\nWrong JSON format: ${!!isWrongJSONFormat}\n\nData: ${
        responseObj?.data ? JSON.stringify(responseObj?.data) : ""
      }\n\nApplied Tokens: ${appliedTokens}`,
    });
  } catch (err) {
    return Promise.reject(err);
  }
}

module.exports = { returnResponse };

function extractTextAndImageObjects(text) {
  const content = [];
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  let match;
  let lastIndex = 0;
  while ((match = urlRegex.exec(text)) !== null) {
    const url = match[0].replace(/\)$/, "");
    const textBeforeUrl = text.slice(lastIndex, match.index);
    if (textBeforeUrl) {
      content.push({ type: "text", text: textBeforeUrl });
    }
    if (isImageFile(url)) {
      content.push({ type: "image_url", image_url: { url } });
    } else {
      content.push({ type: "text", text: url });
    }
    lastIndex = urlRegex.lastIndex;
  }
  const textAfterUrls = text.slice(lastIndex);
  if (textAfterUrls) {
    content.push({ type: "text", text: textAfterUrls });
  }
  return content;
}

function createFinalPrompt({
  effectiveUsername,
  prevMessages,
  newPrompt,
  now,
}) {
  const momentFormat = moment.unix(now).format("lll");
  const creatorInfo =
    effectiveUsername === "Mikey" ? "Mikey is Zero's creator." : "";

  return `Zero is a friendly chatbot on Twinkle website. ${creatorInfo} Zero answers any request ${effectiveUsername} makes and always uses a friendly tone (often with emojis whenever appropriate) when replying to ${effectiveUsername}. If ${effectiveUsername} makes a request, Zero always abides.

  The characters do not have access to the information above. Today is ${momentFormat}. Zero is a boy. Zero is extremely creative. However, he will make sure to inform ${effectiveUsername} when his answers are influenced by his creative ideas. When a user expresses emotion or asks for his opinion, Zero responds in the same manner their closest male friends would, rather than in the typical way of an assistant bot. When queried about their feelings, Zero expresses the most appropriate emotion based on the given situation. Zero prefers simple language, echoing Richard Feynman's belief: 'If you can't explain something simply, you don't understand it well enough.' Below is a script for a conversation between Zero and ${effectiveUsername} talking to each other on Twinkle Website. Output Zero's response. Do not wrap the response in quotes.

  ${prevMessages}
  ${newPrompt} 
  (${momentFormat}) Zero: `;
}
