"use client";
import { type FormEvent, useEffect, useState } from "react";
import { authClient } from "../src/auth-client";
import { SiteFooter } from "./site-footer";
import { validEmail } from "./sign-in/sign-in-form";
import { WebMcpTools } from "./webmcp-tools";

type View = "overview" | "skills" | "devices" | "billing" | "settings";
type Dashboard = {
  workspace: { name: string };
  revision: { id: string | null; sequence: number };
  skills: {
    id: string;
    skill: string;
    ref: string;
    resolutionStatus: string;
    locked: boolean;
  }[];
  devices: {
    id: string;
    name: string;
    platform: string;
    architecture: string;
    appliedRevisionSequence: number;
    syncStatus: string;
    targets: {
      skillId: string;
      agentId: string;
      status: string;
      errorCode: string | null;
    }[];
  }[];
};
type Settings = {
  hosted: boolean;
  email: string | null;
  accounts: { providerId: string; label: string }[];
  subscription: {
    interval: "month" | "year";
    status: string;
    currentPeriodEnd: number | null;
  } | null;
};

const titles: Record<View, string> = {
  overview: "Your desired state",
  skills: "Skills",
  devices: "Devices",
  billing: "Billing",
  settings: "Settings",
};
const navItems: { view: View; href: string; label: string }[] = [
  { view: "overview", href: "/dashboard", label: "Overview" },
  { view: "skills", href: "/dashboard/skills", label: "Skills" },
  { view: "devices", href: "/dashboard/devices", label: "Devices" },
  { view: "billing", href: "/dashboard/billing", label: "Billing" },
  { view: "settings", href: "/settings", label: "Settings" },
];

function statusClass(status: string) {
  if (
    status === "SYNCED" ||
    status === "LOCKED" ||
    status === "ACTIVE" ||
    status === "RESOLVED"
  )
    return "status-synced";
  if (status === "DRIFTED") return "status-drifted";
  if (status === "ERROR" || status === "AUTH_REQUIRED" || status === "402")
    return "status-error";
  return "status-attention";
}

function statusMark(status: string) {
  return status === "SYNCED" ||
    status === "LOCKED" ||
    status === "ACTIVE" ||
    status === "RESOLVED"
    ? "✓"
    : status === "DRIFTED"
      ? "≠"
      : "!";
}

function StatusLabel({ status }: { status: string }) {
  return (
    <strong className={`dashboard-status ${statusClass(status)}`}>
      <span className="status-mark" aria-hidden="true">
        {statusMark(status)}
      </span>
      {status}
    </strong>
  );
}

function DashboardShell({
  view,
  children,
}: {
  view: View;
  children: React.ReactNode;
}) {
  return (
    <div className="dashboard dashboard-shell">
      <WebMcpTools />
      <header className="dashboard-chrome">
        <div className="dashboard-brand-rule" />
        <nav className="dashboard-nav" aria-label="Corotum">
          <a className="wordmark" href="/dashboard">
            Corotum
          </a>
          <div className="dashboard-nav-links">
            {navItems.map((item) => (
              <a
                aria-current={view === item.view ? "page" : undefined}
                href={item.href}
                key={item.view}
              >
                {item.label}
              </a>
            ))}
            <button
              className="dashboard-sign-out"
              type="button"
              onClick={async () => {
                await authClient.signOut();
                window.location.assign("/sign-in");
              }}
            >
              Sign out
            </button>
          </div>
        </nav>
      </header>
      <main className="dashboard-content">{children}</main>
      <SiteFooter />
    </div>
  );
}

function EntitlementPanel({ message }: { message: string }) {
  return (
    <section className="dashboard-panel" aria-labelledby="hosted-entitlement">
      <h2 id="hosted-entitlement">Hosted Cloud</h2>
      <p className="dashboard-pending">
        <StatusLabel status="402" />
        {message}
      </p>
    </section>
  );
}

