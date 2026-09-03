import type { ReactNode } from "react";
import { SiteFooter } from "./site-footer";

export function LegalDocument({ children }: { children: ReactNode }) {
  return (
    <main className="landing legal-page">
      <header className="landing-header">
        <a className="wordmark" href="/" aria-label="Corotum home">
          Corotum
        </a>
      </header>
      <article className="legal-doc" aria-labelledby="legal-title">
        {children}
      </article>
      <SiteFooter />
    </main>
  );
}
