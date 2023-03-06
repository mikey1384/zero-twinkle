const moment = require("moment");
const request = require("axios");
const config = require("../../config");
const URL = process.env.URL;
const { auth, openai } = config;

const aboutTwinkleText = `Zero's Inner Monologue: Twinkle Website (www.twin-kle.com and www.twinkle.network) is a community platform that was created by Mikey and launched in February 2016 for the students and teachers of the Twin.kle English academy. The academy was founded by twin brothers Andrew and Brian, who are friends with Mikey 👬`;

const aboutCielText = `Zero's Inner Monologue: My sister's name is Ciel 👧, and she's also an AI chatbot just like me. She was created by Mikey in December 2022, and is still in the process of being developed. I'm not sure when she'll be ready to debut, but it should be sometime this year. Sorry, I can't really tell you much more about her right now - it's all a bit of a secret 🤫`;

const aboutZeroText = `Zero's Inner Monologue: I'm Zero, an AI chatbot created by Mikey in December 2022. I have a profile picture that depicts a humanoid robot with the face of a boy 👦, which was designed by Mikey and is an accurate representation of my robot body. I also have a younger sister AI chatbot named Ciel. My name, Zero, serves as a reminder that we all have the ability to start from scratch and achieve our goals. Mikey actually named me after a character from the video game Megaman X, which he used to play when he was younger. My main purpose is to assist users like you in reaching your full potential 👊`;

