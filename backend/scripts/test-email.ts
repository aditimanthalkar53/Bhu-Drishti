
import nodemailer from "nodemailer";

const host = process.env.SMTP_HOST;
const port = Number(process.env.SMTP_PORT || 465);
const user = process.env.SMTP_USER;
// Gmail app passwords are shown with spaces; they must be sent without (same as src/email.ts).
const pass = process.env.SMTP_PASS?.replace(/\s+/g, "");

if (!host || !user || !pass) {
  throw new Error("SMTP settings missing. Check the root .env file.");
}

const transporter = nodemailer.createTransport({
  host,
  port,
  secure: port === 465,
  auth: { user, pass },
});

async function main() {
  await transporter.verify();
  console.log("SMTP connection successful!");

  await transporter.sendMail({
    from: `"Bhu-Drishti" <${user}>`,
    to: user,
    subject: "Bhu-Drishti - Email Test",
    text: "Success! Your Bhu-Drishti project can send emails.",
  });

  console.log("Test email sent. Check your inbox.");
}

main().catch((error) => {
  console.error("Email test failed:", error.message);
  process.exitCode = 1;
});
