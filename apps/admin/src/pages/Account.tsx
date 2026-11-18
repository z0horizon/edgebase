import { Fingerprint, Pencil, Trash2 } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/PageHeader";
import { SessionCard } from "@/components/SessionCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { type Provider, startOAuth, useProviders } from "@/lib/oauth";
import { describeDevice, describeNetwork, networkShifted } from "@/lib/state";
import { describePasskey, supportsPasskeys } from "@/lib/webauthn";

/** Linking, passkeys, active session inspection/revocation, and 2FA trusted-device controls. */
export function AccountPage({ me }: { me: User }) {
  const [linked, setLinked] = useState<Set<string> | null>(null);
  const [passkeys, setPasskeys] = useState<PasskeyRecord[] | null>(null);
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null);
  const [trustedDevices, setTrustedDevices] = useState<TrustedDevice[] | null>(null);
  const [addingPasskey, setAddingPasskey] = useState(false);
  const [newPasskeyName, setNewPasskeyName] = useState("");
  const [renaming, setRenaming] = useState<PasskeyRecord | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [busy, setBusy] = useState(false);
  const providers = useProviders();
  const canPasskey = supportsPasskeys();

  const loadSecurity = useCallback(async () => {
    const [accountsRes, passkeysRes, sessionsRes, tdRes] = await Promise.allSettled([
      api<{ providerId: string }[]>("/api/auth/list-accounts"),
      api<PasskeyRecord[]>("/api/auth/passkey/list-user-passkeys"),
      api<{ sessions: SessionRecord[] }>("/v1/sessions"),
      api<{ devices: TrustedDevice[] }>("/v1/trusted-devices"),
    ]);
    if (accountsRes.status === "fulfilled") {
      setLinked(new Set(accountsRes.value.map((a) => a.providerId)));
    } else {
      toast.error(errorMessage(accountsRes.reason));
    }
    if (passkeysRes.status === "fulfilled") {
      setPasskeys(passkeysRes.value);
    } else {
      setPasskeys((prev) => prev ?? []);
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

  const handleAddPasskey = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    try {
      await registerPasskey(newPasskeyName);
      setAddingPasskey(false);
      setNewPasskeyName("");
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

  const otherSessionCount = sessions?.filter((s) => !s.current).length ?? 0;

  return (
    <div className="grid gap-5">
      <PageHeader
        title="Account & Security"
        description="Manage FIDO2 passkeys, linked OAuth providers, active edge sessions, and 30-day trusted devices."
      />

      <section
        aria-label="Security posture"
        className="grid grid-cols-1 divide-y overflow-hidden rounded-md border bg-card sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4 lg:divide-x"
      >
        <div className="grid gap-1 px-4 py-3 sm:border-r sm:border-b lg:border-r lg:border-b-0">
          <span className="text-[11px] text-muted-foreground">Operator account</span>
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="truncate text-[13px] font-medium text-foreground">{me.email}</span>
            <Badge variant="default">Admin</Badge>
          </div>
        </div>
        <div className="grid gap-1 px-4 py-3 sm:border-b lg:border-b-0">
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
        <div className="grid gap-1 px-4 py-3 sm:border-r lg:border-r">
          <span className="text-[11px] text-muted-foreground">WebAuthn passkeys</span>
          <span className="text-[13px] font-medium tabular-nums text-foreground">
            {passkeys ? `${passkeys.length} / 20 registered` : "Loading…"}
          </span>
        </div>
        <div className="grid gap-1 px-4 py-3">
          <span className="text-[11px] text-muted-foreground">Password changed</span>
          <span className="text-[13px] tabular-nums text-foreground">
            {me.passwordChangedAt ? formatDate(me.passwordChangedAt) : "—"}
          </span>
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
              disabled={busy || (passkeys?.length ?? 0) >= 20}
              onClick={() => setAddingPasskey(true)}
            >
              <Fingerprint /> Add passkey
            </Button>
          )}
        </div>
        <div className="divide-y">
          {passkeys === null && (
            <p className="px-4 py-3 text-xs text-muted-foreground">Loading passkeys…</p>
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
                  variant="outline"
                  size="sm"
                  disabled={busy || (!me.twoFactorEnabled && passkeys.length <= 1)}
                  title={
                    !me.twoFactorEnabled && passkeys.length <= 1
                      ? "Add another passkey or enable TOTP before removing your only passkey"
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
          {providers.map(({ id, label }) => (
            <div key={id} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <span className="text-[13px] font-medium text-foreground">{label}</span>
              {linked?.has(id) ? (
                <Badge variant="success">Linked</Badge>
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
          ))}
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
            <Button variant="outline" size="sm" disabled={busy} onClick={revokeOtherSessions}>
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
            <Button variant="outline" size="sm" disabled={busy} onClick={revokeAllDevices}>
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
          {trustedDevices?.map((d) => {
            const shifted = networkShifted(d);
            return (
              <div
                key={d.id}
                className="flex flex-col justify-between gap-3 px-4 py-3 sm:flex-row sm:items-center"
              >
                <div className="grid min-w-0 gap-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className="text-[13px] font-medium text-foreground"
                      title={d.userAgent ?? undefined}
                    >
                      {describeDevice(d.userAgent)}
                    </span>
                    {d.current && <Badge variant="success">This browser</Badge>}
                    {shifted && <Badge variant="warning">ASN / country changed</Badge>}
                  </div>
                  <p className="font-mono text-[11px] text-muted-foreground">
                    {describeNetwork(d)}
                  </p>
                  {shifted && (
                    <p className="font-mono text-[11px] text-muted-foreground">
                      Trusted from:{" "}
                      {describeNetwork({
                        city: d.createdCity,
                        country: d.createdCountry,
                        asOrganization: d.createdAsOrganization,
                        asn: d.createdAsn,
                        ipAddress: d.createdIp,
                      })}
                    </p>
                  )}
                  <p className="text-[11px] tabular-nums text-muted-foreground">
                    Trusted {formatDate(d.createdAt)} · Used {formatDate(d.lastUsedAt)} · Expires{" "}
                    {formatDate(d.expiresAt)}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => revokeDevice(d.id)}
                >
                  <Trash2 /> Remove
                </Button>
              </div>
            );
          })}
        </div>
      </section>

      <Dialog open={addingPasskey} onOpenChange={(open) => !open && setAddingPasskey(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Register passkey</DialogTitle>
            <DialogDescription>
              Assign a label to identify this authenticator. Requires a fresh session within the
              last 15 minutes.
            </DialogDescription>
          </DialogHeader>
          <form className="grid gap-4" onSubmit={handleAddPasskey}>
            <div className="grid gap-1.5">
              <Label htmlFor="passkey-name">Label (optional)</Label>
              <Input
                id="passkey-name"
                maxLength={64}
                placeholder="Work MacBook Touch ID"
                value={newPasskeyName}
                onChange={(e) => setNewPasskeyName(e.target.value)}
                autoFocus
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddingPasskey(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                <Fingerprint /> Register
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

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
    </div>
  );
}
