import { Ban, MoreHorizontal, Search, ShieldCheck, ShieldOff, Undo2 } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/PageHeader";
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
import { api, errorMessage, type User } from "@/lib/api";
import { formatDate } from "@/lib/format";

const PAGE = 20;

export function UsersPage({ me }: { me: User }) {
  const [users, setUsers] = useState<User[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState("");
  const [banning, setBanning] = useState<User | null>(null);
  const latest = useRef(0);

  const load = useCallback(async () => {
    // A slow answer for an older search or page must not replace a newer one.
    const request = ++latest.current;
    const params = new URLSearchParams({
      limit: String(PAGE),
      offset: String(offset),
      sortBy: "createdAt",
      sortDirection: "desc",
    });
    if (query) {
      params.set("searchField", "email");
      params.set("searchOperator", "contains");
      params.set("searchValue", query);
    }
    try {
      const result = await api<{ users: User[]; total: number }>(
        `/api/auth/admin/list-users?${params}`,
      );
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

  return (
    <>
      <PageHeader title="Users" description="Everyone who has signed up, newest first.">
        <search>
          <form onSubmit={search} className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              name="q"
              type="search"
              placeholder="Search by email"
              aria-label="Search by email"
              className="pl-8"
            />
          </form>
        </search>
      </PageHeader>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead className="hidden md:table-cell">Joined</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-12">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users === null &&
              [1, 2, 3, 4].map((key) => (
                <TableRow key={key}>
                  <TableCell colSpan={5}>
                    <Skeleton className="h-9 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {users?.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                  {query ? "No user matches that email." : "No users yet."}
                </TableCell>
              </TableRow>
            )}
            {users?.map((user) => {
              const isAdmin = user.role === "admin";
              return (
                <TableRow key={user.id}>
                  <TableCell>
                    <div className="grid">
                      <span className="font-medium">{user.name || user.email}</span>
                      <span className="text-xs text-muted-foreground">{user.email}</span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">
                    {formatDate(user.createdAt)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={isAdmin ? "default" : "secondary"}>
                      {isAdmin ? "Admin" : "User"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {user.banned ? (
                      <Badge variant="destructive" title={user.banReason ?? undefined}>
                        Banned
                      </Badge>
                    ) : user.emailVerified ? (
                      <Badge variant="outline">Active</Badge>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground">
                        Unverified
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {user.id !== me.id && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Actions for ${user.email}`}
                          >
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onSelect={() =>
                              navigator.clipboard
                                .writeText(user.id)
                                .then(() => toast.success("User ID copied"))
                            }
                          >
                            Copy user ID
                          </DropdownMenuItem>
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
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <footer className="mt-4 flex items-center gap-2">
        <p className="mr-auto text-sm text-muted-foreground">
          {total ? `${offset + 1}–${last} of ${total}` : ""}
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
