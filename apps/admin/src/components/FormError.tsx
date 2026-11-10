/** A form's error line, announced to screen readers; renders nothing without a message. */
export function FormError({ message }: { message: string }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive"
    >
      {message}
    </p>
  );
}
