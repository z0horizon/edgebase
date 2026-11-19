import { PLACEHOLDER } from "@edgebase/core/limits";

export const SEND_RECIPIENTS_KEY = "edgebase:send-recipients";

export function viewKeyFromHash<K extends string>(
  hash: string,
  views: Record<K, unknown>,
  fallback: K,
): K {
  const name = hash.startsWith("#") ? hash.slice(1) : hash;
  return Object.hasOwn(views, name) ? (name as K) : fallback;
}

// Preview only: the server fills placeholders for real and refuses missing ones.
export const fillPreview = (text: string, vars: Record<string, string>) =>
  text.replace(PLACEHOLDER, (match, name: string) =>
    Object.hasOwn(vars, name) ? (vars[name] ?? match) : match,
  );

export function clearSessionDrafts(storage: Pick<Storage, "removeItem">) {
  storage.removeItem(SEND_RECIPIENTS_KEY);
}

export function describeDevice(userAgent: string | null | undefined): string {
  const ua = userAgent?.trim();
  if (!ua) return "Unknown device";
  if (!ua.startsWith("Mozilla/")) return ua.slice(0, 64);
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua) && !/Chromium\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : null;
  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? ua.slice(0, 64);
}

export type NetworkFields = {
  ipAddress?: string | null | undefined;
  asn?: number | null | undefined;
  asOrganization?: string | null | undefined;
  country?: string | null | undefined;
  city?: string | null | undefined;
};

export function describeNetwork(net: NetworkFields): string {
  const location = [net.city, net.country].filter(Boolean).join(", ");
  const isp = net.asOrganization
    ? net.asn
      ? `${net.asOrganization} (AS${net.asn})`
      : net.asOrganization
    : net.asn
      ? `AS${net.asn}`
      : "";
  const parts = [location, isp, net.ipAddress ?? ""].filter(Boolean);
  return parts.join(" · ") || "Unknown network";
}

export function networkShifted(item: {
  asn?: number | null | undefined;
  country?: string | null | undefined;
  createdAsn?: number | null | undefined;
  createdCountry?: string | null | undefined;
}): boolean {
  const asnMoved = item.createdAsn != null && item.asn != null && item.createdAsn !== item.asn;
  const countryMoved =
    Boolean(item.createdCountry && item.country) && item.createdCountry !== item.country;
  return asnMoved || countryMoved;
}
