"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import { authClient } from "../../src/auth-client";

type EmailState = "form" | "submitting" | "confirmed" | "error";

export function validEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function signInCallbackURL(search = "") {
  const next = new URLSearchParams(search).get("next");
  return next &&
    next.startsWith("/") &&
    !next.startsWith("//") &&
    !next.includes("\\") &&
    !next.includes("://")
    ? next
    : "/dashboard";
}

export function SignInForm() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<EmailState>("form");
  const [oauthProvider, setOauthProvider] = useState<
    "github" | "google" | null
  >(null);
  const [oauthError, setOauthError] = useState(false);
  const confirmationRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (state === "confirmed") confirmationRef.current?.focus();
  }, [state]);

  async function submitEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = email.trim();
    if (!validEmail(address)) {
      setState("error");
      return;
    }

    setState("submitting");
    try {
      const { error } = await authClient.signIn.magicLink({
        email: address,
        callbackURL: signInCallbackURL(window.location.search),
      });
      setState(error ? "error" : "confirmed");
    } catch {
      setState("error");
    }
  }

  async function signInWith(provider: "github" | "google") {
    setOauthError(false);
    setOauthProvider(provider);
    try {
      const { error } = await authClient.signIn.social({
        provider,
        callbackURL: signInCallbackURL(window.location.search),
      });
      if (error) {
        setOauthProvider(null);
        setOauthError(true);
      }
    } catch {
      setOauthProvider(null);
      setOauthError(true);
    }
  }

  if (state === "confirmed") {
    return (
      <section className="sign-in-confirmation" aria-labelledby="inbox-heading">
        <h2 id="inbox-heading" ref={confirmationRef} tabIndex={-1}>
          Check your inbox
        </h2>
        <p>We sent you a sign-in link.</p>
        <button
          className="text-button"
          type="button"
          onClick={() => setState("form")}
        >
          Use another email
        </button>
      </section>
    );
  }

  const submitting = state === "submitting";
  const busy = submitting || oauthProvider !== null;
  return (
    <>
      {oauthError && (
        <p className="sign-in-error" role="alert">
          Unable to continue. Try again.
        </p>
      )}
      <div className="oauth-actions" aria-busy={oauthProvider !== null}>
        <button
          disabled={busy}
          type="button"
          onClick={() => signInWith("github")}
        >
          {oauthProvider === "github"
            ? "Connecting to GitHub…"
            : "Continue with GitHub"}
        </button>
        <button
          disabled={busy}
          type="button"
          onClick={() => signInWith("google")}
        >
          {oauthProvider === "google"
            ? "Connecting to Google…"
            : "Continue with Google"}
        </button>
      </div>
      <div className="sign-in-separator" aria-hidden="true">
        <span>or</span>
      </div>
      <form aria-busy={submitting} noValidate onSubmit={submitEmail}>
        <label htmlFor="email">Email address</label>
        <input
          autoComplete="email"
          disabled={busy}
          id="email"
          inputMode="email"
          name="email"
          onChange={(event) => {
            setEmail(event.target.value);
            if (state === "error") setState("form");
          }}
          required
          type="email"
          value={email}
          aria-describedby={state === "error" ? "email-error" : undefined}
          aria-invalid={state === "error"}
        />
        {state === "error" && (
          <p id="email-error" className="sign-in-error" role="alert">
            Enter a valid email address or try again.
          </p>
        )}
        <button type="submit" disabled={busy}>
          {submitting ? "Sending sign-in link…" : "Continue with email"}
        </button>
      </form>
    </>
  );
}
