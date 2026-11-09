import { describe, expect, it } from "vitest";
import { notifyNotice, withNoticeTarget } from "../notice";

const note = { type: "notify" as const, title: "claude finished", body: "herdr tauri · 5" };

describe("notifyNotice", () => {
  it("keeps the tab and pane an agent's notification came from", () => {
    expect(notifyNotice({ ...note, workspace_id: "w1", tab_id: "t2", pane_id: "p3" })).toEqual({
      notice: "claude finished: herdr tauri · 5",
      noticeTarget: { workspaceId: "w1", tabId: "t2", paneId: "p3" },
    });
  });

  it("has nowhere to go for a notification without a tab", () => {
    expect(notifyNotice({ ...note, body: null, workspace_id: null, tab_id: null, pane_id: null })).toEqual({
      notice: "claude finished",
      noticeTarget: null,
    });
  });
});

describe("withNoticeTarget", () => {
  it("drops the old target when the notice is replaced or cleared", () => {
    expect(withNoticeTarget({ notice: "No commit abc in ~/code" })).toEqual({ notice: "No commit abc in ~/code", noticeTarget: null });
    expect(withNoticeTarget({ notice: null })).toEqual({ notice: null, noticeTarget: null });
  });

  it("keeps a target set with its notice, and leaves a patch without a notice alone", () => {
    const target = { workspaceId: "w1", tabId: "t2", paneId: null };
    expect(withNoticeTarget({ notice: "done", noticeTarget: target })).toEqual({ notice: "done", noticeTarget: target });
    expect(withNoticeTarget({ title: "x", noticeTarget: undefined })).toEqual({ title: "x", noticeTarget: undefined });
  });
});
