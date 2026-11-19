import { Laptop, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { SessionRecord, TrustedDevice } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { describeDevice, describeNetwork, networkShifted } from "@/lib/state";

type TelemetryTarget = {
  userAgent?: string | null | undefined;
  city?: string | null | undefined;
  country?: string | null | undefined;
  asOrganization?: string | null | undefined;
  asn?: number | null | undefined;
  ipAddress?: string | null | undefined;
  createdCity?: string | null | undefined;
  createdCountry?: string | null | undefined;
  createdAsOrganization?: string | null | undefined;
  createdAsn?: number | null | undefined;
  createdIp?: string | null | undefined;
};

function TelemetryRow({
  item,
  icon,
  badges,
  originLabel,
  timeline,
  actionLabel,
  busy,
  onAction,
}: {
  item: TelemetryTarget;
  icon?: ReactNode;
  badges?: ReactNode;
  originLabel: string;
  timeline: string;
  actionLabel: string;
  busy: boolean;
  onAction?: (() => void) | undefined;
}) {
  const shifted = networkShifted(item);
  return (
    <div className="flex flex-col justify-between gap-3 px-4 py-3 sm:flex-row sm:items-center">
      <div className="grid min-w-0 gap-1">
        <div className="flex flex-wrap items-center gap-1.5">
          {icon}
          <span
            className="text-[13px] font-medium text-foreground"
            title={item.userAgent ?? undefined}
          >
            {describeDevice(item.userAgent)}
          </span>
          {badges}
          {shifted && <Badge variant="warning">ASN / country changed</Badge>}
        </div>
        <p className="font-mono text-[11px] text-muted-foreground">{describeNetwork(item)}</p>
        {shifted && (
          <p className="font-mono text-[11px] text-muted-foreground">
            {originLabel}:{" "}
            {describeNetwork({
              city: item.createdCity,
              country: item.createdCountry,
              asOrganization: item.createdAsOrganization,
              asn: item.createdAsn,
              ipAddress: item.createdIp,
            })}
          </p>
        )}
        <p className="text-[11px] tabular-nums text-muted-foreground">{timeline}</p>
      </div>
      {onAction && (
        <Button variant="outline" size="sm" disabled={busy} onClick={onAction}>
          <Trash2 /> {actionLabel}
        </Button>
      )}
    </div>
  );
}

export function SessionCard({
  session: s,
  busy,
  onRevoke,
}: {
  session: SessionRecord;
  busy: boolean;
  onRevoke?: (() => void) | undefined;
}) {
  return (
    <TelemetryRow
      item={s}
      icon={<Laptop className="size-3.5 shrink-0 text-muted-foreground" />}
      badges={
        <>
          {s.current && <Badge variant="success">Current</Badge>}
          {s.signInProvider && <Badge variant="secondary">{s.signInProvider}</Badge>}
          {s.twoFactorMethod && (
            <Badge variant="outline">2FA: {s.twoFactorMethod.replaceAll("_", " ")}</Badge>
          )}
        </>
      }
      originLabel="Origin"
      timeline={`Signed in ${formatDate(s.createdAt)} · Active ${formatDate(s.lastActiveAt ?? s.updatedAt)} · Expires ${formatDate(s.expiresAt)}`}
      actionLabel="Revoke"
      busy={busy}
      onAction={onRevoke}
    />
  );
}

export function TrustedDeviceCard({
  device: d,
  busy,
  onRemove,
}: {
  device: TrustedDevice;
  busy: boolean;
  onRemove: () => void;
}) {
  return (
    <TelemetryRow
      item={d}
      badges={d.current ? <Badge variant="success">This browser</Badge> : undefined}
      originLabel="Trusted from"
      timeline={`Trusted ${formatDate(d.createdAt)} · Used ${formatDate(d.lastUsedAt)} · Expires ${formatDate(d.expiresAt)}`}
      actionLabel="Remove"
      busy={busy}
      onAction={onRemove}
    />
  );
}
