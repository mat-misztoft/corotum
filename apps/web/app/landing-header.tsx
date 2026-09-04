"use client";

import { authClient } from "../src/auth-client";

const links = [
  ["#how-it-works", "How it works"],
  ["#git-cloud", "Git / Cloud"],
  ["#pricing", "Pricing"],
  ["#agents", "Agents"],
  ["https://docs.corotum.com", "Docs"],
  ["https://github.com/mat_misztoft/corotum", "GitHub"],
] as const;

const linkEvents: Partial<Record<(typeof links)[number][0], string>> = {
  "https://docs.corotum.com": "nav-docs",
  "https://github.com/mat_misztoft/corotum": "nav-github",
};

export function LandingHeader() {
  const { data: session } = authClient.useSession();
  return (
    <header className="dashboard-chrome">
      <nav className="dashboard-nav" aria-label="Main navigation">
        <a className="wordmark" href="/" aria-label="Corotum home">
          Corotum
        </a>
        <div className="dashboard-nav-links">
          {links.map(([href, label]) => (
            <a data-umami-event={linkEvents[href]} href={href} key={href}>
              {label}
            </a>
          ))}
          {session ? (
            <a
              className="dashboard-sign-out"
              data-umami-event="nav-dashboard"
              href="/dashboard"
            >
              Dashboard
            </a>
          ) : (
            <a
              className="dashboard-sign-out"
              data-umami-event="nav-sign-in"
              href="/sign-in"
            >
              Sign in
            </a>
          )}
        </div>
      </nav>
    </header>
  );
}
