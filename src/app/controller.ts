import { Daemon, type Fingerprint } from "../daemon";
import type { BridgeEvent, PaneInputEvent, Snapshot, Surface } from "../protocol";
import { Grid } from "../terminal/grid";
import { applyTheme } from "../themes/active";
import { HERDR_NIGHT, type NamedTheme } from "../themes/catalog";
import { parseShortcut, type KeyLike, matches, type Shortcut } from "../terminal/keys";
import { catalog, type CatalogEntry, IS_MAC, isWindowCommand, requestFor } from "./catalog";
import { focusAfterClose, withoutClosing } from "./closing";
import { stepWorkspace } from "./step";

export type Status =
  | { phase: "connecting" }
  | { phase: "connected"; serverVersion: string }
  | { phase: "disconnected"; reason: string };

/// A host whose key ssh does not know yet. `fingerprints` is null while
/// its keys are being fetched.
export interface HostKey {
  host: string;
  fingerprints: Fingerprint[] | null;
  error: string | null;
}

const HOST_STORAGE_KEY = "herdr-tauri.host";

function savedHost(): string | null {
  try {
    return localStorage.getItem(HOST_STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveHost(host: string | null): void {
  try {
    if (host) localStorage.setItem(HOST_STORAGE_KEY, host);
    else localStorage.removeItem(HOST_STORAGE_KEY);
  } catch {
    // Remembering the host is a convenience; the connection does not need it.
  }
}

export interface Command extends CatalogEntry {
  parsed: Shortcut[];
}

export interface State {
  status: Status;
  /// The SSH host attached to, or null for this machine's daemon.
  host: string | null;
  /// The named hosts of `~/.ssh/config`, offered in the host picker.
  hosts: string[];
  /// A host key waiting for the user to approve or decline it.
  hostKey: HostKey | null;
  snapshot: Snapshot | null;
  /// The latest local failure, such as a command the daemon refused. Never
  /// hides a disconnection: the status line shows `status` first.
  notice: string | null;
  title: string | null;
  sidebar: boolean;
  palette: boolean;
  /// The Changes panel is open.
  changes: boolean;
  /// The Files panel is open. It shares the drawer with Changes, so at most one is.
  files: boolean;
  /// The Queue panel is open, the third in the drawer.
  queue: boolean;
  /// It opened on its own, for a workspace with prompts queued, so it closes on its own too.
  queueAuto: boolean;
  fontSize: number;
  /// The theme on screen: chrome tokens on :root, terminal colors in the painter.
  theme: NamedTheme;
  commands: Command[];
}

/// Shortcuts beyond the catalog's defaults, the Option-arrows herdr-gpui
/// answers through Herdr's `[keys]`: Up and Down step through workspaces,
/// Left and Right through the focused workspace's tabs.
const EXTRA_SHORTCUTS: Record<string, string[]> = {
  next_tab: ["alt-right"],
  next_workspace: ["alt-down"],
  previous_tab: ["alt-left"],
  previous_workspace: ["alt-up"],
};

export const DEFAULT_FONT_SIZE = 13;

/// Owns the connection, the surface grid, and the state React renders. The
/// grid stays outside React state: the painter reads it on every frame.
export class Controller {
  readonly grid = new Grid();
  private state: State = {
    status: { phase: "connecting" },
    host: savedHost(),
    hosts: [],
    hostKey: null,
    snapshot: null,
    notice: null,
    title: null,
    sidebar: true,
    palette: false,
    changes: false,
    files: false,
    queue: false,
    queueAuto: false,
    fontSize: DEFAULT_FONT_SIZE,
    theme: HERDR_NIGHT,
    commands: [],
  };
  private listeners = new Set<() => void>();
  private frameListeners = new Set<(dirty: Set<number>) => void>();
  private surface: Surface | null = null;
  /// The daemon's latest snapshot; `state.snapshot` is it without `closing`.
  private daemonSnapshot: Snapshot | null = null;
  /// Tabs closed here that the daemon still lists.
  private closing = new Set<string>();
  /// Each `tab.close` request in flight, by request ID, to its tab.
  private closeRequests = new Map<string, string>();
  private readonly daemon = new Daemon((event) => this.handle(event));

  // State store, shaped for `useSyncExternalStore`.
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getState = () => this.state;

  onFrame(listener: (dirty: Set<number>) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  private set(patch: Partial<State>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /// Shows `theme` at once: the chrome, every pane's colors and the workspace hues.
  setTheme(theme: NamedTheme): void {
    if (theme === this.state.theme) return;
    applyTheme(theme);
    this.set({ theme });
  }

  loadCatalog(): void {
    const commands = catalog(IS_MAC).map((entry) => ({
      ...entry,
      parsed: [...entry.shortcuts, ...(EXTRA_SHORTCUTS[entry.name] ?? [])]
        .map(parseShortcut)
        .filter((s): s is Shortcut => s !== null),
    }));
    this.set({ commands });
  }

  /// Connects, or resizes the live connection, to the grid the view can show.
  async setSurface(surface: Surface): Promise<void> {
    const previous = this.surface;
    this.surface = surface;
    if (!previous) return this.connect();
    const bootId = this.state.snapshot?.boot_id;
    if (bootId && this.state.status.phase === "connected") {
      await this.daemon.resize(bootId, surface).catch((error) => this.notice(error));
    }
  }

  async connect(): Promise<void> {
    if (!this.surface) return;
    this.daemonSnapshot = null;
    this.closing.clear();
    this.closeRequests.clear();
    this.set({ status: { phase: "connecting" }, snapshot: null, notice: null });
    try {
      await this.daemon.connect(this.surface, this.state.host);
    } catch (error) {
      this.set({ status: { phase: "disconnected", reason: String(error) } });
    }
  }

  /// Replaces the connection with one to `host`, or to this machine's
  /// daemon with null. One host at a time.
  connectTo(host: string | null): Promise<void> {
    saveHost(host);
    this.set({ host, hostKey: null });
    return this.connect();
  }

  loadHosts(): void {
    this.daemon
      .hosts()
      .then((hosts) => this.set({ hosts }))
      .catch(() => {});
  }

  private async checkHostKey(host: string): Promise<void> {
    this.set({ hostKey: { host, fingerprints: null, error: null } });
    try {
      const fingerprints = await this.daemon.scanHostKey(host);
      if (this.state.hostKey?.host === host) this.set({ hostKey: { host, fingerprints, error: null } });
    } catch (error) {
      if (this.state.hostKey?.host === host) this.set({ hostKey: { host, fingerprints: null, error: String(error) } });
    }
  }

  /// Trusts the keys the dialog showed, then connects again.
  async trustHostKey(): Promise<void> {
    const hostKey = this.state.hostKey;
    if (!hostKey?.fingerprints) return;
    try {
      await this.daemon.trustHostKey(hostKey.host);
    } catch (error) {
      this.set({ hostKey: { ...hostKey, error: String(error) } });
      return;
    }
    this.set({ hostKey: null });
    if (this.state.host === hostKey.host) await this.connect();
  }

  dismissHostKey(): void {
    this.set({ hostKey: null });
  }

  async detach(): Promise<void> {
    await this.daemon.disconnect();
    this.set({ status: { phase: "disconnected", reason: "Detached. The daemon and its terminals keep running." } });
  }

  private handle(event: BridgeEvent): void {
    switch (event.type) {
      case "connected":
        this.set({ status: { phase: "connected", serverVersion: event.server_version } });
        break;
      case "snapshot": {
        this.daemonSnapshot = event.snapshot;
        const listed = new Set(event.snapshot.tabs.map((tab) => tab.tab_id));
        for (const tabId of this.closing) if (!listed.has(tabId)) this.closing.delete(tabId);
        this.showSnapshot();
        break;
      }
      case "frame": {
        const dirty = this.grid.apply(event);
        for (const listener of this.frameListeners) listener(dirty);
        break;
      }
      case "rejected":
        if (event.request_id) this.closeFailed(event.request_id);
        this.set({ notice: `Not sent: ${event.reason}` });
        break;
      case "response": {
        const error = (event.response as { error?: { message?: string } } | null)?.error;
        if (error) {
          this.closeFailed(event.request_id);
          this.set({ notice: error.message ?? "The daemon refused the request" });
        }
        this.closeRequests.delete(event.request_id);
        break;
      }
      case "shell_error":
        this.set({ notice: event.message });
        break;
      case "title":
        this.set({ title: event.title });
        break;
      case "notify":
        this.set({ notice: event.body ? `${event.title}: ${event.body}` : event.title });
        break;
      case "bell":
        break;
      case "version_mismatch":
        this.set({
          notice:
            event.outdated === "daemon"
              ? `Herdr ${event.server_version ?? ""} is too old for this client; update Herdr.`
              : `Herdr ${event.server_version ?? ""} is newer than this client; update herdr-gpui's crates.`,
        });
        break;
      case "unknown_host_key":
        void this.checkHostKey(event.host);
        break;
      case "disconnected":
        this.set({ status: { phase: "disconnected", reason: event.reason } });
        break;
    }
  }

  private notice(error: unknown): void {
    this.set({ notice: String(error) });
  }

  /// Sends to the popup when one is open, otherwise to `paneId` or the
  /// focused pane.
  sendInput(events: PaneInputEvent[], paneId?: string): void {
    const snapshot = this.state.snapshot;
    if (!snapshot || events.length === 0) return;
    const popup = this.grid.popup;
    const send = popup
      ? this.daemon.sendPopupInput(snapshot.boot_id, popup.terminal_id, events)
      : (() => {
          const target = paneId ?? snapshot.focused_pane_id ?? this.grid.panes.find((p) => p.focused)?.pane_id;
          return target ? this.daemon.sendInput(snapshot.boot_id, target, events) : Promise.resolve();
        })();
    send.catch((error) => this.notice(error));
  }

  /// Runs a window-side action, such as opening a folder, showing its failure
  /// in the status bar.
  act(action: Promise<unknown>): void {
    action.catch((error) => this.notice(error));
  }

  request(method: string, params: Record<string, unknown>): void {
    if (method === "tab.close") return this.closeTab(String(params.tab_id));
    void this.send(method, params);
  }

  /// The request's ID once queued, or null if it was not.
  private send(method: string, params: Record<string, unknown>): Promise<string | null> {
    const snapshot = this.state.snapshot;
    if (!snapshot) return Promise.resolve(null);
    return this.daemon.request(snapshot.boot_id, method, params).catch((error) => {
      this.notice(error);
      return null;
    });
  }

  /// Hides the tab at once and, if it is the focused one, focuses the tab
  /// Herdr would, so the terminal switches without waiting for the close.
  /// A close the daemon refuses brings the tab back.
  private closeTab(tabId: string): void {
    const tabs = this.state.snapshot?.tabs ?? [];
    const tab = tabs.find((t) => t.tab_id === tabId);
    if (!tab) return;
    const next = tab.focused ? focusAfterClose(tabs, tab) : null;
    if (next) void this.send("tab.focus", { tab_id: next.tab_id });
    this.closing.add(tabId);
    this.showSnapshot();
    void this.send("tab.close", { tab_id: tabId }).then((requestId) => {
      if (requestId) this.closeRequests.set(requestId, tabId);
      else this.reopen(tabId);
    });
  }

  private closeFailed(requestId: string): void {
    const tabId = this.closeRequests.get(requestId);
    this.closeRequests.delete(requestId);
    if (tabId) this.reopen(tabId);
  }

  private reopen(tabId: string): void {
    if (this.closing.delete(tabId)) this.showSnapshot();
  }

  private showSnapshot(): void {
    this.set({ snapshot: this.daemonSnapshot && withoutClosing(this.daemonSnapshot, this.closing) });
  }

  setWindowFocus(focused: boolean): void {
    const bootId = this.state.snapshot?.boot_id;
    if (bootId) this.daemon.setFocus(bootId, focused).catch(() => {});
  }

  /// A catalog shortcut for `event`, run if found. Returns whether it was.
  shortcut(event: KeyLike): boolean {
    const command = this.state.commands.find((c) => c.parsed.some((s) => matches(s, event)));
    if (!command) return false;
    this.run(command.name);
    return true;
  }

  run(name: string): void {
    switch (name) {
      case "command_palette":
        return this.set({ palette: !this.state.palette });
      case "add_to_queue":
        return this.set({ queue: !this.state.queue, queueAuto: false, changes: false, files: false });
      case "review_changes":
        return this.set({ changes: !this.state.changes, files: false, queue: false, queueAuto: false });
      case "browse_files":
        return this.set({ files: !this.state.files, changes: false, queue: false, queueAuto: false });
      case "toggle_sidebar":
        return this.set({ sidebar: !this.state.sidebar });
      case "increase_font_size":
        return this.set({ fontSize: Math.min(32, this.state.fontSize + 1) });
      case "decrease_font_size":
        return this.set({ fontSize: Math.max(8, this.state.fontSize - 1) });
      case "reset_font_size":
        return this.set({ fontSize: DEFAULT_FONT_SIZE });
      case "next_workspace":
      case "previous_workspace": {
        const snapshot = this.state.snapshot;
        const target =
          snapshot && stepWorkspace(snapshot.workspaces, snapshot.focused_workspace_id, name === "next_workspace" ? 1 : -1);
        if (target) this.request("workspace.focus", { workspace_id: target.workspace_id });
        return;
      }
      case "reconnect":
        void this.connect();
        return;
      case "detach":
        void this.detach();
        return;
    }
    const snapshot = this.state.snapshot;
    const request = snapshot && requestFor(name, snapshot);
    if (request) this.request(request.method, request.params);
  }

  isWindowCommand(name: string): boolean {
    return isWindowCommand(name);
  }

  /// Set by the terminal view, so closing an overlay hands typing back to it.
  focusTerminal: () => void = () => {};

  closeChanges(): void {
    this.set({ changes: false });
  }

  closeFiles(): void {
    this.set({ files: false });
  }

  openQueue(): void {
    this.set({ queue: true, queueAuto: false, changes: false, files: false });
  }

  closeQueue(): void {
    this.set({ queue: false, queueAuto: false });
  }

  /// Follows the focused workspace: its queue holding prompts opens the panel
  /// when the drawer is free, and one opened that way closes again once the
  /// focused workspace has none. A panel opened or closed by hand is left be.
  followQueue(busy: boolean): void {
    const { queue, queueAuto, changes, files } = this.state;
    if (busy && !queue && !changes && !files) this.set({ queue: true, queueAuto: true });
    else if (!busy && queue && queueAuto) this.set({ queue: false, queueAuto: false });
  }

  closePalette(): void {
    this.set({ palette: false });
  }
}
