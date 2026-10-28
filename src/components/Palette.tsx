import { useMemo, useState } from "react";
import type { Command, Controller } from "../app/controller";
import { shortcutLabel } from "../terminal/keys";

/// Every catalog command, filtered by what is typed. Window-only commands
/// this app does not have yet are left out rather than shown and refused.
export function Palette({ controller, commands }: { controller: Controller; commands: Command[] }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const matches = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return commands.filter((command) => {
      const label = command.label.toLowerCase();
      return words.every((word) => label.includes(word));
    });
  }, [commands, query]);
  const run = (command: Command | undefined) => {
    controller.closePalette();
    if (command) controller.run(command.name);
  };
  return (
    <div className="palette-backdrop" onMouseDown={() => controller.closePalette()}>
      <div className="palette" role="dialog" aria-label="Commands" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          className="palette-input"
          placeholder="Run a command"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") controller.closePalette();
            else if (event.key === "ArrowDown") setSelected((s) => Math.min(matches.length - 1, s + 1));
            else if (event.key === "ArrowUp") setSelected((s) => Math.max(0, s - 1));
            else if (event.key === "Enter") run(matches[selected]);
            else return;
            event.preventDefault();
          }}
        />
        <ul className="palette-list" role="listbox">
          {matches.slice(0, 60).map((command, index) => (
            <li
              key={command.name}
              role="option"
              aria-selected={index === selected}
              onMouseEnter={() => setSelected(index)}
              onClick={() => run(command)}
            >
              <span>{command.label}</span>
              {command.parsed[0] && <kbd>{shortcutLabel(command.parsed[0])}</kbd>}
            </li>
          ))}
          {matches.length === 0 && <li className="empty">No command matches “{query}”.</li>}
        </ul>
      </div>
    </div>
  );
}
