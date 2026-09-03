export type AuthenticationEmail = Readonly<{
  to: string;
  subject: string;
  link: string;
}>;

/** Narrow application boundary for transactional authentication messages. */
export type EmailService = Readonly<{
  sendAuthenticationEmail(message: AuthenticationEmail): Promise<void>;
}>;

export type CloudflareEmailBinding = Readonly<{
  send(
    message: Readonly<{
      to: string;
      from: string;
      subject: string;
      text: string;
      html: string;
    }>,
  ): Promise<unknown>;
}>;

export type EmailEnvironment = Readonly<{
  AUTH_EMAIL_FROM?: string;
  EMAIL?: CloudflareEmailBinding;
  COROTUM_HOSTED?: string;
}>;

/** Safe for user-facing auth responses: never include configuration or message data. */
export class EmailDeliveryError extends Error {
  constructor() {
    super("Authentication email delivery is unavailable");
    this.name = "EmailDeliveryError";
  }
}

export function createCloudflareEmailService(
  env: EmailEnvironment,
): EmailService {
  const from = senderFrom(env);
  const binding = env.EMAIL;
  if (!binding || typeof binding.send !== "function")
    throw new EmailDeliveryError();

  return {
    async sendAuthenticationEmail(message) {
      if (!isEmail(message.to) || !isHttpUrl(message.link)) {
        throw new EmailDeliveryError();
      }
      try {
        await binding.send({
          to: message.to,
          from,
          subject: message.subject,
          text: `Open this link to sign in: ${message.link}`,
          html: `<p>Open this link to sign in: <a href="${escapeHtml(message.link)}">${escapeHtml(message.link)}</a></p>`,
        });
      } catch {
        throw new EmailDeliveryError();
      }
    },
  };
}

function senderFrom(env: EmailEnvironment) {
  const from = env.AUTH_EMAIL_FROM?.trim();
  if (!from || !isEmail(from)) throw new EmailDeliveryError();
  if (isHosted(env) && !isCorotumSender(from)) throw new EmailDeliveryError();
  return from;
}

function isHosted(env: Pick<EmailEnvironment, "COROTUM_HOSTED">) {
  return env.COROTUM_HOSTED === "true" || env.COROTUM_HOSTED === "1";
}

function isCorotumSender(address: string) {
  const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
  return domain === "corotum.com" || domain.endsWith(".corotum.com");
}

function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}
