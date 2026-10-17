
import nodemailer from "nodemailer";

function getTransporter() {
  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = Number(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER;
  // Gmail app passwords are shown with spaces; they must be sent without.
  const pass = process.env.SMTP_PASS?.replace(/\s+/g, "");
  if (!user || !pass) {
    throw new Error("SMTP configuration is missing (SMTP_USER / SMTP_PASS).");
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
  return { transporter, user };
}

export async function sendReportEmail(
  recipient: string,
  queryId: string,
  pdf: Buffer,
): Promise<void> {
  const { transporter, user } = getTransporter();

  const info = await transporter.sendMail({
    from: `"SatQuery AI" <${user}>`,
    to: recipient,
    subject: `SatQuery AI Report - ${queryId}`,
    text: "Your completed satellite-analysis report is attached as a PDF.",
    html: `<p>Your completed SatQuery AI satellite-analysis report is attached as a PDF.</p><p style="color:#666">Query ID: ${queryId}</p>`,
    attachments: [
      {
        filename: "report.pdf",
        content: pdf,
        contentType: "application/pdf",
      },
    ],
  });

  if (info.rejected.length > 0) {
    throw new Error(`SMTP server rejected recipient(s): ${info.rejected.join(", ")}`);
  }
  console.log("REPORT EMAIL SENT:", info.accepted, info.response);
}

