import { KeyRound, Layers } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errorMessage } from "@/lib/api";
import { PROVIDERS, type Provider, startOAuth, takeOAuthError } from "@/lib/oauth";

export function SignIn({
  notAdmin,
  onSignedIn,
}: {
  notAdmin: boolean;
  onSignedIn: () => Promise<void>;
}) {
  const [step, setStep] = useState<"password" | "code">("password");
  const [error, setError] = useState(takeOAuthError);
  const shown = error || (notAdmin ? "This account is not an admin." : "");
  const [busy, setBusy] = useState(false);

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

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      if (step === "code") {
        await api("/api/auth/two-factor/verify-totp", {
          method: "POST",
          body: { code: form.get("code") },
        });
      } else {
        const result = await api<{ twoFactorRedirect?: boolean }>("/api/auth/sign-in/email", {
          method: "POST",
          body: { email: form.get("email"), password: form.get("password") },
        });
        if (result?.twoFactorRedirect) {
          setStep("code");
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

  return (
    <main className="grid min-h-screen place-items-center bg-background p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <span className="grid size-10 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            {step === "password" ? <Layers className="size-5" /> : <KeyRound className="size-5" />}
          </span>
          <span className="text-xs font-medium text-muted-foreground">EdgeBase Admin</span>
        </div>

        <Card className="shadow-sm">
          <CardHeader className="text-center">
            <CardTitle className="text-xl tracking-tight">
              {step === "password" ? "Sign in to console" : "Two-factor verification"}
            </CardTitle>
            <CardDescription className="text-pretty">
              {step === "password"
                ? "Sign in with an admin account. Password sign-in needs two-factor."
                : "Enter the 6-digit code from your authenticator app."}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {step === "password" && (
              <>
                <div className="grid gap-2">
                  {PROVIDERS.map(({ id, label }) => (
                    <Button
                      key={id}
                      type="button"
                      variant="outline"
                      disabled={busy}
                      className="w-full"
                      onClick={() => signInWith(id)}
                    >
                      Continue with {label}
                    </Button>
                  ))}
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="h-px flex-1 bg-border" />
                  or
                  <span className="h-px flex-1 bg-border" />
                </div>
              </>
            )}
            <form className="grid gap-4" onSubmit={submit}>
              {step === "password" ? (
                <>
                  <div className="grid gap-2">
                    <Label htmlFor="email">Email</Label>
                    <Input
                      id="email"
                      name="email"
                      type="email"
                      placeholder="admin@example.com"
                      autoComplete="username"
                      required
                      autoFocus
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="password">Password</Label>
                    <Input
                      id="password"
                      name="password"
                      type="password"
                      autoComplete="current-password"
                      required
                    />
                  </div>
                </>
              ) : (
                <div className="grid gap-2">
                  <Label htmlFor="code">6-digit authenticator code</Label>
                  <Input
                    id="code"
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    placeholder="000000"
                    className="h-11 text-center font-mono text-lg tracking-[0.35em] tabular-nums"
                    required
                    autoFocus
                  />
                </div>
              )}
              {shown && (
                <p
                  role="alert"
                  className="rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive"
                >
                  {shown}
                </p>
              )}
              <Button type="submit" disabled={busy} className="w-full">
                {step === "password" ? "Sign in" : "Verify"}
              </Button>
              {step === "code" && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setStep("password");
                    setError("");
                  }}
                >
                  Use a different account
                </Button>
              )}
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
