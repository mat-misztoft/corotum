"use client";
import { useEffect, useState } from "react";

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
  if (status === "SYNCED" || status === "LOCKED" || status === "ACTIVE")
    return "status-synced";
  if (status === "DRIFTED") return "status-drifted";
  if (status === "ERROR" || status === "AUTH_REQUIRED" || status === "402")
    return "status-error";
  return "status-attention";
}

function statusMark(status: string) {
  return status === "SYNCED" || status === "LOCKED" || status === "ACTIVE"
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
          </div>
        </nav>
      </header>
      <main className="dashboard-content">{children}</main>
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
    if (view === "billing")
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
  }, [view]);

  async function revokeDevice(deviceId: string) {
    if (
      !window.confirm(
        "Revoke this device? Its remote status data will be preserved.",
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
      const body = (await response.json()) as {
        checkoutUrl?: string;
        portalUrl?: string;
        error?: string;
      };
      const url = body.checkoutUrl ?? body.portalUrl;
      if (response.status === 402) {
        setEntitlement(body.error ?? "Hosted Cloud subscription required");
        return;
      }
      if (!response.ok || !url)
        throw new Error(body.error ?? "Unable to open billing");
      window.location.assign(url);
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
          {pending.length > 0 && (
            <p className="dashboard-pending">
              <StatusLabel status="PENDING_RESOLUTION" />
              {pending.map((skill) => skill.skill).join(", ")} must be resolved
              by a device with repository access. No remote sync is requested.
            </p>
          )}
          {data.skills.length === 0 ? (
            <p className="dashboard-empty">
              No managed skills yet.
              <br />
              <span>
                Add skills from the CLI with <code>corotum add</code>.
              </span>
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <section
          className="dashboard-panel dashboard-devices-panel"
          aria-labelledby="device-reports"
        >
          <h2 id="device-reports">Device reports</h2>
          {data.devices.length === 0 ? (
            <p className="dashboard-empty">
              No paired devices have reported yet.
            </p>
          ) : (
            data.devices.map((device) => (
              <article className="dashboard-device" key={device.id}>
                <header>
                  <h3>{device.name}</h3>
                  <StatusLabel status={device.syncStatus} />
                </header>
                <p className="dashboard-device-meta">
                  {device.platform}/{device.architecture}
                  <span>applied revision {device.appliedRevisionSequence}</span>
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
              </article>
            ))
          )}
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
                <br />
                <span>
                  Add skills from the CLI with <code>corotum add</code>.
                </span>
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
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
        {view === "devices" && (
          <section className="dashboard-panel" aria-labelledby="device-reports">
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
              data.devices.map((device) => (
                <article className="dashboard-device" key={device.id}>
                  <header>
                    <h3>{device.name}</h3>
                    <StatusLabel status={device.syncStatus} />
                  </header>
                  <p className="dashboard-device-meta">
                    {device.platform}/{device.architecture}
                    <span>
                      applied revision {device.appliedRevisionSequence}
                    </span>
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
                    {action === device.id ? "Revoking…" : "Revoke device"}
                  </button>
                </article>
              ))
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
    </DashboardShell>
  );
}
