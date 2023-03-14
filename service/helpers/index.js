const { writePool, readPool } = require("../pool");
const config = require("../../config");
const { openai, yesNoMaxTokens } = config;

function poolQuery(query, params) {
  return new Promise((resolve, reject) => {
    if (query.substring(0, 6) === "SELECT") {
      readPool.query(query, params, (err, results) => {
        if (err) return reject(err);
        return resolve(results);
      });
    } else {
      writePool.query(query, params, (err, results) => {
        if (err) return reject(err);
        return resolve(results);
      });
    }
  });
}

async function checkConditionsUsingGPT3({ prompt, effectiveUsername }) {
  const conditions = [
    {
      key: "isAskingAboutUser",
      value: `${effectiveUsername} is asking "who am I?"`,
    },
    {
      key: "isAskingToTalkAboutUser",
      value: `${effectiveUsername} is saying "talk about me"`,
    },
    {
      key: "isRequestingSelfIntro",
      value: `${effectiveUsername} is saying "tell me about yourself"`,
    },
    {
      key: "isAskingWhoZeroIs",
      value: `${effectiveUsername} is asking "who are you?"`,
    },
    {
      key: "isZerosProfileRelated",
      value: `${effectiveUsername} is asking Zero about Zero's profile such as pfp (profile picture), bio, or username`,
    },
    {
      key: "isAskingZerosDesire",
      value: `${effectiveUsername} is asking Zero about Zero's desire`,
    },
    {
      key: "isTalkingZerosGender",
      value: `${effectiveUsername} is talk to Zero about Zero's gender`,
    },
    {
      key: "isAskingZerosProperties",
      value: `${effectiveUsername} is asking Zero about Zero's properties`,
    },
    {
      key: "isAskingAboutCiel",
      value: `${effectiveUsername} is asking something about Zero's sister or Ciel`,
    },
    {
      key: "isAskingAboutTwinkle",
      value: `${effectiveUsername} is asking something about Twinkle website`,
    },
    {
      key: "isWantsSomethingExplained",
      value: `${effectiveUsername} wants something to be explained`,
    },
    {
      key: "isAskingFactualQuestion",
      value: `${effectiveUsername} is asking a factual question`,
    },
    {
      key: "isAskingMathQuestion",
      value: `${effectiveUsername} is asking a math question`,
    },
    {
      key: "isNotAskingQuestion",
      value: `${effectiveUsername} is not asking a question`,
    },
    {
      key: "userIsCommandingZero",
      value: `${effectiveUsername} is commanding Zero to do something`,
    },
    {
      key: "userIsRequestingZero",
      value: `${effectiveUsername} is requesting Zero to do something`,
    },
    {
      key: "userWantsSomethingDone",
      value: `${effectiveUsername} is asking Zero to do something`,
    },
    {
      key: "isInterjection",
      value: `${effectiveUsername} only saying one word, and it's an interjection such as "aha," "oh," "wow"`,
    },
  ];
  const JSONResponse = await checkIsPromptMatchConditionUsingGPT3JSON({
    conditions,
    prompt,
  });
  let result = null;
  try {
    result = JSON.parse(JSONResponse);
  } catch (e) {
    console.log("wrong JSON format", JSONResponse);
    result = {};
    for (const condition of conditions) {
      result[condition.key] = await checkIsPromptMatchConditionUsingGPT3({
        prompt,
        condition: condition.value,
      });
    }
    result.isWrongJSONFormat = true;
  }
  return Promise.resolve(result);
}

async function checkIsPromptMatchConditionUsingGPT3JSON({
  conditions,
  prompt,
}) {
  const response = await openai.createChatCompletion({
    model: "gpt-3.5-turbo",
    messages: [
      {
        role: "system",
        content: "You are text-davinci-003 text completion model.",
      },
      {
        role: "user",
        content: `This JSON generator reads the script below and returns a single JSON object with keys ${conditions
          .map(({ key }) => `"${key}"`)
          .join(
            ", "
          )} and value being the boolean value of whether they are met.\n\nScript: ${prompt}\n\nJSON: `,
      },
    ],
    temperature: 0.7,
    max_tokens: 3000,
    top_p: 1,
  });
  const responseText = response.data.choices
    .map(({ message: { content = "" } }) => content.trim())
    .join(" ");
  return responseText;
}

async function checkIsPromptMatchConditionUsingGPT3({ prompt, condition }) {
  const response = await openai.createCompletion({
    model: "text-davinci-003",
    prompt: `When you enter a prompt, I'm going to say "yes" if ${condition}, and say "no" if otherwise. Enter a prompt here: \n\n\n ${prompt}\n\n\n`,
    temperature: 0.7,
    max_tokens: yesNoMaxTokens,
    top_p: 1,
    best_of: 3,
    frequency_penalty: 0,
    presence_penalty: 0,
  });
  const responseText = response.data.choices
    .map(({ text }) => text.trim())
    .join(" ");
  return (responseText.toLowerCase() || "").includes("yes");
}

module.exports = {
  poolQuery,
  checkConditionsUsingGPT3,
  checkIsPromptMatchConditionUsingGPT3,
};
