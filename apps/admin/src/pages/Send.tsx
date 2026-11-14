import { BODY_MAX, MAX_RECIPIENTS, TITLE_MAX } from "@edgebase/core/limits";
import { BellRing, Check, Clock, Inbox, Plus, Radio, Search, Send, Users, X } from "lucide-react";
import {
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { FormError } from "@/components/FormError";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  api,
  type Category,
  errorMessage,
  listUsers,
  type Template,
  type Text,
  type User,
} from "@/lib/api";
import { fillPreview, SEND_RECIPIENTS_KEY } from "@/lib/state";
import { cn } from "@/lib/utils";

const NONE = "none";
const SEARCH_LIMIT = 8;
const COLLAPSED_CHIP_LIMIT = 10;

/** `name=value` per line; the first `=` splits, so values may contain `=`. */
function parseVars(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    const key = (at < 0 ? line : line.slice(0, at)).trim();
    if (key) vars[key] = at < 0 ? "" : line.slice(at + 1).trim();
  }
  return vars;
}

export function SendPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [target, setTarget] = useState<"users" | "topic">("users");
  // Maps userId -> display label (email when picked from list, or the raw ID when pasted).
  const [recipients, setRecipients] = useState<Record<string, string>>(() => {
    const prefill = sessionStorage.getItem(SEND_RECIPIENTS_KEY);
    if (!prefill) return {};
    sessionStorage.removeItem(SEND_RECIPIENTS_KEY);
    try {
      const parsed = JSON.parse(prefill) as Record<string, string>;
      return Object.fromEntries(Object.entries(parsed).slice(0, MAX_RECIPIENTS));
    } catch {
      return {};
    }
  });
  const [showAllChips, setShowAllChips] = useState(false);
  const [userQuery, setUserQuery] = useState("");
  const [directory, setDirectory] = useState<{ users: User[]; total: number } | null>(null);
  const latestDirectory = useRef(0);
  const [topic, setTopic] = useState("all");
  const [templateName, setTemplateName] = useState(NONE);
  const [text, setText] = useState<Text>({ title: "", body: "" });
  const [vars, setVars] = useState("");
  const [category, setCategory] = useState<Category>("transactional");
  const [inbox, setInbox] = useState(true);
  const [sendAt, setSendAt] = useState("");
  const [locale, setLocale] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // One key per message, so a retry after a timeout is not sent twice; a new message gets a new key.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    api<{ templates: Template[] }>("/v1/templates")
      .then((r) => setTemplates(r.templates))
      .catch((e) => toast.error(errorMessage(e)));
  }, []);

  useEffect(() => {
    const q = userQuery.trim();
    if (target !== "users" || q.length < 2) {
      setDirectory(null);
      return;
    }
    const req = ++latestDirectory.current;
    const timer = setTimeout(() => {
      listUsers({ limit: SEARCH_LIMIT, email: q })
        .then((res) => {
          if (req === latestDirectory.current) setDirectory(res);
        })
        .catch(() => {
          if (req === latestDirectory.current) setDirectory({ users: [], total: 0 });
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [target, userQuery]);

  const recipientIds = Object.keys(recipients);
  const visibleChipIds = showAllChips ? recipientIds : recipientIds.slice(0, COLLAPSED_CHIP_LIMIT);
  const hiddenChipCount = recipientIds.length - visibleChipIds.length;

  const addRawIds = (raw: string) => {
    const tokens = raw
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (tokens.length === 0) return;
    const next = { ...recipients };
    let capped = false;
    let unresolvedEmail: string | null = null;
    for (const token of tokens) {
      const matched = directory?.users.find(
        (u) => u.id === token || u.email.toLowerCase() === token.toLowerCase(),
      );
      const id = matched ? matched.id : token;
      if (!matched && token.includes("@")) {
        unresolvedEmail = token;
        continue;
      }
      if (!(id in next) && Object.keys(next).length >= MAX_RECIPIENTS) {
        capped = true;
        break;
      }
      next[id] = matched ? matched.email : (recipients[id] ?? id);
    }
    if (capped) {
      toast.error(
        `Capped at ${MAX_RECIPIENTS} users per push. Use a topic to broadcast to everyone.`,
      );
    }
    if (unresolvedEmail) {
      setError(
        `Click a matching user in the search dropdown for "${unresolvedEmail}", or paste user IDs.`,
      );
      return;
    }
    setRecipients(next);
    setUserQuery("");
    setError("");
  };

  const toggleUser = (u: User) => {
    if (u.id in recipients) {
      const { [u.id]: _, ...rest } = recipients;
      setRecipients(rest);
      setError("");
      return;
    }
    if (recipientIds.length >= MAX_RECIPIENTS) {
      toast.error(`A single push accepts at most ${MAX_RECIPIENTS} users.`);
      return;
    }
    setRecipients({ ...recipients, [u.id]: u.email });
    setError("");
  };

  const removeRecipient = (id: string) => {
    setRecipients((prev) => {
      const { [id]: _, ...rest } = prev;
      return rest;
    });
  };

  const onRecipientKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && userQuery.trim()) {
      event.preventDefault();
      addRawIds(userQuery);
    } else if (event.key === "Backspace" && !userQuery && recipientIds.length > 0) {
      if (!showAllChips && hiddenChipCount > 0) {
        setShowAllChips(true);
        return;
      }
      const lastId = recipientIds[recipientIds.length - 1];
      if (lastId) removeRecipient(lastId);
    }
  };

  const onRecipientPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData("text");
    if (/[\s,]/.test(pasted.trim())) {
      event.preventDefault();
      addRawIds(pasted);
    }
  };

  const template = templates.find((t) => t.name === templateName);

  // What each language will show; "" is the default text.
  const preview = useMemo(() => {
    const values = parseVars(vars);
    const base = template ?? { ...text, translations: {} };
    const texts: Record<string, Text> = { "": base, ...base.translations };
    return Object.fromEntries(
      Object.entries(texts).map(([key, t]) => [
        key,
        { title: fillPreview(t.title, values), body: fillPreview(t.body, values) },
      ]),
    );
  }, [template, text, vars]);
  const shown = preview[locale] ?? preview[""] ?? { title: "", body: "" };

  const chooseTemplate = (name: string) => {
    setTemplateName(name);
    setLocale("");
    const chosen = templates.find((t) => t.name === name);
    if (chosen?.category) setCategory(chosen.category);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (target === "users") {
      if (userQuery.trim()) {
        setError("Select a matching user from the search list or click 'Add ID' before sending.");
        return;
      }
      if (recipientIds.length === 0) {
        setError("Select at least one user or paste a user ID.");
        return;
      }
      if (recipientIds.length > MAX_RECIPIENTS) {
        setError(`A single push supports at most ${MAX_RECIPIENTS} users.`);
        return;
      }
    }
    setBusy(true);
    try {
      const result = await api<{ id: number; users?: number; scheduled?: boolean }>("/v1/push", {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
        body: {
          to: target === "users" ? { userIds: recipientIds } : { topic: topic.trim() },
          category,
          inbox,
          ...(template ? { template: template.name, vars: parseVars(vars) } : text),
          ...(sendAt && { sendAt: new Date(sendAt).toISOString() }),
        },
      });
      toast.success(
        result.scheduled
          ? `Push #${result.id} scheduled`
          : target === "topic"
            ? `Push #${result.id} sent to topic ${topic.trim()}`
            : `Push #${result.id} sent to ${result.users} ${result.users === 1 ? "user" : "users"}`,
      );
      setIdempotencyKey(crypto.randomUUID());
      location.hash = "#pushes";
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Send a push"
        description="Notify chosen users or everyone subscribed to a topic."
      />
      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card className="shadow-xs">
          <CardContent>
            <form className="grid gap-6" onSubmit={submit}>
              <fieldset className="grid gap-3">
                <legend className="mb-2 text-sm font-medium">Send to</legend>
                <RadioGroup
                  value={target}
                  onValueChange={(v) => setTarget(v as "users" | "topic")}
                  className="grid gap-3 sm:grid-cols-2"
                >
                  <Label
                    htmlFor="target-users"
                    className={cn(
                      "cursor-pointer items-start gap-3 rounded-xl border p-3.5 font-normal transition-colors",
                      target === "users"
                        ? "border-primary/40 bg-accent/60 shadow-2xs"
                        : "hover:bg-secondary/50",
                    )}
                  >
                    <RadioGroupItem id="target-users" value="users" className="mt-0.5" />
                    <div className="grid gap-1 leading-snug">
                      <span className="flex items-center gap-1.5 font-medium text-foreground">
                        <Users className="size-3.5 text-primary" /> Chosen users
                      </span>
                      <span className="text-xs text-muted-foreground">
                        Pick accounts by email or paste user IDs
                      </span>
                    </div>
                  </Label>
                  <Label
                    htmlFor="target-topic"
                    className={cn(
                      "cursor-pointer items-start gap-3 rounded-xl border p-3.5 font-normal transition-colors",
                      target === "topic"
                        ? "border-primary/40 bg-accent/60 shadow-2xs"
                        : "hover:bg-secondary/50",
                    )}
                  >
                    <RadioGroupItem id="target-topic" value="topic" className="mt-0.5" />
                    <div className="grid gap-1 leading-snug">
                      <span className="flex items-center gap-1.5 font-medium text-foreground">
                        <Radio className="size-3.5 text-primary" /> A topic
                      </span>
                      <span className="text-xs text-muted-foreground">
                        Broadcast to topic subscribers
                      </span>
                    </div>
                  </Label>
                </RadioGroup>

                {target === "users" ? (
                  <div className="overflow-hidden rounded-xl border bg-card">
                    <div className="relative flex items-center px-3">
                      <Search className="pointer-events-none size-4 shrink-0 text-muted-foreground" />
                      <input
                        type="text"
                        aria-label="User IDs"
                        placeholder={`Type email to search (2+ chars), or paste up to ${MAX_RECIPIENTS} user IDs…`}
                        value={userQuery}
                        onChange={(e) => setUserQuery(e.target.value)}
                        onKeyDown={onRecipientKeyDown}
                        onPaste={onRecipientPaste}
                        spellCheck={false}
                        className="h-10 w-full bg-transparent px-2.5 text-sm outline-none placeholder:text-muted-foreground"
                      />
                      {userQuery.trim() && (
                        <Button
                          type="button"
                          variant="secondary"
                          size="xs"
                          onClick={() => addRawIds(userQuery)}
                        >
                          <Plus /> Add ID
                        </Button>
                      )}
                    </div>

                    {userQuery.trim().length >= 2 && (
                      <div
                        className="max-h-52 divide-y overflow-y-auto border-t bg-muted/20"
                        role="listbox"
                        aria-label="Matching users"
                        aria-multiselectable="true"
                      >
                        {directory === null && (
                          <p className="px-3.5 py-2.5 text-xs text-muted-foreground">
                            Searching users…
                          </p>
                        )}
                        {directory && directory.users.length === 0 && (
                          <p className="px-3.5 py-2.5 text-xs text-muted-foreground">
                            No email matches &ldquo;{userQuery.trim()}&rdquo;. Press Enter to add it
                            as a user ID.
                          </p>
                        )}
                        {directory?.users.map((u) => {
                          const selected = u.id in recipients;
                          const initial = (u.name || u.email).trim().charAt(0).toUpperCase() || "U";
                          return (
                            <button
                              key={u.id}
                              type="button"
                              role="option"
                              aria-selected={selected}
                              onClick={() => toggleUser(u)}
                              className={cn(
                                "flex w-full items-center gap-3 px-3.5 py-2 text-left text-sm transition-colors hover:bg-secondary/70",
                                selected && "bg-accent/50",
                              )}
                            >
                              <span
                                aria-hidden="true"
                                className={cn(
                                  "grid size-4 shrink-0 place-items-center rounded border transition-colors",
                                  selected
                                    ? "border-primary bg-primary text-primary-foreground"
                                    : "border-input bg-card",
                                )}
                              >
                                {selected && <Check className="size-3" />}
                              </span>
                              <span
                                aria-hidden="true"
                                className="grid size-6 shrink-0 place-items-center rounded-full border bg-secondary text-[11px] font-semibold text-secondary-foreground"
                              >
                                {initial}
                              </span>
                              <div className="min-w-0 flex-1">
                                <span className="truncate text-xs font-medium text-foreground">
                                  {u.email}
                                </span>
                                {u.name && (
                                  <span className="ml-2 truncate text-xs text-muted-foreground">
                                    {u.name}
                                  </span>
                                )}
                              </div>
                              <code className="shrink-0 rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                                {u.id.slice(0, 8)}…
                              </code>
                            </button>
                          );
                        })}
                        {directory && directory.total > directory.users.length && (
                          <p className="bg-muted/40 px-3.5 py-1.5 text-[11px] tabular-nums text-muted-foreground">
                            Showing top {directory.users.length} of {directory.total} matches — keep
                            typing to narrow down.
                          </p>
                        )}
                      </div>
                    )}

                    <div className="flex flex-col gap-2 border-t bg-muted/25 px-3 py-2.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="tabular-nums text-muted-foreground">
                          <strong className="font-medium text-foreground">
                            {recipientIds.length}
                          </strong>{" "}
                          / {MAX_RECIPIENTS} recipients
                        </span>
                        {recipientIds.length > 0 ? (
                          <button
                            type="button"
                            onClick={() => setRecipients({})}
                            className="font-medium text-muted-foreground transition-colors hover:text-destructive"
                          >
                            Clear all
                          </button>
                        ) : (
                          <span className="text-muted-foreground">
                            Over {MAX_RECIPIENTS} users? Switch to a topic.
                          </span>
                        )}
                      </div>

                      {recipientIds.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5">
                          {visibleChipIds.map((id) => {
                            const label = recipients[id] ?? id;
                            const isEmail = label.includes("@");
                            return (
                              <span
                                key={id}
                                className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-primary/20 bg-accent py-0.5 pr-1.5 pl-2.5 text-xs font-medium text-accent-foreground"
                              >
                                <span
                                  className={cn("truncate", !isEmail && "font-mono text-[11px]")}
                                  title={id}
                                >
                                  {label}
                                </span>
                                <button
                                  type="button"
                                  aria-label={`Remove ${label}`}
                                  onClick={() => removeRecipient(id)}
                                  className="grid size-4 shrink-0 place-items-center rounded-full text-accent-foreground/70 transition-colors hover:bg-primary/15 hover:text-accent-foreground"
                                >
                                  <X className="size-3" />
                                </button>
                              </span>
                            );
                          })}
                          {hiddenChipCount > 0 && (
                            <button
                              type="button"
                              onClick={() => setShowAllChips(true)}
                              className="rounded-full border bg-card px-2.5 py-0.5 text-xs font-medium tabular-nums text-muted-foreground transition-colors hover:text-foreground"
                            >
                              +{hiddenChipCount} more
                            </button>
                          )}
                          {showAllChips && recipientIds.length > COLLAPSED_CHIP_LIMIT && (
                            <button
                              type="button"
                              onClick={() => setShowAllChips(false)}
                              className="rounded-full border bg-card px-2.5 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                            >
                              Collapse
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="grid gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        aria-label="Topic"
                        value={topic}
                        onChange={(e) => setTopic(e.target.value)}
                        spellCheck={false}
                        placeholder="all"
                        className="flex-1 font-mono text-sm"
                        required
                      />
                      {(["all", "promotions"] as const).map((preset) => (
                        <Button
                          key={preset}
                          type="button"
                          size="xs"
                          variant={topic.trim() === preset ? "default" : "outline"}
                          className="font-mono"
                          onClick={() => setTopic(preset)}
                        >
                          #{preset}
                        </Button>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Subscribers to{" "}
                      <code className="rounded bg-secondary px-1 py-0.5 font-mono">
                        {topic.trim() || "all"}
                      </code>{" "}
                      will receive this push (unlimited audience).
                    </p>
                  </div>
                )}
              </fieldset>

              <div className="grid gap-4 border-t pt-6">
                <div className="grid gap-2">
                  <Label htmlFor="template">Template</Label>
                  <Select value={templateName} onValueChange={chooseTemplate}>
                    <SelectTrigger id="template" className="w-full bg-card">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>None, write the message here</SelectItem>
                      {templates.map((t) => (
                        <SelectItem key={t.name} value={t.name}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {template ? (
                  <div className="grid gap-2">
                    <Label htmlFor="vars">Values</Label>
                    <Textarea
                      id="vars"
                      placeholder={"order=1042\neta=tomorrow"}
                      value={vars}
                      onChange={(e) => setVars(e.target.value)}
                      spellCheck={false}
                      className="font-mono text-sm"
                    />
                    <p className="text-xs text-muted-foreground">
                      One{" "}
                      <code className="rounded bg-secondary px-1 py-0.5 font-mono">name=value</code>{" "}
                      per line, for each{" "}
                      <code className="rounded bg-secondary px-1 py-0.5 font-mono">
                        {"{{name}}"}
                      </code>{" "}
                      in the template.
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="grid gap-2">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="title">Title</Label>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {text.title.length}/{TITLE_MAX}
                        </span>
                      </div>
                      <Input
                        id="title"
                        maxLength={TITLE_MAX}
                        placeholder="Order shipped"
                        value={text.title}
                        onChange={(e) => setText({ ...text, title: e.target.value })}
                        required
                      />
                    </div>
                    <div className="grid gap-2">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="body">Message</Label>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {text.body.length}/{BODY_MAX}
                        </span>
                      </div>
                      <Textarea
                        id="body"
                        maxLength={BODY_MAX}
                        placeholder="Your package is on its way."
                        value={text.body}
                        onChange={(e) => setText({ ...text, body: e.target.value })}
                      />
                    </div>
                  </>
                )}
              </div>

              <fieldset className="grid gap-3 border-t pt-6">
                <legend className="mb-2 text-sm font-medium">Kind</legend>
                <RadioGroup
                  value={category}
                  onValueChange={(v) => setCategory(v as Category)}
                  className="grid gap-3 sm:grid-cols-2"
                >
                  <Label
                    htmlFor="kind-transactional"
                    className={cn(
                      "cursor-pointer items-start gap-3 rounded-xl border p-3.5 font-normal transition-colors",
                      category === "transactional"
                        ? "border-primary/40 bg-accent/60 shadow-2xs"
                        : "hover:bg-secondary/50",
                    )}
                  >
                    <RadioGroupItem
                      id="kind-transactional"
                      value="transactional"
                      className="mt-0.5"
                    />
                    <div className="grid gap-1 leading-snug">
                      <span className="font-medium text-foreground">Transactional</span>
                      <span className="text-xs text-muted-foreground">
                        Account, order, or security updates
                      </span>
                    </div>
                  </Label>
                  <Label
                    htmlFor="kind-marketing"
                    className={cn(
                      "cursor-pointer items-start gap-3 rounded-xl border p-3.5 font-normal transition-colors",
                      category === "marketing"
                        ? "border-primary/40 bg-accent/60 shadow-2xs"
                        : "hover:bg-secondary/50",
                    )}
                  >
                    <RadioGroupItem id="kind-marketing" value="marketing" className="mt-0.5" />
                    <div className="grid gap-1 leading-snug">
                      <span className="font-medium text-foreground">Marketing</span>
                      <span className="text-xs text-muted-foreground">
                        Only sent to users who opted in
                      </span>
                    </div>
                  </Label>
                </RadioGroup>
              </fieldset>

              <div className="grid gap-4 sm:grid-cols-2">
                <Label
                  htmlFor="inbox-toggle"
                  className="cursor-pointer items-start gap-3 rounded-xl border bg-muted/30 p-3.5 font-normal"
                >
                  <Checkbox
                    id="inbox-toggle"
                    checked={inbox}
                    onCheckedChange={(v) => setInbox(v === true)}
                    className="mt-0.5"
                  />
                  <div className="grid gap-1 leading-snug">
                    <span className="flex items-center gap-1.5 font-medium text-foreground">
                      <Inbox className="size-3.5 text-muted-foreground" /> Also add it to the inbox
                    </span>
                    <span className="text-xs text-muted-foreground">
                      Persists in the user&apos;s in-app inbox
                    </span>
                  </div>
                </Label>
                <div className="grid gap-2">
                  <Label htmlFor="sendAt" className="flex items-center gap-1.5">
                    <Clock className="size-3.5 text-muted-foreground" /> Send later (optional)
                  </Label>
                  <Input
                    id="sendAt"
                    type="datetime-local"
                    value={sendAt}
                    onChange={(e) => setSendAt(e.target.value)}
                  />
                </div>
              </div>

              <FormError message={error} />
              <Button type="submit" disabled={busy} className="justify-self-start">
                <Send /> {sendAt ? "Schedule push" : "Send push"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <aside className="grid gap-3 lg:sticky lg:top-8" aria-label="Preview">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">Lock screen preview</span>
            <div className="flex flex-wrap gap-1" role="tablist" aria-label="Language">
              {Object.keys(preview).map((key) => (
                <Button
                  key={key || "default"}
                  type="button"
                  role="tab"
                  aria-selected={key === locale}
                  size="xs"
                  variant={key === locale ? "default" : "outline"}
                  className="rounded-full px-2.5"
                  onClick={() => setLocale(key)}
                >
                  {key || "Default"}
                </Button>
              ))}
            </div>
          </div>

          <div
            className="relative overflow-hidden rounded-[2.25rem] border-[7px] border-slate-900 px-3.5 pt-4 pb-20 shadow-xl ring-1 ring-black/10 dark:border-slate-700"
            style={{
              background:
                "radial-gradient(125% 80% at 20% 0%, #2563eb 0%, #1e3a8a 45%, #0f172a 100%)",
            }}
          >
            <div className="mx-auto mb-5 h-5 w-24 rounded-full bg-black/80" aria-hidden="true" />
            <p className="text-center text-xs font-medium text-white/75">Monday, November 9</p>
            <p className="mb-7 text-center text-5xl font-light tracking-tight tabular-nums text-white">
              9:41
            </p>
            <div className="grid grid-cols-[38px_1fr] gap-3 rounded-2xl border border-white/30 bg-white/90 p-3.5 text-slate-900 shadow-lg backdrop-blur-md">
              <span className="grid size-9.5 place-items-center rounded-xl bg-primary text-white shadow-xs">
                <BellRing className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="flex items-center justify-between text-[11px] font-medium text-slate-500">
                  <span>EdgeBase</span>
                  <span>now</span>
                </p>
                <p
                  className={cn(
                    "mt-0.5 text-sm font-semibold leading-snug break-words",
                    !shown.title && "font-normal text-slate-400",
                  )}
                >
                  {shown.title || "Title"}
                </p>
                <p
                  className={cn(
                    "mt-0.5 text-xs leading-relaxed break-words text-slate-700",
                    !shown.body && "text-slate-400",
                  )}
                >
                  {shown.body || "Your notification message will appear here."}
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5">
            <Badge variant={category === "marketing" ? "warning" : "secondary"}>
              {category === "marketing" ? "Marketing" : "Transactional"}
            </Badge>
            <Badge variant="outline">{inbox ? "Push + Inbox" : "Push only"}</Badge>
            {sendAt && <Badge variant="default">Scheduled</Badge>}
          </div>

          <p className="text-xs text-pretty text-muted-foreground">
            Each user sees the language in their profile, or the default text. Topic pushes always
            use the default text.
          </p>
        </aside>
      </div>
    </>
  );
}
