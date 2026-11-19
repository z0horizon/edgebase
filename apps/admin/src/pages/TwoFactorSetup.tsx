import { Copy, Download, Fingerprint } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { renderSVG } from "uqr";
import { AuthShell, type AuthStep } from "@/components/AuthShell";
import { FormError } from "@/components/FormError";
import { PasswordField } from "@/components/PasswordField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errorMessage, registerPasskey } from "@/lib/api";
import { supportsPasskeys } from "@/lib/webauthn";

type Enrolment = { totpURI: string; backupCodes: string[] };

/** Admin routes stay gated on the server until a passkey or TOTP factor is active. */
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
  const canPasskey = supportsPasskeys();

  const enrollPasskey = async () => {
    setBusy(true);
    setError("");
    try {
      await registerPasskey();
      toast.success("Passkey registered");
      await onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

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

  const downloadCodes = () => {
    if (!enrolment) return;
    const blob = new Blob([`${enrolment.backupCodes.join("\n")}\n`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "edgebase-recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
  };

  const secret = enrolment ? (new URL(enrolment.totpURI).searchParams.get("secret") ?? "") : "";
  const qr = enrolment
    ? `data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(enrolment.totpURI))}`
    : "";

  const steps: AuthStep[] = [
    { label: "Factor", state: step === "password" ? "current" : "done" },
    { label: "Verify", state: step === "scan" ? "current" : step === "codes" ? "done" : "pending" },
    { label: "Recovery", state: step === "codes" ? "current" : "pending" },
  ];

  return (
    <AuthShell
      title={
        step === "password"
          ? "Secure admin access"
          : step === "scan"
            ? "Scan authenticator QR"
            : "Save recovery codes"
      }
      subtitle={
        step === "password" ? (
          <>
            Enroll a FIDO2 passkey or TOTP authenticator for{" "}
            <span className="font-medium text-foreground">{email}</span> before entering the
            console.
          </>
        ) : step === "scan" ? (
          "Scan with Google Authenticator, 1Password, or Authy, then confirm the 6-digit code."
        ) : (
          "Store these single-use recovery codes securely. Each code works once if you lose your authenticator."
        )
      }
      steps={steps}
    >
      {step === "password" && (
        <div>
          {canPasskey && (
            <>
              <Button
                type="button"
                size="lg"
                disabled={busy}
                onClick={enrollPasskey}
                className="w-full"
              >
                <Fingerprint className="size-4" />
                <span>Enroll FIDO2 passkey</span>
              </Button>

              <div className="my-5 flex items-center gap-3">
                <span className="h-px flex-1 bg-border" />
                <span className="font-mono text-[10px] tracking-[0.08em] text-muted-foreground">
                  OR
                </span>
                <span className="h-px flex-1 bg-border" />
              </div>
            </>
          )}

          <form className="grid gap-3.5" onSubmit={start}>
            <PasswordField
              id="password"
              name="password"
              label="Current password (for TOTP setup)"
              autoComplete="current-password"
              placeholder="Enter current password"
              required
            />
            <FormError message={error} />
            <Button
              type="submit"
              variant={canPasskey ? "outline" : "default"}
              size="lg"
              disabled={busy}
              className="w-full"
            >
              Set up authenticator app
            </Button>
          </form>
        </div>
      )}

      {step === "scan" && (
        <form className="grid min-w-0 gap-4" onSubmit={confirm}>
          <div className="grid min-w-0 place-items-center gap-3 rounded-md border bg-muted/35 p-4">
            <img
              src={qr}
              alt="QR code for your authenticator app"
              className="size-40 rounded-sm border bg-white p-2"
            />
            <div className="flex w-full min-w-0 items-center justify-between gap-2 rounded-sm border bg-card px-2.5 py-1.5">
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground select-all">
                {secret}
              </code>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() =>
                  navigator.clipboard
                    .writeText(secret)
                    .then(() => toast.success("Setup key copied"))
                }
              >
                <Copy /> Copy
              </Button>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="code">6-digit verification code</Label>
            <Input
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
          </div>

          <FormError message={error} />

          <Button type="submit" size="lg" disabled={busy} className="w-full">
            Verify &amp; continue
          </Button>
        </form>
      )}

      {step === "codes" && enrolment && (
        <div className="grid gap-4">
          <ul className="grid grid-cols-2 divide-x divide-y overflow-hidden rounded-md border bg-muted/25 font-mono text-xs tabular-nums">
            {enrolment.backupCodes.map((code) => (
              <li key={code} className="px-3 py-2 text-center font-medium tracking-wider">
                {code}
              </li>
            ))}
          </ul>
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={() =>
                navigator.clipboard
                  .writeText(enrolment.backupCodes.join("\n"))
                  .then(() => toast.success("Recovery codes copied"))
              }
            >
              <Copy className="size-4" /> Copy
            </Button>
            <Button type="button" variant="outline" size="lg" onClick={downloadCodes}>
              <Download className="size-4" /> Download .txt
            </Button>
          </div>
          <Button type="button" size="lg" onClick={onDone} className="w-full">
            I have saved these codes
          </Button>
        </div>
      )}

      <div className="mt-5 border-t pt-4 text-center">
        <button
          type="button"
          onClick={onSignOut}
          className="text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          Log out
        </button>
      </div>
    </AuthShell>
  );
}
