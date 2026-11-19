import { Eye, EyeOff, Fingerprint } from "lucide-react";
import { type FormEvent, useState } from "react";
import { AuthShell, FloatingInput } from "@/components/AuthShell";
import { FormError } from "@/components/FormError";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { api, authenticateWithPasskey, errorMessage } from "@/lib/api";
import { type Provider, startOAuth, takeOAuthError, useSignInOptions } from "@/lib/oauth";
import { supportsPasskeys } from "@/lib/webauthn";

function ProviderIcon({ provider }: { provider: Provider }) {
  if (provider === "google") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5 shrink-0">
        <path
          fill="#4285F4"
          d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82Z"
        />
        <path
          fill="#34A853"
          d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24Z"
        />
        <path
          fill="#FBBC05"
          d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29a11.99 11.99 0 0 0 0 10.76l3.98-3.09Z"
        />
        <path
          fill="#EA4335"
          d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09c.95-2.85 3.6-4.96 6.73-4.96Z"
        />
      </svg>
    );
  }
  if (provider === "github") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5 shrink-0 fill-foreground">
        <path d="M12 .3a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.03c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6.02 0c2.28-1.55 3.29-1.23 3.29-1.23.66 1.66.25 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.63-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.21.7.82.58A12 12 0 0 0 12 .3Z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5 shrink-0 fill-foreground">
      <path d="M16.37 12.76c.02 2.58 2.26 3.44 2.29 3.45-.02.06-.36 1.23-1.18 2.43-.71 1.04-1.45 2.08-2.62 2.1-1.14.02-1.51-.68-2.82-.68-1.31 0-1.72.66-2.8.7-1.12.04-1.98-1.12-2.7-2.16-1.47-2.12-2.59-5.99-1.08-8.61.75-1.3 2.09-2.12 3.54-2.14 1.11-.02 2.15.75 2.82.75.67 0 1.94-.92 3.27-.79.56.02 2.12.23 3.12 1.69-.08.05-1.86 1.09-1.84 3.26ZM14.22 6.4c.6-.72 1-1.73.89-2.73-.86.04-1.91.57-2.53 1.3-.55.64-1.04 1.67-.91 2.65.96.07 1.95-.49 2.55-1.22Z" />
    </svg>
  );
}

