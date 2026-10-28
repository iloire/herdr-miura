import { Daemon, type CatalogEntry } from "../daemon";
import type { BridgeEvent, PaneInputEvent, Snapshot, Surface } from "../protocol";
import { Grid } from "../terminal/grid";
import { parseShortcut, type KeyLike, matches, type Shortcut } from "../terminal/keys";

export type Status =
  | { phase: "connecting" }
  | { phase: "connected"; serverVersion: string }
  | { phase: "disconnected"; reason: string };

export interface Command extends CatalogEntry {
  parsed: Shortcut[];
}

export interface State {
  status: Status;
  snapshot: Snapshot | null;
  /// The latest local failure, such as a command the daemon refused. Never
  /// hides a disconnection: the status line shows `status` first.
  notice: string | null;
  title: string | null;
  sidebar: boolean;
  palette: boolean;
  fontSize: number;
  commands: Command[];
}

/// Commands the window runs itself; the rest go to the daemon.
const WINDOW_COMMANDS = new Set([
  "command_palette",
  "decrease_font_size",
  "detach",
  "increase_font_size",
  "reconnect",
  "reset_font_size",
  "toggle_sidebar",
]);

export const DEFAULT_FONT_SIZE = 13;

/// Owns the connection, the surface grid, and the state React renders. The
/// grid stays outside React state: the painter reads it on every frame.
export class Controller {
  readonly grid = new Grid();
  private state: State = {
    status: { phase: "connecting" },
    snapshot: null,
    notice: null,
    title: null,
    sidebar: true,
    palette: false,
    fontSize: DEFAULT_FONT_SIZE,
    commands: [],
  };
  private listeners = new Set<() => void>();
  private frameListeners = new Set<(dirty: Set<number>) => void>();
  private surface: Surface | null = null;
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

  async loadCatalog(): Promise<void> {
    const entries = await this.daemon.catalog();
    const commands = entries.map((entry) => ({
      ...entry,
      parsed: entry.shortcuts.map(parseShortcut).filter((s): s is Shortcut => s !== null),
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
    this.set({ status: { phase: "connecting" }, snapshot: null, notice: null });
    try {
      await this.daemon.connect(this.surface);
    } catch (error) {
      this.set({ status: { phase: "disconnected", reason: String(error) } });
    }
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
      case "snapshot":
        this.set({ snapshot: event.snapshot });
        break;
      case "frame": {
        const dirty = this.grid.apply(event);
        for (const listener of this.frameListeners) listener(dirty);
        break;
      }
      case "rejected":
        this.set({ notice: `Not sent: ${event.reason}` });
        break;
      case "response": {
        const error = (event.response as { error?: { message?: string } } | null)?.error;
        if (error) this.set({ notice: error.message ?? "The daemon refused the request" });
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

  request(method: string, params: Record<string, unknown>): void {
    const snapshot = this.state.snapshot;
    if (!snapshot) return;
    this.daemon.request(snapshot.boot_id, method, params).catch((error) => this.notice(error));
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
      case "toggle_sidebar":
        return this.set({ sidebar: !this.state.sidebar });
      case "increase_font_size":
        return this.set({ fontSize: Math.min(32, this.state.fontSize + 1) });
      case "decrease_font_size":
        return this.set({ fontSize: Math.max(8, this.state.fontSize - 1) });
      case "reset_font_size":
        return this.set({ fontSize: DEFAULT_FONT_SIZE });
      case "reconnect":
        void this.connect();
        return;
      case "detach":
        void this.detach();
        return;
    }
    this.daemon.runCommand(name).catch((error) => this.notice(error));
  }

  isWindowCommand(name: string): boolean {
    return WINDOW_COMMANDS.has(name);
  }

  closePalette(): void {
    this.set({ palette: false });
  }
}
