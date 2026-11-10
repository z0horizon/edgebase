import { Copy, ShieldCheck } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { renderSVG } from "uqr";
import { FormError } from "@/components/FormError";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";

type Enrolment = { totpURI: string; backupCodes: string[] };

const STEPS = [
  { key: "password", label: "Password" },
  { key: "scan", label: "Scan QR" },
  { key: "codes", label: "Backup codes" },
] as const;

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
  const activeStepIndex = STEPS.findIndex((s) => s.key === step);

  return (
    <main className="grid min-h-screen place-items-center bg-background p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <span className="grid size-10 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            <ShieldCheck className="size-5" />
          </span>
          <ol className="mt-1 flex items-center gap-2 text-xs" aria-label="Setup steps">
            {STEPS.map((s, idx) => (
              <li
                key={s.key}
                className={cn(
                  "flex items-center gap-1.5",
                  idx <= activeStepIndex ? "font-medium text-foreground" : "text-muted-foreground",
                )}
              >
                <span
                  className={cn(
                    "grid size-5 place-items-center rounded-full text-[11px] tabular-nums",
                    idx < activeStepIndex
                      ? "bg-primary/15 text-primary"
                      : idx === activeStepIndex
                        ? "bg-primary text-primary-foreground"
                        : "bg-secondary text-muted-foreground",
                  )}
                >
                  {idx + 1}
                </span>
                <span>{s.label}</span>
                {idx < STEPS.length - 1 && (
                  <span aria-hidden="true" className="mx-1 h-px w-4 bg-border" />
                )}
              </li>
            ))}
          </ol>
        </div>

        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-xl tracking-tight">Turn on two-factor</CardTitle>
            <CardDescription className="text-pretty">
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
                    autoFocus
                  />
                </div>
                <FormError message={error} />
                <Button type="submit" disabled={busy}>
                  Continue
                </Button>
              </form>
            )}

            {step === "scan" && (
              <form className="grid gap-4" onSubmit={confirm}>
                <div className="grid place-items-center gap-3 rounded-xl border bg-muted/40 p-4">
                  <img
                    src={qr}
                    alt="QR code for your authenticator app"
                    className="size-44 rounded-lg border bg-white p-2.5 shadow-2xs"
                  />
                  <div className="w-full text-center">
                    <p className="text-xs text-muted-foreground">
                      Or enter this setup key manually:
                    </p>
                    <code className="mt-1 inline-block rounded bg-background px-2 py-1 font-mono text-xs break-all select-all">
                      {secret}
                    </code>
                  </div>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="code">6-digit code</Label>
                  <Input
                    id="code"
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9 ]{6,7}"
                    placeholder="000000"
                    className="h-11 text-center font-mono text-lg tracking-[0.35em] tabular-nums"
                    required
                    autoFocus
                  />
                </div>
                <FormError message={error} />
                <Button type="submit" disabled={busy}>
                  Turn on two-factor
                </Button>
              </form>
            )}

            {step === "codes" && enrolment && (
              <div className="grid gap-4">
                <ul className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-3.5 text-center font-mono text-sm tabular-nums">
                  {enrolment.backupCodes.map((code) => (
                    <li
                      key={code}
                      className="rounded border bg-card py-1.5 text-xs font-medium tracking-wider"
                    >
                      {code}
                    </li>
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
      </div>
    </main>
  );
}
