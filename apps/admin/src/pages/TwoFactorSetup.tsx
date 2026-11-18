import { Copy, Fingerprint } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { renderSVG } from "uqr";
import { AuthShell, FloatingInput } from "@/components/AuthShell";
import { FormError } from "@/components/FormError";
import { Button } from "@/components/ui/button";
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
  const [passkeyName, setPasskeyName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const canPasskey = supportsPasskeys();

  const enrollPasskey = async () => {
    setBusy(true);
    setError("");
    try {
      await registerPasskey(passkeyName);
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

  const secret = enrolment ? (new URL(enrolment.totpURI).searchParams.get("secret") ?? "") : "";
  const qr = enrolment
    ? `data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(enrolment.totpURI))}`
    : "";

  return (
    <AuthShell
      title={
        step === "password"
          ? "Secure your account"
          : step === "scan"
            ? "Scan QR code"
            : "Save recovery codes"
      }
      subtitle={
        step === "password" ? (
          <>
            Add a passkey or authenticator app for{" "}
            <span className="font-medium text-foreground">{email}</span> to continue.
          </>
        ) : step === "scan" ? (
          "Scan with Google Authenticator, 1Password, or Authy, then enter its 6-digit code."
        ) : (
          "Store these single-use recovery codes safely. Each code works once if you lose your device."
        )
      }
    >
      {step === "password" && (
        <div>
          {canPasskey && (
            <>
              <div className="grid gap-3">
                <FloatingInput
                  id="passkey-label"
                  label="Device label (optional)"
                  maxLength={64}
                  value={passkeyName}
                  onChange={(e) => setPasskeyName(e.target.value)}
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={enrollPasskey}
                  className="inline-flex h-[50px] w-full items-center justify-center gap-2 rounded-[4px] bg-primary px-4 text-[15px] font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
                >
                  <Fingerprint className="size-4" />
                  <span>Continue with a passkey</span>
                </button>
              </div>

              <div className="my-6 flex items-center gap-4">
                <span className="h-px flex-1 bg-border" />
                <span className="text-[12px] font-medium tracking-[0.06em] text-muted-foreground">
                  OR
                </span>
                <span className="h-px flex-1 bg-border" />
              </div>
            </>
          )}

          <form className="grid gap-3.5" onSubmit={start}>
            <FloatingInput
              id="password"
              name="password"
              type="password"
              label="Current password (for TOTP)"
              requiredMark
              autoComplete="current-password"
              required
            />
            <FormError message={error} />
            <button
              type="submit"
              disabled={busy}
              className={
                canPasskey
                  ? "flex h-[50px] w-full items-center justify-center rounded-[4px] border border-[#c2c8d0] bg-card px-4 text-[15px] font-normal text-foreground transition-colors duration-150 hover:bg-secondary/65 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/25 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 dark:border-input"
                  : "inline-flex h-[50px] w-full items-center justify-center rounded-[4px] bg-primary px-4 text-[15px] font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
              }
            >
              Set up authenticator app
            </button>
          </form>
        </div>
      )}

      {step === "scan" && (
        <form className="grid min-w-0 gap-4" onSubmit={confirm}>
          <div className="grid min-w-0 place-items-center gap-3 rounded-[4px] border bg-muted/35 p-4">
            <img
              src={qr}
              alt="QR code for your authenticator app"
              className="size-40 rounded-[4px] border bg-white p-2"
            />
            <div className="flex w-full min-w-0 items-center justify-between gap-2 rounded-[4px] border bg-card px-2.5 py-1.5">
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

          <FloatingInput
            id="code"
            name="code"
            label="6-digit code"
            requiredMark
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 ]{6,7}"
            className="font-mono tracking-[0.25em] tabular-nums"
            required
            autoFocus
          />

          <FormError message={error} />

          <button
            type="submit"
            disabled={busy}
            className="inline-flex h-[50px] w-full items-center justify-center rounded-[4px] bg-primary px-4 text-[15px] font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
          >
            Continue
          </button>
        </form>
      )}

      {step === "codes" && enrolment && (
        <div className="grid gap-4">
          <ul className="grid grid-cols-2 divide-x divide-y overflow-hidden rounded-[4px] border bg-muted/25 font-mono text-xs tabular-nums">
            {enrolment.backupCodes.map((code) => (
              <li key={code} className="px-3 py-2 text-center font-medium tracking-wider">
                {code}
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() =>
              navigator.clipboard
                .writeText(enrolment.backupCodes.join("\n"))
                .then(() => toast.success("Recovery codes copied"))
            }
            className="flex h-[46px] w-full items-center justify-center gap-2 rounded-[4px] border border-[#c2c8d0] bg-card px-4 text-[14px] font-normal text-foreground transition-colors hover:bg-secondary/65 dark:border-input"
          >
            <Copy className="size-4" /> Copy recovery codes
          </button>
          <button
            type="button"
            onClick={onDone}
            className="inline-flex h-[50px] w-full items-center justify-center rounded-[4px] bg-primary px-4 text-[15px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            I have saved these codes
          </button>
        </div>
      )}

      <div className="mt-5 text-center">
        <button
          type="button"
          onClick={onSignOut}
          className="text-[13px] text-muted-foreground transition-colors hover:text-foreground"
        >
          Log out
        </button>
      </div>
    </AuthShell>
  );
}
