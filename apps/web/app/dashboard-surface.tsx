"use client";
import { useEffect, useState } from "react";

type View = "overview" | "skills" | "devices" | "billing" | "settings";
type Dashboard = { workspace: { name: string }; revision: { id: string | null; sequence: number }; skills: { id: string; skill: string; ref: string; resolutionStatus: string; locked: boolean }[]; devices: { id: string; name: string; platform: string; architecture: string; appliedRevisionSequence: number; syncStatus: string; targets: { skillId: string; agentId: string; status: string; errorCode: string | null }[] }[] };
type Settings = { hosted: boolean; subscription: { interval: "month" | "year"; status: string; currentPeriodEnd: number | null } | null };

const titles: Record<View, string> = { overview: "Your desired state", skills: "Skills", devices: "Devices", billing: "Billing", settings: "Settings" };

export function DashboardSurface({ view }: { view: View }) {
  const [data, setData] = useState<Dashboard | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/v1/dashboard").then(async (response) => {
      const body = await response.json() as Dashboard & { error?: string };
      if (response.ok) setData(body); else setError(body.error ?? "Unable to load dashboard");
    }).catch(() => setError("Unable to load dashboard"));
    if (view === "billing" || view === "settings") fetch("/api/v1/dashboard/settings").then(async (response) => {
      const body = await response.json() as Settings & { error?: string };
      if (response.ok) setSettings(body); else setError(body.error ?? "Unable to load settings");
    }).catch(() => setError("Unable to load settings"));
  }, [view]);

  async function revokeDevice(deviceId: string) {
    if (!window.confirm("Revoke this device? Its remote status data will be preserved.")) return;
    setAction(deviceId);
    try {
      const response = await fetch(`/api/v1/devices/${deviceId}/revoke`, { method: "POST" });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Unable to revoke device");
      setData((current) => current && { ...current, devices: current.devices.filter((device) => device.id !== deviceId) });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to revoke device"); }
    finally { setAction(null); }
  }

  async function billingAction(path: "checkout" | "portal", interval?: "month" | "year") {
    setAction(path);
    try {
      const response = await fetch(`/api/v1/billing/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(interval ? { interval } : {}) });
      const body = await response.json() as { checkoutUrl?: string; portalUrl?: string; error?: string };
      const url = body.checkoutUrl ?? body.portalUrl;
      if (!response.ok || !url) throw new Error(body.error ?? "Unable to open billing");
      window.location.assign(url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to open billing"); }
    finally { setAction(null); }
  }

  if (error) return <main className="dashboard"><h1>ToolMirror</h1><p role="alert">{error}</p></main>;
  if (!data) return <main className="dashboard"><p>Loading workspace…</p></main>;
  const pending = data.skills.filter((skill) => skill.resolutionStatus === "PENDING_RESOLUTION");
  return <main className="dashboard">
    <nav><strong>ToolMirror</strong><a href="/dashboard">Overview</a><a href="/dashboard/skills">Skills</a><a href="/dashboard/devices">Devices</a><a href="/dashboard/billing">Billing</a><a href="/settings">Settings</a></nav>
    <header><p className="eyebrow">{data.workspace.name}</p><h1>{titles[view]}</h1><p>Revision {data.revision.sequence}{data.revision.id ? ` · ${data.revision.id.slice(0, 12)}` : " · not yet created"}</p></header>
    {(view === "overview" || view === "skills") && <section><h2>Desired skills</h2>{data.skills.length === 0 ? <p>No managed skills yet.</p> : <table><thead><tr><th>Skill</th><th>Ref</th><th>Resolution</th><th>Lock</th></tr></thead><tbody>{data.skills.map((skill) => <tr key={skill.id}><td>{skill.skill}</td><td><code>{skill.ref}</code></td><td>{skill.resolutionStatus}</td><td>{skill.locked ? "LOCKED" : "PENDING_RESOLUTION"}</td></tr>)}</tbody></table>}</section>}
    {pending.length > 0 && <section><h2>Awaiting device resolution</h2><p>{pending.map((skill) => skill.skill).join(", ")} must be resolved by a device with repository access. No remote sync is requested.</p></section>}
    {(view === "overview" || view === "devices") && <section><h2>Device reports</h2>{data.devices.length === 0 ? <p>No paired devices have reported yet.</p> : data.devices.map((device) => <article className="device" key={device.id}><h3>{device.name} <span>{device.syncStatus}</span></h3><p>{device.platform}/{device.architecture} · applied revision {device.appliedRevisionSequence}</p>{device.targets.length === 0 ? <p>No target report.</p> : <ul>{device.targets.map((target) => <li key={`${target.skillId}-${target.agentId}`}>{target.skillId} · {target.agentId} · <strong>{target.status}</strong>{target.errorCode ? ` (${target.errorCode})` : ""}</li>)}</ul>}{view === "devices" && <button type="button" disabled={action === device.id} onClick={() => revokeDevice(device.id)}>{action === device.id ? "Revoking…" : "Revoke device"}</button>}</article>)}</section>}
    {view === "billing" && settings && <section><h2>ToolMirror Cloud</h2>{settings.hosted ? <>{settings.subscription ? <p>Current subscription: <strong>{settings.subscription.status}</strong> · {settings.subscription.interval === "month" ? "$5.99/month" : "$59.90/year"}{settings.subscription.currentPeriodEnd ? ` · renews ${new Date(settings.subscription.currentPeriodEnd).toLocaleDateString()}` : ""}</p> : <p>No active Cloud subscription.</p>}<button type="button" disabled={action === "checkout"} onClick={() => billingAction("checkout", "month")}>Start monthly · $5.99</button><button type="button" disabled={action === "checkout"} onClick={() => billingAction("checkout", "year")}>Start annual · $59.90</button>{settings.subscription && <button type="button" disabled={action === "portal"} onClick={() => billingAction("portal")}>{action === "portal" ? "Opening…" : "Manage subscription"}</button>}</> : <p>This is a self-hosted ToolMirror Cloud instance. Cloud functionality is free and has no billing portal.</p>}</section>}
    {view === "settings" && <section><h2>Local CLI preferences</h2><p>Telemetry is an anonymous, opt-in preference stored locally by the ToolMirror CLI. It is not a dashboard setting and is never tied to your account or devices.</p><p>Use <code>toolmirror config set telemetry true</code> or <code>toolmirror config set telemetry false</code> on each machine to change it.</p></section>}
  </main>;
}