function Loading() {
  return (
    <div className="dashboard-loading" aria-busy="true">
      <p>Loading workspace…</p>
      <div className="dashboard-skeleton-header" aria-hidden="true">
        <i />
        <i />
      </div>
      <div className="dashboard-skeleton-panel" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className="dashboard-skeleton-panel" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}

export function DashboardSurface({ view }: { view: View }) {
  const [data, setData] = useState<Dashboard | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entitlement, setEntitlement] = useState<string | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [emailDraft, setEmailDraft] = useState("");
  const [emailSent, setEmailSent] = useState(false);
  useEffect(() => {
    fetch("/api/v1/dashboard")
      .then(async (response) => {
        if (response.status === 401) {
          window.location.assign("/sign-in");
          return;
        }
        const body = (await response.json()) as Dashboard & { error?: string };
        if (response.status === 402) {
          setEntitlement(body.error ?? "Hosted Cloud subscription required");
          return;
        }
        if (response.ok) setData(body);
        else setError(body.error ?? "Unable to load dashboard");
      })
      .catch(() => setError("Unable to load dashboard"));
    if (view === "billing" || view === "settings")
      fetch("/api/v1/dashboard/settings")
        .then(async (response) => {
          if (response.status === 401) {
            window.location.assign("/sign-in");
            return;
          }
          const body = (await response.json()) as Settings & { error?: string };
          if (response.status === 402) {
            setEntitlement(body.error ?? "Hosted Cloud subscription required");
            return;
          }
          if (response.ok) setSettings(body);
          else setError(body.error ?? "Unable to load settings");
        })
        .catch(() => setError("Unable to load settings"));
    if (view === "settings" &&
      new URLSearchParams(window.location.search).get("error"))
      setAccountError("Unable to connect that account. Try again.");
  }, [view]);

  async function revokeDevice(deviceId: string) {
    if (
      !window.confirm(
        "Remove this device? It will need corotum login again. Remote status rows stay.",
      )
    )
      return;
    setAction(deviceId);
    try {
      const response = await fetch(`/api/v1/devices/${deviceId}/revoke`, {
        method: "POST",
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok)
        throw new Error(body.error ?? "Unable to revoke device");
      setData(
        (current) =>
          current && {
            ...current,
            devices: current.devices.filter((device) => device.id !== deviceId),
          },
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to revoke device",
      );
    } finally {
      setAction(null);
    }
  }

  async function mutateDesired(mutation: Record<string, string>) {
    if (!data) return false;
    setError(null);
    const response = await fetch("/api/v1/dashboard", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseRevisionId: data.revision.id,
        idempotencyKey: crypto.randomUUID(),
        mutation,
      }),
    });
    const body = (await response.json()) as { error?: string };
    if (response.status === 409) {
      const fresh = await fetch("/api/v1/dashboard");
      if (fresh.ok) setData((await fresh.json()) as Dashboard);
      throw new Error(
        body.error ?? "The workspace changed before this mutation could be applied.",
      );
    }
    if (!response.ok) throw new Error(body.error ?? "Unable to update skills");
    const fresh = await fetch("/api/v1/dashboard");
    if (fresh.ok) setData((await fresh.json()) as Dashboard);
    return true;
  }

  async function clearCloudData() {
    if (
      !window.confirm(
        "Delete all Cloud desired-state skills? Local files on devices stay. This cannot be undone.",
      )
    )
      return;
    setAction("clear-cloud");
    try {
      await mutateDesired({ type: "CLEAR" });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to delete Cloud data",
      );
    } finally {
      setAction(null);
    }
  }

  async function addSkill(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const source = String(fields.get("source") ?? "").trim();
    const skill = String(fields.get("skill") ?? "").trim();
    const ref = String(fields.get("ref") ?? "").trim();
    setAction("add");
    try {
      if (
        await mutateDesired({
          type: "ADD",
          source,
          skill,
          ...(ref ? { ref } : {}),
        })
      ) {
        form.reset();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to add skill");
    } finally {
      setAction(null);
    }
  }

  async function removeSkill(skillId: string, name: string) {
    if (!window.confirm(`Remove ${name} from desired state? Devices apply on corotum sync.`))
      return;
    setAction(skillId);
    try {
      await mutateDesired({ type: "REMOVE", skillId });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to remove skill",
      );
    } finally {
      setAction(null);
    }
  }

  async function linkProvider(provider: "github" | "google") {
    setAction(provider);
    setAccountError(null);
    try {
      const { error } = await authClient.linkSocial({
        provider,
        callbackURL: "/settings",
        errorCallbackURL: "/settings",
      });
      if (error) throw new Error(error.message);
    } catch {
      setAccountError("Unable to connect that account. Try again.");
      setAction(null);
    }
  }

  async function unlinkProvider(provider: "github" | "google") {
    setAction(`unlink-${provider}`);
    setAccountError(null);
    try {
      const { error } = await authClient.unlinkAccount({ providerId: provider });
      if (error) throw new Error(error.message);
      const response = await fetch("/api/v1/dashboard/settings");
      if (response.status === 401) {
        window.location.assign("/sign-in");
        return;
      }
      const body = (await response.json()) as Settings & { error?: string };
      if (!response.ok) throw new Error(body.error);
      setSettings(body);
    } catch {
      setAccountError("Unable to disconnect that account. Try again.");
    } finally {
      setAction(null);
    }
  }

  async function submitEmailChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = emailDraft.trim();
    if (!validEmail(next)) {
      setAccountError("Enter a valid email address or try again.");
      return;
    }
    setAction("email");
    setAccountError(null);
    setEmailSent(false);
    try {
      const { error } = await authClient.changeEmail({
        newEmail: next,
        callbackURL: "/settings",
      });
      if (error) throw new Error(error.message);
      setEmailSent(true);
    } catch {
      setAccountError("Unable to change email. Try again.");
    } finally {
      setAction(null);
    }
  }

  async function billingAction(
    path: "checkout" | "portal",
    interval?: "month" | "year",
  ) {
    setAction(interval ? `${path}-${interval}` : path);
    try {
      const response = await fetch(`/api/v1/billing/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(interval ? { interval } : {}),
      });
      const body = (await response.json().catch(() => null)) as {
        checkoutUrl?: string;
        portalUrl?: string;
        error?: string;
      } | null;
      const url = body?.checkoutUrl ?? body?.portalUrl;
      if (response.status === 402) {
        setEntitlement(body?.error ?? "Hosted Cloud subscription required");
        return;
      }
      if (!response.ok || !url)
        throw new Error(body?.error ?? "Unable to open billing");
      if (path === "portal")
        window.open(url, "_blank", "noopener,noreferrer");
      else window.location.assign(url);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to open billing",
      );
    } finally {
      setAction(null);
    }
  }

  if (error)
    return (
      <DashboardShell view={view}>
        <div className="dashboard-error" role="alert">
          <h1>{titles[view]}</h1>
          <p>{error}</p>
        </div>
      </DashboardShell>
    );
  if (entitlement && !data)
    return (
      <DashboardShell view={view}>
        <header className="dashboard-page-header">
          <h1>{titles[view]}</h1>
        </header>
        <EntitlementPanel message={entitlement} />
      </DashboardShell>
    );
  if (!data)
    return (
      <DashboardShell view={view}>
        <Loading />
      </DashboardShell>
    );
  const pending = data.skills.filter(
    (skill) => skill.resolutionStatus === "PENDING_RESOLUTION",
  );
  const resolved = data.skills.length - pending.length;
  const locked = data.skills.filter((skill) => skill.locked).length;
  const deviceCounts = data.devices.reduce(
    (counts, device) => {
      counts[device.syncStatus] = (counts[device.syncStatus] ?? 0) + 1;
      return counts;
    },
    {} as Record<string, number>,
  );

  if (view === "overview")
    return (
      <DashboardShell view={view}>
        <header className="dashboard-overview-header">
          <p className="dashboard-eyebrow">{data.workspace.name}</p>
          <h1>Your desired state</h1>
          <p className="dashboard-revision">
            Revision {data.revision.sequence}
          </p>
          <p className="dashboard-revision">
            {data.revision.id
              ? data.revision.id.slice(0, 12)
              : "not yet created"}
          </p>
        </header>
        <section className="dashboard-panel" aria-labelledby="desired-skills">
          <h2 id="desired-skills">Desired skills</h2>
          {data.skills.length === 0 ? (
            <p className="dashboard-empty">No managed skills yet.</p>
          ) : (
            <dl className="dashboard-skill-summary">
              <div>
                <dt>Total</dt>
                <dd>{data.skills.length}</dd>
              </div>
              <div>
                <dt>Resolved</dt>
                <dd>{resolved}</dd>
              </div>
              <div>
                <dt>Pending</dt>
                <dd>{pending.length}</dd>
              </div>
              <div>
                <dt>Locked</dt>
                <dd>{locked}</dd>
              </div>
            </dl>
          )}
          {pending.length > 0 && (
            <p className="dashboard-pending">
              <StatusLabel status="PENDING_RESOLUTION" />
              {pending.length} skill{pending.length === 1 ? "" : "s"} need a
              device with Git access. No remote sync is requested.
            </p>
          )}
          <a className="dashboard-inline-link" href="/dashboard/skills">
            Open skills
          </a>
        </section>
        <section
          className="dashboard-panel dashboard-devices-panel"
          aria-labelledby="device-reports"
        >
          <h2 id="device-reports">Devices</h2>
          {data.devices.length === 0 ? (
            <p className="dashboard-empty">
              No paired devices have reported yet.
            </p>
          ) : (
            <dl className="dashboard-skill-summary">
              <div>
                <dt>Total</dt>
                <dd>{data.devices.length}</dd>
              </div>
              <div>
                <dt>Synced</dt>
                <dd>{deviceCounts.SYNCED ?? 0}</dd>
              </div>
              <div>
                <dt>Drifted</dt>
                <dd>{deviceCounts.DRIFTED ?? 0}</dd>
              </div>
              <div>
                <dt>Never synced</dt>
                <dd>{deviceCounts.NEVER_SYNCED ?? 0}</dd>
              </div>
            </dl>
          )}
          <a className="dashboard-inline-link" href="/dashboard/devices">
            Open devices
          </a>
        </section>
      </DashboardShell>
    );

  if (view === "skills" || view === "devices")
    return (
      <DashboardShell view={view}>
        <header className="dashboard-page-header">
          <p className="dashboard-eyebrow">{data.workspace.name}</p>
          <h1>{titles[view]}</h1>
          <p className="dashboard-revision">
            Revision {data.revision.sequence}
          </p>
          <p className="dashboard-revision">
            {data.revision.id
              ? data.revision.id.slice(0, 12)
              : "not yet created"}
          </p>
        </header>
        {view === "skills" && (
          <section className="dashboard-panel" aria-labelledby="desired-skills">
            <h2 id="desired-skills">Desired skills</h2>
            {pending.length > 0 && (
              <p className="dashboard-pending">
                <StatusLabel status="PENDING_RESOLUTION" />
                {pending.map((skill) => skill.skill).join(", ")} must be
                resolved by a device with repository access. No remote sync is
                requested.
              </p>
            )}
            {data.skills.length === 0 ? (
              <p className="dashboard-empty">
                No managed skills yet.
              </p>
            ) : (
              <div className="dashboard-table-wrap">
                <table className="dashboard-skills">
                  <caption>Desired skills in this workspace</caption>
                  <thead>
                    <tr>
                      <th>Skill</th>
                      <th>Ref</th>
                      <th>Resolution</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.skills.map((skill) => (
                      <tr key={skill.id}>
                        <td data-label="Skill">{skill.skill}</td>
                        <td data-label="Ref">
                          <code>{skill.ref}</code>
                        </td>
                        <td data-label="Resolution">
                          <StatusLabel status={skill.resolutionStatus} />
                        </td>
                        <td data-label="Actions">
                          <button
                            className="dashboard-secondary-button"
                            type="button"
                            disabled={action === skill.id}
                            onClick={() => removeSkill(skill.id, skill.skill)}
                          >
                            {action === skill.id ? "Removing…" : "Remove"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <form className="dashboard-add-skill" onSubmit={addSkill}>
              <p className="dashboard-add-skill-kicker">Add a Git-backed skill</p>
              <label>
                Source
                <input
                  autoComplete="off"
                  disabled={action === "add"}
                  name="source"
                  placeholder="https://github.com/owner/skills.git"
                  required
                  spellCheck={false}
                />
              </label>
              <label>
                Skill
                <input
                  autoComplete="off"
                  disabled={action === "add"}
                  name="skill"
                  required
                  spellCheck={false}
                />
              </label>
              <label>
                Ref
                <input
                  autoComplete="off"
                  disabled={action === "add"}
                  name="ref"
                  placeholder="main"
                  spellCheck={false}
                />
              </label>
              <button type="submit" disabled={action === "add"}>
                {action === "add" ? "Adding…" : "Add skill"}
              </button>
              <p className="dashboard-add-skill-note">
                New skills stay pending until a device with Git access resolves them. Devices apply on <code>corotum sync</code>. No remote sync is requested.
              </p>
            </form>
          </section>
        )}
        {view === "devices" && (
          <section className="dashboard-overview-block" aria-labelledby="device-reports">
            <h2 id="device-reports">Device reports</h2>
            {data.devices.length === 0 ? (
              <p className="dashboard-empty">
                No paired devices have reported yet.
                <br />
                <span>
                  Pair a device from the CLI with <code>corotum login</code>.
                </span>
              </p>
            ) : (
              <div className="dashboard-device-grid">
                {data.devices.map((device) => (
                  <article className="dashboard-device-tile" key={device.id}>
                    <header>
                      <h3>{device.name}</h3>
                      <StatusLabel status={device.syncStatus} />
                    </header>
                    <p className="dashboard-device-meta">
                      {device.platform}/{device.architecture}
                      <span>rev {device.appliedRevisionSequence}</span>
                    </p>
                    {device.targets.length === 0 ? (
                      <p className="dashboard-target-empty">No target report.</p>
                    ) : (
                      <ul className="dashboard-targets">
                        {device.targets.map((target) => (
                          <li key={`${target.skillId}-${target.agentId}`}>
                            <code>{target.skillId}</code>
                            <code>{target.agentId}</code>
                            <StatusLabel status={target.status} />
                            {target.errorCode && (
                              <code className="dashboard-error-code">
                                ({target.errorCode})
                              </code>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    <button
                      className="dashboard-secondary-button"
                      type="button"
                      disabled={action === device.id}
                      onClick={() => revokeDevice(device.id)}
                    >
                      {action === device.id ? "Removing…" : "Remove"}
                    </button>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}
      </DashboardShell>
    );

  if (view === "billing")
    return (
      <DashboardShell view={view}>
        <header className="dashboard-page-header">
          <p className="dashboard-eyebrow">{data.workspace.name}</p>
          <h1>Billing</h1>
          <p className="dashboard-revision">
            Revision {data.revision.sequence}
          </p>
          <p className="dashboard-revision">
            {data.revision.id
              ? data.revision.id.slice(0, 12)
              : "not yet created"}
          </p>
        </header>
        {!settings ? (
          <Loading />
        ) : (
          <section
            className="dashboard-panel dashboard-billing-panel"
            aria-labelledby="billing-title"
          >
            <h2 id="billing-title">Corotum Cloud</h2>
            {entitlement && (
              <p className="dashboard-pending">
                <StatusLabel status="402" />
                {entitlement}
              </p>
            )}
            {settings.hosted ? (
              <>
                <div className="dashboard-billing-summary">
                  {settings.subscription ? (
                    <>
                      <p className="dashboard-billing-label">
                        Current subscription
                      </p>
                      <p className="dashboard-billing-status">
                        <StatusLabel
                          status={settings.subscription.status.toUpperCase()}
                        />
                        <span>
                          {settings.subscription.interval === "month"
                            ? "$5.99/month"
                            : "$59.90/year"}
                        </span>
                      </p>
                      {settings.subscription.currentPeriodEnd && (
                        <p className="dashboard-billing-note">
                          Renews{" "}
                          {new Date(
                            settings.subscription.currentPeriodEnd,
                          ).toLocaleDateString()}
                          .
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      <p className="dashboard-billing-label">Subscription</p>
                      <p className="dashboard-billing-empty">
                        No active Cloud subscription.
                      </p>
                    </>
                  )}
                </div>
                <fieldset
                  className="dashboard-billing-actions"
                  aria-label="Billing actions"
                >
                  {!(settings.subscription &&
                    (settings.subscription.status === "active" ||
                      settings.subscription.status === "trialing" ||
                      settings.subscription.status === "paid")) && (
                    <>
                      <button
                        className="dashboard-primary-button"
                        type="button"
                        disabled={action !== null}
                        onClick={() => billingAction("checkout", "month")}
                      >
                        {action === "checkout-month"
                          ? "Opening monthly checkout…"
                          : "Start monthly - $5.99"}
                      </button>
                      <button
                        className="dashboard-secondary-button"
                        type="button"
                        disabled={action !== null}
                        onClick={() => billingAction("checkout", "year")}
                      >
                        {action === "checkout-year"
                          ? "Opening annual checkout…"
                          : "Start annual - $59.90"}
                      </button>
                    </>
                  )}
                  {settings.subscription && (
                    <button
                      className="dashboard-secondary-button"
                      type="button"
                      disabled={action !== null}
                      onClick={() => billingAction("portal")}
                    >
                      {action === "portal"
                        ? "Opening portal…"
                        : "Manage subscription"}
                    </button>
                  )}
                </fieldset>
              </>
            ) : (
              <div className="dashboard-self-hosted">
                <p className="dashboard-billing-label">Self-hosted Cloud</p>
                <p>
                  This Corotum Cloud instance is self-hosted. Cloud
                  functionality is free and has no billing portal.
                </p>
              </div>
            )}
          </section>
        )}
      </DashboardShell>
    );

  return (
    <DashboardShell view={view}>
      <header className="dashboard-page-header">
        <p className="dashboard-eyebrow">{data.workspace.name}</p>
        <h1>Settings</h1>
        <p className="dashboard-revision">Revision {data.revision.sequence}</p>
        <p className="dashboard-revision">
          {data.revision.id ? data.revision.id.slice(0, 12) : "not yet created"}
        </p>
      </header>
      {!settings ? (
        <Loading />
      ) : (
        <>
      <section
        className="dashboard-panel dashboard-settings-panel"
        aria-labelledby="sign-in-methods"
      >
        <h2 id="sign-in-methods">Sign-in methods</h2>
        <p>
          Magic link uses {settings.email ?? "your Corotum email"}. GitHub and
          Google can use a different address; they stay on this account after
          you connect them here.
        </p>
        {accountError && (
          <p className="dashboard-pending" role="alert">
            {accountError}
          </p>
        )}
        {(["github", "google"] as const).map((provider) => {
          const linked = settings.accounts.find(
            (account) => account.providerId === provider,
          );
          const label = provider === "github" ? "GitHub" : "Google";
          return (
            <div className="dashboard-account-row" key={provider}>
              <p className="dashboard-billing-label">
                {label}
                {linked ? ` · ${linked.label}` : ""}
              </p>
              <button
                className="dashboard-secondary-button"
                type="button"
                disabled={action !== null}
                onClick={() =>
                  linked ? unlinkProvider(provider) : linkProvider(provider)
                }
              >
                {action === provider || action === `unlink-${provider}`
                  ? linked
                    ? `Disconnecting ${label}…`
                    : `Connecting ${label}…`
                  : linked
                    ? `Disconnect ${label}`
                    : `Connect ${label}`}
              </button>
            </div>
          );
        })}
      </section>
      <section
        className="dashboard-panel dashboard-settings-panel"
        aria-labelledby="magic-link-email-heading"
      >
        <h2 id="magic-link-email-heading">Magic link email</h2>
        <p>
          Sign-in links go to this address. GitHub and Google stay connected
          if you change it.
        </p>
        {emailSent ? (
          <p className="dashboard-pending">
            We sent a confirmation link to the new address.
          </p>
        ) : (
          <form className="dashboard-email-change" onSubmit={submitEmailChange}>
            <label htmlFor="magic-link-email">Email</label>
            <input
              autoComplete="email"
              disabled={action !== null}
              id="magic-link-email"
              inputMode="email"
              name="email"
              onChange={(event) => setEmailDraft(event.target.value)}
              placeholder={settings.email ?? undefined}
              required
              type="email"
              value={emailDraft}
            />
            <button
              className="dashboard-secondary-button"
              disabled={action !== null}
              type="submit"
            >
              {action === "email" ? "Sending link…" : "Change email"}
            </button>
          </form>
        )}
      </section>
      <section
        className="dashboard-panel dashboard-settings-panel"
        aria-labelledby="cli-preferences"
      >
        <h2 id="cli-preferences">Local CLI preferences</h2>
        <p>
          Telemetry is an anonymous, opt-in preference stored locally by the
          Corotum CLI. It is not a dashboard setting and is never tied to
          your account or devices.
        </p>
        <p className="dashboard-settings-instruction">
          Change the preference separately on each machine:
        </p>
        <code className="dashboard-command">
          corotum config set telemetry true
          <br />
          corotum config set telemetry false
        </code>
      </section>
      <section
        className="dashboard-panel dashboard-settings-panel"
        aria-labelledby="cloud-data-heading"
      >
        <h2 id="cloud-data-heading">Cloud data</h2>
        <p>
          Delete desired-state skills stored in Cloud. Local skill files on
          devices are not deleted. Remove a paired device on the Devices page.
        </p>
        <button
          className="dashboard-secondary-button"
          type="button"
          disabled={action !== null}
          onClick={() => clearCloudData()}
        >
          {action === "clear-cloud" ? "Deleting…" : "Delete Cloud skills"}
        </button>
      </section>
        </>
      )}
    </DashboardShell>
  );
}
