import { openUrl } from "@tauri-apps/plugin-opener";
import type { ListeningPort } from "../app/ports";
import { GlobeIcon } from "./icons";

/// The globe a workspace card shows while its servers listen, however many:
/// the numbers are in its tooltip and, once the workspace is focused, in the
/// status bar's `Ports`, so a long list never has to fit on a card.
export function PortsMark({ ports }: { ports: ListeningPort[] }) {
  if (ports.length === 0) return null;
  const lines = ports.map((port) => `:${port.port} ${port.process || "Server"}`);
  return (
    <span className="ports-mark" title={lines.join("\n")} aria-label={`Listening ports: ${lines.join(", ")}`}>
      <GlobeIcon />
    </span>
  );
}

/// A globe and `:3000 :5173` after it, as herdr-gpui draws a workspace's
/// listening ports; each number opens its page in the browser.
export function Ports({ ports }: { ports: ListeningPort[] }) {
  if (ports.length === 0) return null;
  return (
    <span className="ports" aria-label="Listening ports">
      <GlobeIcon />
      {ports.map((port) => (
        <button
          key={port.port}
          className="port"
          title={`${port.process || "Server"} on ${port.address}. Click to open ${port.url}`}
          onClick={(event) => {
            event.stopPropagation();
            void openUrl(port.url);
          }}
        >
          :{port.port}
        </button>
      ))}
    </span>
  );
}
