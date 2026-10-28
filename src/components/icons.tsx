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
