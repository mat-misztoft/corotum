import { SignInForm } from "./sign-in-form";

export default function SignInPage() {
  return (
    <main className="sign-in-page">
      <div className="sign-in-panel">
        <a className="wordmark" href="/">ToolMirror</a>
        <p className="sign-in-kicker">TOOLMIRROR CLOUD</p>
        <h1>Sign in</h1>
        <p className="sign-in-intro">Use your account to manage your Cloud workspace.</p>
        <SignInForm />
      </div>
    </main>
  );
}
