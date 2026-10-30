import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { type ListeningPort, portRows } from "../app/ports";
import { GlobeIcon } from "./icons";

/// The globe an expanded workspace card shows while its servers listen,
/// however many: the numbers are in its tooltip and the card's Ports section.
export function PortsMark({ ports }: { ports: ListeningPort[] }) {
  if (ports.length === 0) return null;
  const lines = ports.map((port) => `:${port.port} ${port.process || "Server"}`);
  return (
    <span className="ports-mark" title={lines.join("\n")} aria-label={`Listening ports: ${lines.join(", ")}`}>
      <GlobeIcon />
    </span>
  );
}

/// A number that opens its page in the browser.
function PortButton({ port, children }: { port: ListeningPort; children: React.ReactNode }) {
  return (
    <button
      className="port"
      title={`${port.process || "Server"} on ${port.address}. Click to open ${port.url}`}
      onClick={(event) => {
        event.stopPropagation();
        void openUrl(port.url);
      }}
    >
      {children}
    </button>
  );
}

/// A globe and `:3000 :5173` after it, as herdr-gpui draws a workspace's
/// listening ports.
export function Ports({ ports }: { ports: ListeningPort[] }) {
  if (ports.length === 0) return null;
  return (
    <span className="ports" aria-label="Listening ports">
      <GlobeIcon />
      {ports.map((port) => (
        <PortButton key={port.port} port={port}>
          :{port.port}
        </PortButton>
      ))}
    </span>
  );
}

/// Each port with what serves it, for an expanded workspace card: a few at
/// most so a Docker stack cannot push the card down, then a way to the rest.
export function PortList({ ports }: { ports: ListeningPort[] }) {
  const [expanded, setExpanded] = useState(false);
  const { rows, more } = portRows(ports);
  return (
    <>
      <div className="card-ports">
        {(expanded ? ports : rows).map((port) => (
          <PortButton key={port.port} port={port}>
            :{port.port} {port.process && <small>{port.process}</small>}
          </PortButton>
        ))}
      </div>
      {more > 0 && (
        <button className="card-row card-row-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : `+${more} more`}
        </button>
      )}
    </>
  );
}
