import { MAX_RECIPIENTS } from "@edgebase/core/limits";
import {
  Ban,
  Copy,
  Laptop,
  MoreHorizontal,
  Search,
  Send,
  ShieldCheck,
  ShieldOff,
  Undo2,
  X,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/PageHeader";
import { SessionCard } from "@/components/SessionCard";
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
import { api, errorMessage, listUsers, type SessionRecord, type User } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { SEND_RECIPIENTS_KEY } from "@/lib/state";

const PAGE = 20;

export function UsersPage({ me }: { me: User }) {
  const [users, setUsers] = useState<User[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [banning, setBanning] = useState<User | null>(null);
  const [inspecting, setInspecting] = useState<User | null>(null);
  const [userSessions, setUserSessions] = useState<SessionRecord[] | null>(null);
  const [sessionsBusy, setSessionsBusy] = useState(false);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const latest = useRef(0);

  const loadUserSessions = useCallback(async (target: User) => {
    setUserSessions(null);
    try {
      const res = await api<{ sessions: SessionRecord[] }>(
        `/v1/admin/users/${encodeURIComponent(target.id)}/sessions`,
      );
      setUserSessions(res.sessions);
    } catch (e) {
      setUserSessions([]);
      toast.error(errorMessage(e));
    }
  }, []);

  const openSessions = (target: User) => {
    setInspecting(target);
    loadUserSessions(target);
  };

  const revokeTargetSession = async (sessionId: string) => {
    if (!inspecting) return;
    setSessionsBusy(true);
    try {
      await api(
        `/v1/admin/users/${encodeURIComponent(inspecting.id)}/sessions/${encodeURIComponent(sessionId)}`,
        { method: "DELETE" },
      );
      toast.success("Session revoked");
      await loadUserSessions(inspecting);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSessionsBusy(false);
    }
  };

  const revokeAllTargetSessions = async () => {
    if (!inspecting) return;
    setSessionsBusy(true);
    try {
      await api(`/v1/admin/users/${encodeURIComponent(inspecting.id)}/sessions`, {
        method: "DELETE",
      });
      toast.success(`Revoked all sessions and trusted devices for ${inspecting.email}`);
      await loadUserSessions(inspecting);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSessionsBusy(false);
    }
  };

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
    setQuery(searchInput.trim());
  };

  const clearSearch = () => {
    setSearchInput("");
    setOffset(0);
    setQuery("");
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
      <PageHeader
        title="Users"
        description="Registered accounts, role grants, verification state, and active edge sessions."
      />

      <div className="overflow-hidden rounded-md border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3.5 py-2.5">
          <search className="w-full sm:w-auto">
            <form onSubmit={search} className="relative flex items-center gap-1.5 sm:w-72">
              <Search className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground" />
              <Input
                name="q"
                type="search"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Filter by email…"
                aria-label="Search by email"
                className="h-7 pr-7 pl-8 text-xs"
              />
              {(query || searchInput) && (
                <button
                  type="button"
                  onClick={clearSearch}
                  aria-label="Clear filter"
                  className="absolute right-2 text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </form>
          </search>

          <div className="flex flex-wrap items-center gap-2">
            {selectedCount > 0 && (
              <>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {selectedCount} selected
                </span>
                <Button
                  size="sm"
                  onClick={() => {
                    sessionStorage.setItem(SEND_RECIPIENTS_KEY, JSON.stringify(selected));
                    location.hash = "#send";
                  }}
                >
                  <Send /> Send push ({selectedCount})
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setSelected({})}>
                  Clear
                </Button>
              </>
            )}
            {users !== null && (
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {total} {total === 1 ? "account" : "accounts"}
              </span>
            )}
          </div>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8 pr-0">
                <Checkbox
                  aria-label="Select all on this page"
                  checked={pageAllSelected}
                  onCheckedChange={(v) => togglePage(v === true)}
                />
              </TableHead>
              <TableHead>Account</TableHead>
              <TableHead className="hidden lg:table-cell">User ID</TableHead>
              <TableHead className="hidden sm:table-cell">Role</TableHead>
              <TableHead className="hidden md:table-cell">2FA</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden text-right md:table-cell">Joined</TableHead>
              <TableHead className="w-9 px-2 text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users === null &&
              [1, 2, 3, 4, 5].map((key) => (
                <TableRow key={key}>
                  <TableCell colSpan={8}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {users?.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="h-28 text-center text-xs text-muted-foreground">
                  {query ? `No account matches "${query}".` : "No accounts registered yet."}
                </TableCell>
              </TableRow>
            )}
            {users?.map((user) => {
              const isAdmin = user.role === "admin";
              const isSelected = user.id in selected;
              const showDistinctName = Boolean(
                user.name &&
                  user.name !== user.email &&
                  user.name.toLowerCase() !== user.email.split("@")[0]?.toLowerCase(),
              );
              return (
                <TableRow key={user.id} data-state={isSelected ? "selected" : undefined}>
                  <TableCell className="pr-0">
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
                  <TableCell className="max-w-[175px] sm:max-w-none">
                    <div className="grid min-w-0">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="truncate font-medium text-foreground">{user.email}</span>
                        {user.id === me.id && (
                          <Badge variant="outline" className="hidden sm:inline-flex">
                            You
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                        {showDistinctName && <span className="truncate">{user.name}</span>}
                        <span className="sm:hidden">
                          {showDistinctName ? "· " : ""}
                          {isAdmin ? "Admin" : "User"}
                          {user.id === me.id ? " (You)" : ""}
                        </span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    <button
                      type="button"
                      title={`Copy ${user.id}`}
                      onClick={() =>
                        navigator.clipboard
                          .writeText(user.id)
                          .then(() => toast.success("User ID copied"))
                      }
                      className="inline-flex items-center gap-1 rounded-sm border bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:border-input hover:text-foreground"
                    >
                      <span>{user.id.slice(0, 10)}…</span>
                      <Copy className="size-2.5" />
                    </button>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <Badge variant={isAdmin ? "default" : "secondary"}>
                      {isAdmin ? "Admin" : "User"}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {user.twoFactorEnabled ? (
                      <Badge variant="outline">TOTP</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
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
                  <TableCell className="hidden text-right text-xs tabular-nums text-muted-foreground md:table-cell">
                    {formatDate(user.createdAt)}
                  </TableCell>
                  <TableCell className="px-2 text-right">
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
                              SEND_RECIPIENTS_KEY,
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
                        <DropdownMenuItem onSelect={() => openSessions(user)}>
                          <Laptop /> Inspect sessions
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
                                <ShieldOff /> Revoke admin
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
                                <ShieldCheck /> Grant admin
                              </DropdownMenuItem>
                            )}
                            {user.banned ? (
                              <DropdownMenuItem
                                onSelect={() =>
                                  act("unban-user", { userId: user.id }, `Unbanned ${user.email}`)
                                }
                              >
                                <Undo2 /> Unban account
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={() => setBanning(user)}
                              >
                                <Ban /> Ban account
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
          <footer className="flex items-center gap-2 border-t bg-muted/35 px-3.5 py-2">
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
                Immediately revokes active sessions and blocks future sign-ins until unbanned.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-1.5">
              <Label htmlFor="reason">Audit reason (optional)</Label>
              <Input
                id="reason"
                name="reason"
                maxLength={200}
                placeholder="Policy violation or compromised account"
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setBanning(null)}>
                Cancel
              </Button>
              <Button type="submit" variant="destructive">
                Ban account
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={inspecting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setInspecting(null);
            setUserSessions(null);
          }
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Active sessions — {inspecting?.email}</DialogTitle>
            <DialogDescription>
              {inspecting?.twoFactorEnabled
                ? `TOTP enabled${inspecting.twoFactorEnabledAt ? ` (${formatDate(inspecting.twoFactorEnabledAt)})` : ""}`
                : "TOTP disabled"}
              {" · "}
              Password changed:{" "}
              {inspecting?.passwordChangedAt ? formatDate(inspecting.passwordChangedAt) : "—"}
            </DialogDescription>
          </DialogHeader>
          <div className="divide-y overflow-hidden rounded-md border bg-background/50">
            {userSessions === null && (
              <p className="px-4 py-3 text-xs text-muted-foreground">Loading sessions…</p>
            )}
            {userSessions?.length === 0 && (
              <p className="px-4 py-3 text-xs text-muted-foreground">No active sessions.</p>
            )}
            {userSessions?.map((s) => (
              <SessionCard
                key={s.id}
                session={s}
                busy={sessionsBusy}
                onRevoke={inspecting?.id !== me.id ? () => revokeTargetSession(s.id) : undefined}
              />
            ))}
          </div>
          <DialogFooter>
            {inspecting?.id !== me.id && (userSessions?.length ?? 0) > 0 && (
              <Button
                type="button"
                variant="destructive"
                disabled={sessionsBusy}
                onClick={revokeAllTargetSessions}
              >
                Revoke all sessions
              </Button>
            )}
            <Button type="button" variant="outline" onClick={() => setInspecting(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
