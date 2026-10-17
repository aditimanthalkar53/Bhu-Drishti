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

export async function sendReportEmail(recipient: string, reportTitle: string, summary: string, pdf: Buffer, name?: string): Promise<{ messageId: string }> {
  const greet = name ? `Dear ${name},` : "Hello,";
  return sendMail({
    to: recipient,
    subject: `Bhu-Drishti report — ${reportTitle}`,
    text: `${greet}\n\n${summary}\n\nThe full report, with data sources, uncertainty and limitations, is attached as a PDF.\n\n— Bhu-Drishti satellite monitoring`,
    html: `<p>${esc(greet)}</p><p>${esc(summary)}</p><p>The full report, with data sources, uncertainty and limitations, is attached as a PDF.</p>` +
      `<p style="color:#666;font-size:12px">Sent by Bhu-Drishti satellite monitoring. Figures are satellite-based estimates; please read the limitations section before acting.</p>`,
    attachments: [{ filename: `bhu-drishti-${reportTitle.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 60)}.pdf`, content: pdf, contentType: "application/pdf" }],
  });
}
