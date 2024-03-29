const nodemailer = require("nodemailer");
const config = require("../../config");
const { mailAuth } = config;

async function sendEmailReportForPLRewardLevel({
  rewardLevel,
  playlistId,
  playlistTitle,
  explanation,
}) {
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
    subject: `Set reward level for ${playlistTitle} to ${rewardLevel}`,
    html: `
      <p>Set reward level for ${playlistTitle} to ${rewardLevel}</p>
      <p>Playlist id: ${playlistId}</p>
      <p>Explanation: ${explanation}</p>
      `,
  };
  smtpTransport.sendMail(mailOptions);
  return Promise.resolve();
}

async function sendEmailReport({
  playlists,
  newRewardLevel,
  newPlaylistName,
  videoId,
  videoRewardLevel,
  ytTags,
  suggestedByZero,
  playlistCreatedByZero,
}) {
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
          !videoRewardLevel && newRewardLevel
            ? `<p>set video's reward level to ${newRewardLevel}</p>`
            : ""
        }
        <a target="_blank" href="${
          process.env.CONTENT_URL
        }/videos/${videoId}">${process.env.CONTENT_URL}/videos/${videoId}</a>
        ${
          newPlaylistName
            ? `<p>New playlist "${newPlaylistName}" has been created for this video</p>`
            : ""
        }
        ${
          suggestedByZero ? `<p>This playlist tagging was done by Zero</p>` : ""
        }
        ${
          playlistCreatedByZero
            ? `<p>This playlist was created by Zero</p>`
            : ""
        }
      `,
  };
  smtpTransport.sendMail(mailOptions);
  return Promise.resolve();
}

module.exports = { sendEmailReport, sendEmailReportForPLRewardLevel };