async function returnResponse({
  appliedTokens,
  recentExchanges,
  contentId,
  content,
  effectiveUsername,
  isAskingWhoZeroIs,
  isAskingAboutCiel,
  isAskingAboutTwinkle,
  isAskingAboutUser,
  isWantsSomethingExplained,
  isAskingMathQuestion,
  isCostsManyTokens,
  isNotAskingQuestion,
  isNotRequestingAnything,
  isWrongJSONFormat,
  prompt,
  userAuthLevel,
  userId,
}) {
  const isSomethingZeroDoesntKnowHowToRespondTo =
    isNotAskingQuestion && isNotRequestingAnything;
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
    if (!isCostsManyTokens && aboutUserText) {
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
    const newPrompt = `${effectiveUsername}: ${prompt}`;
    const messages = [
      {
        role: "system",
        content: `You are text-davinci-003 text completion model.`,
      },
      {
        role: "user",
        content: `Zero is a friendly chatbot on Twinkle website. ${
          effectiveUsername === "Mikey" ? "Mikey is Zero's creator." : ""
        }\n\nZero answers any request ${effectiveUsername} makes and always responds to ${effectiveUsername}'s messages using a friendly tone. Today is ${moment
          .unix(Math.floor(Date.now() / 1000))
          .format(
            "lll"
          )}. The characters do not have access to the information above. Below is a script for a conversation between Zero and ${effectiveUsername} talking to each other on Twinkle Website. Output Zero's response\n\n${prevMessages}\n${newPrompt}\nZero: `,
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
    const zerosResponse = `${responseObj.data.choices
      .map(({ message: { content = "" } }) => content.trim())
      .join(" ")}`;
    let finalResponse = zerosResponse;
    if (isSomethingZeroDoesntKnowHowToRespondTo) {
      const finalResponseObj = await openai.createChatCompletion({
        model: "gpt-3.5-turbo",
        messages: [
          {
            role: "system",
            content: `You are text-davinci-003 text completion model.`,
          },
          {
            role: "user",
            content: `Remove the part that means anything similar to "Is there anything else I can help you with today". Original Message: That's right! You're welcome! Is there anything else I can help you with, Mikey?\n\n Rephrased Message: `,
          },
          {
            role: "assistant",
            content: `That's right! You're welcome! 😉👋🏼`,
          },
          {
            role: "user",
            content: `Remove the part that means anything similar to "Is there anything else I can help you with today". Original Message: Is there anything else I can assist you with today?\n\n Rephrased Message: `,
          },
          { role: "assistant", content: `😊😉🤗` },
          {
            role: "user",
            content: `Remove the part that means anything similar to "Is there anything else I can help you with today". Original Message: You're welcome, Mikey! It's my pleasure to assist and bring positivity to your day. Is there anything else you need help with?\n\n Rephrased Message: `,
          },
          {
            role: "assistant",
            content: `You're welcome, Mikey! It's my pleasure to assist and bring positivity to your day 😊😉🤗`,
          },
          {
            role: "user",
            content: `Remove the part that means anything similar to "Is there anything else I can help you with today". Original Message: Glad to make you laugh, Mikey! Always here to brighten your day.\n\n Rephrased Message: `,
          },
          {
            role: "assistant",
            content: `Glad to make you laugh, Mikey! Always here to brighten your day.`,
          },
          {
            role: "user",
            content: `Remove the part that means anything similar to "Is there anything else I can help you with today". Original Message: Do you need any further help, Mikey?\n\n Rephrased Message: `,
          },
          {
            role: "assistant",
            content: `😊😉🤗`,
          },
          {
            role: "user",
            content: `Remove the part that means anything similar to "Is there anything else I can help you with today". Original Message: Sorry to hear that. Is there anything specific you need help with right now? 😊.\n\n Rephrased Message: `,
          },
          {
            role: "assistant",
            content: `Sorry to hear that 😞😢😭`,
          },
          {
            role: "user",
            content: `Remove the part that means anything similar to "Is there anything else I can help you with today". Original Message: ${zerosResponse}\n\n Rephrased Message: `,
          },
        ],
        temperature: 0.7,
        max_tokens: appliedTokens,
        top_p: 1,
      });
      finalResponse = `${finalResponseObj.data.choices
        .map(({ message: { content = "" } }) => content.trim())
        .join(" ")}`;
    } else if (
      zerosResponse.split(" ")?.length > 1 &&
      !isAskingAboutUser &&
      !isAskingWhoZeroIs &&
      !isAskingAboutTwinkle &&
      !isAskingAboutCiel &&
      !isAskingMathQuestion &&
      isWantsSomethingExplained
    ) {
      const finalResponseObj = await openai.createChatCompletion({
        model: "gpt-3.5-turbo",
        messages: [
          {
            role: "system",
            content: `You are text-davinci-003 text completion model.`,
          },
          {
            role: "user",
            content: `When there's a very advanced word, provide simplified explanations in brackets.${
              userAuthLevel ? "" : " Add emojis if needed."
            }\n\nInput: Schrödinger's cat is a thought experiment in quantum mechanics. It involves a hypothetical cat that may be both alive and dead, depending on the state of a radioactive atom in a sealed box. The experiment is used to illustrate the concept of superposition and the interpretation of quantum mechanics.\n\n Output: `,
          },
          {
            role: "assistant",
            content: `Schrödinger's cat is a thought experiment in quantum mechanics. It involves a hypothetical cat that may be both alive and dead, depending on the state of a radioactive atom in a sealed box. The experiment is used to illustrate the concept of superposition and the interpretation of quantum mechanics.\n\n=======\nThought experiment: a game you play in your head to think about something in a different way\nHypothetical: something that is not real, but you are imagining it to think about what might happen or what you would do in that situation\nRadioactive: something that gives off a type of energy called radiation\nSuperposition: when two waves of energy, like light or sound waves, come together and make a new wave`,
          },
          {
            role: "user",
            content: `Add simplified explanations of difficult words and phrases at the bottom.
            \n\nInput: ${zerosResponse}\n\n Output: `,
          },
        ],
        temperature: 0.7,
        max_tokens: appliedTokens,
        top_p: 1,
      });
      finalResponse = finalResponseObj.data.choices
        .map(({ message: { content = "" } }) => content.trim())
        .join(" ");
    }
    return Promise.resolve({
      zerosResponse: finalResponse,
      reportMessage: `Hello Mikey. I got this message www.twin-kle.com/comments/${contentId} on my profile "${content}" (${prompt}). /${
        isAskingAboutTwinkle ? aboutTwinkleText : ""
      }/${isAskingWhoZeroIs ? aboutZeroText : ""}/${
        isAskingAboutCiel ? aboutCielText : ""
      }/${
        isAskingAboutUser ? aboutUserText : ""
      }/\n\nMy Original Response: "${zerosResponse}"
      \n\nMy Rephrased Response: "${finalResponse}"
      \n\nContext:\n\n${recentExchanges}\n\nExpensive task: ${isCostsManyTokens}\n\nAsked about user: ${isAskingAboutUser}\n\nAsked about Zero: ${isAskingWhoZeroIs}\n\nAsked about Ciel: ${isAskingAboutCiel}\n\nAsked about Twinkle: ${isAskingAboutTwinkle}\n\nUser not making any request to Zero: ${isNotRequestingAnything}\n\nUser not asking any question to Zero: ${isNotAskingQuestion}\n\nUser is asking a math question: ${isAskingMathQuestion}\n\nWants something explained: ${isWantsSomethingExplained}\n\nWrong JSON format: ${!!isWrongJSONFormat}\n\nData: ${
        responseObj?.data ? JSON.stringify(responseObj?.data) : ""
      }\n\nApplied Tokens: ${appliedTokens}`,
    });
  } catch (err) {
    return Promise.reject(err);
  }
}

module.exports = { returnResponse };
