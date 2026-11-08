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

  return (
    <>
      <PageHeader title="Sent pushes" description="The last 50 pushes. Stats are kept for 90 days.">
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw /> Refresh
        </Button>
      </PageHeader>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">#</TableHead>
              <TableHead>Sent</TableHead>
              <TableHead className="hidden sm:table-cell">Kind</TableHead>
              <TableHead className="text-right">Users</TableHead>
              <TableHead className="text-right">Delivered</TableHead>
              <TableHead className="text-right">Failed</TableHead>
              <TableHead className="w-48">Opened</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pushes === null &&
              [1, 2, 3].map((key) => (
                <TableRow key={key}>
                  <TableCell colSpan={7}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {pushes?.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                  Nothing sent yet.{" "}
                  <a href="#send" className="underline underline-offset-4">
                    Send a push
                  </a>
                </TableCell>
              </TableRow>
            )}
            {pushes?.map((p) => {
              const rate = p.users ? Math.min(p.opened / p.users, 1) : null;
              const scheduled = p.sendAt > Date.now();
              return (
                <TableRow key={p.id}>
                  <TableCell className="tabular-nums text-muted-foreground">{p.id}</TableCell>
                  <TableCell>
                    <span className="mr-2">{formatDate(p.sendAt)}</span>
                    {scheduled && <Badge variant="secondary">Scheduled</Badge>}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <Badge variant="outline">
                      {p.category === "marketing" ? "Marketing" : "Transactional"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{p.users || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.sent}</TableCell>
                  <TableCell
                    className={`text-right tabular-nums ${p.failed ? "text-destructive" : ""}`}
                  >
                    {p.failed}
                  </TableCell>
                  <TableCell>
                    {rate === null ? (
                      <span className="tabular-nums">{p.opened}</span>
                    ) : (
                      <div className="flex items-center gap-2">
                        <div
                          className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
                          role="presentation"
                        >
                          <div
                            className="h-full rounded-full bg-primary"
                            style={{ width: `${rate * 100}%` }}
                          />
                        </div>
                        <span className="w-20 text-right text-sm tabular-nums">
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
