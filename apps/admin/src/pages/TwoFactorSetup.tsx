import { Copy } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { renderSVG } from "uqr";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errorMessage } from "@/lib/api";

type Enrolment = { totpURI: string; backupCodes: string[] };

/** Admin features stay off on the server until TOTP is on, so a first sign-in lands here. */
export function TwoFactorSetup({
  email,
  onDone,
  onSignOut,
}: {
  email: string;
  onDone: () => Promise<void>;
  onSignOut: () => Promise<void>;
}) {
  const [step, setStep] = useState<"password" | "scan" | "codes">("password");
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const run =
    (action: (form: FormData) => Promise<void>) => async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      setBusy(true);
      setError("");
      try {
        await action(form);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusy(false);
      }
    };

  const start = run(async (form) => {
    setEnrolment(
      await api<Enrolment>("/api/auth/two-factor/enable", {
        method: "POST",
        body: { password: form.get("password") },
      }),
    );
    setStep("scan");
  });

  const confirm = run(async (form) => {
    await api("/api/auth/two-factor/verify-totp", {
      method: "POST",
      body: { code: String(form.get("code") ?? "").replace(/\s/g, "") },
    });
    setStep("codes");
  });

  const secret = enrolment ? (new URL(enrolment.totpURI).searchParams.get("secret") ?? "") : "";
  const qr = enrolment
    ? `data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(enrolment.totpURI))}`
    : "";

  return (
    <main className="grid min-h-screen place-items-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Turn on two-factor</CardTitle>
          <CardDescription>
            {step === "password" &&
              `Admin features need an authenticator app for ${email}. Confirm your password to start.`}
            {step === "scan" &&
              "Scan the code with an authenticator app, then enter the 6-digit code it shows."}
            {step === "codes" &&
              "Save these backup codes somewhere safe. Each one signs you in once if you lose the app."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {step === "password" && (
            <form className="grid gap-4" onSubmit={start}>
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
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <Button type="submit" disabled={busy}>
                Continue
              </Button>
            </form>
          )}

          {step === "scan" && (
            <form className="grid gap-4" onSubmit={confirm}>
              <img
                src={qr}
                alt="QR code for your authenticator app"
                className="mx-auto size-48 rounded-md bg-white p-2"
              />
              <p className="text-center text-xs text-muted-foreground">
                Or enter this key: <code className="break-all font-mono">{secret}</code>
              </p>
              <div className="grid gap-2">
                <Label htmlFor="code">Code</Label>
                <Input
                  id="code"
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9 ]{6,7}"
                  required
                />
              </div>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <Button type="submit" disabled={busy}>
                Turn on two-factor
              </Button>
            </form>
          )}

          {step === "codes" && enrolment && (
            <div className="grid gap-4">
              <ul className="grid grid-cols-2 gap-2 rounded-md border bg-muted/40 p-3 font-mono text-sm">
                {enrolment.backupCodes.map((code) => (
                  <li key={code}>{code}</li>
                ))}
              </ul>
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  navigator.clipboard
                    .writeText(enrolment.backupCodes.join("\n"))
                    .then(() => toast.success("Backup codes copied"))
                }
              >
                <Copy /> Copy codes
              </Button>
              <Button type="button" onClick={onDone}>
                I saved them
              </Button>
            </div>
          )}

          <Button type="button" variant="link" className="mt-2 w-full" onClick={onSignOut}>
            Sign out
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
