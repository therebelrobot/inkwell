import { useState, type FormEvent } from "react";
import { api } from "../api";

export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [password, setPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (formEvent: FormEvent) => {
    formEvent.preventDefault();
    setSubmitting(true);
    setErrorMessage(null);
    try {
      await api.signIn(password);
      onSignedIn();
    } catch (signInFailure) {
      setErrorMessage(signInFailure instanceof Error ? signInFailure.message : String(signInFailure));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="sign-in">
      <form onSubmit={submit} className="sign-in__form">
        <p className="wordmark">inkwell</p>
        <label htmlFor="editor-password">Password</label>
        <input
          id="editor-password"
          type="password"
          value={password}
          onChange={(changeEvent) => setPassword(changeEvent.target.value)}
          autoComplete="current-password"
          autoFocus
        />
        {errorMessage && (
          <p className="form-error" role="alert">
            {errorMessage}
          </p>
        )}
        <button type="submit" className="button--verdigris" disabled={submitting || !password}>
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
