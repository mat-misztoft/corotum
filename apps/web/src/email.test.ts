import { expect, test } from "bun:test";
import {
  type CloudflareEmailBinding,
  createCloudflareEmailService,
  EmailDeliveryError,
  type EmailService,
} from "./email";

const authMessage = {
  to: "ada@example.com",
  subject: "Sign in to ToolMirror",
  link: "https://toolmirror.com/api/auth/magic-link?token=secret-token",
};

function binding(messages: unknown[], reject = false): CloudflareEmailBinding {
  return {
    async send(message) {
      if (reject) throw new Error("provider detail must not escape");
      messages.push(message);
    },
  };
}

test("an authentication email test double needs no Cloudflare binding details", async () => {
  const messages: unknown[] = [];
  const service: EmailService = {
    async sendAuthenticationEmail(message) {
      messages.push(message);
    },
  };

  await service.sendAuthenticationEmail(authMessage);

  expect(messages).toEqual([authMessage]);
});

test("hosted authentication email dispatches through the EMAIL binding", async () => {
  const messages: unknown[] = [];
  const service = createCloudflareEmailService({
    TOOLMIRROR_HOSTED: "true",
    AUTH_EMAIL_FROM: "auth@toolmirror.com",
    EMAIL: binding(messages),
  });

  await service.sendAuthenticationEmail(authMessage);

  expect(messages).toEqual([
    {
      to: "ada@example.com",
      from: "auth@toolmirror.com",
      subject: "Sign in to ToolMirror",
      text: "Open this link to sign in: https://toolmirror.com/api/auth/magic-link?token=secret-token",
      html: '<p>Open this link to sign in: <a href="https://toolmirror.com/api/auth/magic-link?token=secret-token">https://toolmirror.com/api/auth/magic-link?token=secret-token</a></p>',
    },
  ]);
});

test("delivery configuration fails before sending when the sender or EMAIL binding is unavailable", () => {
  const messages: unknown[] = [];
  expect(() =>
    createCloudflareEmailService({
      TOOLMIRROR_HOSTED: "true",
      EMAIL: binding(messages),
    }),
  ).toThrow(EmailDeliveryError);
  expect(() =>
    createCloudflareEmailService({
      TOOLMIRROR_HOSTED: "true",
      AUTH_EMAIL_FROM: "auth@toolmirror.com",
    }),
  ).toThrow(EmailDeliveryError);
  expect(() =>
    createCloudflareEmailService({
      TOOLMIRROR_HOSTED: "true",
      AUTH_EMAIL_FROM: "auth@toolmirror.com",
      EMAIL: {} as CloudflareEmailBinding,
    }),
  ).toThrow(EmailDeliveryError);
  expect(() =>
    createCloudflareEmailService({
      TOOLMIRROR_HOSTED: "true",
      AUTH_EMAIL_FROM: "not-an-email",
      EMAIL: binding(messages),
    }),
  ).toThrow(EmailDeliveryError);
  expect(messages).toEqual([]);
});

test("hosted delivery only accepts a ToolMirror-domain sender", () => {
  expect(() =>
    createCloudflareEmailService({
      TOOLMIRROR_HOSTED: "true",
      AUTH_EMAIL_FROM: "auth@selfhost.example",
      EMAIL: binding([]),
    }),
  ).toThrow("Authentication email delivery is unavailable");
});

test("provider failures expose neither message tokens nor binding details", async () => {
  const service = createCloudflareEmailService({
    TOOLMIRROR_HOSTED: "true",
    AUTH_EMAIL_FROM: "auth@toolmirror.com",
    EMAIL: binding([], true),
  });

  await expect(service.sendAuthenticationEmail(authMessage)).rejects.toEqual(
    new EmailDeliveryError(),
  );
});

test("self-hosted deployments supply their own sender and EMAIL binding without hosted billing configuration", async () => {
  const messages: unknown[] = [];
  const service = createCloudflareEmailService({
    TOOLMIRROR_HOSTED: "false",
    AUTH_EMAIL_FROM: "login@selfhost.example",
    EMAIL: binding(messages),
  });

  await service.sendAuthenticationEmail(authMessage);

  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ from: "login@selfhost.example" });
});
