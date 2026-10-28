import { Channel, invoke } from "@tauri-apps/api/core";
import type { BridgeEvent, PaneInputEvent, Surface } from "./protocol";

export interface Fingerprint {
  keyType: string;
  fingerprint: string;
}

/// The webview's handle on the Rust bridge. Each `connect` opens a fresh
/// channel, and events from an older one are dropped here, so a reconnect can
/// never be confused by what the previous connection was still delivering.
export class Daemon {
  private generation = 0;

  constructor(private readonly onEvent: (event: BridgeEvent) => void) {}

  /// Connects to this machine's daemon, or with `host`, to one over SSH.
  async connect(surface: Surface, host: string | null): Promise<void> {
    const generation = ++this.generation;
    const channel = new Channel<BridgeEvent>();
    channel.onmessage = (event) => {
      if (generation === this.generation) this.onEvent(event);
    };
    await invoke("connect", { surface, host, events: channel });
  }

  async disconnect(): Promise<void> {
    this.generation++;
    await invoke("disconnect");
  }

  resize(bootId: string, surface: Surface): Promise<void> {
    return invoke("resize", { bootId, surface });
  }

  setFocus(bootId: string, focused: boolean): Promise<void> {
    return invoke("set_focus", { bootId, focused });
  }

  sendInput(bootId: string, paneId: string, events: PaneInputEvent[]): Promise<void> {
    return invoke("send_input", { bootId, paneId, events });
  }

  sendPopupInput(bootId: string, terminalId: string, events: PaneInputEvent[]): Promise<void> {
    return invoke("send_popup_input", { bootId, terminalId, events });
  }

  /// The named hosts of `~/.ssh/config`.
  hosts(): Promise<string[]> {
    return invoke("ssh_hosts");
  }

  /// Fetches `host`'s keys; only the ones returned can then be trusted.
  scanHostKey(host: string): Promise<Fingerprint[]> {
    return invoke("scan_host_key", { host });
  }

  trustHostKey(host: string): Promise<void> {
    return invoke("trust_host_key", { host });
  }

  /// Resolves with the request ID once queued; the daemon's answer arrives
  /// later as a `response` event.
  request(bootId: string, method: string, params: Record<string, unknown>): Promise<string> {
    return invoke("request", { bootId, method, params });
  }
}
