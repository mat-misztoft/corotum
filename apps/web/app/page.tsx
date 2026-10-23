import type { Metadata } from "next";
import { isLaunchFreePeriod } from "../src/billing";
import { BillingToggle } from "./billing-toggle";
import { FlowStory } from "./landing-flow-story";
import { LandingHeader } from "./landing-header";
import { SiteFooter } from "./site-footer";

export const metadata: Metadata = {
  metadataBase: new URL("https://corotum.com"),
  title:
    "Corotum: identical AI agent skills on every machine, locked and drift-checked",
  description:
    "A lockfile for AI agent skills. Corotum pins each skill to an exact revision and content hash, makes every machine and agent match, and detects drift instead of overwriting it.",
  alternates: { canonical: "/" },
  openGraph: {
    title:
      "Corotum: the same skills, at the same revision, on every machine and agent",
    description:
      "One desired state for your SKILL.md skills. Exact revision and content hash per skill, drift detection per device and agent, no silent overwrites. Free Git Sync or Corotum Cloud.",
    url: "/",
    type: "website",
  },
};

export const dynamic = "force-dynamic";

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
  "Gemini CLI",
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
      <LandingHeader />

      <section className="hero" aria-labelledby="hero-heading">
        <div className="hero-copy">
          <p className="dispatch-label">01 / ONE DESIRED STATE</p>
          <h1 id="hero-heading">Identical agent skills on every machine.</h1>
          <p className="hero-summary">
            A lockfile for your AI agent skills. Corotum pins each skill to an
            exact revision and content hash. It then makes your laptop, desktop
            and VPS match that one desired state, along with every agent on
            them: Claude Code, Codex, Cursor, Gemini CLI, Pi and more.
          </p>
          <p className="hero-support">
            Drift is detected and reported, never silently overwritten. Exact,
            not latest.
          </p>
          {isLaunchFreePeriod() && (
            <aside
              className="launch-promotion"
              aria-label="Free Launch Extended"
            >
              <strong>FREE LAUNCH EXTENDED</strong>
              <span>Cloud free until October 21, 2026 · No card required</span>
              <small>$5.99/month or $59.90/year from October 22</small>
            </aside>
          )}
          <div className="hero-actions">
            <a
              className="button button-primary"
              data-umami-event="cta-cloud"
              data-umami-event-location="hero"
              href="/sign-in"
            >
              Start with Corotum Cloud
            </a>
            <a
              className="button button-secondary"
              data-umami-event="cta-github"
              data-umami-event-location="hero"
              href="https://github.com/mat-misztoft/corotum"
            >
              View on GitHub
            </a>
          </div>
          <code className="install-command">
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
          <h2 id="state-everywhere-heading">
            Same skills.
            <br />
            Different machines.
          </h2>
          <p>
            Your laptop has one copy of <code>code-review</code>. The VPS has an
            older one, and Cursor on the desktop has a copy someone edited by
            hand. Nothing tells you which one is right.
          </p>
          <p>
            Corotum gives you one desired state for your skills: what should
            exist, from which source, at which exact commit, with which content
            hash. Every machine reconciles to it, so the same skills run in
            Claude Code, Codex and Cursor without you copying folders around.
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
          <h2 id="product-flow-heading">How it works.</h2>
          <p>
            <code>sync</code> installs the locked SHA. It never installs
            whatever HEAD points to at that moment.
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
              <p>puts the skill in desired state.</p>
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
              <p>
                Corotum resolves the ref to an exact commit SHA and records a
                content hash.
              </p>
            </li>
            <li>
              <h3>DIFF</h3>
              <p>
                <code>corotum diff</code> compares desired state with what this
                device actually has, before anything changes.
              </p>
            </li>
            <li>
              <h3>RECONCILE</h3>
              <p>
                <code>corotum sync</code> installs the locked revision into{" "}
                <code>~/.agents/skills</code> and applies only the changes that
                are needed. Unmanaged and drifted skills are not silently
                overwritten.
              </p>
            </li>
            <li>
              <h3>SYNCED</h3>
              <p>
                With Corotum Cloud, the device reports the revision it applied.
                The dashboard only shows SYNCED after that report.
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
          <h2 id="git-cloud-heading">
            Git Sync
            <br />
            or Cloud
          </h2>
          <p>
            Keep desired state in your own Git repository, or use Corotum Cloud
            for hosted state, devices, a dashboard and WebMCP. Both use the same
            CLI commands and the same <code>corotum sync</code>.
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

      <section
        className="pricing"
        id="pricing"
        aria-labelledby="pricing-heading"
      >
        <div className="pricing-intro">
          <p className="dispatch-label">05 / PRICING</p>
          <h2 id="pricing-heading">Free, or hosted.</h2>
        </div>
        <div className="pricing-plans">
          <article className="pricing-plan pricing-git">
            <div className="pricing-plan-heading">
              <h3>GIT SYNC</h3>
              <strong>$0</strong>
              <span>Free forever</span>
            </div>
            <p className="pricing-summary">
              The complete local CLI, backed by your repository.
            </p>
            <ul className="pricing-list">
              <li>
                CLI and Git-backed desired state (<code>corotum.yaml</code>,{" "}
                <code>corotum.lock</code>)
              </li>
              <li>Add, remove, unmanage, adopt and restore skills</li>
              <li>Status, diff and sync</li>
              <li>Deterministic lockfile across multiple machines</li>
              <li>Agent auto-detection and targeting</li>
              <li>
                Works with GitHub, GitLab, Codeberg, self-hosted Git and other
                normal Git remotes
              </li>
              <li>No Corotum account required</li>
              <li>
                Manual by design: a device reconciles when you run{" "}
                <code>corotum sync</code> on it
              </li>
            </ul>
            <a
              className="pricing-link"
              data-umami-event="cta-github"
              data-umami-event-location="pricing"
              href="https://github.com/mat-misztoft/corotum"
            >
              View on GitHub
            </a>
          </article>

          <article className="pricing-plan pricing-cloud">
            <div className="pricing-plan-heading">
              <h3>COROTUM CLOUD</h3>
              <BillingToggle />
            </div>
            <p className="pricing-summary">
              Everything needed for hosted Cloud Sync.
            </p>
            {isLaunchFreePeriod() && (
              <aside className="launch-promotion pricing-launch-promotion">
                <strong>FREE LAUNCH EXTENDED</strong>
                <span>
                  Cloud free until October 21, 2026 · No card required
                </span>
                <small>$5.99/month or $59.90/year from October 22</small>
              </aside>
            )}
            <ul className="pricing-list">
              <li>Hosted desired state and unlimited devices</li>
              <li>Dashboard with per-device and per-agent sync status</li>
              <li>WebMCP and revisions</li>
              <li>Device pairing and Cloud API</li>
              <li>
                Opt-in automatic sync per device (
                <code>corotum auto enable</code>)
              </li>
              <li>Git to Cloud migration and back</li>
            </ul>
            <a
              className="button button-primary"
              data-umami-event="cta-cloud"
              data-umami-event-location="pricing"
              href="/sign-in"
            >
              Start with Corotum Cloud
            </a>
          </article>
        </div>
        <p className="pricing-note">
          Self-hosted Corotum Cloud is free under AGPLv3. The subscription is
          only for the hosted corotum.com service.
        </p>
      </section>

      <section className="devices" aria-labelledby="devices-heading">
        <div className="device-dispatch">
          <div className="device-dispatch-copy">
            <p className="dispatch-label">06 / SEE EVERY DEVICE</p>
            <h2 id="devices-heading">See every device at a glance.</h2>
            <p>
              See which machine is behind, which skill drifted and which agent
              needs attention.
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
            Corotum. There is no remote force-sync. (Cloud feature.)
          </p>
          <table className="status-board drift-board">
            <caption>THIS DEVICE / STATUS AND DIFF</caption>
            <thead>
              <tr>
                <th scope="col">STATUS</th>
                <th scope="col">WHAT ORDINARY SYNC DOES</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <StatusLabel status="SYNCED" />
                </td>
                <td>Matches the locked revision. Nothing.</td>
              </tr>
              <tr>
                <td>
                  <StatusLabel status="DRIFTED" />
                </td>
                <td>A managed copy changed locally. Does not clobber it.</td>
              </tr>
              <tr>
                <td>
                  <StatusLabel status="LOCAL_CONFLICT" />
                </td>
                <td>Unmanaged or unproven content is in the way. Leaves it.</td>
              </tr>
              <tr>
                <td>
                  <StatusLabel status="PARTIALLY_SYNCED" />
                </td>
                <td>Some targets failed. Reported as partial, not success.</td>
              </tr>
              <tr>
                <td>
                  <StatusLabel status="AUTH_REQUIRED" />
                </td>
                <td>Can&apos;t read a private Git source. Local files stay.</td>
              </tr>
            </tbody>
          </table>
          <p className="device-dispatch-note">
            <code>corotum status</code> is this device.{" "}
            <code>corotum diff</code> is the plan. Both have <code>--json</code>{" "}
            for CI.
          </p>
        </div>
      </section>

      <section className="agents" id="agents" aria-labelledby="agents-heading">
        <div className="agents-intro">
          <p className="dispatch-label">07 / BUILT FOR AGENTS</p>
          <h2 id="agents-heading">One skill set, every agent</h2>
          <p>
            The same managed skills are exposed to each agent you enable on a
            device.
          </p>
        </div>
        <div className="agent-facts">
          <p>
            Skills live once in <code>~/.agents/skills</code>. Agents get a
            symlink, or a normal copy when a symlink can&apos;t be used.
          </p>
          <p>
            Agents are optional: zero enabled agents is a valid state.{" "}
            <code>corotum agents enable &lt;agent&gt;</code> turns exposure on
            for one device, and{" "}
            <code>corotum agents disable &lt;agent&gt;</code> removes only that
            device&apos;s exposure.
          </p>
          <p>
            With Corotum Cloud, agents can also read and change desired state
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

      <section className="contrast" aria-labelledby="different-heading">
        <h2 id="different-heading">How Corotum is different</h2>
        <div className="contrast-grid">
          <article>
            <h3>Newest upstream</h3>
            <p>
              Many skill tools resolve a branch at install time, so two machines
              installing on different days can get different bytes. Corotum
              resolves a ref once, writes the exact commit SHA and content hash
              to the lock, and every later <code>sync</code> installs that SHA.
              Moving a skill to a new revision is an explicit command (
              <code>corotum set-ref &lt;skill&gt; &lt;ref&gt;</code>) that
              writes a new lock, not a side effect of syncing.
            </p>
          </article>
          <article>
            <h3>No silent overwrite</h3>
            <p>
              Some tools &quot;fix&quot; a changed skill by reinstalling it on
              top of your edits. Corotum reports a locally changed managed skill
              as <code>DRIFTED</code> and leaves it alone. It also reports
              unmanaged content in the way as <code>LOCAL_CONFLICT</code> and
              leaves that alone too. You decide what happens next.
            </p>
          </article>
          <article>
            <h3>Not one machine</h3>
            <p>
              A project lockfile pins one repo on one machine. Corotum&apos;s
              desired state is shared across your machines: through a Git
              repository you own (Git Sync) or a Cloud workspace (Corotum
              Cloud). Each device reconciles to the same lock. With Cloud, each
              device and agent reports its own status, so you can see which
              machine is behind or drifted.
            </p>
          </article>
          <article>
            <h3>No remote force-sync.</h3>
            <p>
              Nothing pushes changes onto a device. A device changes only when
              it runs <code>corotum sync</code>, or when you have opted in to
              automatic Cloud sync on that device, which uses the same safe sync
              path.
            </p>
          </article>
        </div>
      </section>

      <section className="faq-board" aria-labelledby="faq-heading">
        <h2 id="faq-heading">FAQ</h2>
        <div className="faq-list">
          <details>
            <summary>
              How do I make sure every machine has exactly the same AI agent
              skills?
            </summary>
            <p>
              Put your skills under one desired state with Corotum and run{" "}
              <code>corotum sync</code> on each machine. Every skill is locked
              to an exact commit SHA and content hash, and each machine installs
              those exact bytes into <code>~/.agents/skills</code>.
            </p>
          </details>
          <details>
            <summary>Is there a lockfile for agent skills?</summary>
            <p>
              Yes. Corotum keeps <code>corotum.yaml</code> (what you want) and{" "}
              <code>corotum.lock</code> (the exact revision and content hash per
              skill). With Git Sync both live in your own Git repository.
            </p>
          </details>
          <details>
            <summary>
              How do I detect when Claude Code or Codex skills have drifted
              between my machines?
            </summary>
            <p>
              Run <code>corotum status</code> or <code>corotum diff</code> on a
              machine to see whether its managed skills match the lock. A
              changed managed copy is reported as <code>DRIFTED</code>. With
              Corotum Cloud, the dashboard shows each device&apos;s and each
              agent&apos;s reported status.
            </p>
          </details>
          <details>
            <summary>
              Can I use the same skills in Claude Code, Codex and Cursor without
              copying folders?
            </summary>
            <p>
              Yes. Corotum stores each skill once in{" "}
              <code>~/.agents/skills</code> and exposes it to every agent you
              enable on that device, by symlink where possible and by copy
              otherwise.
            </p>
          </details>
          <details>
            <summary>
              Does Corotum install whatever is on <code>main</code> when I sync?
            </summary>
            <p>
              No. A ref like <code>main</code> is only followed when you
              explicitly re-resolve a skill. <code>corotum sync</code> always
              installs the exact SHA recorded in the lock and never installs
              upstream HEAD.
            </p>
          </details>
          <details>
            <summary>
              Will Corotum overwrite skills I edited or installed by hand?
            </summary>
            <p>
              No. Ordinary sync does not overwrite unmanaged skills (
              <code>LOCAL_CONFLICT</code>) or managed skills you changed locally
              (<code>DRIFTED</code>). Unmanaged skills are only adopted when you
              choose to adopt them.
            </p>
          </details>
          <details>
            <summary>Is this like Terraform or Nix for agent skills?</summary>
            <p>
              It follows the same desired-state idea: you declare which skills
              should exist at which locked revision, <code>corotum diff</code>{" "}
              shows the plan, and <code>corotum sync</code> reconciles the
              machine to it. It is scoped to agent skills only.
            </p>
          </details>
          <details>
            <summary>What does Corotum not do?</summary>
            <ul>
              <li>
                v0.5 manages global (user-level) skills only. Project-level
                skills are out of scope.
              </li>
              <li>There is no remote force-sync.</li>
              <li>Git Sync has no background service.</li>
              <li>
                v0.5 binaries are unsigned. The official installers verify
                SHA-256 checksums before installing.
              </li>
              <li>Windows arm64 is not supported.</li>
            </ul>
          </details>
        </div>
      </section>

      <section className="final-cta" aria-labelledby="final-cta-heading">
        <p className="dispatch-label">08 / FINAL CTA</p>
        <h2 id="final-cta-heading">
          Lock it once.
          <br />
          Same skills everywhere.
        </h2>
        <p>
          Start with Corotum Cloud, or use your own Git repository for free.
        </p>
        <div className="hero-actions">
          <a
            className="button button-primary"
            data-umami-event="cta-cloud"
            data-umami-event-location="final"
            href="/sign-in"
          >
            Start with Corotum Cloud
          </a>
          <a
            className="button button-secondary"
            data-umami-event="cta-github"
            data-umami-event-location="final"
            href="https://github.com/mat-misztoft/corotum"
          >
            View on GitHub
          </a>
        </div>
        <code className="install-command">
          curl -fsSL https://corotum.com/install.sh | sh
        </code>
      </section>
      <SiteFooter />
    </main>
  );
}
