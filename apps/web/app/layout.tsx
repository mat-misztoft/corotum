import { env } from "cloudflare:workers";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { umamiAssets } from "../src/umami";
import "./globals.css";

export const metadata: Metadata = {
  title: "Corotum",
  description: "Keep your agent skills in sync.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const workerEnv = env as unknown as Env;
  const umami = umamiAssets(workerEnv.UMAMI_HOST, workerEnv.UMAMI_WEBSITE_ID);
  return (
    <html lang="en">
      <head>
        {umami && (
          <>
            <script
              defer
              src={umami.script}
              data-website-id={umami.websiteId}
            />
            <script
              defer
              src={umami.recorder}
              data-website-id={umami.websiteId}
            />
          </>
        )}
      </head>
      <body>{children}</body>
    </html>
  );
}
