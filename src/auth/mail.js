import nodemailer from "nodemailer";

function smtpConfigured() {
  return Boolean(
    process.env.SMTP_HOST &&
      String(process.env.SMTP_HOST).trim() &&
      process.env.SMTP_FROM &&
      String(process.env.SMTP_FROM).trim()
  );
}

function createTransport() {
  if (!smtpConfigured()) {
    throw new Error("SMTP is not configured (SMTP_HOST / SMTP_FROM)");
  }
  const port = Number(process.env.SMTP_PORT) || 587;
  const user = process.env.SMTP_USER || "";
  const pass = process.env.SMTP_PASS || "";
  return nodemailer.createTransport({
    host: String(process.env.SMTP_HOST).trim(),
    port,
    secure: port === 465,
    auth: user ? { user, pass } : undefined,
  });
}

export function appBaseUrl() {
  const raw = process.env.APP_URL || `http://localhost:${process.env.PORT || 3847}`;
  return String(raw).replace(/\/$/, "");
}

export async function sendPasswordResetEmail({ to, resetToken }) {
  const resetUrl = `${appBaseUrl()}/reset-password.html?token=${encodeURIComponent(resetToken)}`;
  const from = String(process.env.SMTP_FROM).trim();
  const transport = createTransport();
  await transport.sendMail({
    from,
    to,
    subject: "Reset your Prop Tax Scraper password",
    text: `You requested a password reset.\n\nOpen this link to set a new password (expires in 1 hour):\n\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`,
    html: `<p>You requested a password reset.</p>
<p><a href="${resetUrl}">Set a new password</a> (expires in 1 hour).</p>
<p>If you did not request this, you can ignore this email.</p>`,
  });
  return { resetUrl };
}
