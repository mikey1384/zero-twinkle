const { poolQuery } = require("../helpers");
const { sendEmailReport, sendEmailReportForPLRewardLevel } = require("./model");
const config = require("../../config");
const { openai } = config;

const userId = Number(process.env.ZERO_TWINKLE_ID);
let lastVideoId = 0;

async function setPlaylistRewardLevel() {
  const [playlist] = await poolQuery(`
    SELECT id, title, description, rewardLevel FROM vq_playlists WHERE rewardLevel IS NULL
  `);
  if (!playlist) {
    return;
  }
  const { id, title, description } = playlist;
  const videoIdRows = await poolQuery(
    `SELECT videoId FROM vq_playlistvideos WHERE playlistId = ? LIMIT 5`,
    id
  );
  const videoIds = videoIdRows.map(({ videoId }) => videoId);
  const videos = await poolQuery(
    `SELECT id, title, rewardLevel, ytChannelName FROM vq_videos WHERE id IN (?)`,
    [videoIds]
  );
  const videoTitles = videos.map(({ title }) => title);
  const videoChannelNames = videos.map(({ ytChannelName }) => ytChannelName);
  const videoRewardLevels = videos.map(({ rewardLevel }) => rewardLevel);
  const playlistData = JSON.stringify({
    "Playlist Title": title,
    "Playlist Description": description,
    "Video Titles": videoTitles,
    "Video Channel Names": videoChannelNames,
    "Video Educational Levels": videoRewardLevels,
  });
  const response = await openai.createChatCompletion({
    model: "gpt-3.5-turbo",
    messages: [
      {
        role: "system",
        content:
          "You are a helpful tool that analyzes playlist metadata and determines its educational value on a scale of 0 to 5.",
      },
      {
        role: "user",
        content: `Analyze the given playlist metadata and determine its educational value on a scale from 0 (not educational at all) to 5 (extremely educational). Return a single JSON object with a key "digit" for the educational value and "explanation" for the reasoning behind the value. Playlist Metadata: ${playlistData}\n\nJSON: `,
      },
    ],
    max_tokens: 200,
    top_p: 0.1,
    temperature: 0.1,
  });
  const ResultingJSON = response.data.choices
    .map(({ message: { content = "" } }) => content.trim())
    .join(" ");
  const result = JSON.parse(ResultingJSON);
  const rewardLevel = result.digit;
  await poolQuery(`UPDATE vq_playlists SET rewardLevel = ? WHERE id = ?`, [
    rewardLevel,
    id,
  ]);
  sendEmailReportForPLRewardLevel({
    rewardLevel,
    playlistId: id,
    playlistTitle: title,
    explanation: result.explanation,
  });
}

