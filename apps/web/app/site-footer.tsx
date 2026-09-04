export function SiteFooter() {
  return (
    <footer className="site-footer">
      <p>© 2026 Corotum</p>
      <p>Keep your agent skills in sync.</p>
      <nav aria-label="Footer">
        <a data-umami-event="nav-docs" href="https://docs.corotum.com">
          Docs
        </a>
        <a
          data-umami-event="nav-github"
          href="https://github.com/mat_misztoft/corotum"
        >
          GitHub
        </a>
        <a href="/terms">Terms</a>
        <a href="/privacy">Privacy</a>
      </nav>
    </footer>
  );
}
