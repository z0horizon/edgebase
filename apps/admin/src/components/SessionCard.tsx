import { Laptop, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { SessionRecord } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { describeDevice, describeNetwork, networkShifted } from "@/lib/state";

export function SessionCard({
  session: s,
  busy,
  onRevoke,
}: {
  session: SessionRecord;
  busy: boolean;
  onRevoke?: (() => void) | undefined;
}) {
  const shifted = networkShifted(s);
  return (
    <div className="flex flex-col justify-between gap-3 rounded-lg border p-3.5 sm:flex-row sm:items-center">
      <div className="grid gap-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Laptop className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium" title={s.userAgent ?? undefined}>
            {describeDevice(s.userAgent)}
          </span>
          {s.current && <Badge variant="success">Current session</Badge>}
          {s.signInProvider && <Badge variant="secondary">{s.signInProvider}</Badge>}
          {s.twoFactorMethod && (
            <Badge variant="outline">2FA: {s.twoFactorMethod.replaceAll("_", " ")}</Badge>
          )}
          {shifted && <Badge variant="warning">Network changed</Badge>}
        </div>
        <p className="text-xs text-muted-foreground">{describeNetwork(s)}</p>
        {shifted && (
          <p className="text-xs text-muted-foreground">
            Origin:{" "}
            {describeNetwork({
              city: s.createdCity,
              country: s.createdCountry,
              asOrganization: s.createdAsOrganization,
              asn: s.createdAsn,
              ipAddress: s.createdIp,
            })}
          </p>
        )}
        <p className="text-xs tabular-nums text-muted-foreground">
          Signed in {formatDate(s.createdAt)} · Last active{" "}
          {formatDate(s.lastActiveAt ?? s.updatedAt)} · Expires {formatDate(s.expiresAt)}
        </p>
      </div>
      {onRevoke && (
        <Button variant="outline" size="sm" disabled={busy} onClick={onRevoke}>
          <Trash2 /> Revoke
        </Button>
      )}
    </div>
  );
}
