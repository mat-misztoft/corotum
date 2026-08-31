import { SignInForm } from "./sign-in-form";

export default function SignInPage() {
  return (
    <main className="sign-in-page">
      <div className="sign-in-panel">
        <div className="sign-in-brand-rule" aria-hidden="true" />
        <a className="wordmark" href="/">
          Corotum
        </a>
        <p className="sign-in-kicker">COROTUM CLOUD</p>
        <h1>Sign in</h1>
        <p className="sign-in-intro">
          Use your account to manage your Cloud workspace.
        </p>
        <SignInForm />
      </div>
    </main>
  );
}
