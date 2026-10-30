/// A span of whole minutes as `12m`, `4h 30m`, `4d 11h`.
export function formatMinutes(minutes: number): string {
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

/// A span of milliseconds as `<1m`, or in `formatMinutes`' terms.
export function formatSpan(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  return minutes < 1 ? "<1m" : formatMinutes(minutes);
}

/// A moment in milliseconds as `Oct 30, 2:47 PM`, in the Mac's own format.
export function formatMoment(ms: number): string {
  return new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/// A Unix time as `5m ago`, `3h ago`, `2d ago`.
export function relativeTime(seconds: number): string {
  const minutes = Math.round((Date.now() / 1000 - seconds) / 60);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
