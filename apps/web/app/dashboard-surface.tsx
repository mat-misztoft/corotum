"use client";
import { useEffect, useState } from "react";

type View = "overview" | "skills" | "devices";
type Dashboard = { workspace: { name: string }; revision: { id: string | null; sequence: number }; skills: { id: string; skill: string; ref: string; resolutionStatus: string; locked: boolean }[]; devices: { id: string; name: string; platform: string; architecture: string; appliedRevisionSequence: number; syncStatus: string; targets: { skillId: string; agentId: string; status: string; errorCode: string | null }[] }[] };

export function DashboardSurface({ view }: { view: View }) {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { fetch("/api/v1/dashboard").then(async (response) => { const body = await response.json() as Dashboard & { error?: string }; if (response.ok) setData(body); else setError(body.error ?? "Unable to load dashboard"); }).catch(() => setError("Unable to load dashboard")); }, []);
  if (error) return <main className="dashboard"><h1>ToolMirror</h1><p role="alert">{error}</p></main>;
  if (!data) return <main className="dashboard"><p>Loading workspace…</p></main>;
  const pending = data.skills.filter((skill) => skill.resolutionStatus === "PENDING_RESOLUTION");
  return <main className="dashboard">
    <nav><strong>ToolMirror</strong><a href="/dashboard">Overview</a><a href="/dashboard/skills">Skills</a><a href="/dashboard/devices">Devices</a></nav>
    <header><p className="eyebrow">{data.workspace.name}</p><h1>{view === "overview" ? "Your desired state" : view === "skills" ? "Skills" : "Devices"}</h1><p>Revision {data.revision.sequence}{data.revision.id ? ` · ${data.revision.id.slice(0, 12)}` : " · not yet created"}</p></header>
    {(view === "overview" || view === "skills") && <section><h2>Desired skills</h2>{data.skills.length === 0 ? <p>No managed skills yet.</p> : <table><thead><tr><th>Skill</th><th>Ref</th><th>Resolution</th><th>Lock</th></tr></thead><tbody>{data.skills.map((skill) => <tr key={skill.id}><td>{skill.skill}</td><td><code>{skill.ref}</code></td><td>{skill.resolutionStatus}</td><td>{skill.locked ? "LOCKED" : "PENDING_RESOLUTION"}</td></tr>)}</tbody></table>}</section>}
    {pending.length > 0 && <section><h2>Awaiting device resolution</h2><p>{pending.map((skill) => skill.skill).join(", ")} must be resolved by a device with repository access. No remote sync is requested.</p></section>}
    {(view === "overview" || view === "devices") && <section><h2>Device reports</h2>{data.devices.length === 0 ? <p>No paired devices have reported yet.</p> : data.devices.map((device) => <article className="device" key={device.id}><h3>{device.name} <span>{device.syncStatus}</span></h3><p>{device.platform}/{device.architecture} · applied revision {device.appliedRevisionSequence}</p>{device.targets.length === 0 ? <p>No target report.</p> : <ul>{device.targets.map((target) => <li key={`${target.skillId}-${target.agentId}`}>{target.skillId} · {target.agentId} · <strong>{target.status}</strong>{target.errorCode ? ` (${target.errorCode})` : ""}</li>)}</ul>}</article>)}</section>}
  </main>;
}
