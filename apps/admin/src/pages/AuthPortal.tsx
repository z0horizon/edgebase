import { cn } from "cn";
import { ArrowLeft, CheckCircle2, KeyRound, MailCheck, ShieldAlert } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AuthShell, type AuthStep } from "@/components/AuthShell";
import { FormError } from "@/components/FormError";
import { PasswordField } from "@/components/PasswordField";
import { FederatedOptions } from "@/components/ProviderButtons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, authenticateWithPasskey, errorMessage, type User } from "@/lib/api";
import { type AuthMode, parseAuthUrl } from "@/lib/auth-url";
import { type Provider, startOAuth, takeAuthUrlState, useSignInOptions } from "@/lib/oauth";
import { supportsPasskeys } from "@/lib/webauthn";

const HASH_FOR_MODE: Record<AuthMode, string> = {
  signin: "#signin",
  signup: "#signup",
  forgot: "#forgot-password",
  reset: "#reset-password",
  verified: "#verified",
};

function ModeSwitcher({
  mode,
  onSelect,
}: {
  mode: "signin" | "signup";
  onSelect: (next: "signin" | "signup") => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-1 rounded-sm bg-muted p-0.5" role="tablist">
      {(
        [
          ["signin", "Sign in"],
          ["signup", "Create account"],
        ] as const
      ).map(([id, label]) => {
        const active = mode === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(id)}
            className={cn(
              "h-8 rounded-sm text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              active
                ? "bg-card text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function TurnstileField({
  id,
  value,
  onChange,
  note,
  required = true,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  note?: string;
  required?: boolean;
}) {
  return (
    <div className="grid gap-1.5 rounded-md border bg-muted/35 p-3">
      <Label htmlFor={id}>Turnstile verification token</Label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Paste X-Captcha-Response token"
        className="h-9 font-mono text-xs"
        required={required}
      />
      {note && <p className="text-[11px] text-muted-foreground">{note}</p>}
    </div>
  );
}

/**
 * Unified authentication portal supporting Sign In (+ 2FA & Passkey & OAuth), Sign Up,
 * Email Verification, Forgot Password, and Reset Password.
 */
export function AuthPortal({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const [initial] = useState(takeAuthUrlState);
  const [mode, setMode] = useState<AuthMode>(initial.initialMode);
  const [signInStep, setSignInStep] = useState<"password" | "code">("password");
  const [useBackup, setUseBackup] = useState(false);
  const [trustDevice, setTrustDevice] = useState(false);

  const [emailDraft, setEmailDraft] = useState("");
  const [unverifiedEmail, setUnverifiedEmail] = useState("");
  const [signUpSentEmail, setSignUpSentEmail] = useState("");
  const [marketingOptIn, setMarketingOptIn] = useState(false);

  const [forgotSentEmail, setForgotSentEmail] = useState("");
  const [resetToken, setResetToken] = useState(initial.resetToken);
  const [editingToken, setEditingToken] = useState(!initial.resetToken);
  const [resetDone, setResetDone] = useState(false);
  const [captchaToken, setCaptchaToken] = useState("");

  const [error, setError] = useState(initial.authError || initial.oauthError);
  const [busy, setBusy] = useState(false);

  const { appName, providers, emailPassword, turnstileRequired } = useSignInOptions();
  const canPasskey = supportsPasskeys();

  const resetModeState = useCallback((next: AuthMode) => {
    setMode(next);
    setError("");
    setUnverifiedEmail("");
    setCaptchaToken("");
    if (next !== "signin") {
      setSignInStep("password");
      setUseBackup(false);
      setTrustDevice(false);
    }
    if (next !== "signup") setSignUpSentEmail("");
    if (next !== "forgot") setForgotSentEmail("");
    if (next !== "reset") setResetDone(false);
  }, []);

  useEffect(() => {
    const onHash = () => {
      const parsed = parseAuthUrl(location.search, location.hash);
      resetModeState(parsed.state.initialMode);
      if (parsed.state.initialMode === "signin") {
        setSignInStep("password");
        setUseBackup(false);
      }
      if (parsed.state.resetToken) {
        setResetToken(parsed.state.resetToken);
        setEditingToken(false);
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [resetModeState]);

  const switchMode = (next: AuthMode) => {
    resetModeState(next);
    const targetHash = HASH_FOR_MODE[next];
    if (location.hash !== targetHash) {
      history.replaceState(null, "", `${location.pathname}${targetHash}`);
    }
  };

  const captchaHeaders = (): Record<string, string> | undefined => {
    const token = captchaToken.trim();
    return token ? { "x-captcha-response": token } : undefined;
  };

  const signInWithProvider = async (provider: Provider) => {
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

  const resendVerification = async (email: string) => {
    if (turnstileRequired && !captchaToken.trim()) {
      setError("Enter a Turnstile verification token before resending verification mail.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const headers = captchaHeaders();
      await api("/api/auth/send-verification-email", {
        method: "POST",
        ...(headers && { headers }),
        body: { email, callbackURL: "/admin/#verified" },
      });
      toast.success(`Verification email sent to ${email}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setCaptchaToken("");
      setBusy(false);
    }
  };

  const handleSignInSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    setUnverifiedEmail("");
    let submittedEmail = "";
    try {
      if (signInStep === "code") {
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
        submittedEmail = String(form.get("email") ?? "").trim();
        setEmailDraft(submittedEmail);
        const result = await api<{ twoFactorRedirect?: boolean }>("/api/auth/sign-in/email", {
          method: "POST",
          body: { email: submittedEmail, password: form.get("password") },
        });
        if (result?.twoFactorRedirect) {
          setSignInStep("code");
          setUseBackup(false);
          return;
        }
      }
      await onSignedIn();
    } catch (e) {
      const msg = errorMessage(e);
      setError(msg);
      if (msg.toLowerCase().includes("not verified") && submittedEmail) {
        setUnverifiedEmail(submittedEmail);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleSignUpSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const confirm = String(form.get("confirmPassword") ?? "");

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      const headers = captchaHeaders();
      await api("/api/auth/sign-up/email", {
        method: "POST",
        ...(headers && { headers }),
        body: {
          name,
          email,
          password,
          marketingOptIn,
          callbackURL: "/admin/#verified",
        },
      });
      setSignUpSentEmail(email);
      setEmailDraft(email);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setCaptchaToken("");
      setBusy(false);
    }
  };

  const handleForgotSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    setBusy(true);
    setError("");
    try {
      const headers = captchaHeaders();
      await api("/api/auth/request-password-reset", {
        method: "POST",
        ...(headers && { headers }),
        body: { email, redirectTo: "/admin/#reset-password" },
      });
      setForgotSentEmail(email);
      setEmailDraft(email);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setCaptchaToken("");
      setBusy(false);
    }
  };

  const handleResetSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const token = resetToken.trim();
    const newPassword = String(form.get("newPassword") ?? "");
    const confirm = String(form.get("confirmPassword") ?? "");

    if (!token) {
      setError("Paste the reset token from your password reset link.");
      return;
    }
    if (newPassword.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      await api("/api/auth/reset-password", {
        method: "POST",
        body: { token, newPassword },
      });
      setResetToken("");
      setEditingToken(true);
      setResetDone(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const passwordAuthEnabled = emailPassword !== false;
  const showModeTabs =
    passwordAuthEnabled &&
    ((mode === "signin" && signInStep === "password") || (mode === "signup" && !signUpSentEmail));

  let steps: AuthStep[] | undefined;
  if (mode === "signin" && signInStep === "code") {
    steps = [
      { label: "Credentials", state: "done" },
      { label: "Two-factor", state: "current" },
    ];
  } else if (mode === "signup" && signUpSentEmail) {
    steps = [
      { label: "Account details", state: "done" },
      { label: "Verify email", state: "current" },
    ];
  } else if (mode === "forgot") {
    steps = [
      { label: "Request link", state: forgotSentEmail ? "done" : "current" },
      { label: "Check inbox", state: forgotSentEmail ? "current" : "pending" },
      { label: "New password", state: "pending" },
    ];
  } else if (mode === "reset") {
    steps = [
      { label: "Request link", state: "done" },
      { label: "Check inbox", state: "done" },
      { label: "New password", state: resetDone ? "done" : "current" },
    ];
  }

  let title = "Sign in";
  let subtitle = `Access ${appName || "EdgeBase"} console and edge security tools.`;
  if (mode === "signin" && signInStep === "code") {
    title = "Verify your identity";
    subtitle = useBackup
      ? "Enter one of your single-use recovery backup codes."
      : "Enter the 6-digit code from your authenticator app.";
  } else if (mode === "signup") {
    title = signUpSentEmail ? "Verify your email" : "Create an account";
    subtitle = signUpSentEmail
      ? `We mailed a confirmation link to ${signUpSentEmail}.`
      : `Register a verified account on ${appName || "EdgeBase"}.`;
  } else if (mode === "forgot") {
    title = forgotSentEmail ? "Check your inbox" : "Reset password";
    subtitle = forgotSentEmail
      ? `If an account exists for ${forgotSentEmail}, a reset link has been sent.`
      : "Enter your account email to receive a password reset link.";
  } else if (mode === "reset") {
    title = resetDone ? "Password updated" : "Choose a new password";
    subtitle = resetDone
      ? "Your password is updated and previous trusted devices have been cleared."
      : "Set a new password (minimum 8 characters) to restore account access.";
  } else if (mode === "verified") {
    title = error ? "Verification failed" : "Email verified";
    subtitle = error
      ? "The confirmation link could not be verified."
      : "Your email address is confirmed. Sign in below to continue.";
  }

  return (
    <AuthShell
      title={title}
      subtitle={subtitle}
      {...(steps && { steps })}
      topSlot={
        showModeTabs ? (
          <ModeSwitcher mode={mode === "signup" ? "signup" : "signin"} onSelect={switchMode} />
        ) : undefined
      }
    >
      {mode === "signin" &&
        (signInStep === "password" ? (
          <>
            {passwordAuthEnabled && (
              <form className="grid gap-4" onSubmit={handleSignInSubmit}>
                <div className="grid gap-1.5">
                  <Label htmlFor="signin-email">Email address</Label>
                  <Input
                    id="signin-email"
                    name="email"
                    type="email"
                    autoComplete="username"
                    placeholder="operator@company.com"
                    value={emailDraft}
                    onChange={(e) => setEmailDraft(e.target.value)}
                    className="h-10 text-[14px]"
                    required
                    autoFocus
                  />
                </div>

                <PasswordField
                  id="signin-password"
                  name="password"
                  label="Password"
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  required
                  labelAction={
                    <button
                      type="button"
                      onClick={() => switchMode("forgot")}
                      className="text-xs font-medium text-primary-ink hover:underline"
                    >
                      Forgot password?
                    </button>
                  }
                />

                <FormError message={error} />

                {unverifiedEmail && (
                  <div className="grid gap-2.5 rounded-md border bg-muted/30 p-3">
                    {turnstileRequired && (
                      <TurnstileField
                        id="signin-resend-captcha"
                        value={captchaToken}
                        onChange={setCaptchaToken}
                        required={false}
                      />
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => resendVerification(unverifiedEmail)}
                      className="justify-center"
                    >
                      Resend verification email to {unverifiedEmail}
                    </Button>
                  </div>
                )}

                <Button type="submit" size="lg" disabled={busy} className="mt-1 w-full">
                  {busy ? "Signing in…" : "Sign in"}
                </Button>
              </form>
            )}

            {!passwordAuthEnabled && <FormError message={error} />}

            {!passwordAuthEnabled && !canPasskey && providers.length === 0 && (
              <p className="rounded-md border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
                No sign-in method is configured. Set Google, Apple, or GitHub credentials or turn on{" "}
                <code className="font-mono text-foreground">EMAIL_PASSWORD=on</code>.
              </p>
            )}

            <FederatedOptions
              showDivider={passwordAuthEnabled}
              showPasskey={canPasskey}
              providers={providers}
              busy={busy}
              onPasskey={signInPasskey}
              onProvider={signInWithProvider}
            />
          </>
        ) : (
          <form className="grid gap-4" onSubmit={handleSignInSubmit}>
            <div className="grid gap-1.5">
              <Label htmlFor="code">
                {useBackup ? "Recovery backup code" : "6-digit authenticator code"}
              </Label>
              {useBackup ? (
                <Input
                  key="backup"
                  id="code"
                  name="code"
                  autoComplete="off"
                  maxLength={32}
                  placeholder="xxxx-xxxx"
                  className="h-10 font-mono text-[14px] tracking-widest"
                  required
                  autoFocus
                />
              ) : (
                <Input
                  key="totp"
                  id="code"
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9 ]{6,7}"
                  maxLength={7}
                  placeholder="000 000"
                  className="h-11 text-center font-mono text-base tracking-[0.25em] tabular-nums"
                  required
                  autoFocus
                />
              )}
            </div>

            <div className="flex items-center gap-2.5">
              <Checkbox
                id="trust-device"
                checked={trustDevice}
                onCheckedChange={(v) => setTrustDevice(v === true)}
              />
              <Label htmlFor="trust-device" className="cursor-pointer font-normal">
                Remember this device for 30 days
              </Label>
            </div>

            <FormError message={error} />

            <Button type="submit" size="lg" disabled={busy} className="w-full">
              {busy ? "Verifying…" : "Verify & continue"}
            </Button>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4 text-xs">
              <button
                type="button"
                className="font-medium text-primary-ink hover:underline"
                onClick={() => {
                  setUseBackup((prev) => !prev);
                  setError("");
                }}
              >
                {useBackup ? "Use authenticator app" : "Use a recovery code"}
              </button>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setSignInStep("password");
                  setUseBackup(false);
                  setTrustDevice(false);
                  setError("");
                }}
              >
                Back to sign in
              </button>
            </div>
          </form>
        ))}

      {mode === "signup" &&
        (signUpSentEmail ? (
          <div className="grid gap-4">
            <div className="flex items-start gap-3 rounded-md border bg-muted/40 p-3.5 text-xs leading-relaxed text-foreground">
              <MailCheck className="mt-0.5 size-4 shrink-0 text-emerald-700 dark:text-emerald-400" />
              <div className="grid gap-1">
                <p className="font-medium">Confirmation link sent</p>
                <p className="text-muted-foreground">
                  Open the email sent to{" "}
                  <span className="font-medium text-foreground">{signUpSentEmail}</span> to activate
                  your account. Unverified sign-ups expire after 7 days.
                </p>
              </div>
            </div>

            {turnstileRequired && (
              <TurnstileField
                id="signup-resend-captcha"
                value={captchaToken}
                onChange={setCaptchaToken}
                required={false}
                note="Enter a fresh Turnstile token before resending verification mail."
              />
            )}

            <FormError message={error} />

            <Button
              type="button"
              variant="outline"
              size="lg"
              disabled={busy}
              onClick={() => resendVerification(signUpSentEmail)}
              className="w-full"
            >
              Resend verification email
            </Button>
            <Button type="button" size="lg" onClick={() => switchMode("signin")} className="w-full">
              Back to sign in
            </Button>
          </div>
        ) : (
          <>
            {passwordAuthEnabled ? (
              <form className="grid gap-4" onSubmit={handleSignUpSubmit}>
                <div className="grid gap-1.5">
                  <Label htmlFor="signup-name">Full name</Label>
                  <Input
                    id="signup-name"
                    name="name"
                    type="text"
                    autoComplete="name"
                    maxLength={120}
                    placeholder="Alex Nguyen"
                    className="h-10 text-[14px]"
                    required
                    autoFocus
                  />
                </div>

                <div className="grid gap-1.5">
                  <Label htmlFor="signup-email">Email address</Label>
                  <Input
                    id="signup-email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    value={emailDraft}
                    onChange={(e) => setEmailDraft(e.target.value)}
                    placeholder="alex@company.com"
                    className="h-10 text-[14px]"
                    required
                  />
                </div>

                <PasswordField
                  id="signup-password"
                  name="password"
                  label="Password"
                  autoComplete="new-password"
                  minLength={8}
                  maxLength={128}
                  placeholder="At least 8 characters"
                  required
                />

                <PasswordField
                  id="signup-confirm"
                  name="confirmPassword"
                  label="Confirm password"
                  autoComplete="new-password"
                  minLength={8}
                  maxLength={128}
                  placeholder="Re-enter password"
                  required
                />

                {turnstileRequired && (
                  <TurnstileField
                    id="signup-captcha"
                    value={captchaToken}
                    onChange={setCaptchaToken}
                    note="This deployment enforces Cloudflare Turnstile on public sign-up."
                  />
                )}

                <div className="flex items-start gap-2.5 pt-0.5">
                  <Checkbox
                    id="marketing-opt-in"
                    checked={marketingOptIn}
                    onCheckedChange={(v) => setMarketingOptIn(v === true)}
                    className="mt-0.5"
                  />
                  <Label
                    htmlFor="marketing-opt-in"
                    className="cursor-pointer text-xs leading-snug font-normal text-muted-foreground"
                  >
                    Receive release announcements and marketing updates
                  </Label>
                </div>

                <FormError message={error} />

                <Button type="submit" size="lg" disabled={busy} className="w-full">
                  {busy ? "Creating account…" : "Create account"}
                </Button>
              </form>
            ) : (
              <p className="rounded-md border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
                Email and password registration is disabled on this environment. Continue with a
                configured identity provider below.
              </p>
            )}

            <FederatedOptions
              showDivider={passwordAuthEnabled}
              showPasskey={false}
              providers={providers}
              busy={busy}
              onProvider={signInWithProvider}
            />
          </>
        ))}

      {mode === "forgot" &&
        (forgotSentEmail ? (
          <div className="grid gap-4">
            <div className="flex items-start gap-3 rounded-md border bg-muted/40 p-3.5 text-xs leading-relaxed text-foreground">
              <MailCheck className="mt-0.5 size-4 shrink-0 text-emerald-700 dark:text-emerald-400" />
              <div className="grid gap-1">
                <p className="font-medium">Reset instructions sent</p>
                <p className="text-muted-foreground">
                  Click the link sent to{" "}
                  <span className="font-medium text-foreground">{forgotSentEmail}</span> to set a
                  new password.
                </p>
              </div>
            </div>

            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={() => switchMode("reset")}
              className="w-full"
            >
              Enter reset token manually
            </Button>
            <Button type="button" size="lg" onClick={() => switchMode("signin")} className="w-full">
              Back to sign in
            </Button>
            <button
              type="button"
              onClick={() => setForgotSentEmail("")}
              className="text-center text-xs text-muted-foreground hover:text-foreground"
            >
              Try a different email address
            </button>
          </div>
        ) : (
          <form className="grid gap-4" onSubmit={handleForgotSubmit}>
            {!passwordAuthEnabled && (
              <p className="rounded-md border border-amber-600/30 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200">
                Password resets are disabled when{" "}
                <code className="font-mono font-medium">EMAIL_PASSWORD=off</code>.
              </p>
            )}

            <div className="grid gap-1.5">
              <Label htmlFor="forgot-email">Account email</Label>
              <Input
                id="forgot-email"
                name="email"
                type="email"
                autoComplete="email"
                value={emailDraft}
                onChange={(e) => setEmailDraft(e.target.value)}
                placeholder="operator@company.com"
                className="h-10 text-[14px]"
                required
                autoFocus
              />
            </div>

            {turnstileRequired && (
              <TurnstileField id="forgot-captcha" value={captchaToken} onChange={setCaptchaToken} />
            )}

            <FormError message={error} />

            <Button
              type="submit"
              size="lg"
              disabled={busy || !passwordAuthEnabled}
              className="w-full"
            >
              {busy ? "Sending reset link…" : "Send reset link"}
            </Button>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4 text-xs">
              <button
                type="button"
                onClick={() => switchMode("reset")}
                className="font-medium text-primary-ink hover:underline"
              >
                Already have a reset token?
              </button>
              <button
                type="button"
                onClick={() => switchMode("signin")}
                className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="size-3" /> Back to sign in
              </button>
            </div>
          </form>
        ))}

      {mode === "reset" &&
        (resetDone ? (
          <div className="grid gap-4">
            <div className="flex items-start gap-3 rounded-md border border-emerald-600/25 bg-emerald-500/10 p-3.5 text-xs leading-relaxed text-emerald-900 dark:text-emerald-200">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
              <span>
                Your password has been changed and all prior trusted devices were revoked.
              </span>
            </div>
            <Button type="button" size="lg" onClick={() => switchMode("signin")} className="w-full">
              Sign in with new password
            </Button>
          </div>
        ) : (
          <form className="grid gap-4" onSubmit={handleResetSubmit}>
            {!editingToken && resetToken ? (
              <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs">
                <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                  <KeyRound className="size-3.5 text-emerald-700 dark:text-emerald-400" />
                  Reset token loaded from link
                </span>
                <button
                  type="button"
                  onClick={() => setEditingToken(true)}
                  className="font-medium text-primary-ink hover:underline"
                >
                  Edit
                </button>
              </div>
            ) : (
              <div className="grid gap-1.5">
                <Label htmlFor="reset-token">Reset token</Label>
                <Input
                  id="reset-token"
                  value={resetToken}
                  onChange={(e) => setResetToken(e.target.value)}
                  placeholder="Paste reset token"
                  spellCheck={false}
                  className="h-10 font-mono text-xs"
                  required
                />
              </div>
            )}

            <PasswordField
              id="reset-password"
              name="newPassword"
              label="New password"
              autoComplete="new-password"
              minLength={8}
              maxLength={128}
              placeholder="At least 8 characters"
              required
              autoFocus
            />

            <PasswordField
              id="reset-confirm"
              name="confirmPassword"
              label="Confirm new password"
              autoComplete="new-password"
              minLength={8}
              maxLength={128}
              placeholder="Re-enter new password"
              required
            />

            <FormError message={error} />

            <Button type="submit" size="lg" disabled={busy} className="w-full">
              {busy ? "Updating password…" : "Update password"}
            </Button>

            <div className="flex items-center justify-between border-t pt-4 text-xs">
              <button
                type="button"
                onClick={() => switchMode("forgot")}
                className="font-medium text-primary-ink hover:underline"
              >
                Request new link
              </button>
              <button
                type="button"
                onClick={() => switchMode("signin")}
                className="text-muted-foreground hover:text-foreground"
              >
                Back to sign in
              </button>
            </div>
          </form>
        ))}

      {mode === "verified" && (
        <div className="grid gap-4">
          {error ? (
            <>
              <FormError message={error} />
              <form
                className="grid gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = new FormData(e.currentTarget);
                  const email = String(form.get("email") ?? "").trim();
                  if (email) void resendVerification(email);
                }}
              >
                <div className="grid gap-1.5">
                  <Label htmlFor="verify-email">Email address</Label>
                  <Input
                    id="verify-email"
                    name="email"
                    type="email"
                    defaultValue={emailDraft}
                    placeholder="alex@company.com"
                    className="h-10 text-[14px]"
                    required
                  />
                </div>
                {turnstileRequired && (
                  <TurnstileField
                    id="verify-resend-captcha"
                    value={captchaToken}
                    onChange={setCaptchaToken}
                  />
                )}
                <Button type="submit" size="lg" disabled={busy} className="w-full">
                  Resend verification email
                </Button>
              </form>
            </>
          ) : (
            <div className="flex items-start gap-3 rounded-md border border-emerald-600/25 bg-emerald-500/10 p-3.5 text-xs leading-relaxed text-emerald-900 dark:text-emerald-200">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
              <span>Your email address is verified and active.</span>
            </div>
          )}

          <Button
            type="button"
            variant={error ? "outline" : "default"}
            size="lg"
            onClick={() => switchMode("signin")}
            className="w-full"
          >
            Sign in to continue
          </Button>
        </div>
      )}
    </AuthShell>
  );
}

/**
 * Shown when a standard user (non-admin) signs in through the portal instead of trapping them
 * in a broken error banner with no sign-out action.
 */
export function PendingAccess({
  me,
  onRefresh,
  onSignOut,
}: {
  me: User;
  onRefresh: () => Promise<void>;
  onSignOut: () => Promise<void>;
}) {
  const { emailPassword } = useSignInOptions();
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [changingPassword, setChangingPassword] = useState(false);
  const [revokeOthers, setRevokeOthers] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<{ id: string; providerId: string }[]>("/api/auth/list-accounts")
      .then((accounts) => {
        if (!cancelled) setHasPassword(accounts.some((a) => a.providerId === "credential"));
      })
      .catch(() => {
        if (!cancelled) setHasPassword(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const canChangePassword = emailPassword !== false && hasPassword === true;

  const submitChangePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const currentPassword = String(form.get("currentPassword") ?? "");
    const newPassword = String(form.get("newPassword") ?? "");
    const confirmPassword = String(form.get("confirmPassword") ?? "");
    if (newPassword.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/change-password", {
        method: "POST",
        body: { currentPassword, newPassword, revokeOtherSessions: revokeOthers },
      });
      toast.success("Password updated");
      setChangingPassword(false);
      await onRefresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="Signed in as standard user"
      subtitle="This account is active, but Admin privileges are required to operate the control plane."
    >
      <div className="grid gap-4">
        <dl className="divide-y overflow-hidden rounded-md border bg-muted/25 text-xs">
          <div className="flex items-center justify-between gap-2 px-3.5 py-2.5">
            <dt className="text-muted-foreground">Account</dt>
            <dd className="truncate font-medium text-foreground">{me.email}</dd>
          </div>
          <div className="flex items-center justify-between gap-2 px-3.5 py-2.5">
            <dt className="text-muted-foreground">Role</dt>
            <dd>
              <Badge variant="secondary">{me.role || "user"}</Badge>
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2 px-3.5 py-2.5">
            <dt className="text-muted-foreground">Verification</dt>
            <dd>
              {me.emailVerified ? (
                <Badge variant="success">Verified</Badge>
              ) : (
                <Badge variant="warning">Unverified</Badge>
              )}
            </dd>
          </div>
        </dl>

        <div className="flex items-start gap-2.5 rounded-md border border-amber-600/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-900 dark:text-amber-200">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            Promote this account via{" "}
            <code className="font-mono font-medium">pnpm admin:create</code> or ask an existing
            admin to grant the <code className="font-mono font-medium">admin</code> role in Users.
          </span>
        </div>

        {canChangePassword && changingPassword ? (
          <form
            className="grid gap-3 rounded-md border bg-muted/20 p-3.5"
            onSubmit={submitChangePassword}
          >
            <PasswordField
              id="pending-cur-pw"
              name="currentPassword"
              label="Current password"
              autoComplete="current-password"
              maxLength={128}
              required
            />
            <PasswordField
              id="pending-new-pw"
              name="newPassword"
              label="New password"
              autoComplete="new-password"
              minLength={8}
              maxLength={128}
              required
            />
            <PasswordField
              id="pending-confirm-pw"
              name="confirmPassword"
              label="Confirm new password"
              autoComplete="new-password"
              minLength={8}
              maxLength={128}
              required
            />
            <div className="flex items-center gap-2">
              <Checkbox
                id="pending-revoke"
                checked={revokeOthers}
                onCheckedChange={(v) => setRevokeOthers(v === true)}
              />
              <Label htmlFor="pending-revoke" className="cursor-pointer text-xs font-normal">
                Sign out of other active sessions
              </Label>
            </div>
            <FormError message={error} />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setChangingPassword(false);
                  setError("");
                }}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={busy}>
                Save password
              </Button>
            </div>
          </form>
        ) : null}

        <div className={cn("grid gap-2", canChangePassword && "sm:grid-cols-2")}>
          {canChangePassword && (
            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={() => {
                setChangingPassword((prev) => !prev);
                setError("");
              }}
            >
              Change password
            </Button>
          )}
          <Button type="button" size="lg" onClick={onSignOut}>
            Sign out &amp; switch
          </Button>
        </div>
      </div>
    </AuthShell>
  );
}
