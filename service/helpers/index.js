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
      value: `I think ${effectiveUsername} is asking questions like "who am I?"`,
    },
    {
      key: "isAskingAboutZero",
      value: `I think ${effectiveUsername} is asking questions about Zero or is asking Zero to tell something about himself`,
    },
    {
      key: "isAskingAboutCiel",
      value: `I think ${effectiveUsername} is asking something about Zero's sister or Ciel`,
    },
    {
      key: "isAskingAboutTwinkle",
      value: `I think ${effectiveUsername} is asking something about Twinkle website`,
    },
    {
      key: "isRequireComplexAnswer",
      value: "if the task requires a lot of resources",
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
    const isAskingAboutUser = await checkIsPromptMatchConditionUsingGPT3({
      prompt,
      condition: `I think ${effectiveUsername} is asking questions like "who am I?"`,
    });
    const isAskingAboutZero = await checkIsPromptMatchConditionUsingGPT3({
      prompt,
      condition: `I think ${effectiveUsername} is asking questions about Zero`,
    });
    const isAskingAboutCiel = await checkIsPromptMatchConditionUsingGPT3({
      prompt,
      condition: `I think ${effectiveUsername} is asking something about Zero's sister or Ciel`,
    });
    const isAskingAboutTwinkle = await checkIsPromptMatchConditionUsingGPT3({
      prompt,
      condition: `I think ${effectiveUsername} is asking something about Twinkle website`,
    });
    const isRequireComplexAnswer = await checkIsPromptMatchConditionUsingGPT3({
      prompt,
      condition: "if the task requires a lot of resources",
    });
    result = {
      isAskingAboutUser,
      isAskingAboutZero,
      isAskingAboutCiel,
      isAskingAboutTwinkle,
      isRequireComplexAnswer,
    };
  }
  return Promise.resolve(result);
}

async function checkIsPromptMatchConditionUsingGPT3JSON({
  conditions,
  prompt,
}) {
  const response = await openai.createCompletion({
    model: "text-davinci-003",
    prompt: `When you enter a prompt, I'm going to analyze whether ${conditions
      .map(({ value }) => `${value}`)
      .join(
        ", "
      )} are met and return a single JSON object with keys ${conditions
      .map(({ key }) => `"${key}"`)
      .join(
        ", "
      )} and value being the boolean value of whether they are met. Enter a prompt here: ${prompt}\n JSON: `,
    temperature: 0.7,
    max_tokens: 1000,
    top_p: 1,
    best_of: 3,
    frequency_penalty: 0,
    presence_penalty: 0,
  });
  const responseText = response.data.choices
    .map(({ text }) => text.trim())
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
