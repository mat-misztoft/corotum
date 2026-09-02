"use client";

import { type FormEvent, useEffect, useState } from "react";

function activateNext(code: string) {
  return code ? `/activate?code=${encodeURIComponent(code)}` : "/activate";
}

export default function ActivatePage() {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);

  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get("code") ?? "";
    setCode(value);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/cli/pairings/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userCode: code }),
      });
      if (response.status === 401) {
        window.location.assign(
          `/sign-in?next=${encodeURIComponent(activateNext(code))}`,
        );
        return;
      }
      const body = (await response.json()) as { error?: string };
      if (response.ok) setApproved(true);
      else setError(body.error ?? "Unable to approve this device.");
    } catch {
      setError("Unable to approve this device.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="sign-in-page">
      <div className="sign-in-panel">
        <div className="sign-in-brand-rule" aria-hidden="true" />
        <a className="wordmark" href="/">
          Corotum
        </a>
        <p className="sign-in-kicker">DEVICE PAIRING</p>
        {approved ? (
          <>
            <h1>Device approved</h1>
            <p className="sign-in-intro">This CLI device is now paired.</p>
            <a href="/dashboard">Open dashboard</a>
          </>
        ) : (
          <>
            <h1>Approve this device</h1>
            <p className="sign-in-intro">
              Enter the code from <code>corotum login</code>.
            </p>
            <form noValidate onSubmit={submit} aria-busy={busy}>
              <label htmlFor="code">User code</label>
              <input
                autoComplete="off"
                disabled={busy}
                id="code"
                name="userCode"
                onChange={(event) => setCode(event.target.value)}
                required
                spellCheck={false}
                value={code}
              />
              {error && (
                <p className="sign-in-error" role="alert">
                  {error}
                </p>
              )}
              <button type="submit" disabled={busy}>
                {busy ? "Approving…" : "Approve device"}
              </button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
