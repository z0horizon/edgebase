import { cn } from "cn";
import { Fingerprint, KeyRound, Monitor, Moon, Pencil, Sun, Trash2 } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { FormError } from "@/components/FormError";
import { PageHeader } from "@/components/PageHeader";
import { PasswordField } from "@/components/PasswordField";
import { ProviderIcon } from "@/components/ProviderButtons";
import { SessionCard, TrustedDeviceCard } from "@/components/SessionCard";
import { AccentSwatchPicker } from "@/components/ThemeCustomizer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  api,
  errorMessage,
  type PasskeyRecord,
  registerPasskey,
  type SessionRecord,
  type TrustedDevice,
  type User,
} from "@/lib/api";
import { formatDate } from "@/lib/format";
import { type Provider, startOAuth, useSignInOptions } from "@/lib/oauth";
import { type ThemePreference, useTheme } from "@/lib/theme";
import { describePasskey, supportsPasskeys } from "@/lib/webauthn";

/** Linking, passkeys, active session inspection/revocation, password & theme controls. */
export function AccountPage({
  me,
  onRefresh,
}: {
  me: User;
  onRefresh?: (() => Promise<void>) | undefined;
}) {
  const [linked, setLinked] = useState<Map<string, string> | null>(null);
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [passkeys, setPasskeys] = useState<PasskeyRecord[] | null>(null);
  const [passkeysFailed, setPasskeysFailed] = useState(false);
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null);
  const [trustedDevices, setTrustedDevices] = useState<TrustedDevice[] | null>(null);
  const [renaming, setRenaming] = useState<PasskeyRecord | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [changingPw, setChangingPw] = useState(false);
  const [revokeOthersOnPw, setRevokeOthersOnPw] = useState(true);
  const [pwError, setPwError] = useState("");
  const [busy, setBusy] = useState(false);

  const { providers, emailPassword } = useSignInOptions();
  const { preference, setPreference } = useTheme();
  const canPasskey = supportsPasskeys();

  const loadSecurity = useCallback(async () => {
    const [accountsRes, passkeysRes, sessionsRes, tdRes] = await Promise.allSettled([
      api<{ id: string; providerId: string }[]>("/api/auth/list-accounts"),
      api<PasskeyRecord[]>("/api/auth/passkey/list-user-passkeys"),
      api<{ sessions: SessionRecord[] }>("/v1/sessions"),
      api<{ devices: TrustedDevice[] }>("/v1/trusted-devices"),
    ]);
    if (accountsRes.status === "fulfilled") {
      setHasPassword(accountsRes.value.some((a) => a.providerId === "credential"));
      setLinked(
        new Map(
          accountsRes.value
            .filter((a) => a.providerId !== "credential")
            .map((a) => [a.providerId, a.id]),
        ),
      );
    } else {
      toast.error(errorMessage(accountsRes.reason));
    }
    if (passkeysRes.status === "fulfilled") {
      setPasskeysFailed(false);
      setPasskeys(passkeysRes.value);
    } else {
      setPasskeysFailed(true);
      toast.error(errorMessage(passkeysRes.reason));
    }
    if (sessionsRes.status === "fulfilled") {
      setSessions(sessionsRes.value.sessions);
    } else {
      setSessions((prev) => prev ?? []);
      toast.error(errorMessage(sessionsRes.reason));
    }
    if (tdRes.status === "fulfilled") {
      setTrustedDevices(tdRes.value.devices);
    } else {
      setTrustedDevices((prev) => prev ?? []);
      toast.error(errorMessage(tdRes.reason));
    }
  }, []);

  useEffect(() => {
    loadSecurity();
  }, [loadSecurity]);

  const link = async (provider: Provider) => {
    setBusy(true);
    try {
      await startOAuth("/api/auth/link-social", provider);
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  };

  const unlink = async (accountId: string, label: string) => {
    setBusy(true);
    try {
      await api("/api/auth/unlink-account", {
        method: "POST",
        body: { accountId },
      });
      toast.success(`${label} unlinked`);
      await loadSecurity();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const revokeSession = async (id: string) => {
    setBusy(true);
    try {
      await api(`/v1/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
      toast.success("Session revoked");
      await loadSecurity();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const revokeOtherSessions = async () => {
    setBusy(true);
    try {
      await api("/v1/sessions/revoke-others", { method: "POST" });
      toast.success("Signed out of all other sessions");
      await loadSecurity();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const revokeDevice = async (id: string) => {
    setBusy(true);
    try {
      await api(`/v1/trusted-devices/${encodeURIComponent(id)}`, { method: "DELETE" });
      toast.success("Trusted device removed");
      await loadSecurity();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const revokeAllDevices = async () => {
    setBusy(true);
    try {
      await api("/v1/trusted-devices", { method: "DELETE" });
      toast.success("All trusted devices removed");
      await loadSecurity();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const handleAddPasskey = async () => {
    setBusy(true);
    try {
      await registerPasskey();
      toast.success("Passkey added");
      await loadSecurity();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const handleRenamePasskey = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!renaming) return;
    setBusy(true);
    try {
      await api("/api/auth/passkey/update-passkey", {
        method: "POST",
        body: { id: renaming.id, name: renameValue.trim() },
      });
      setRenaming(null);
      toast.success("Passkey renamed");
      await loadSecurity();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDeletePasskey = async (id: string) => {
    setBusy(true);
    try {
      await api("/api/auth/passkey/delete-passkey", {
        method: "POST",
        body: { id },
      });
      toast.success("Passkey removed");
      await loadSecurity();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const handleChangePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const currentPassword = String(form.get("currentPassword") ?? "");
    const newPassword = String(form.get("newPassword") ?? "");
    const confirmPassword = String(form.get("confirmPassword") ?? "");
    if (newPassword.length < 8) {
      setPwError("New password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwError("New passwords do not match.");
      return;
    }
    setBusy(true);
    setPwError("");
    try {
      await api("/api/auth/change-password", {
        method: "POST",
        body: {
          currentPassword,
          newPassword,
          revokeOtherSessions: revokeOthersOnPw,
        },
      });
      setChangingPw(false);
      toast.success("Password updated");
      await Promise.all([loadSecurity(), onRefresh?.()]);
    } catch (e) {
      setPwError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const otherSessionCount = sessions?.filter((s) => !s.current).length ?? 0;
  const factorsLoaded = hasPassword !== null && linked !== null && passkeys !== null;
  const lastAdminFactor =
    hasPassword === true &&
    !me.twoFactorEnabled &&
    (passkeys?.length ?? 0) + (linked?.size ?? 0) <= 1;
  const soleLoginAccount = hasPassword === false && (linked?.size ?? 0) <= 1;
  const passkeyCount = passkeys?.length ?? 0;
  const passkeyPct = Math.min(100, Math.round((passkeyCount / 20) * 100));

  return (
    <div className="grid gap-5">
      <PageHeader
        title="Account & Security"
        description="Manage FIDO2 passkeys, linked OAuth providers, active edge sessions, 30-day trusted devices, and interface preferences."
      />

      <section
        aria-label="Security posture"
        className="grid grid-cols-1 divide-y overflow-hidden rounded-md border bg-card sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4 lg:divide-x"
      >
        <div className="grid gap-1.5 px-4 py-3 sm:border-r sm:border-b lg:border-r-0 lg:border-b-0">
          <span className="text-[11px] text-muted-foreground">Operator account</span>
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[13px] font-medium text-foreground">{me.email}</span>
            <Badge variant="default">Admin</Badge>
          </div>
        </div>
        <div className="grid gap-1.5 px-4 py-3 sm:border-b lg:border-b-0">
          <span className="text-[11px] text-muted-foreground">Authenticator (TOTP)</span>
          <div className="flex items-center gap-2">
            {me.twoFactorEnabled ? (
              <Badge variant="success">Enabled</Badge>
            ) : (
              <Badge variant="secondary">Off (passkey / OAuth)</Badge>
            )}
            {me.twoFactorEnabledAt && (
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {formatDate(me.twoFactorEnabledAt)}
              </span>
            )}
          </div>
        </div>
        <div className="grid gap-1.5 px-4 py-3 sm:border-r lg:border-r-0">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>WebAuthn passkeys</span>
            <span className="font-mono text-[10px]">CAP 20</span>
          </div>
          <span className="text-[13px] font-medium tabular-nums text-foreground">
            {passkeys
              ? `${passkeyCount} / 20 registered`
              : passkeysFailed
                ? "Unavailable"
                : "Loading…"}
          </span>
          <div className="h-[3px] overflow-hidden rounded-xs bg-muted" role="presentation">
            <div
              className="h-full bg-primary transition-[width] duration-200"
              style={{ width: `${passkeyPct}%` }}
            />
          </div>
        </div>
        <div className="grid gap-1.5 px-4 py-3">
          <span className="text-[11px] text-muted-foreground">Password changed</span>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13px] tabular-nums text-foreground">
              {me.passwordChangedAt ? formatDate(me.passwordChangedAt) : "—"}
            </span>
            {hasPassword && emailPassword !== false && (
              <Button
                variant="outline"
                size="xs"
                onClick={() => {
                  setPwError("");
                  setChangingPw(true);
                }}
              >
                <KeyRound /> Change
              </Button>
            )}
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-md border bg-card">
        <div className="grid gap-0.5 border-b bg-muted/35 px-4 py-3">
          <h2 className="text-[13px] font-semibold text-foreground">Interface preferences</h2>
          <p className="text-xs text-muted-foreground">
            Customize appearance mode and primary accent color across all views. Saved locally per
            browser.
          </p>
        </div>
        <div className="divide-y">
          <div className="flex flex-col justify-between gap-3 px-4 py-3 sm:flex-row sm:items-center">
            <div className="grid gap-0.5">
              <span className="text-[13px] font-medium text-foreground">Color mode</span>
              <span className="text-xs text-muted-foreground">
                Follow OS setting or force Light / Dark theme.
              </span>
            </div>
            <fieldset
              aria-label="Color mode"
              className="inline-flex gap-0.5 rounded-md border bg-muted/50 p-0.5"
            >
              {(
                [
                  ["system", "System", Monitor],
                  ["light", "Light", Sun],
                  ["dark", "Dark", Moon],
                ] as const
              ).map(([id, label, Icon]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setPreference(id as ThemePreference)}
                  aria-pressed={preference === id}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs font-medium transition-colors",
                    preference === id
                      ? "bg-card text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="size-3.5" /> {label}
                </button>
              ))}
            </fieldset>
          </div>
          <div className="flex flex-col justify-between gap-3 px-4 py-3.5 sm:flex-row sm:items-center">
            <div className="grid gap-0.5">
              <span className="text-[13px] font-medium text-foreground">Primary accent color</span>
              <span className="text-xs text-muted-foreground">
                Updates primary buttons, active tabs, highlights, and progress meters immediately.
              </span>
            </div>
            <AccentSwatchPicker />
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-md border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/35 px-4 py-3">
          <div className="grid gap-0.5">
            <h2 className="text-[13px] font-semibold text-foreground">
              Passkeys (WebAuthn / FIDO2)
            </h2>
            <p className="text-xs text-muted-foreground">
              Phishing-resistant hardware and biometric credentials with mandatory user
              verification.
            </p>
          </div>
          {canPasskey && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy || passkeyCount >= 20}
              onClick={handleAddPasskey}
            >
              <Fingerprint /> Add passkey
            </Button>
          )}
        </div>
        <div className="divide-y">
          {passkeys === null && (
            <p className="px-4 py-3 text-xs text-muted-foreground">
              {passkeysFailed ? "Unable to load passkeys." : "Loading passkeys…"}
            </p>
          )}
          {passkeys?.length === 0 && (
            <p className="px-4 py-3 text-xs text-muted-foreground">
              No passkeys registered on this account.
            </p>
          )}
          {passkeys?.map((pk) => (
            <div
              key={pk.id}
              className="flex flex-col justify-between gap-3 px-4 py-3 sm:flex-row sm:items-center"
            >
              <div className="grid min-w-0 gap-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Fingerprint className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="text-[13px] font-medium text-foreground">
                    {describePasskey(pk)}
                  </span>
                  <Badge variant={pk.backedUp ? "secondary" : "outline"}>
                    {pk.backedUp ? "Synced" : "Device-bound"}
                  </Badge>
                  <code className="font-mono text-[11px] text-muted-foreground">
                    {pk.id.slice(0, 8)}…
                  </code>
                </div>
                {pk.createdAt && (
                  <p className="text-[11px] tabular-nums text-muted-foreground">
                    Registered {formatDate(pk.createdAt)}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setRenaming(pk);
                    setRenameValue(describePasskey(pk));
                  }}
                >
                  <Pencil /> Rename
                </Button>
                <Button
                  variant="destructive-outline"
                  size="sm"
                  disabled={busy || !factorsLoaded || lastAdminFactor}
                  title={
                    lastAdminFactor
                      ? "Add another second factor or enable TOTP before removing your last one"
                      : undefined
                  }
                  onClick={() => handleDeletePasskey(pk.id)}
                >
                  <Trash2 /> Remove
                </Button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="overflow-hidden rounded-md border bg-card">
        <div className="grid gap-0.5 border-b bg-muted/35 px-4 py-3">
          <h2 className="text-[13px] font-semibold text-foreground">Linked OAuth providers</h2>
          <p className="text-xs text-muted-foreground">
            Link an external identity provider matching your verified email address.
          </p>
        </div>
        <div className="divide-y">
          {providers.length === 0 && (
            <p className="px-4 py-3 text-xs text-muted-foreground">
              No external OAuth providers are enabled on this Worker deployment.
            </p>
          )}
          {providers.map(({ id, label }) => {
            const accountId = linked?.get(id);
            return (
              <div key={id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="flex items-center gap-2.5">
                  <ProviderIcon provider={id} />
                  <span className="text-[13px] font-medium text-foreground">{label}</span>
                </div>
                {accountId ? (
                  <div className="flex items-center gap-2">
                    <Badge variant="success">Linked</Badge>
                    <Button
                      variant="destructive-outline"
                      size="sm"
                      disabled={busy || !factorsLoaded || lastAdminFactor || soleLoginAccount}
                      title={
                        soleLoginAccount
                          ? "Cannot unlink your only sign-in method"
                          : lastAdminFactor
                            ? "Add another second factor or enable TOTP before removing your last one"
                            : undefined
                      }
                      onClick={() => unlink(accountId, label)}
                    >
                      <Trash2 /> Unlink
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || linked === null}
                    onClick={() => link(id)}
                  >
                    Link {label}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="overflow-hidden rounded-md border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/35 px-4 py-3">
          <div className="grid gap-0.5">
            <h2 className="text-[13px] font-semibold text-foreground">Active sessions</h2>
            <p className="text-xs text-muted-foreground">
              Live D1 sessions with Cloudflare ASN, ISP, and geographic origin telemetry.
            </p>
          </div>
          {otherSessionCount > 0 && (
            <Button variant="destructive" size="sm" disabled={busy} onClick={revokeOtherSessions}>
              Revoke {otherSessionCount} other {otherSessionCount === 1 ? "session" : "sessions"}
            </Button>
          )}
        </div>
        <div className="divide-y">
          {sessions === null && (
            <p className="px-4 py-3 text-xs text-muted-foreground">Loading sessions…</p>
          )}
          {sessions?.length === 0 && (
            <p className="px-4 py-3 text-xs text-muted-foreground">No active sessions.</p>
          )}
          {sessions?.map((s) => (
            <SessionCard
              key={s.id}
              session={s}
              busy={busy}
              onRevoke={s.current ? undefined : () => revokeSession(s.id)}
            />
          ))}
        </div>
      </section>

      <section className="overflow-hidden rounded-md border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/35 px-4 py-3">
          <div className="grid gap-0.5">
            <h2 className="text-[13px] font-semibold text-foreground">
              Trusted devices (30-day 2FA bypass)
            </h2>
            <p className="text-xs text-muted-foreground">
              Single-use rotating device tokens bound to OS family and country; cleared on password
              change.
            </p>
          </div>
          {(trustedDevices?.length ?? 0) > 0 && (
            <Button variant="destructive" size="sm" disabled={busy} onClick={revokeAllDevices}>
              Revoke all
            </Button>
          )}
        </div>
        <div className="divide-y">
          {trustedDevices === null && (
            <p className="px-4 py-3 text-xs text-muted-foreground">Loading trusted devices…</p>
          )}
          {trustedDevices?.length === 0 && (
            <p className="px-4 py-3 text-xs text-muted-foreground">
              No browsers are currently marked as trusted.
            </p>
          )}
          {trustedDevices?.map((d) => (
            <TrustedDeviceCard
              key={d.id}
              device={d}
              busy={busy}
              onRemove={() => revokeDevice(d.id)}
            />
          ))}
        </div>
      </section>

      <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename passkey</DialogTitle>
          </DialogHeader>
          <form className="grid gap-4" onSubmit={handleRenamePasskey}>
            <div className="grid gap-1.5">
              <Label htmlFor="rename-passkey">Credential label</Label>
              <Input
                id="rename-passkey"
                maxLength={64}
                required
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                autoFocus
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRenaming(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !renameValue.trim()}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={changingPw} onOpenChange={(open) => !open && setChangingPw(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change password</DialogTitle>
            <DialogDescription>
              Updating your password rotates credentials and clears all 30-day trusted devices.
            </DialogDescription>
          </DialogHeader>
          <form className="grid gap-3.5" onSubmit={handleChangePassword}>
            <PasswordField
              id="acct-cur-pw"
              name="currentPassword"
              label="Current password"
              autoComplete="current-password"
              required
              autoFocus
            />
            <PasswordField
              id="acct-new-pw"
              name="newPassword"
              label="New password"
              autoComplete="new-password"
              minLength={8}
              maxLength={128}
              placeholder="At least 8 characters"
              required
            />
            <PasswordField
              id="acct-confirm-pw"
              name="confirmPassword"
              label="Confirm new password"
              autoComplete="new-password"
              minLength={8}
              maxLength={128}
              required
            />
            <div className="flex items-center gap-2 pt-0.5">
              <Checkbox
                id="acct-revoke-others"
                checked={revokeOthersOnPw}
                onCheckedChange={(v) => setRevokeOthersOnPw(v === true)}
              />
              <Label htmlFor="acct-revoke-others" className="cursor-pointer font-normal">
                Revoke all other active sessions
              </Label>
            </div>
            <FormError message={pwError} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setChangingPw(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                Update password
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
