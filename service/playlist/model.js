const nodemailer = require("nodemailer");
const config = require("../../config");
const { mailAuth } = config;
const SMTP_CONNECTION_TIMEOUT_MS = 15_000;
const SMTP_SOCKET_TIMEOUT_MS = 30_000;

function createSmtpTransport() {
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: mailAuth,
    connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
  });
}

// Titles, channel names and labels come from uploaders or the AI; never inject them as HTML.
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function sendEmailReportForPLRewardLevel({
  rewardLevel,
  playlistId,
  playlistTitle,
  explanation,
}) {
  const smtpTransport = createSmtpTransport();
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
  try {
    await smtpTransport.sendMail(mailOptions);
  } finally {
    smtpTransport.close();
  }
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
  const playlistsHtml = escapeHtml(playlistsText);
  const newPlaylistNameHtml = escapeHtml(newPlaylistName);

  const smtpTransport = createSmtpTransport();

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
        <p>yt tags contained are as follows: ${escapeHtml(ytTags)}</p>
        <p>reward level of this video was: ${videoRewardLevel}</p>
        ${
          playlistsText
            ? `
                <p>the video was successfully added to the following playlists:</p>
                <p>${playlistsHtml}</p>
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
            ? `<p>New playlist "${newPlaylistNameHtml}" has been created for this video</p>`
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
  try {
    await smtpTransport.sendMail(mailOptions);
  } finally {
    smtpTransport.close();
  }
}

module.exports = { sendEmailReport, sendEmailReportForPLRewardLevel };
