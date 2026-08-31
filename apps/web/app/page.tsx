import { FlowStory } from "./landing-flow-story";

const deviceTargets = [
  { device: "Desktop", agent: "Codex", status: "SYNCED" },
  { device: "Desktop", agent: "Pi", status: "SYNCED" },
  { device: "VPS", agent: "Codex", status: "DRIFTED" },
  { device: "VPS", agent: "Pi", status: "AUTH_REQUIRED" },
] as const;

const matrixAgents = [
  "Codex",
  "Claude Code",
  "Pi",
  "Cursor",
  "Gemini",
] as const;

const matrixSkills = ["frontend-design", "code-review", "playwright"] as const;

const moreAgents =
  "OpenCode · Windsurf · Cline · Roo Code · GitHub Copilot · Kiro CLI";

function statusClass(status: string) {
  if (status === "SYNCED" || status === "LOCKED") return "status-synced";
  if (status === "DRIFTED") return "status-drifted";
  if (status === "AUTH_REQUIRED" || status === "ERROR") return "status-error";
  return "status-attention";
}

function statusMark(status: string) {
  if (status === "SYNCED" || status === "LOCKED") return "✓";
  if (status === "DRIFTED") return "≠";
  return "!";
}

function StatusLabel({ status }: { status: string }) {
  return (
    <strong className={statusClass(status)}>
      <span className="status-mark" aria-hidden="true">
        {statusMark(status)}
      </span>
      {status}
    </strong>
  );
}

