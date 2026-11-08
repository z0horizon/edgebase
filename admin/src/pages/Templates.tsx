import { Pencil, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/PageHeader";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage, type Template } from "@/lib/api";

const ANY = "any";
type Editing = { template: Template | null } | null;

export function TemplatesPage() {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<Template | null>(null);

  const load = useCallback(async () => {
    try {
      setTemplates((await api<{ templates: Template[] }>("/v1/templates")).templates);
    } catch (e) {
      setTemplates([]);
      toast.error(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const remove = async (template: Template) => {
    try {
      await api(`/v1/templates/${encodeURIComponent(template.name)}`, { method: "DELETE" });
      toast.success(`Deleted ${template.name}`);
      await load();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <>
      <PageHeader
        title="Templates"
        description="Reusable pushes, with {{name}} where a value changes and a translation per language."
      >
        <Button onClick={() => setEditing({ template: null })}>
          <Plus /> New template
        </Button>
      </PageHeader>

      {templates?.length === 0 && (
        <div className="grid place-items-center gap-3 rounded-lg border border-dashed p-12 text-center">
          <p className="text-muted-foreground">No templates yet. Save the pushes you send often.</p>
          <Button variant="outline" onClick={() => setEditing({ template: null })}>
            <Plus /> New template
          </Button>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {templates?.map((t) => (
          <Card key={t.name} className="gap-4">
            <CardHeader>
              <p className="font-mono text-xs text-muted-foreground">{t.name}</p>
              <CardTitle className="break-words">{t.title}</CardTitle>
              <CardDescription className="line-clamp-2 break-words">{t.body}</CardDescription>
              <CardAction>
                {t.category && (
                  <Badge variant="outline">
                    {t.category === "marketing" ? "Marketing" : "Transactional"}
                  </Badge>
                )}
              </CardAction>
            </CardHeader>
            <CardFooter className="mt-auto flex-wrap gap-2">
              <div className="mr-auto flex flex-wrap gap-1">
                {["Default", ...Object.keys(t.translations ?? {})].map((l) => (
                  <Badge key={l} variant="secondary">
                    {l}
                  </Badge>
                ))}
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Edit ${t.name}`}
                onClick={() => setEditing({ template: t })}
              >
                <Pencil />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Delete ${t.name}`}
                onClick={() => setDeleting(t)}
              >
                <Trash2 />
              </Button>
            </CardFooter>
          </Card>
        ))}
      </div>

      <TemplateDialog
        editing={editing}
        names={templates?.map((t) => t.name) ?? []}
        onClose={() => setEditing(null)}
        onSaved={load}
      />

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Scheduled pushes that used it keep their text.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => deleting && remove(deleting)}>
              Delete template
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function TemplateDialog({
  editing,
  names,
  onClose,
  onSaved,
}: {
  editing: Editing;
  names: string[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const template = editing?.template ?? null;
  const [category, setCategory] = useState(ANY);
  const [error, setError] = useState("");

  useEffect(() => {
    setCategory(template?.category ?? ANY);
    setError("");
  }, [template]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? template?.name ?? "");
    if (!template && names.includes(name)) {
      setError(`A template named ${name} already exists. Edit it instead.`);
      return;
    }
    const rawTranslations = String(form.get("translations") ?? "").trim();
    let translations: unknown;
    try {
      translations = rawTranslations ? JSON.parse(rawTranslations) : undefined;
    } catch {
      setError('Translations must be JSON, for example { "vi": { "title": "…", "body": "…" } }.');
      return;
    }
    try {
      await api(`/v1/templates/${encodeURIComponent(name)}`, {
        method: "PUT",
        body: {
          title: form.get("title"),
          body: form.get("body"),
          ...(category !== ANY && { category }),
          ...(translations !== undefined && { translations }),
          // The page has no field for data; keep what the API stored, since PUT replaces it all.
          ...(template?.data && { data: template.data }),
        },
      });
      toast.success(`Saved ${name}`);
      onClose();
      await onSaved();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog open={editing !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form className="grid gap-4" onSubmit={save} key={template?.name ?? "new"}>
          <DialogHeader>
            <DialogTitle>{template ? `Edit ${template.name}` : "New template"}</DialogTitle>
            <DialogDescription>
              Write {"{{name}}"} where a value goes; it is filled in when you send.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="t-name">Name</Label>
            <Input
              id="t-name"
              name="name"
              defaultValue={template?.name}
              disabled={template !== null}
              pattern="[a-z0-9_.\-]{1,64}"
              title="Lowercase letters, digits, dots, dashes and underscores"
              placeholder="order-shipped"
              spellCheck={false}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="t-title">Title</Label>
            <Input
              id="t-title"
              name="title"
              defaultValue={template?.title}
              maxLength={120}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="t-body">Message</Label>
            <Textarea id="t-body" name="body" defaultValue={template?.body} maxLength={500} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="t-kind">Kind</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger id="t-kind" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Choose when sending</SelectItem>
                <SelectItem value="transactional">Transactional</SelectItem>
                <SelectItem value="marketing">Marketing</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="t-translations">Translations (JSON, optional)</Label>
            <Textarea
              id="t-translations"
              name="translations"
              rows={5}
              spellCheck={false}
              className="font-mono text-xs"
              defaultValue={
                template?.translations ? JSON.stringify(template.translations, null, 2) : ""
              }
              placeholder={'{ "vi": { "title": "Đơn {{order}} đã gửi", "body": "Đang giao" } }'}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Save template</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
