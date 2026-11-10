import { STATS_KEPT_DAYS, STATS_LISTED } from "@edgebase/core/limits";
import { BellRing, RefreshCw } from "lucide-react";
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
import { api, errorMessage, type PushStats } from "@/lib/api";
import { formatDate } from "@/lib/format";

export function PushesPage() {
  const [pushes, setPushes] = useState<PushStats[] | null>(null);

  const load = useCallback(async () => {
    try {
      setPushes((await api<{ pushes: PushStats[] }>("/v1/push")).pushes);
    } catch (e) {
      setPushes([]);
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
        description={`The last ${STATS_LISTED} pushes. Stats are kept for ${STATS_KEPT_DAYS} days.`}
      >
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw /> Refresh
        </Button>
      </PageHeader>

      {pushes && pushes.length > 0 && (
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-xl border bg-card px-4 py-3 shadow-2xs">
            <p className="text-xs text-muted-foreground">Batches</p>
            <p className="mt-1 text-xl font-semibold tabular-nums">{pushes.length}</p>
          </div>
          <div className="rounded-xl border bg-card px-4 py-3 shadow-2xs">
            <p className="text-xs text-muted-foreground">Delivered</p>
            <p className="mt-1 text-xl font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
              {totalSent}
            </p>
          </div>
          <div className="rounded-xl border bg-card px-4 py-3 shadow-2xs">
            <p className="text-xs text-muted-foreground">Failed</p>
            <p
              className={`mt-1 text-xl font-semibold tabular-nums ${totalFailed ? "text-destructive" : ""}`}
            >
              {totalFailed}
            </p>
          </div>
          <div className="rounded-xl border bg-card px-4 py-3 shadow-2xs">
            <p className="text-xs text-muted-foreground">Opened</p>
            <p className="mt-1 text-xl font-semibold tabular-nums">
              {totalOpened}
              {totalUsers > 0 && (
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                  ({Math.round(Math.min(totalOpened / totalUsers, 1) * 100)}%)
                </span>
              )}
            </p>
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">#</TableHead>
              <TableHead>Sent</TableHead>
              <TableHead className="hidden sm:table-cell">Kind</TableHead>
              <TableHead className="text-right">Users</TableHead>
              <TableHead className="text-right">Delivered</TableHead>
              <TableHead className="text-right">Failed</TableHead>
              <TableHead className="w-52">Opened</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pushes === null &&
              [1, 2, 3].map((key) => (
                <TableRow key={key}>
                  <TableCell colSpan={7}>
                    <Skeleton className="h-8 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {pushes?.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="h-32 text-center text-muted-foreground">
                  <div className="mx-auto flex flex-col items-center gap-1.5">
                    <BellRing className="size-5 text-muted-foreground/60" />
                    <p>
                      Nothing sent yet.{" "}
                      <a
                        href="#send"
                        className="font-medium text-primary underline underline-offset-4"
                      >
                        Send a push
                      </a>
                    </p>
                  </div>
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
                  <TableCell className="tabular-nums">
                    <span className="mr-2">{formatDate(p.sendAt)}</span>
                    {scheduled && <Badge variant="warning">Scheduled</Badge>}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <Badge variant={p.category === "marketing" ? "warning" : "secondary"}>
                      {p.category === "marketing" ? "Marketing" : "Transactional"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{p.users || "—"}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{p.sent}</TableCell>
                  <TableCell
                    className={`text-right tabular-nums ${p.failed ? "font-medium text-destructive" : "text-muted-foreground"}`}
                  >
                    {p.failed}
                  </TableCell>
                  <TableCell>
                    {rate === null ? (
                      <span className="tabular-nums">{p.opened}</span>
                    ) : (
                      <div className="flex items-center gap-2.5">
                        <div
                          className="h-2 flex-1 overflow-hidden rounded-full bg-secondary"
                          role="presentation"
                        >
                          <div
                            className="h-full rounded-full bg-primary transition-[width] duration-300"
                            style={{ width: `${rate * 100}%` }}
                          />
                        </div>
                        <span className="w-20 text-right text-xs font-medium tabular-nums">
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
