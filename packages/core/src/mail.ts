/** The only place that touches the Email Sending binding. */
export async function sendMail(
  env: Env,
  msg: { to: string; subject: string; text: string },
): Promise<void> {
  try {
    await env.MAIL.send({ to: msg.to, from: env.MAIL_FROM, subject: msg.subject, text: msg.text });
  } catch (error) {
    console.error("mail send failed", { to: msg.to, subject: msg.subject, error: String(error) });
  }
}
