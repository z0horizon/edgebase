import { ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/PageHeader";
import { SessionCard } from "@/components/SessionCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api, errorMessage, type SessionRecord, type TrustedDevice, type User } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { type Provider, startOAuth, useProviders } from "@/lib/oauth";
import { describeDevice, describeNetwork, networkShifted } from "@/lib/state";

/** Linking, active session inspection/revocation, and 2FA trusted-device controls for the admin. */
export function AccountPage({ me }: { me: User }) {
  const [linked, setLinked] = useState<Set<string> | null>(null);
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null);
  const [trustedDevices, setTrustedDevices] = useState<TrustedDevice[] | null>(null);
  const [busy, setBusy] = useState(false);
  const providers = useProviders();

  const loadSecurity = useCallback(async () => {
    const [accountsRes, sessionsRes, tdRes] = await Promise.allSettled([
      api<{ providerId: string }[]>("/api/auth/list-accounts"),
      api<{ sessions: SessionRecord[] }>("/v1/sessions"),
      api<{ devices: TrustedDevice[] }>("/v1/trusted-devices"),
    ]);
    if (accountsRes.status === "fulfilled") {
      setLinked(new Set(accountsRes.value.map((a) => a.providerId)));
    } else {
      toast.error(errorMessage(accountsRes.reason));
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

  const otherSessionCount = sessions?.filter((s) => !s.current).length ?? 0;

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Account & Security"
        description="Manage your active sessions, 2FA trusted devices, and linked sign-in providers."
      />

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Security status</CardTitle>
            <CardDescription>Audit timestamps for your admin credentials.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2.5 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Two-factor authentication</span>
              {me.twoFactorEnabled ? (
                <Badge variant="success">
                  <ShieldCheck /> Enabled
                </Badge>
              ) : (
                <Badge variant="secondary">Off (social sign-in)</Badge>
              )}
            </div>
            {me.twoFactorEnabledAt && (
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">2FA enabled since</span>
                <span className="tabular-nums">{formatDate(me.twoFactorEnabledAt)}</span>
              </div>
            )}
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Password last changed</span>
              <span className="tabular-nums">
                {me.passwordChangedAt ? formatDate(me.passwordChangedAt) : "—"}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Linked sign-in providers</CardTitle>
            <CardDescription>
              Link a provider account with your email to sign in without a 2FA code.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {providers.length === 0 && (
              <p className="text-sm text-muted-foreground">No sign-in provider is configured.</p>
            )}
            {providers.map(({ id, label }) => (
              <div key={id} className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium">{label}</span>
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
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <div className="grid gap-1">
            <CardTitle className="text-base">Active sessions</CardTitle>
            <CardDescription>
              Devices currently signed in, with Cloudflare ASN/ISP and location telemetry.
            </CardDescription>
          </div>
          {otherSessionCount > 0 && (
            <Button variant="outline" size="sm" disabled={busy} onClick={revokeOtherSessions}>
              Sign out {otherSessionCount} other {otherSessionCount === 1 ? "session" : "sessions"}
            </Button>
          )}
        </CardHeader>
        <CardContent className="grid gap-3">
          {sessions === null && <p className="text-sm text-muted-foreground">Loading sessions…</p>}
          {sessions?.length === 0 && (
            <p className="text-sm text-muted-foreground">No active sessions.</p>
          )}
          {sessions?.map((s) => (
            <SessionCard
              key={s.id}
              session={s}
              busy={busy}
              onRevoke={s.current ? undefined : () => revokeSession(s.id)}
            />
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <div className="grid gap-1">
            <CardTitle className="text-base">Trusted devices (30-day 2FA bypass)</CardTitle>
            <CardDescription>
              Browsers and apps allowed to skip 2FA prompts. Automatically cleared on password
              change.
            </CardDescription>
          </div>
          {(trustedDevices?.length ?? 0) > 0 && (
            <Button variant="outline" size="sm" disabled={busy} onClick={revokeAllDevices}>
              Revoke all
            </Button>
          )}
        </CardHeader>
        <CardContent className="grid gap-3">
          {trustedDevices === null && (
            <p className="text-sm text-muted-foreground">Loading trusted devices…</p>
          )}
          {trustedDevices?.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No devices are currently marked as trusted.
            </p>
          )}
          {trustedDevices?.map((d) => {
            const shifted = networkShifted(d);
            return (
              <div
                key={d.id}
                className="flex flex-col justify-between gap-3 rounded-lg border p-3.5 sm:flex-row sm:items-center"
              >
                <div className="grid gap-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium" title={d.userAgent ?? undefined}>
                      {describeDevice(d.userAgent)}
                    </span>
                    {d.current && <Badge variant="success">This device</Badge>}
                    {shifted && <Badge variant="warning">Network changed</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground">{describeNetwork(d)}</p>
                  {shifted && (
                    <p className="text-xs text-muted-foreground">
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
                  <p className="text-xs tabular-nums text-muted-foreground">
                    Trusted {formatDate(d.createdAt)} · Last used {formatDate(d.lastUsedAt)} ·
                    Expires {formatDate(d.expiresAt)}
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
        </CardContent>
      </Card>
    </div>
  );
}
