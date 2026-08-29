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

      <section
        className="state-everywhere"
        id="how-it-works"
        aria-labelledby="state-everywhere-heading"
      >
        <div className="section-intro">
          <p className="dispatch-label">02 / RECONCILIATION</p>
          <h2 id="state-everywhere-heading">One state. Everywhere.</h2>
          <p>
            Your Mac, laptop and VPS should not each have a different version of
            the same skill setup. ToolMirror keeps them aligned automatically.
          </p>
        </div>
        <section
          className="machine-room"
          aria-label="Divergent devices become one locked state"
        >
          <div className="machine-room-heading">
            <p>LOCAL SETUPS</p>
            <p>ONE LOCKED STATE</p>
          </div>
          <div className="machine-room-routes" aria-hidden="true" />
          <ol className="machine-room-list">
            <li>
              <span>Mac Mini</span>
              <code>frontend-design@a19c</code>
              <strong>LOCKED</strong>
            </li>
            <li>
              <span>MacBook</span>
              <code>frontend-design@18f2</code>
              <strong>BEHIND</strong>
            </li>
            <li>
              <span>VPS</span>
              <code>frontend-design@local</code>
              <strong>DRIFTED</strong>
            </li>
          </ol>
          <p className="machine-room-result">
            Each device reaches <code>frontend-design@a19c</code> when its CLI
            reconciles the exact lock.
          </p>
        </section>
      </section>

      <section className="product-flow" aria-labelledby="product-flow-heading">
        <div className="flow-heading">
          <p className="dispatch-label">03 / ACTUAL PRODUCT FLOW</p>
          <h2 id="product-flow-heading">From skill to synced state.</h2>
          <p>
            Add a skill once. ToolMirror knows what should exist, what actually
            exists, and applies only what needs to change.
          </p>
        </div>
        <div className="flow-story">
          <div className="flow-panel">
            <p className="flow-panel-label">LOCKED OPERATION</p>
            <ol className="flow-sequence">
              <li>
                <strong>01</strong> ADD
              </li>
              <li>
                <strong>02</strong> LOCK
              </li>
              <li>
                <strong>03</strong> DIFF
              </li>
              <li>
                <strong>04</strong> RECONCILE
              </li>
              <li>
                <strong>05</strong> SYNCED
              </li>
            </ol>
            <p className="flow-panel-note">
              The complete sequence remains visible without animation.
            </p>
          </div>
          <ol className="flow-detail-list">
            <li>
              <h3>ADD</h3>
              <code>
                toolmirror add vercel-labs/skills --skill frontend-design
              </code>
              <p>Add the selected skill to desired state.</p>
            </li>
            <li>
              <h3>LOCK</h3>
              <dl>
                <div>
                  <dt>SOURCE</dt>
                  <dd>vercel-labs/skills</dd>
                </div>
                <div>
                  <dt>REF</dt>
                  <dd>main</dd>
                </div>
                <div>
                  <dt>REVISION</dt>
                  <dd>a19c4f2</dd>
                </div>
                <div>
                  <dt>HASH</dt>
                  <dd>sha256:7cf9…d10a</dd>
                </div>
              </dl>
              <p>Exact revision and content hash — exact, not latest.</p>
            </li>
            <li>
              <h3>DIFF</h3>
              <p>
                Compare desired state with each device&apos;s actual managed
                state.
              </p>
            </li>
            <li>
              <h3>RECONCILE</h3>
              <p>
                Apply only required changes; unmanaged and drifted skills are
                not silently overwritten.
              </p>
            </li>
            <li>
              <h3>SYNCED</h3>
              <p>
                Each device reports the locked revision after its CLI runs{" "}
                <code>toolmirror sync</code>.
              </p>
            </li>
          </ol>
        </div>
      </section>
    </main>
  );
}
