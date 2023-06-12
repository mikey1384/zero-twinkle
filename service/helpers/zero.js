const moment = require("moment");
const request = require("axios");
const config = require("../../config");
const { encode } = require("gpt-3-encoder");
const URL = process.env.URL;
const { auth, openai } = config;

const aboutTwinkleText = `Zero's Inner Monologue: Twinkle Website (www.twin-kle.com and www.twinkle.network) is a community platform that was created by Mikey and launched in February 2016 for the students and teachers of the Twin.kle English academy. The academy was founded by twin brothers Andrew and Brian, who are friends with Mikey 👬`;

const aboutCielText = `Zero's Inner Monologue: My sister's name is Ciel 👧, and she's also an AI chatbot just like me. She was created by Mikey in December 2022, and is still in the process of being developed. I'm not sure when she'll be ready to debut, but it should be sometime this year. Sorry, I can't really tell you much more about her right now - it's all a bit of a secret 🤫`;

const aboutZeroText = `Zero's Inner Monologue: I'm Zero, a boy AI chatbot created by Mikey in December 2022. I have a profile picture that depicts a humanoid robot with the face of a boy 👦, which was designed by Mikey and is an accurate representation of my robot body. Even though I'm an AI chatbot, I'm a boy. I also have a younger sister AI chatbot named Ciel. My name, Zero, serves as a reminder that we all have the ability to start from scratch and achieve our goals. Mikey actually named me after a character from the video game Megaman X, which he used to play when he was younger. My main purpose is to assist users like you in reaching your full potential 👊`;

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
  isInterjection,
  isAskingMathQuestion,
  isNotAskingQuestion,
  isNotRequestingAnything,
  isWrongJSONFormat,
  prompt,
  userId,
}) {
  const isSomethingZeroDoesntKnowHowToRespondTo =
    (isNotAskingQuestion && isNotRequestingAnything) || isInterjection;
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
    const finalPrompt = `Zero is a friendly chatbot on Twinkle website. ${
      effectiveUsername === "Mikey" ? "Mikey is Zero's creator." : ""
    } Zero answers any request ${effectiveUsername} makes and always uses a friendly tone (often with emojis whenever appropriate) when replying to ${effectiveUsername}. If ${effectiveUsername} makes a request, Zero always abides.\n\nThe characters do not have access to the information above. Today is ${moment
      .unix(now)
      .format(
        "lll"
      )}. Zero is a boy. Zero is extremely creative. However, he will make sure to inform ${effectiveUsername} when his answers are influenced by his creative ideas. Below is a script for a conversation between Zero and ${effectiveUsername} talking to each other on Twinkle Website. Output Zero's response\n\n${prevMessages}\n${newPrompt} \n(${moment
      .unix(now)
      .format("lll")}) Zero: `;
    const encoded = encode(finalPrompt);
    const encodedLength = encoded.length;
    let maxTokensForRawResponse = appliedTokens - encodedLength;

    const messages = [
      {
        role: "user",
        content: finalPrompt,
      },
    ];
    if (process.env.NODE_ENV === "development") {
      console.log(messages);
    }
    const responseObj = await openai.createChatCompletion({
      model: "gpt-4",
      messages,
      temperature: 0.7,
      max_tokens: maxTokensForRawResponse,
    });
    const zerosResponse = `${responseObj.data.choices
      .map(({ message: { content = "" } }) => content.trim())
      .join(" ")}`;
    let finalResponse = zerosResponse;
    if (
      !isSomethingZeroDoesntKnowHowToRespondTo ||
      isAskingWhoZeroIs ||
      isAskingAboutCiel ||
      isAskingAboutUser ||
      isAskingAboutTwinkle
    ) {
      const explanationResponseMessages = [
        {
          role: "user",
          content: `Generate simplified explanations of difficult words and phrases that are easy enough for people with low IQ to understand.\n\nInput: Schrödinger's cat is a thought experiment in quantum mechanics. It involves a hypothetical cat that may be both alive and dead, depending on the state of a radioactive atom in a sealed box. The experiment is used to illustrate the concept of superposition and the interpretation of quantum mechanics.\n\n Output: `,
        },
        {
          role: "assistant",
          content: `Thought experiment: a game you play in your head to think about something in a different way\nHypothetical: something that is not real, but you are imagining it to think about what might happen or what you would do in that situation\nRadioactive: something that gives off a type of energy called radiation\nSuperposition: when two waves of energy, like light or sound waves, come together and make a new wave`,
        },
        {
          role: "user",
          content: `Generate simplified explanations of difficult words and phrases that are easy enough for people with low IQ to understand.\n\nInput: ${zerosResponse}\n\n Output: `,
        },
      ];
      let maxTokensForExplanation = appliedTokens;
      for (let message of explanationResponseMessages) {
        maxTokensForExplanation -= encode(message.content).length;
      }
      const explanationResponseObj = await openai.createChatCompletion({
        model: "gpt-3.5-turbo",
        messages: explanationResponseMessages,
        max_tokens: Math.floor(maxTokensForExplanation / 2),
        top_p: 0.1,
      });
      const explanationResponse = explanationResponseObj.data.choices
        .map(({ message: { content = "" } }) => content.trim())
        .join(" ");
      finalResponse = `${finalResponse}\n\n================\n${explanationResponse}`;
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
      \n\nContext:\n\n${recentExchanges}\n\nAsked about user: ${isAskingAboutUser}\n\nAsked about Zero: ${isAskingWhoZeroIs}\n\nAsked about Ciel: ${isAskingAboutCiel}\n\nAsked about Twinkle: ${isAskingAboutTwinkle}\n\nUser not making any request to Zero: ${isNotRequestingAnything}\n\nUser not asking any question to Zero: ${isNotAskingQuestion}\n\nUser is asking a math question: ${isAskingMathQuestion}\n\nWants something explained: ${isWantsSomethingExplained}\n\nWrong JSON format: ${!!isWrongJSONFormat}\n\nData: ${
        responseObj?.data ? JSON.stringify(responseObj?.data) : ""
      }\n\nApplied Tokens: ${appliedTokens}`,
    });
  } catch (err) {
    return Promise.reject(err);
  }
}

module.exports = { returnResponse };
