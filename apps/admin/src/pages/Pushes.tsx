import { STATS_KEPT_DAYS, STATS_LISTED } from "@edgebase/core/limits";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ApiError, api, errorMessage, type PushStats } from "@/lib/api";
import { formatDate } from "@/lib/format";

export function PushesPage() {
  const [pushes, setPushes] = useState<PushStats[] | null>(null);
  const [pushUnconfigured, setPushUnconfigured] = useState(false);

  const load = useCallback(async () => {
    try {
      setPushes((await api<{ pushes: PushStats[] }>("/v1/push")).pushes);
      setPushUnconfigured(false);
    } catch (e) {
      setPushes([]);
      if (e instanceof ApiError && e.status === 503) {
        setPushUnconfigured(true);
        return;
      }
      toast.error(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const totalSent = pushes?.reduce((acc, p) => acc + p.sent, 0) ?? 0;
  const totalFailed = pushes?.reduce((acc, p) => acc + p.failed, 0) ?? 0;
  const totalOpened = pushes?.reduce((acc, p) => acc + p.opened, 0) ?? 0;
  const totalUsers = pushes?.reduce((acc, p) => acc + p.users, 0) ?? 0;

  return (
    <>
      <PageHeader
        title="Sent pushes"
        description={`Recent ${STATS_LISTED} dispatches with ${STATS_KEPT_DAYS}-day delivery and open retention.`}
      >
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw /> Refresh
        </Button>
      </PageHeader>

      {pushUnconfigured && (
        <div
          role="status"
          className="mb-4 rounded-md border border-amber-600/30 bg-amber-500/10 px-3.5 py-2.5 text-xs leading-relaxed text-amber-900 dark:border-amber-400/25 dark:text-amber-200"
        >
          Push delivery is disabled on this environment. Configure{" "}
          <code className="font-mono font-medium">FCM_SERVICE_ACCOUNT</code> in Worker secrets to
          record and inspect push dispatches.
        </div>
      )}

      {pushes && pushes.length > 0 && (
        <div className="mb-4 grid grid-cols-2 overflow-hidden rounded-md border bg-card sm:grid-cols-4">
          <div className="flex items-baseline justify-between gap-2 border-r border-b px-3.5 py-2.5 sm:border-b-0">
            <span className="text-xs text-muted-foreground">Batches</span>
            <span className="text-sm font-semibold tabular-nums text-foreground">
              {pushes.length}
            </span>
          </div>
          <div className="flex items-baseline justify-between gap-2 border-b px-3.5 py-2.5 sm:border-r sm:border-b-0">
            <span className="text-xs text-muted-foreground">Delivered</span>
            <span className="text-sm font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
              {totalSent.toLocaleString()}
            </span>
          </div>
          <div className="flex items-baseline justify-between gap-2 border-r px-3.5 py-2.5">
            <span className="text-xs text-muted-foreground">Failed</span>
            <span
              className={`text-sm font-semibold tabular-nums ${totalFailed ? "text-destructive" : "text-foreground"}`}
            >
              {totalFailed.toLocaleString()}
            </span>
          </div>
          <div className="flex items-baseline justify-between gap-2 px-3.5 py-2.5">
            <span className="text-xs text-muted-foreground">Opened</span>
            <span className="text-sm font-semibold tabular-nums text-foreground">
              {totalOpened.toLocaleString()}
              {totalUsers > 0 && (
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  ({Math.round(Math.min(totalOpened / totalUsers, 1) * 100)}%)
                </span>
              )}
            </span>
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-md border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">Batch</TableHead>
              <TableHead>Dispatched</TableHead>
              <TableHead className="hidden sm:table-cell">Category</TableHead>
              <TableHead className="text-right">Audience</TableHead>
              <TableHead className="text-right">Delivered</TableHead>
              <TableHead className="text-right">Failed</TableHead>
              <TableHead className="w-48">Open rate</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pushes === null &&
              [1, 2, 3, 4].map((key) => (
                <TableRow key={key}>
                  <TableCell colSpan={7}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {pushes?.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="h-28 text-center text-xs text-muted-foreground">
                  No push batches recorded yet.{" "}
                  <a
                    href="#send"
                    className="font-medium text-primary-ink underline underline-offset-4"
                  >
                    Dispatch a push
                  </a>
                </TableCell>
              </TableRow>
            )}
            {pushes?.map((p) => {
              const rate = p.users ? Math.min(p.opened / p.users, 1) : null;
              const scheduled = p.sendAt > Date.now();
              return (
                <TableRow key={p.id}>
                  <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                    #{p.id}
                  </TableCell>
                  <TableCell className="text-xs tabular-nums">
                    <span className="mr-2 text-foreground">{formatDate(p.sendAt)}</span>
                    {scheduled && <Badge variant="warning">Scheduled</Badge>}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <Badge variant={p.category === "marketing" ? "warning" : "secondary"}>
                      {p.category === "marketing" ? "Marketing" : "Transactional"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                    {p.users ? p.users.toLocaleString() : "Topic"}
                  </TableCell>
                  <TableCell className="text-right text-xs font-medium tabular-nums text-foreground">
                    {p.sent.toLocaleString()}
                  </TableCell>
                  <TableCell
                    className={`text-right text-xs tabular-nums ${p.failed ? "font-medium text-destructive" : "text-muted-foreground"}`}
                  >
                    {p.failed.toLocaleString()}
                  </TableCell>
                  <TableCell>
                    {rate === null ? (
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {p.opened.toLocaleString()}
                      </span>
                    ) : (
                      <div className="flex items-center gap-2">
                        <div
                          className="h-1.5 flex-1 overflow-hidden rounded-xs bg-secondary"
                          role="presentation"
                        >
                          <div
                            className="h-full bg-primary transition-[width] duration-200"
                            style={{ width: `${rate * 100}%` }}
                          />
                        </div>
                        <span className="w-20 text-right font-mono text-[11px] tabular-nums text-foreground">
                          {p.opened} · {Math.round(rate * 100)}%
                        </span>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
