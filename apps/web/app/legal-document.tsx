import type { ReactNode } from "react";
import { SiteFooter } from "./site-footer";
import { Wordmark } from "./wordmark";

export function LegalDocument({ children }: { children: ReactNode }) {
  return (
    <main className="landing legal-page">
      <header className="landing-header">
        <Wordmark href="/" label="Corotum home" />
      </header>
      <article className="legal-doc" aria-labelledby="legal-title">
        {children}
      </article>
      <SiteFooter />
    </main>
  );
}
