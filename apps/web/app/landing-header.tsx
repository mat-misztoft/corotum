"use client";

import { authClient } from "../src/auth-client";

const links = [
  ["#how-it-works", "How it works"],
  ["#git-cloud", "Git / Cloud"],
  ["#pricing", "Pricing"],
  ["#agents", "Agents"],
  ["https://github.com/mat_misztoft/corotum", "GitHub"],
] as const;

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
            <a href={href} key={href}>
              {label}
            </a>
          ))}
          {session ? (
            <a className="dashboard-sign-out" href="/dashboard">
              Dashboard
            </a>
          ) : (
            <a className="dashboard-sign-out" href="/sign-in">
              Sign in
            </a>
          )}
        </div>
      </nav>
    </header>
  );
}
