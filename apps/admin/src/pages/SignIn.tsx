import { BellRing } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errorMessage } from "@/lib/api";

export function SignIn({
  notAdmin,
  onSignedIn,
}: {
  notAdmin: boolean;
  onSignedIn: () => Promise<void>;
}) {
  const [step, setStep] = useState<"password" | "code">("password");
  const [error, setError] = useState("");
  const shown = error || (notAdmin ? "This account is not an admin." : "");
  const [busy, setBusy] = useState(false);

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
    <main className="grid min-h-screen place-items-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <span className="mb-2 grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground">
            <BellRing className="size-5" />
          </span>
          <CardTitle className="text-xl">EdgeBase admin</CardTitle>
          <CardDescription>
            {step === "password"
              ? "Sign in with an admin account."
              : "Enter the 6-digit code from your authenticator app."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4" onSubmit={submit}>
            {step === "password" ? (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    name="email"
                    type="email"
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
                <Label htmlFor="code">Code</Label>
                <Input
                  id="code"
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  autoFocus
                />
              </div>
            )}
            {shown && (
              <p role="alert" className="text-sm text-destructive">
                {shown}
              </p>
            )}
            <Button type="submit" disabled={busy}>
              {step === "password" ? "Sign in" : "Verify"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
