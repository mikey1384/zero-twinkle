const nodemailer = require("nodemailer");
const { poolQuery } = require("./");
const config = require("../config");
const { mailAuth } = config;

let lastVideoId = 0;

async function tagVideosToPlaylist() {
  try {
    const [
      {
        content,
        videoId,
        ytTags,
        rewardLevel: videoRewardLevel,
        ytChannelName,
      } = {},
    ] = await poolQuery(
      `SELECT id AS videoId, ytTags, ytChannelName, rewardLevel, content FROM vq_videos WHERE isDeleted != '1' AND id NOT IN (SELECT videoId AS id FROM vq_playlistvideos) ORDER BY id DESC LIMIT 1`
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
              creator: 7587,
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
        if (
          tag === "national geographic" &&
          ytChannelName.toLowerCase() === "national geographic"
        ) {
          playlists = [{ playlistId, title, rewardLevel }];
          break;
        }
        if (
          tag === "bazbattles" ||
          tag === "dude perfect" ||
          tag === "TED-ED"
        ) {
          playlists = [{ playlistId, title, rewardLevel }];
          break;
        }
        if (!dupes[title.toLowerCase()]) {
          playlists.push({ playlistId, title, rewardLevel });
        }
        dupes[title.toLowerCase()] = true;
      }
      if (playlists.length === 5) {
        break;
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

    const playlistsText = playlists
      .map(({ playlistId, title }) => `${title} (${playlistId})`)
      .join(", ");

    const smtpTransport = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: mailAuth,
    });

    await smtpTransport.verify();

    const mailOptions = {
      from: "twinkle.notification@gmail.com",
      to: "mikey@twin-kle.com",
      subject:
        playlistsText || newPlaylistName
          ? `${playlistsText ? `tagged: ${playlistsText} ` : " "}${
              newPlaylistName ? `new playlist created: ${newPlaylistName}` : ""
            }`
          : "Could not tag this video",
      html: `
        <p>the video with id: ${videoId} was not included in any playlists.</p>
        <p>yt tags contained are as follows: ${ytTags}</p>
        <p>reward level of this video was: ${videoRewardLevel}</p>
        ${
          playlistsText
            ? `
                <p>the video was successfully added to the following playlists:</p>
                <p>${playlistsText}</p>
              `
            : ""
        }
        ${
          !videoRewardLevel && playlistRewardLevel
            ? `<p>set video's reward level to ${playlistRewardLevel}</p>`
            : ""
        }
        <a target="_blank" href="https://www.twin-kle.com/videos/${videoId}">https://www.twin-kle.com/videos/${videoId}</a>
        ${
          newPlaylistName
            ? `<p>New playlist "${newPlaylistName}" has been created for this video</p>`
            : ""
        }
      `,
    };
    smtpTransport.sendMail(mailOptions);
    lastVideoId = videoId;
  } catch (error) {
    return console.error(error);
  }
}

module.exports = { tagVideosToPlaylist };
