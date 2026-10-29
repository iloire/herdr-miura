import { useState } from "react";

/// Inline rename: Enter saves, Escape or leaving cancels. An empty name is
/// not sent, so the name stays as it was.
export function RenameField({
  initial,
  className,
  label,
  onDone,
}: {
  initial: string;
  className: string;
  label: string;
  onDone: (label: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      className={className}
      aria-label={label}
      autoFocus
      value={value}
      maxLength={200}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => onDone(null)}
      // A press in the field places the cursor; it must not start a row drag.
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") onDone(value.trim() || null);
        else if (event.key === "Escape") onDone(null);
      }}
    />
  );
}
