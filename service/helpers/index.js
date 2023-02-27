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

async function checkConditionsUsingGPT3(prompt) {
  const isAskingAboutUser = await checkIsPromptMatchConditionUsingGPT3({
    prompt,
    condition: `I think you are asking questions like "who am I?"`,
  });
  const isAskingAboutZero = await checkIsPromptMatchConditionUsingGPT3({
    prompt,
    condition: "I think you are asking something about me",
  });
  const isAskingAboutCiel = await checkIsPromptMatchConditionUsingGPT3({
    prompt,
    condition: "I think you are asking something about my sister or Ciel",
  });
  const isAskingAboutTwinkle = await checkIsPromptMatchConditionUsingGPT3({
    prompt,
    condition: "I think you are asking something about Twinkle website",
  });
  const isRequireComplexAnswer = await checkIsPromptMatchConditionUsingGPT3({
    prompt,
    condition: "if the task requires a lot of resources",
  });
  return Promise.resolve({
    isAskingAboutUser,
    isAskingAboutZero,
    isAskingAboutCiel,
    isAskingAboutTwinkle,
    isRequireComplexAnswer,
  });
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
