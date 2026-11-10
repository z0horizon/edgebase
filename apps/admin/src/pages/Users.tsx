import { MAX_RECIPIENTS } from "@edgebase/core/limits";
import {
  Ban,
  Copy,
  MoreHorizontal,
  Search,
  Send,
  ShieldCheck,
  ShieldOff,
  Undo2,
  Users,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/PageHeader";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api, errorMessage, listUsers, type User } from "@/lib/api";
import { formatDate } from "@/lib/format";

const PAGE = 20;

export function UsersPage({ me }: { me: User }) {
  const [users, setUsers] = useState<User[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState("");
  const [banning, setBanning] = useState<User | null>(null);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const latest = useRef(0);

  const load = useCallback(async () => {
    // A slow answer for an older search or page must not replace a newer one.
    const request = ++latest.current;
    try {
      const result = await listUsers({ limit: PAGE, offset, email: query });
      if (request !== latest.current) return;
      setUsers(result.users);
      setTotal(result.total);
    } catch (e) {
      if (request !== latest.current) return;
      setUsers((current) => current ?? []);
      toast.error(errorMessage(e));
    }
  }, [offset, query]);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (path: string, body: object, done: string) => {
    try {
      await api(`/api/auth/admin/${path}`, { method: "POST", body });
      toast.success(done);
      await load();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const search = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setOffset(0);
    setQuery(String(new FormData(event.currentTarget).get("q") ?? "").trim());
  };

  const last = Math.min(offset + PAGE, total);
  const selectedCount = Object.keys(selected).length;
  const pageAllSelected =
    Boolean(users && users.length > 0) && users?.every((u) => u.id in selected);

  const togglePage = (checked: boolean) => {
    if (!users) return;
    const next = { ...selected };
    let capped = false;
    for (const u of users) {
      if (checked) {
        if (!(u.id in next) && Object.keys(next).length >= MAX_RECIPIENTS) {
          capped = true;
          break;
        }
        next[u.id] = u.email;
      } else {
        delete next[u.id];
      }
    }
    if (capped) {
      toast.error(`A single push accepts at most ${MAX_RECIPIENTS} users.`);
    }
    setSelected(next);
  };

  return (
    <>
      <PageHeader title="Users" description="Everyone who has signed up, newest first.">
        {selectedCount > 0 && (
          <Button
            size="sm"
            onClick={() => {
              sessionStorage.setItem("edgebase:send-recipients", JSON.stringify(selected));
              location.hash = "#send";
            }}
          >
            <Send /> Send push ({selectedCount})
          </Button>
        )}
        {users !== null && (
          <Badge variant="secondary" className="tabular-nums">
            {total} {total === 1 ? "account" : "accounts"}
          </Badge>
        )}
        <search>
          <form onSubmit={search} className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              name="q"
              type="search"
              placeholder="Search by email"
              aria-label="Search by email"
              className="pl-9"
            />
          </form>
        </search>
      </PageHeader>

      <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  aria-label="Select all on this page"
                  checked={pageAllSelected}
                  onCheckedChange={(v) => togglePage(v === true)}
                />
              </TableHead>
              <TableHead>User</TableHead>
              <TableHead className="hidden md:table-cell">Joined</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-12 text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users === null &&
              [1, 2, 3, 4].map((key) => (
                <TableRow key={key}>
                  <TableCell colSpan={6}>
                    <Skeleton className="h-10 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {users?.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                  <div className="mx-auto flex flex-col items-center gap-1.5">
                    <Users className="size-5 text-muted-foreground/60" />
                    <p>{query ? "No user matches that email." : "No users yet."}</p>
                  </div>
                </TableCell>
              </TableRow>
            )}
            {users?.map((user) => {
              const isAdmin = user.role === "admin";
              const initial = (user.name || user.email).trim().charAt(0).toUpperCase() || "U";
              const isSelected = user.id in selected;
              return (
                <TableRow key={user.id} data-state={isSelected ? "selected" : undefined}>
                  <TableCell>
                    <Checkbox
                      aria-label={`Select ${user.email}`}
                      checked={isSelected}
                      onCheckedChange={(v) => {
                        if (v !== true) {
                          const { [user.id]: _, ...rest } = selected;
                          setSelected(rest);
                          return;
                        }
                        if (selectedCount >= MAX_RECIPIENTS) {
                          toast.error(`A single push accepts at most ${MAX_RECIPIENTS} users.`);
                          return;
                        }
                        setSelected({ ...selected, [user.id]: user.email });
                      }}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <span
                        aria-hidden="true"
                        className="grid size-8 shrink-0 place-items-center rounded-full border bg-secondary/70 text-xs font-semibold text-secondary-foreground"
                      >
                        {initial}
                      </span>
                      <div className="grid min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium">{user.name || user.email}</span>
                          {user.id === me.id && (
                            <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                              You
                            </span>
                          )}
                        </div>
                        <span className="truncate text-xs text-muted-foreground">{user.email}</span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="hidden tabular-nums text-muted-foreground md:table-cell">
                    {formatDate(user.createdAt)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={isAdmin ? "default" : "secondary"}>
                      {isAdmin && <ShieldCheck />}
                      {isAdmin ? "Admin" : "User"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {user.banned ? (
                      <Badge variant="destructive" title={user.banReason ?? undefined}>
                        Banned
                      </Badge>
                    ) : user.emailVerified ? (
                      <Badge variant="success">
                        <span
                          aria-hidden="true"
                          className="size-1.5 rounded-full bg-emerald-600 dark:bg-emerald-400"
                        />
                        Active
                      </Badge>
                    ) : (
                      <Badge variant="warning">Unverified</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Actions for ${user.email}`}
                        >
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onSelect={() => {
                            sessionStorage.setItem(
                              "edgebase:send-recipients",
                              JSON.stringify({ [user.id]: user.email }),
                            );
                            location.hash = "#send";
                          }}
                        >
                          <Send /> Send push
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() =>
                            navigator.clipboard
                              .writeText(user.id)
                              .then(() => toast.success("User ID copied"))
                          }
                        >
                          <Copy /> Copy user ID
                        </DropdownMenuItem>
                        {user.id !== me.id && (
                          <>
                            <DropdownMenuSeparator />
                            {isAdmin ? (
                              <DropdownMenuItem
                                onSelect={() =>
                                  act(
                                    "set-role",
                                    { userId: user.id, role: "user" },
                                    `${user.email} is now a user`,
                                  )
                                }
                              >
                                <ShieldOff /> Remove admin
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem
                                onSelect={() =>
                                  act(
                                    "set-role",
                                    { userId: user.id, role: "admin" },
                                    `${user.email} is now an admin`,
                                  )
                                }
                              >
                                <ShieldCheck /> Make admin
                              </DropdownMenuItem>
                            )}
                            {user.banned ? (
                              <DropdownMenuItem
                                onSelect={() =>
                                  act("unban-user", { userId: user.id }, `Unbanned ${user.email}`)
                                }
                              >
                                <Undo2 /> Unban
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={() => setBanning(user)}
                              >
                                <Ban /> Ban
                              </DropdownMenuItem>
                            )}
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>

        {total > 0 && (
          <footer className="flex items-center gap-2 border-t bg-muted/30 px-4 py-3">
            <p className="mr-auto text-xs tabular-nums text-muted-foreground">
              Showing <span className="font-medium text-foreground">{offset + 1}</span>–
              <span className="font-medium text-foreground">{last}</span> of{" "}
              <span className="font-medium text-foreground">{total}</span>
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={last >= total}
              onClick={() => setOffset(offset + PAGE)}
            >
              Next
            </Button>
          </footer>
        )}
      </div>

      <Dialog open={banning !== null} onOpenChange={(open) => !open && setBanning(null)}>
        <DialogContent>
          <form
            className="grid gap-4"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!banning) return;
              const reason = String(new FormData(event.currentTarget).get("reason") ?? "").trim();
              await act(
                "ban-user",
                { userId: banning.id, ...(reason && { banReason: reason }) },
                `Banned ${banning.email}`,
              );
              setBanning(null);
            }}
          >
            <DialogHeader>
              <DialogTitle>Ban {banning?.email}</DialogTitle>
              <DialogDescription>
                They are signed out everywhere and cannot sign in until you unban them.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="reason">Reason, for other admins</Label>
              <Input id="reason" name="reason" maxLength={200} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setBanning(null)}>
                Cancel
              </Button>
              <Button type="submit" variant="destructive">
                Ban user
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
