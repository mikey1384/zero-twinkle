const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createTwinkleNewspaperRequestError,
  getTwinkleNewspaperRequestConfig,
} = require("../service/news");

test("newspaper worker supports current and previous API auth transports", () => {
  const originalToken = process.env.ZERO_TWINKLE_TOKEN;
  process.env.ZERO_TWINKLE_TOKEN = "worker-secret";

  try {
    const config = getTwinkleNewspaperRequestConfig();
    assert.deepEqual(config, {
      headers: {
        "User-Agent": "AI-Zero",
        "x-zero-twinkle-token": "worker-secret",
        authorization: "worker-secret",
      },
    });
    assert.equal(
      config.headers.authorization,
      config.headers["x-zero-twinkle-token"]
    );
  } finally {
    if (originalToken === undefined) {
      delete process.env.ZERO_TWINKLE_TOKEN;
    } else {
      process.env.ZERO_TWINKLE_TOKEN = originalToken;
    }
  }
});

test("newspaper worker fails before requesting when its token is missing", () => {
  const originalToken = process.env.ZERO_TWINKLE_TOKEN;
  delete process.env.ZERO_TWINKLE_TOKEN;

  try {
    assert.throws(
      () => getTwinkleNewspaperRequestConfig(),
      /ZERO_TWINKLE_TOKEN is not configured/
    );
  } finally {
    if (originalToken !== undefined) {
      process.env.ZERO_TWINKLE_TOKEN = originalToken;
    }
  }
});

test("newspaper worker errors never retain Axios request headers", () => {
  const exposedSecret = "must-not-appear";
  const error = createTwinkleNewspaperRequestError({
    code: "ERR_BAD_REQUEST",
    message: `request contained ${exposedSecret}`,
    config: {
      headers: {
        "x-zero-twinkle-token": exposedSecret,
        authorization: exposedSecret,
      },
    },
    response: {
      status: 401,
      data: { error: "Unauthorized" },
    },
  });

  assert.equal(
    error.message,
    "Twinkle newspaper worker request failed: HTTP 401 - Unauthorized"
  );
  assert.equal(error.message.includes(exposedSecret), false);
  assert.equal(Object.hasOwn(error, "config"), false);
  assert.equal(Object.hasOwn(error, "response"), false);
});
