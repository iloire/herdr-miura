import type { Controller } from "../app/controller";
import type { Snapshot } from "../protocol";
import { StatusDot } from "./Sidebar";

export function TabBar({
  controller,
  snapshot,
  changes,
}: {
  controller: Controller;
  snapshot: Snapshot | null;
  changes: boolean;
}) {
  const tabs = snapshot?.tabs.filter((tab) => tab.workspace_id === snapshot.focused_workspace_id) ?? [];
  return (
    <div className="tabbar" role="tablist" aria-label="Tabs">
      {tabs.map((tab) => (
        <div key={tab.tab_id} className="tab" role="tab" aria-selected={tab.focused}>
          <button
            className="tab-label"
            onClick={() => controller.request("tab.focus", { tab_id: tab.tab_id })}
            onAuxClick={(event) => event.button === 1 && controller.request("tab.close", { tab_id: tab.tab_id })}
          >
            <StatusDot status={tab.agent_status} />
            {tab.label}
            {tab.zoomed && <span className="tab-zoomed" title="Zoomed">⤢</span>}
          </button>
          <button
            className="tab-close"
            aria-label={`Close ${tab.label}`}
            title="Close tab"
            onClick={() => controller.request("tab.close", { tab_id: tab.tab_id })}
          >
            ×
          </button>
        </div>
      ))}
      <button
        className="icon-button"
        title="New tab"
        aria-label="New tab"
        disabled={!snapshot?.focused_workspace_id}
        onClick={() => controller.run("new_tab")}
      >
        +
      </button>
      <span className="tabbar-spacer" />
      <button
        className="icon-button changes-toggle"
        title="Changes"
        aria-label="Changes"
        aria-pressed={changes}
        onClick={() => controller.run("review_changes")}
      >
        ±
      </button>
    </div>
  );
}