export default function Home() {
  return (
    <main className="landing">
      <header className="landing-header">
        <a className="wordmark" href="/" aria-label="Corotum home">
          Corotum
        </a>
        <nav aria-label="Main navigation">
          <a href="#how-it-works">How it works</a>
          <a href="#git-cloud">Git / Cloud</a>
          <a href="#agents">Agents</a>
          <a href="https://github.com/mat_misztoft/corotum">GitHub</a>
          <a href="/sign-in">Sign in</a>
        </nav>
      </header>

      <section className="hero" aria-labelledby="hero-heading">
        <div className="hero-copy">
          <p className="dispatch-label">01 / ONE DESIRED STATE</p>
          <h1 id="hero-heading">Keep your agent skills in sync.</h1>
          <p className="hero-summary">
            Manage your skills once. Corotum keeps every agent and every
            machine on the same exact version.
          </p>
          <div className="hero-actions">
            <a className="button button-primary" href="/sign-in">
              Start with Corotum Cloud
            </a>
            <a
              className="button button-secondary"
              href="https://github.com/mat_misztoft/corotum"
            >
              View on GitHub
            </a>
          </div>
          <code
            className="install-command"
            aria-label="Official install command"
          >
            curl -fsSL https://corotum.com/install.sh | sh
          </code>
        </div>

        {/* biome-ignore lint/performance/noImgElement: Static landing artwork must retain its supplied dimensions. */}
        <img
          className="landing-visual"
          src="/images/landing/01-one-desired-state.jpg"
          alt="One desired state across your agent skills and devices."
          width={1000}
          height={1000}
        />
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
            Your desktop, laptop and VPS should not each have a different version of
            the same skill setup. Corotum keeps them aligned automatically.
          </p>
        </div>
        {/* biome-ignore lint/performance/noImgElement: Static landing artwork must retain its supplied dimensions. */}
        <img
          className="landing-visual"
          src="/images/landing/02-reconciliation.jpg"
          alt="Corotum reconciliation across device states."
          width={1000}
          height={1000}
        />
      </section>

      <section className="product-flow" aria-labelledby="product-flow-heading">
        <div className="flow-heading">
          <p className="dispatch-label">03 / ACTUAL PRODUCT FLOW</p>
          <h2 id="product-flow-heading">From skill to synced state.</h2>
          <p>
            Add a skill once. Corotum knows what should exist, what actually
            exists, and applies only what needs to change.
          </p>
        </div>
        <FlowStory>
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
                corotum add vercel-labs/skills --skill frontend-design
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
              <p>Exact revision and content hash. Exact, not latest.</p>
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
                <code>corotum sync</code>.
              </p>
            </li>
          </ol>
        </FlowStory>
      </section>

      <section
        className="git-cloud"
        id="git-cloud"
        aria-labelledby="git-cloud-heading"
      >
        <div className="git-cloud-heading">
          <p className="dispatch-label">04 / GIT OR CLOUD</p>
          <h2 id="git-cloud-heading">One Corotum. Two ways to sync.</h2>
          <p>
            Keep your state in your own Git repository, or use Corotum Cloud
            for hosted sync, devices, dashboard and WebMCP.
          </p>
        </div>
        {/* biome-ignore lint/performance/noImgElement: Static landing artwork must retain its supplied dimensions. */}
        <img
          className="landing-visual"
          src="/images/landing/04-two-ways-to-sync.jpg"
          alt="Corotum syncs through Git or Corotum Cloud."
          width={1000}
          height={1000}
        />
      </section>

      <section className="devices" aria-labelledby="devices-heading">
        <div className="device-dispatch">
          <div className="device-dispatch-copy">
            <p className="dispatch-label">05 / SEE EVERY DEVICE</p>
            <h2 id="devices-heading">See every device at a glance.</h2>
            <p>
              Stop guessing what is out of sync. See which machine is behind,
              which skill drifted and which agent needs attention.
            </p>
          </div>
          <table className="status-board">
            <caption>TARGET STATUS / AFTER CLI SYNC</caption>
            <thead>
              <tr>
                <th scope="col">DEVICE</th>
                <th scope="col">AGENT</th>
                <th scope="col">STATUS</th>
              </tr>
            </thead>
            <tbody>
              {deviceTargets.map((row) => (
                <tr key={`${row.device}-${row.agent}`}>
                  <td>{row.device}</td>
                  <td>{row.agent}</td>
                  <td>
                    <StatusLabel status={row.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="device-dispatch-note">
            Status is current per device and agent after that machine runs
            Corotum. No remote force-sync.
          </p>
        </div>
      </section>

      <section className="agents" id="agents" aria-labelledby="agents-heading">
        <div className="agents-intro">
          <p className="dispatch-label">06 / BUILT FOR AGENTS</p>
          <h2 id="agents-heading">One skill. Many agents.</h2>
          <p>
            Sync the same managed skills across Codex, Claude Code, Pi, Cursor,
            Gemini and more.
          </p>
          <p>
            With Corotum Cloud, agents can also manage your desired state
            through WebMCP.
          </p>
        </div>
        <table className="agent-matrix">
          <caption>SKILL EXPOSURE / SUPPORTED AGENTS</caption>
          <thead>
            <tr>
              <th scope="col">SKILL</th>
              {matrixAgents.map((agent) => (
                <th key={agent} scope="col">
                  {agent}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrixSkills.map((skill) => (
              <tr key={skill}>
                <th scope="row">
                  <code>{skill}</code>
                </th>
                {matrixAgents.map((agent) => (
                  <td key={agent} data-agent={agent}>
                    <span className="exposure">exposed</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="agent-roster">Also supported: {moreAgents}</p>
      </section>

      <section className="final-cta" aria-labelledby="final-cta-heading">
        <p className="dispatch-label">07 / FINAL CTA</p>
        <h2 id="final-cta-heading">Set it once. Keep it in sync.</h2>
        <p>
          Start with Corotum Cloud, or use your own Git repository for free.
        </p>
        <div className="hero-actions">
          <a className="button button-primary" href="/sign-in">
            Start with Corotum Cloud
          </a>
          <a
            className="button button-secondary"
            href="https://github.com/mat_misztoft/corotum"
          >
            View on GitHub
          </a>
        </div>
        <code
          className="install-command"
          aria-label="Official install command"
        >
          curl -fsSL https://corotum.com/install.sh | sh
        </code>
      </section>
    </main>
  );
}
