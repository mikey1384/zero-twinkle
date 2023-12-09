const { writePool, readPool } = require("../pool");
const config = require("../../config");
const { defaultMaxTokens } = require("../../constants");
const { encode } = require("gpt-3-encoder");
const { openai, GPT4 } = config;

function poolQuery(query, params) {
  return new Promise((resolve, reject) => {
    const trimmedQuery = query.trim();
    if (trimmedQuery.substring(0, 6) === "SELECT") {
      readPool.query(trimmedQuery, params, (err, results) => {
        if (err) {
          return reject(err);
        }
        return resolve(results);
      });
    } else {
      writePool.query(trimmedQuery, params, (err, results) => {
        if (err) {
          return reject(err);
        }
        return resolve(results);
      });
    }
  });
}

async function checkConditionsUsingGPT({ prompt, effectiveUsername }) {
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
  const JSONResponse = await checkIsPromptMatchConditionUsingGPTJSON({
    conditions,
    prompt,
  });
  let result = null;
  try {
    result = JSON.parse(JSONResponse);
  } catch (e) {
    console.log("wrong JSON format", JSONResponse);
  }
  return Promise.resolve(result || {});
}

async function checkIsPromptMatchConditionUsingGPTJSON({ conditions, prompt }) {
  const messages = [
    {
      role: "user",
      content: `This JSON generator reads the script below and returns a single JSON object with keys ${conditions
        .map(({ key }) => `"${key}"`)
        .join(
          ", "
        )} and value being the boolean value of whether they are met.\n\nScript: ${prompt}\n\nJSON: `,
    },
  ];
  let appliedTokens = defaultMaxTokens;
  for (const message of messages) {
    appliedTokens -= encode(message.content).length;
  }

  let responseText;

  try {
    const response = await openai.createChatCompletion({
      model: GPT4,
      messages,
      max_tokens: appliedTokens,
      top_p: 0.1,
    });

    responseText = response.data.choices
      .map(({ message: { content = "" } }) => content.trim())
      .join(" ");
  } catch (error) {
    console.error("Error with GPT-4, falling back to GPT-3.5-turbo:", error);
    try {
      const response = await openai.createChatCompletion({
        model: "gpt-3.5-turbo",
        messages,
        max_tokens: Math.floor(appliedTokens / 2),
        top_p: 0.1,
      });
      responseText = response.data.choices
        .map(({ message: { content = "" } }) => content.trim())
        .join(" ");
    } catch (error) {
      console.error("Error with GPT-3.5-turbo:", error);
      throw error;
    }
  }

  return (responseText || "").replace("```json", "").replace("```", "");
}

module.exports = {
  poolQuery,
  checkConditionsUsingGPT,
};
