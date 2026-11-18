import { KeyRound, Layers } from "lucide-react";
import { type FormEvent, useState } from "react";
import { FormError } from "@/components/FormError";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errorMessage } from "@/lib/api";
import { type Provider, startOAuth, takeOAuthError, useProviders } from "@/lib/oauth";

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
  const [error, setError] = useState(takeOAuthError);
  const shown = error || (notAdmin ? "This account is not an admin." : "");
  const [busy, setBusy] = useState(false);
  const providers = useProviders();

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
                : useBackup
                  ? "Enter one of your single-use recovery backup codes."
                  : "Enter the 6-digit code from your authenticator app."}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {step === "password" && providers.length > 0 && (
              <>
                <div className="grid gap-2">
                  {providers.map(({ id, label }) => (
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
                <>
                  <div className="grid gap-2">
                    <Label htmlFor="code">
                      {useBackup ? "Backup recovery code" : "6-digit authenticator code"}
                    </Label>
                    {useBackup ? (
                      <Input
                        key="backup"
                        id="code"
                        name="code"
                        autoComplete="off"
                        maxLength={32}
                        placeholder="XXXXX-XXXXX"
                        className="h-11 text-center font-mono text-base tracking-widest"
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
                        placeholder="000000"
                        className="h-11 text-center font-mono text-lg tracking-[0.35em] tabular-nums"
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
                    <Label htmlFor="trust-device" className="text-xs font-normal leading-snug">
                      Trust this device for 30 days
                    </Label>
                  </div>
                </>
              )}
              <FormError message={shown} />
              <Button type="submit" disabled={busy} className="w-full">
                {step === "password" ? "Sign in" : "Verify"}
              </Button>
              {step === "code" && (
                <div className="grid gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setUseBackup((prev) => !prev);
                      setError("");
                    }}
                  >
                    {useBackup ? "Use authenticator code instead" : "Use a backup code instead"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setStep("password");
                      setUseBackup(false);
                      setTrustDevice(false);
                      setError("");
                    }}
                  >
                    Use a different account
                  </Button>
                </div>
              )}
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
