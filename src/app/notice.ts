import type { BridgeEvent } from "../protocol";

/// The tab (and pane) a notice came from, so clicking it goes there.
export interface NoticeTarget {
  workspaceId: string | null;
  tabId: string;
  paneId: string | null;
}

export interface NoticeState {
  notice: string | null;
  noticeTarget: NoticeTarget | null;
}

/// A notification's notice, with where it came from when it names a tab.
export function notifyNotice(event: Extract<BridgeEvent, { type: "notify" }>): NoticeState {
  return {
    notice: event.body ? `${event.title}: ${event.body}` : event.title,
    noticeTarget: event.tab_id ? { workspaceId: event.workspace_id, tabId: event.tab_id, paneId: event.pane_id } : null,
  };
}

/// A patch that replaces or clears the notice drops the old target with it,
/// so an error notice never leads to the tab of the notification before it.
export function withNoticeTarget<P extends Partial<NoticeState>>(patch: P): P {
  return "notice" in patch && !("noticeTarget" in patch) ? { ...patch, noticeTarget: null } : patch;
}
