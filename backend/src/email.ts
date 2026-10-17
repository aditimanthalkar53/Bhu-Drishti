import nodemailer, { type Transporter } from "nodemailer";

let cached: { transporter: Transporter; user: string } | null = null;

export function smtpConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SMTP_USER && env.SMTP_PASS);
}

function getTransporter() {
  if (cached) return cached;
  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = Number(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER;
  // Gmail app passwords are shown with spaces; they must be sent without.
  const pass = process.env.SMTP_PASS?.replace(/\s+/g, "");
  if (!user || !pass) {
    throw new Error("SMTP configuration is missing (SMTP_USER / SMTP_PASS).");
  }
  const transporter = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass }, pool: true, maxConnections: 2 });
  cached = { transporter, user };
  return cached;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface MailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
}

export async function sendMail(m: MailOptions): Promise<{ messageId: string }> {
  const { transporter, user } = getTransporter();
  const from = process.env.SMTP_FROM || `"Bhu-Drishti" <${user}>`;
  const info = await transporter.sendMail({ from, ...m });
  const rejected = (info as { rejected?: unknown[] }).rejected ?? [];
  if (rejected.length > 0) {
    throw new Error(`SMTP server rejected recipient(s): ${rejected.join(", ")}`);
  }
  return { messageId: info.messageId };
}


export type Attachment = { filename: string; content: Buffer; contentType: string };

export async function sendReportEmail(recipient: string, reportTitle: string, summary: string, files: Attachment[], name?: string): Promise<{ messageId: string }> {
  const greet = name ? `Dear ${name},` : "Hello,";
  return sendMail({
    to: recipient,
    subject: `Bhu-Drishti report — ${reportTitle}`,
    text: `${greet}\n\n${summary}\n\nTwo PDFs are attached: a plain-language summary, and the full technical report with data sources, uncertainty and limitations.\n\n— Bhu-Drishti satellite monitoring`,
    html: `<p>${esc(greet)}</p><p>${esc(summary)}</p><p>Two PDFs are attached: a <b>plain-language summary</b>, and the full <b>technical report</b> with data sources, uncertainty and limitations.</p>` +
      `<p style="color:#666;font-size:12px">Sent by Bhu-Drishti satellite monitoring. Figures are satellite-based estimates; please read the limitations before acting.</p>`,
    attachments: files,
  });
}
