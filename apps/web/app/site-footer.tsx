export function SiteFooter() {
  return (
    <footer className="site-footer">
      <p className="site-footer-brand">
        {/* biome-ignore lint/performance/noImgElement: Footer mark is a static public SVG. */}
        <img
          alt=""
          className="site-footer-mark"
          height={600}
          src="/brand/corotum-mark.svg"
          width={490}
        />
        © 2026 Corotum
      </p>
      <p>Identical agent skills on every machine.</p>
      <nav aria-label="Footer">
        <a data-umami-event="nav-docs" href="https://docs.corotum.com">
          Docs
        </a>
        <a
          data-umami-event="nav-github"
          href="https://github.com/mat-misztoft/corotum"
        >
          GitHub
        </a>
        <a href="/terms">Terms</a>
        <a href="/privacy">Privacy</a>
      </nav>
    </footer>
  );
}
