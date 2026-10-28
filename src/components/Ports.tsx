import { openUrl } from "@tauri-apps/plugin-opener";
import type { ListeningPort } from "../app/ports";
import { GlobeIcon } from "./icons";

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
