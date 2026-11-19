import { appName, emailSendingEnabled } from "./config";

/**
 * The only place that touches the Email Sending binding; subjects start with APP_NAME. With
 * EMAIL_SENDING=off nothing is sent: security alerts still reach the in-app inbox.
 */
export async function sendMail(
  env: Env,
  msg: { to: string; subject: string; text: string },
): Promise<void> {
  if (!emailSendingEnabled(env)) return;
  try {
    await env.MAIL.send({
      to: msg.to,
      from: env.MAIL_FROM,
      subject: `${appName(env)}: ${msg.subject}`,
      text: msg.text,
    });
  } catch (error) {
    console.error({
      event: "mail_send_failed",
      to: msg.to,
      subject: msg.subject,
      error: String(error),
    });
  }
}
