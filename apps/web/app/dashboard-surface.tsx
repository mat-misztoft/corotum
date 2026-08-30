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
  if (status === "SYNCED" || status === "LOCKED") return "status-synced";
  if (status === "DRIFTED") return "status-drifted";
  if (status === "ERROR" || status === "AUTH_REQUIRED") return "status-error";
  return "status-attention";
}

function statusMark(status: string) {
  return status === "SYNCED" || status === "LOCKED"
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
      <div className="dashboard-brand-rule" />
      <nav className="dashboard-nav" aria-label="ToolMirror">
        <a className="wordmark" href="/dashboard">
          ToolMirror
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
      <main className="dashboard-content">{children}</main>
    </div>
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
  const [action, setAction] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/v1/dashboard")
      .then(async (response) => {
        if (response.status === 401) {
          window.location.assign("/sign-in");
          return;
        }
        const body = (await response.json()) as Dashboard & { error?: string };
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
    setAction(path);
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
                Add skills from the CLI with <code>toolmirror add</code>.
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

  return (
    <DashboardShell view={view}>
      <div className="dashboard-legacy">
        <header>
          <p className="eyebrow">{data.workspace.name}</p>
          <h1>{titles[view]}</h1>
          <p>
            Revision {data.revision.sequence}
            {data.revision.id
              ? ` · ${data.revision.id.slice(0, 12)}`
              : " · not yet created"}
          </p>
        </header>
        {view === "skills" && (
          <section>
            <h2>Desired skills</h2>
            {data.skills.length === 0 ? (
              <p>No managed skills yet.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Skill</th>
                    <th>Ref</th>
                    <th>Resolution</th>
                    <th>Lock</th>
                  </tr>
                </thead>
                <tbody>
                  {data.skills.map((skill) => (
                    <tr key={skill.id}>
                      <td>{skill.skill}</td>
                      <td>
                        <code>{skill.ref}</code>
                      </td>
                      <td>{skill.resolutionStatus}</td>
                      <td>{skill.locked ? "LOCKED" : "PENDING_RESOLUTION"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        )}
        {view === "devices" && (
          <section>
            <h2>Device reports</h2>
            {data.devices.length === 0 ? (
              <p>No paired devices have reported yet.</p>
            ) : (
              data.devices.map((device) => (
                <article className="device" key={device.id}>
                  <h3>
                    {device.name} <span>{device.syncStatus}</span>
                  </h3>
                  <p>
                    {device.platform}/{device.architecture} · applied revision{" "}
                    {device.appliedRevisionSequence}
                  </p>
                  {device.targets.length === 0 ? (
                    <p>No target report.</p>
                  ) : (
                    <ul>
                      {device.targets.map((target) => (
                        <li key={`${target.skillId}-${target.agentId}`}>
                          {target.skillId} · {target.agentId} ·{" "}
                          <strong>{target.status}</strong>
                          {target.errorCode ? ` (${target.errorCode})` : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                  <button
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
        {view === "billing" && settings && (
          <section>
            <h2>ToolMirror Cloud</h2>
            {settings.hosted ? (
              <>
                {settings.subscription ? (
                  <p>
                    Current subscription:{" "}
                    <strong>{settings.subscription.status}</strong> ·{" "}
                    {settings.subscription.interval === "month"
                      ? "$5.99/month"
                      : "$59.90/year"}
                    {settings.subscription.currentPeriodEnd
                      ? ` · renews ${new Date(settings.subscription.currentPeriodEnd).toLocaleDateString()}`
                      : ""}
                  </p>
                ) : (
                  <p>No active Cloud subscription.</p>
                )}
                <button
                  type="button"
                  disabled={action === "checkout"}
                  onClick={() => billingAction("checkout", "month")}
                >
                  Start monthly · $5.99
                </button>
                <button
                  type="button"
                  disabled={action === "checkout"}
                  onClick={() => billingAction("checkout", "year")}
                >
                  Start annual · $59.90
                </button>
                {settings.subscription && (
                  <button
                    type="button"
                    disabled={action === "portal"}
                    onClick={() => billingAction("portal")}
                  >
                    {action === "portal" ? "Opening…" : "Manage subscription"}
                  </button>
                )}
              </>
            ) : (
              <p>
                This is a self-hosted ToolMirror Cloud instance. Cloud
                functionality is free and has no billing portal.
              </p>
            )}
          </section>
        )}
        {view === "settings" && (
          <section>
            <h2>Local CLI preferences</h2>
            <p>
              Telemetry is an anonymous, opt-in preference stored locally by the
              ToolMirror CLI. It is not a dashboard setting and is never tied to
              your account or devices.
            </p>
            <p>
              Use <code>toolmirror config set telemetry true</code> or{" "}
              <code>toolmirror config set telemetry false</code> on each machine
              to change it.
            </p>
          </section>
        )}
      </div>
    </DashboardShell>
  );
}
