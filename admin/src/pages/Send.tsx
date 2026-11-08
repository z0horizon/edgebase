import { BellRing, Send } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/PageHeader";
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
import { api, type Category, errorMessage, type Template, type Text } from "@/lib/api";
import { cn } from "@/lib/utils";

const NONE = "none";

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

// Preview only: the server fills placeholders for real and refuses missing ones.
const fill = (text: string, vars: Record<string, string>) =>
  text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, name: string) => vars[name] ?? match);

export function SendPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [target, setTarget] = useState<"users" | "topic">("users");
  const [userIds, setUserIds] = useState("");
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

  const template = templates.find((t) => t.name === templateName);

  // What each language will show; "" is the default text.
  const preview = useMemo(() => {
    const values = parseVars(vars);
    const base = template ?? { ...text, translations: {} };
    const texts: Record<string, Text> = { "": base, ...base.translations };
    return Object.fromEntries(
      Object.entries(texts).map(([key, t]) => [
        key,
        { title: fill(t.title, values), body: fill(t.body, values) },
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
    setBusy(true);
    try {
      const result = await api<{ id: number; users?: number; scheduled?: boolean }>("/v1/push", {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
        body: {
          to:
            target === "users"
              ? { userIds: userIds.split(/[\s,]+/).filter(Boolean) }
              : { topic: topic.trim() },
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
        <Card>
          <CardContent>
            <form className="grid gap-6" onSubmit={submit}>
              <fieldset className="grid gap-3">
                <legend className="mb-3 text-sm font-medium">Send to</legend>
                <RadioGroup
                  value={target}
                  onValueChange={(v) => setTarget(v as "users" | "topic")}
                  className="flex flex-wrap gap-x-6 gap-y-3"
                >
                  <Label className="font-normal">
                    <RadioGroupItem value="users" /> Chosen users
                  </Label>
                  <Label className="font-normal">
                    <RadioGroupItem value="topic" /> A topic
                  </Label>
                </RadioGroup>
                {target === "users" ? (
                  <Textarea
                    aria-label="User IDs"
                    placeholder="User IDs, one per line or comma-separated. Copy them from the Users page."
                    value={userIds}
                    onChange={(e) => setUserIds(e.target.value)}
                    spellCheck={false}
                    className="font-mono text-sm"
                    required
                  />
                ) : (
                  <Input
                    aria-label="Topic"
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    spellCheck={false}
                    required
                  />
                )}
              </fieldset>

              <div className="grid gap-2">
                <Label htmlFor="template">Template</Label>
                <Select value={templateName} onValueChange={chooseTemplate}>
                  <SelectTrigger id="template" className="w-full">
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
                    One <code>name=value</code> per line, for each {"{{name}}"} in the template.
                  </p>
                </div>
              ) : (
                <>
                  <div className="grid gap-2">
                    <Label htmlFor="title">Title</Label>
                    <Input
                      id="title"
                      maxLength={120}
                      value={text.title}
                      onChange={(e) => setText({ ...text, title: e.target.value })}
                      required
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="body">Message</Label>
                    <Textarea
                      id="body"
                      maxLength={500}
                      value={text.body}
                      onChange={(e) => setText({ ...text, body: e.target.value })}
                    />
                  </div>
                </>
              )}

              <fieldset className="grid gap-3">
                <legend className="mb-3 text-sm font-medium">Kind</legend>
                <RadioGroup
                  value={category}
                  onValueChange={(v) => setCategory(v as Category)}
                  className="flex flex-wrap gap-x-6 gap-y-3"
                >
                  <Label className="font-normal">
                    <RadioGroupItem value="transactional" /> Transactional
                  </Label>
                  <Label className="font-normal">
                    <RadioGroupItem value="marketing" /> Marketing, only to users who opted in
                  </Label>
                </RadioGroup>
              </fieldset>

              <div className="grid gap-4 sm:grid-cols-2">
                <Label className="font-normal">
                  <Checkbox checked={inbox} onCheckedChange={(v) => setInbox(v === true)} /> Also
                  add it to the inbox
                </Label>
                <div className="grid gap-2">
                  <Label htmlFor="sendAt">Send later (optional)</Label>
                  <Input
                    id="sendAt"
                    type="datetime-local"
                    value={sendAt}
                    onChange={(e) => setSendAt(e.target.value)}
                  />
                </div>
              </div>

              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <Button type="submit" disabled={busy} className="justify-self-start">
                <Send /> {sendAt ? "Schedule push" : "Send push"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <aside className="grid gap-3 lg:sticky lg:top-8" aria-label="Preview">
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Language">
            {Object.keys(preview).map((key) => (
              <Button
                key={key || "default"}
                type="button"
                role="tab"
                aria-selected={key === locale}
                size="sm"
                variant={key === locale ? "default" : "outline"}
                className="h-7 rounded-full px-3"
                onClick={() => setLocale(key)}
              >
                {key || "Default"}
              </Button>
            ))}
          </div>
          <div
            className="relative overflow-hidden rounded-[2rem] border-[6px] border-zinc-900 px-3 pt-14 pb-24 shadow-xl dark:border-zinc-700"
            style={{
              background: "radial-gradient(120% 70% at 20% 0%, #3b5bdb, transparent 70%), #16204a",
            }}
          >
            <p className="mb-6 text-center text-5xl font-light tracking-tight text-white/90">
              9:41
            </p>
            <div className="grid grid-cols-[36px_1fr] gap-3 rounded-2xl bg-white/85 p-3 text-zinc-900 backdrop-blur-md">
              <span className="grid size-9 place-items-center rounded-[10px] bg-zinc-900 text-white">
                <BellRing className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="flex justify-between text-xs text-zinc-500">
                  <span>EdgeBase</span>
                  <span>now</span>
                </p>
                <p
                  className={cn(
                    "text-sm font-semibold break-words",
                    !shown.title && "font-normal text-zinc-400",
                  )}
                >
                  {shown.title || "Title"}
                </p>
                <p className="text-sm break-words">{shown.body}</p>
              </div>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Each user sees the language in their profile, or the default text. Topic pushes always
            use the default text.
          </p>
        </aside>
      </div>
    </>
  );
}
