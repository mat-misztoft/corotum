const deviceRows = [
  { skill: "frontend-design", device: "Mac Mini", status: "SYNCED" },
  { skill: "code-review", device: "MacBook", status: "BEHIND" },
  { skill: "playwright", device: "VPS", status: "BEHIND" },
];

export default function Home() {
  return (
    <main className="landing">
      <header className="landing-header">
        <a className="wordmark" href="/" aria-label="ToolMirror home">
          ToolMirror
        </a>
        <nav aria-label="Main navigation">
          <a href="#how-it-works">How it works</a>
          <a href="#git-cloud">Git / Cloud</a>
          <a href="#agents">Agents</a>
          <a href="https://github.com/toolmirror/toolmirror">GitHub</a>
          <a href="/dashboard">Sign in</a>
        </nav>
      </header>

      <section className="hero" aria-labelledby="hero-heading">
        <div className="hero-copy">
          <p className="dispatch-label">01 / ONE DESIRED STATE</p>
          <h1 id="hero-heading">Keep your agent skills in sync.</h1>
          <p className="hero-summary">
            Manage your skills once. ToolMirror keeps every agent and every
            machine on the same exact version.
          </p>
          <div className="hero-actions">
            <a className="button button-primary" href="/dashboard">
              Start with ToolMirror Cloud
            </a>
            <a
              className="button button-secondary"
              href="https://github.com/toolmirror/toolmirror"
            >
              View on GitHub
            </a>
          </div>
          <code className="install-command">
            curl -fsSL https://toolmirror.com/install.sh | sh
          </code>
        </div>

        <section className="dispatch-board" aria-labelledby="dispatch-heading">
          <div className="board-heading">
            <p id="dispatch-heading">DESIRED STATE</p>
            <p>ACTUAL DEVICES</p>
          </div>
          <div className="board-axis" aria-hidden="true" />
          <p className="reconcile-label">DIFF / RECONCILE</p>
          <ol className="device-list">
            {deviceRows.map(({ skill, device, status }) => (
              <li key={skill}>
                <code>{skill}</code>
                <span className="state-line" aria-hidden="true" />
                <span>
                  {device} <strong>{status}</strong>
                </span>
              </li>
            ))}
          </ol>
          <p className="board-note">
            Desired state is reconciled when each device runs ToolMirror sync.
          </p>
        </section>
      </section>
    </main>
  );
}
