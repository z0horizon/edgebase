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
    <div className="flex flex-col justify-between gap-3 px-4 py-3 sm:flex-row sm:items-center">
      <div className="grid min-w-0 gap-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Laptop className="size-3.5 shrink-0 text-muted-foreground" />
          <span
            className="text-[13px] font-medium text-foreground"
            title={s.userAgent ?? undefined}
          >
            {describeDevice(s.userAgent)}
          </span>
          {s.current && <Badge variant="success">Current</Badge>}
          {s.signInProvider && <Badge variant="secondary">{s.signInProvider}</Badge>}
          {s.twoFactorMethod && (
            <Badge variant="outline">2FA: {s.twoFactorMethod.replaceAll("_", " ")}</Badge>
          )}
          {shifted && <Badge variant="warning">ASN / country changed</Badge>}
        </div>
        <p className="font-mono text-[11px] text-muted-foreground">{describeNetwork(s)}</p>
        {shifted && (
          <p className="font-mono text-[11px] text-muted-foreground">
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
        <p className="text-[11px] tabular-nums text-muted-foreground">
          Signed in {formatDate(s.createdAt)} · Active {formatDate(s.lastActiveAt ?? s.updatedAt)} ·
          Expires {formatDate(s.expiresAt)}
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
