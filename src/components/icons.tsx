// Small line icons for menus, 16 px in currentColor.

const LINE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      {children}
    </svg>
  );
}

export const CodeIcon = () => (
  <Icon>
    <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" {...LINE} />
  </Icon>
);

export const BranchIcon = () => (
  <Icon>
    <circle cx="4.5" cy="3.5" r="1.5" {...LINE} />
    <circle cx="4.5" cy="12.5" r="1.5" {...LINE} />
    <circle cx="11.5" cy="5" r="1.5" {...LINE} />
    <path d="M4.5 5v6M11.5 6.5c0 3-7 2-7 4.5" {...LINE} />
  </Icon>
);

export const OpenIcon = () => (
  <Icon>
    <path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" {...LINE} />
  </Icon>
);

export const CopyIcon = () => (
  <Icon>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" {...LINE} />
    <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" {...LINE} />
  </Icon>
);

export const CheckIcon = () => (
  <Icon>
    <path d="m3 8.5 3.25 3.25L13 5" {...LINE} />
  </Icon>
);

export const TerminalIcon = () => (
  <Icon>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" {...LINE} />
    <path d="m4.5 6 2 2-2 2M8.5 10h3" {...LINE} />
  </Icon>
);

/// Workspaces in the order you dragged them.
export const HandOrderIcon = () => (
  <Icon>
    <path d="M3 4.5h10M3 8h10M3 11.5h10" {...LINE} />
  </Icon>
);

/// Workspaces with what needs you on top.
export const AttentionOrderIcon = () => (
  <Icon>
    <path d="M3 4.5h10M3 8h7M3 11.5h4" {...LINE} />
  </Icon>
);

/// A pinned tab.
export const PinIcon = () => (
  <Icon>
    <path d="M10 2.5 13.5 6l-2 .75-2.25 2.25.25 3L8 13.5 2.5 8 4 6.5l3 .25L9.25 4.5Z M5.25 10.75 2.5 13.5" {...LINE} />
  </Icon>
);

/// A server listening on a port.
export const GlobeIcon = () => (
  <Icon>
    <circle cx="8" cy="8" r="6" {...LINE} />
    <path d="M2 8h12M8 2c-2 2-2 10 0 12M8 2c2 2 2 10 0 12" {...LINE} />
  </Icon>
);

/// A folder in the Files tree.
export const FolderIcon = () => (
  <Icon>
    <path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z" {...LINE} />
  </Icon>
);

/// A file in the Files tree.
export const FileIcon = () => (
  <Icon>
    <path d="M4 1.75h5L12.5 5.25v8a1 1 0 0 1-1 1h-7.5a1 1 0 0 1-1-1v-10.5a1 1 0 0 1 1-1ZM8.75 1.75v3.5h3.5M5.5 8.5h5M5.5 11h3.5" {...LINE} />
  </Icon>
);

/// A session `/loop` will run again.
export const LoopIcon = () => (
  <Icon>
    <path d="M13 8a5 5 0 1 1-1.46-3.54M9.25 4.6h2.4V2.2" {...LINE} />
  </Icon>
);

/// Claude's mark, beside its plan usage in the status bar.
export const ClaudeIcon = () => (
  <Icon>
    <path d="M8 2v12M2 8h12M3.75 3.75l8.5 8.5M12.25 3.75l-8.5 8.5" {...LINE} />
  </Icon>
);

export const TeamIcon = () => (
  <Icon>
    <circle cx="6" cy="5.5" r="2" {...LINE} />
    <circle cx="11.5" cy="6.5" r="1.5" {...LINE} />
    <path d="M2.5 13c0-2.2 1.6-3.5 3.5-3.5s3.5 1.3 3.5 3.5M10 9.8c.4-.2.9-.3 1.5-.3 1.4 0 2.5 1 2.5 2.8" {...LINE} />
  </Icon>
);

/// An hourglass: the prompt queue.
export const QueueIcon = () => (
  <Icon>
    <path d="M4 2.5h8M4 13.5h8M5 2.5c0 3 6 3.5 6 5.5s-6 2.5-6 5.5M11 2.5c0 3-6 3.5-6 5.5s6 2.5 6 5.5" {...LINE} />
  </Icon>
);

export const PauseIcon = () => (
  <Icon>
    <path d="M6 4v8M10 4v8" {...LINE} />
  </Icon>
);

export const PlayIcon = () => (
  <Icon>
    <path d="M5.5 3.5v9l7-4.5z" {...LINE} />
  </Icon>
);

/// A gear: the app's settings.
export const GearIcon = () => (
  <Icon>
    <path d="M12.64 6.43 14.35 6.62 14.35 9.38 12.64 9.57 12.39 10.17 13.47 11.52 11.52 13.47 10.17 12.39 9.57 12.64 9.38 14.35 6.62 14.35 6.43 12.64 5.83 12.39 4.48 13.47 2.53 11.52 3.61 10.17 3.36 9.57 1.65 9.38 1.65 6.62 3.36 6.43 3.61 5.83 2.53 4.48 4.48 2.53 5.83 3.61 6.43 3.36 6.62 1.65 9.38 1.65 9.57 3.36 10.17 3.61 11.52 2.53 13.47 4.48 12.39 5.83Z" {...LINE} />
    <circle cx="8" cy="8" r="2" {...LINE} />
  </Icon>
);