export function SignIn({
  notAdmin,
  onSignedIn,
}: {
  notAdmin: boolean;
  onSignedIn: () => Promise<void>;
}) {
  const [step, setStep] = useState<"password" | "code">("password");
  const [useBackup, setUseBackup] = useState(false);
  const [trustDevice, setTrustDevice] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(takeOAuthError);
  const shown = error || (notAdmin ? "This account does not have admin privileges." : "");
  const [busy, setBusy] = useState(false);
  const { appName, providers, emailPassword } = useSignInOptions();
  const canPasskey = supportsPasskeys();

  const signInWith = async (provider: Provider) => {
    setBusy(true);
    setError("");
    try {
      await startOAuth("/api/auth/sign-in/social", provider);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  const signInPasskey = async () => {
    setBusy(true);
    setError("");
    try {
      await authenticateWithPasskey();
      await onSignedIn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      if (step === "code") {
        const endpoint = useBackup
          ? "/api/auth/two-factor/verify-backup-code"
          : "/api/auth/two-factor/verify-totp";
        const rawCode = String(form.get("code") ?? "").trim();
        await api(endpoint, {
          method: "POST",
          body: {
            code: useBackup ? rawCode : rawCode.replace(/\s/g, ""),
            trustDevice,
          },
        });
      } else {
        const result = await api<{ twoFactorRedirect?: boolean }>("/api/auth/sign-in/email", {
          method: "POST",
          body: { email: form.get("email"), password: form.get("password") },
        });
        if (result?.twoFactorRedirect) {
          setStep("code");
          setUseBackup(false);
          return;
        }
      }
      await onSignedIn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const hasAlternatives = step === "password" && (canPasskey || providers.length > 0);
  // The form holds the password step and the two-factor step; with EMAIL_PASSWORD=off only the latter.
  // Shown while the server has not answered, so default deployments do not jump; hidden once it says off.
  const showForm = step === "code" || emailPassword !== false;
  const noMethod = step === "password" && emailPassword === false && !hasAlternatives;

  return (
    <AuthShell
      title={step === "password" ? "Welcome" : "Verify your identity"}
      subtitle={
        step === "password"
          ? `Log in${appName ? ` to ${appName}` : ""} to continue to Admin Console.`
          : useBackup
            ? "Enter one of your single-use recovery backup codes."
            : "Enter the 6-digit code from your authenticator app."
      }
    >
      {showForm && (
        <form className="grid gap-4" onSubmit={submit}>
          {step === "password" ? (
            <>
              <FloatingInput
                id="email"
                name="email"
                type="email"
                label="Email address"
                requiredMark
                autoComplete="username"
                required
                autoFocus
              />
              <FloatingInput
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                label="Password"
                requiredMark
                autoComplete="current-password"
                required
                endAdornment={
                  <button
                    type="button"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    onClick={() => setShowPassword((prev) => !prev)}
                    className="grid size-8 place-items-center rounded-[4px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                }
              />
            </>
          ) : (
            <>
              {useBackup ? (
                <FloatingInput
                  key="backup"
                  id="code"
                  name="code"
                  label="Recovery backup code"
                  requiredMark
                  autoComplete="off"
                  maxLength={32}
                  className="font-mono tracking-widest"
                  required
                  autoFocus
                />
              ) : (
                <FloatingInput
                  key="totp"
                  id="code"
                  name="code"
                  label="6-digit code"
                  requiredMark
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9 ]{6,7}"
                  maxLength={7}
                  className="font-mono tracking-[0.25em] tabular-nums"
                  required
                  autoFocus
                />
              )}
              <div className="flex items-center gap-2.5 pt-0.5">
                <Checkbox
                  id="trust-device"
                  checked={trustDevice}
                  onCheckedChange={(v) => setTrustDevice(v === true)}
                />
                <Label htmlFor="trust-device" className="text-[13px] font-normal text-foreground">
                  Remember this device for 30 days
                </Label>
              </div>
            </>
          )}

          <FormError message={shown} />

          <button
            type="submit"
            disabled={busy}
            className="mt-1 inline-flex h-[50px] w-full items-center justify-center rounded-[4px] bg-primary px-4 text-[15px] font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
          >
            Continue
          </button>
        </form>
      )}

      {!showForm && <FormError message={shown} />}
      {noMethod && (
        <p className="text-[14px] text-muted-foreground">
          No sign-in method is set up. Configure Google, Apple or GitHub, or set EMAIL_PASSWORD=on,
          then reload this page.
        </p>
      )}

      {hasAlternatives && (
        <>
          {showForm && (
            <div className="my-6 flex items-center gap-4">
              <span className="h-px flex-1 bg-border" />
              <span className="text-[12px] font-medium tracking-[0.06em] text-muted-foreground">
                OR
              </span>
              <span className="h-px flex-1 bg-border" />
            </div>
          )}

          <div className="grid gap-2.5">
            {canPasskey && (
              <button
                type="button"
                disabled={busy}
                onClick={signInPasskey}
                className="flex h-[50px] w-full items-center justify-start gap-3.5 rounded-[4px] border border-[#c2c8d0] bg-card px-4 text-[15px] font-normal text-foreground transition-colors duration-150 hover:bg-secondary/65 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/25 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 dark:border-input"
              >
                <Fingerprint className="size-5 shrink-0 text-foreground" />
                <span>Continue with a passkey</span>
              </button>
            )}
            {providers.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                disabled={busy}
                onClick={() => signInWith(id)}
                className="flex h-[50px] w-full items-center justify-start gap-3.5 rounded-[4px] border border-[#c2c8d0] bg-card px-4 text-[15px] font-normal text-foreground transition-colors duration-150 hover:bg-secondary/65 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/25 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 dark:border-input"
              >
                <ProviderIcon provider={id} />
                <span>Continue with {label}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {step === "code" && (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t pt-4 text-[13px]">
          <button
            type="button"
            className="font-medium text-primary-ink hover:underline"
            onClick={() => {
              setUseBackup((prev) => !prev);
              setError("");
            }}
          >
            {useBackup ? "Try authenticator app" : "Use a recovery code"}
          </button>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => {
              setStep("password");
              setUseBackup(false);
              setTrustDevice(false);
              setError("");
            }}
          >
            Back to login
          </button>
        </div>
      )}
    </AuthShell>
  );
}
