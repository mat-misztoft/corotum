import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Page not found | Corotum",
};

export default function NotFound() {
  return (
    <main className="not-found-page">
      <section className="not-found-shell" aria-labelledby="not-found-title">
        <div className="not-found-brand-rule" aria-hidden="true" />
        <a className="wordmark" href="/">
          Corotum
        </a>

        <div className="not-found-layout">
          <div className="not-found-copy">
            <p className="not-found-kicker">ROUTE UNAVAILABLE</p>
            <h1 id="not-found-title">Page not found</h1>
            <p>
              This route does not exist, or it may have moved. Return to
              Corotum to continue.
            </p>
            <div className="not-found-actions">
              <a className="not-found-primary" href="/">
                Go to landing
              </a>
              <a className="not-found-secondary" href="/sign-in">
                Sign in
              </a>
            </div>
          </div>

          <aside className="not-found-status" aria-label="Route status">
            <p>REQUESTED ROUTE</p>
            <strong className="status-error">
              <span className="status-mark" aria-hidden="true">
                !
              </span>
              NOT FOUND
            </strong>
            <p className="not-found-status-note">
              Landing and sign-in remain available.
            </p>
          </aside>
        </div>
      </section>
    </main>
  );
}