async function tagVideosToPlaylist() {
  try {
    const [
      {
        content,
        videoId,
        ytTags,
        rewardLevel: videoRewardLevel,
        videoTitle,
        ytChannelName,
      } = {},
    ] = await poolQuery(
      `SELECT id AS videoId, ytTags, ytChannelName, rewardLevel, title AS videoTitle, content FROM vq_videos WHERE isDeleted != '1' AND id NOT IN (SELECT videoId AS id FROM vq_playlistvideos) ORDER BY id DESC LIMIT 1`
    );
    if (!ytTags || !videoId || videoId === lastVideoId) {
      return;
    }

    const tags = JSON.parse(ytTags);
    let playlists = [];
    let newPlaylistName = "";

    if (ytChannelName) {
      let [{ id: playlistId, title, rewardLevel } = {}] = await poolQuery(
        `SELECT * FROM vq_playlists WHERE title = ?`,
        ytChannelName
      );
      if (title) {
        playlists.push({ playlistId, title, rewardLevel });
      } else {
        const rows = await poolQuery(
          `SELECT * FROM vq_videos WHERE ytChannelName = ?`,
          ytChannelName
        );
        if (rows.length > 1) {
          const { insertId } = await poolQuery(
            `INSERT INTO vq_playlists SET ?`,
            {
              title: ytChannelName,
              creator: userId,
              timeStamp: Math.floor(Date.now() / 1000),
            }
          );
          for (let { id } of rows) {
            if (id !== videoId) {
              await poolQuery(`INSERT INTO vq_playlistvideos SET ?`, {
                playlistId: insertId,
                videoId: id,
              });
            }
          }
          playlists.push({
            playlistId: insertId,
            title: ytChannelName.toLowerCase(),
            rewardLevel: null,
          });
          newPlaylistName = ytChannelName;
        }
      }
    }

    const dupes = {};
    if (playlists[0]) {
      dupes[playlists[0].title.toLowerCase()] = true;
    }
    for (let tag of tags) {
      if (tag.split(" ").includes("quiz")) {
        tag = "quiz";
      }
      const [{ id: playlistId, title, rewardLevel } = {}] = await poolQuery(
        `SELECT * FROM vq_playlists WHERE title = ?`,
        tag
      );
      if (title) {
        const lowerCaseTitle = title.toLowerCase();
        const lowerCaseYtChannelName = ytChannelName.toLowerCase();
        if (
          tag === "national geographic" &&
          lowerCaseYtChannelName === lowerCaseTitle
        ) {
          playlists = [{ playlistId, title, rewardLevel }];
          break;
        }
        if (
          ["bazbattles", "dude perfect", "TED-ED", "naroditsky"].includes(tag)
        ) {
          playlists = [{ playlistId, title, rewardLevel }];
          break;
        }
        if (!dupes[lowerCaseTitle]) {
          playlists.push({ playlistId, title, rewardLevel });
          dupes[lowerCaseTitle] = true;
        }
      }
      if (playlists.length === 5) {
        break;
      }
    }

    let suggestedByZero = false;
    let playlistCreatedByZero = false;
    if (playlists.length === 0) {
      const suggestedTag = await suggestTag(
        `Video Title: ${videoTitle}, Channel Name: ${ytChannelName}, Tags: ${ytTags}`
      );
      if (suggestedTag) {
        suggestedByZero = true;
        const [{ id: playlistId, title, rewardLevel } = {}] = await poolQuery(
          `SELECT * FROM vq_playlists WHERE title = ?`,
          suggestedTag
        );
        if (title) {
          playlists.push({ playlistId, title, rewardLevel });
        } else {
          const { insertId } = await poolQuery(
            `INSERT INTO vq_playlists SET ?`,
            {
              title: suggestedTag,
              creator: userId,
              timeStamp: Math.floor(Date.now() / 1000),
            }
          );
          playlists.push({
            playlistId: insertId,
            title: suggestedTag.toLowerCase(),
            rewardLevel: null,
          });
          newPlaylistName = suggestedTag;
          playlistCreatedByZero = true;
        }
      }
    }

    const videosWithTheSameVideoCode = await poolQuery(
      `SELECT * FROM vq_videos WHERE content = ?`,
      content
    );

    let playlistRewardLevel = null;
    const isNewVideo = videosWithTheSameVideoCode.length < 2;

    for (let { playlistId, rewardLevel } of playlists) {
      await poolQuery(`INSERT INTO vq_playlistvideos SET ?`, {
        playlistId,
        videoId,
      });
      if (isNewVideo && (rewardLevel > 2 || videoRewardLevel > 3)) {
        await poolQuery(`UPDATE vq_playlists SET timeStamp = ? WHERE id = ?`, [
          Math.floor(Date.now() / 1000),
          playlistId,
        ]);
      }
      if (!!rewardLevel && !playlistRewardLevel) {
        playlistRewardLevel = rewardLevel;
      }
    }

    if (!videoRewardLevel && playlistRewardLevel && isNewVideo) {
      await poolQuery(`UPDATE vq_videos SET ? WHERE id = ?`, [
        { rewardLevel: playlistRewardLevel },
        videoId,
      ]);
    }
    await sendEmailReport({
      playlists,
      playlistRewardLevel,
      newPlaylistName,
      videoId,
      videoRewardLevel,
      ytTags,
      suggestedByZero,
      playlistCreatedByZero,
    });
    lastVideoId = videoId;
  } catch (error) {
    return console.error(error);
  }
}

async function suggestTag(videoData) {
  try {
    const response = await openai.createChatCompletion({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content:
            "You are a helpful tool that generates an appropriate category label",
        },
        {
          role: "user",
          content: `Prompt: Based on the given video metadata, suggest a concise category label using ideally a single word and no more than two words: ${videoData}\n\nLabel: `,
        },
      ],
      max_tokens: 50,
    });
    const tag = response.data.choices
      .map(({ message: { content = "" } }) => content.trim())
      .join(" ");
    return (tag || "").replace(/[".]/g, "");
  } catch (error) {
    console.error(`Error while processing video category: ${error}`);
    return "";
  }
}

module.exports = { tagVideosToPlaylist, setPlaylistRewardLevel };
