import { type CSSProperties, type PointerEvent, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Controller } from "../app/controller";
import { workspaceDirectory } from "../changes/counts";
import { agentRefusal, type Land, type LandStore, landing } from "../changes/land";
import { type Queue, workspaceFolder } from "../app/queue";
import { agentsByWorkspace, cardAgents, cardWantsOpen, loopTags, unseenDone, workspaceMarks } from "../app/attention";
import { loadSidebarView, type PlacedAgent, saveSidebarView, type SidebarViewState, statusSections } from "../app/agentsView";
import { hasGitLine, shownBranch } from "../app/gitLine";
import { colorKey, type HueSlot, workspaceHue } from "../app/hue";
import { pinKey, pinnedByWorkspace } from "../app/pins";
import { cardOpen, hasChevron, loadOpenCards, saveOpenCards, toggleCard } from "../app/openCards";
import type { Settings } from "../app/settings";
import { useAutoCards } from "../app/useAutoCards";
import { groupWorktrees, type Row, workspaceOn } from "../app/worktreeGroups";
import { groupNames, groupSections, loadCollapsed, renameGroup, saveCollapsed, workspaceGroups } from "../app/workspaceGroups";
import { filterTerms, matchesTerms, workspaceText } from "../app/workspaceFilter";
import { dropSlot, loadSort, moveIndex, saveSort, sortWorkspaces, type WorkspaceSort } from "../app/workspaceOrder";
import type { ListeningPort } from "../app/ports";
import type { Worktree } from "../changes/worktrees";
import type { Agent, AgentStatus, Snapshot, Tab, Workspace } from "../protocol";
import { AgentsView, type ClosedAsks } from "./AgentsView";
import { AttentionRows, CardDetails, type LandAction } from "./CardDetails";
import { colorSwatches } from "./colorSwatches";
import { ContextMenu, type MenuAt, type MenuItem } from "./ContextMenu";
import { folderMenu } from "./folderMenu";
import { GitAhead, GitBehind, GitChanged } from "./GitCounts";
import { LandDialog, LandNote } from "./Land";
import { LoopMark } from "./LoopMark";
import {
  AttentionOrderIcon,
  CheckIcon,
  ChevronIcon,
  FolderIcon,
  HandOrderIcon,
  PinIcon,
  QueueIcon,
  RenameIcon,
  SearchIcon,
  TeamIcon,
} from "./icons";
import { PortsMark } from "./Ports";
import { QueueChip } from "./QueueChip";
import { RenameField } from "./RenameField";
import { Worktrees } from "./Worktrees";
import { StatusMark } from "./StatusMark";
import { TeamSection } from "./TeamSection";
import { createTeam, type TeamState, useTeams } from "../app/team";

const NO_LANDS: ReadonlyMap<string, Land> = new Map();
const noLands = () => NO_LANDS;
const noSubscription = () => () => {};

export function Sidebar({
  controller,
  title,
  fullTitle,
  snapshot,
  changedFiles,
  worktrees,
  onOpenWorktrees,
  queues,
  onOpenQueue,
  pins,
  ports,
  rootOf,
  lands,
  onMarkSeen,
  slots,
  onChooseColor,
  onMoveColor,
  groups,
  onSetGroups,
  cards,
  showAgents,
  findAsked,
  switchViewAsked,
  closedAsks,
}: {
  controller: Controller;
  /// The app's name, over the list, and the window's title on hover.
  title: string;
  fullTitle: string;
  snapshot: Snapshot | null;
  /// Files changed in each workspace's checkout, by workspace id; absent when none.
  changedFiles: Map<string, number>;
  /// Linked worktrees of each workspace's checkout, by workspace id; absent when none.
  worktrees: Map<string, Worktree[]>;
  /// Opens the details of a workspace's worktrees.
  onOpenWorktrees: (workspaceId: string) => void;
  /// Each workspace's prompt queue, by workspace id; absent when it has none.
  queues: Map<string, Queue>;
  /// Opens a workspace's prompt queue.
  onOpenQueue: (workspaceId: string) => void;
  /// Pinned tabs, as `pinKey`s.
  pins: Set<string>;
  /// Ports each workspace's servers listen on, by workspace id; absent when none.
  ports: Map<string, ListeningPort[]>;
  /// A workspace's fixed root; null when it has none yet or on a remote host.
  rootOf: (workspace: Workspace) => string | null;
  /// Landing worktrees; `null` on a remote host, whose worktrees are not on this Mac.
  lands: LandStore | null;
  /// Clears these finished agents' marks in this window.
  onMarkSeen: (agents: Agent[]) => void;
  /// Each workspace's chosen color, by workspace id; absent when automatic.
  slots: ReadonlyMap<string, HueSlot>;
  /// Chooses the color of the workspace on this folder; `null` is automatic.
  onChooseColor: (key: string, slot: HueSlot | null) => void;
  /// Keeps a chosen color with a workspace whose name changed.
  onMoveColor: (from: string, to: string, slot: HueSlot) => void;
  /// Each workspace's sidebar group, by `colorKey`.
  groups: Settings["workspaceGroups"];
  /// Puts workspaces in groups, by `colorKey`; `null` takes one out.
  onSetGroups: (entries: [string, string | null][]) => void;
  /// What every card shows.
  cards: Settings["workspaceCards"];
  /// Offers the Agents tab, every active agent by status (`ui.sidebar_agents`).
  showAgents: boolean;
  /// Counts the asks to find a workspace (⌘⇧F): each new one opens the filter and puts the cursor in it.
  findAsked: number;
  /// Counts the asks to switch between the Workspaces and Agents tabs (⌘⇧G).
  switchViewAsked: number;
  /// What waits on you from closed sessions, listed with the agents that need you.
  closedAsks: ClosedAsks;
}) {
  const landsByRepo = useSyncExternalStore(lands?.subscribe ?? noSubscription, lands?.getState ?? noLands);
  const [sort, setSort] = useState(loadSort);
  // The team file sits in the workspace's own folder, not wherever its active tab has wandered.
  const folderOf = (workspace: Workspace) => (snapshot && (rootOf(workspace) ?? workspaceFolder(workspace, snapshot))) || null;
  const rows = groupWorktrees(
    sortWorkspaces(snapshot?.workspaces ?? [], sort, snapshot?.agents ?? []),
    folderOf,
    (workspace) => worktrees.get(workspace.workspace_id) ?? [],
  );
  const workspaces = rows.map((row) => row.workspace);
  const agents = snapshot ? agentsByWorkspace(snapshot) : new Map<string, Agent[]>();
  // The Agents tab: the same agents as the cards, by status, in the sidebar's order.
  const placed: PlacedAgent[] = showAgents
    ? rows.flatMap(({ workspace }) =>
        cardAgents(agents.get(workspace.workspace_id) ?? []).map((agent) => ({
          agent,
          workspaceId: workspace.workspace_id,
          label: workspace.label,
          hue: workspaceHue(workspace, slots),
        })),
      )
    : [];
  const statuses = statusSections(placed);
  const askingClosed = showAgents ? closedAsks.outcomes.length : 0;
  const [viewState, setViewState] = useState(loadSidebarView);
  const changeView = (change: (state: SidebarViewState) => SidebarViewState) =>
    setViewState((state) => {
      const next = change(state);
      saveSidebarView(next);
      return next;
    });
  const showView = (next: SidebarViewState["view"]) => changeView((state) => ({ ...state, view: next }));
  const view = showAgents ? viewState.view : "workspaces";
  const needsYouCount = statuses.needsYou.length + askingClosed;
  // Groups by hand only: sorting by attention answers "what needs me", so the list goes flat.
  const groupOf = sort === "manual" ? workspaceGroups(rows, rootOf, groups) : new Map<string, string>();
  // The filter: null while closed. Typing narrows the list to the workspaces
  // whose name, folder, branch, tabs or agents hold every word.
  const [filter, setFilter] = useState<string | null>(null);
  const filterField = useRef<HTMLInputElement>(null);
  const openFilter = () => {
    setFilter((current) => current ?? "");
    requestAnimationFrame(() => filterField.current?.select());
  };
  const closeFilter = () => {
    setFilter(null);
    controller.focusTerminal();
  };
  useEffect(() => {
    if (findAsked === 0) return;
    // Finding a workspace means the workspaces.
    showView("workspaces");
    openFilter();
    // Only a new ask opens it, not a render.
  }, [findAsked]);
  useEffect(() => {
    if (switchViewAsked > 0 && showAgents) changeView((state) => ({ ...state, view: state.view === "agents" ? "workspaces" : "agents" }));
    // Only a new ask switches, not a render.
  }, [switchViewAsked]);
  const terms = filterTerms(filter ?? "");
  const filtering = terms.length > 0;
  const matching = filtering && snapshot ? rows.filter(({ workspace }) => matchesTerms(workspaceText(workspace, snapshot, folderOf(workspace)), terms)) : rows;
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const fold = (next: Set<string>) => {
    setCollapsed(next);
    saveCollapsed(next);
  };
  const sections = groupSections(matching, groupOf).map((section) => {
    // A match shows even in a folded group: it is what you are looking for.
    const folded = !filtering && section.name !== null && collapsed.has(section.name);
    // A folded group hides every row; its header's icons say what waits inside.
    const shown = folded ? [] : section.rows;
    return { ...section, folded, shown };
  });
  const shownRows = sections.flatMap((section) => section.shown);
  const shownWorkspaces = shownRows.map((row) => row.workspace);
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null);
  /// The workspace key a New Group… is being named for.
  const [newGroupFor, setNewGroupFor] = useState<string | null>(null);
  // Rows are dragged where they show, but Herdr moves workspaces in its own
  // list, which keeps worktrees wherever they were opened: translate both.
  const drag = useRowDrag(sort === "manual" && !filtering, (from, slot) => {
    const daemon = snapshot?.workspaces ?? [];
    const workspace = shownWorkspaces[from];
    const at = (shown: Workspace | undefined) => (shown ? daemon.indexOf(shown) : daemon.length);
    const index = workspace ? moveIndex(at(workspace), at(shownWorkspaces[slot])) : null;
    if (workspace && index !== null) {
      controller.request("workspace.move", { workspace_id: workspace.workspace_id, insert_index: index });
    }
  });
  const toggleSort = () => {
    const next: WorkspaceSort = sort === "manual" ? "attention" : "manual";
    setSort(next);
    saveSort(next);
  };
  const [openCards, setOpenCards] = useState(loadOpenCards);
  const automatic = cards.details === "auto";
  const autoCards = useAutoCards(
    new Map(automatic ? workspaces.map((workspace) => [workspace.workspace_id, cardWantsOpen(agents.get(workspace.workspace_id) ?? [])]) : []),
  );
  const toggleOpen = (workspaceId: string) => {
    if (automatic) return autoCards.toggle(workspaceId);
    const next = toggleCard(openCards, workspaceId, workspaces.map((workspace) => workspace.workspace_id));
    setOpenCards(next);
    saveOpenCards(next);
  };
  const pinned = pinnedByWorkspace(snapshot?.tabs ?? [], (tab) => pins.has(pinKey(snapshot?.boot_id ?? "", tab.tab_id)));
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [teamVersion, setTeamVersion] = useState(0);
  // New team writes the starter team, then shows it: the workspace takes focus and its file is read again.
  const newTeam = (workspaceId: string, folder: string): MenuItem => ({
    label: "New Team",
    icon: <TeamIcon />,
    onSelect: () => {
      controller.request("workspace.focus", { workspace_id: workspaceId });
      controller.act(createTeam(folder).then(() => setTeamVersion((v) => v + 1)));
    },
  });
  const folders = [...new Set(workspaces.map(folderOf).filter((folder) => folder !== null))].sort();
  const teams = useTeams(folders, teamVersion);
  const teamOf = (workspace: Workspace): TeamState => teams.get(folderOf(workspace) ?? "") ?? { phase: "none" };
  const focused = workspaces.find((workspace) => workspace.focused);
  const focusedFolder = focused && folderOf(focused);
  const asking = [...landsByRepo].find(([, land]) => land.phase === "asking");
  const card = ({ workspace, parent }: Row, index: number) => {
      const own = agents.get(workspace.workspace_id) ?? [];
      const listed = cardAgents(own);
      const path = snapshot && (rootOf(workspace) ?? workspaceDirectory(workspace, snapshot));
      const marks = workspaceMarks(own, workspace.agent_status);
      const needsYou = marks.some((mark) => mark.status === "blocked");
      const colored = slots.has(workspace.workspace_id);
      const listening = ports.get(workspace.workspace_id) ?? [];
      const trees = worktrees.get(workspace.workspace_id) ?? [];
      const pinnedTabs = pinned.get(workspace.workspace_id) ?? [];
      const queue = queues.get(workspace.workspace_id) ?? null;
      const openQueue = () => onOpenQueue(workspace.workspace_id);
      // A card with nothing more to show has nothing to open.
      const expandable = listed.length + trees.length + listening.length + pinnedTabs.length > 0 || shownBranch(workspace.branch) !== null;
      const open = cardOpen(cards.details, expandable, automatic ? autoCards.shown(workspace.workspace_id) : openCards.has(workspace.workspace_id));
      const focus = () => {
        if (drag.consumeClick()) return;
        controller.request("workspace.focus", { workspace_id: workspace.workspace_id });
      };
      const openWorktrees = () => onOpenWorktrees(workspace.workspace_id);
      const land: LandAction | null = lands && {
        busy: (worktree) => landing(landsByRepo.get(worktree.repo)),
        // Read when asked, not from this render: it is asked again after a long check.
        start: (worktree) =>
          void lands.ask(workspace.workspace_id, worktree, () =>
            agentRefusal(worktree.path, controller.getState().snapshot),
          ),
      };
      const landed = [...landsByRepo].find(([, land]) => land.card === workspace.workspace_id);
      const gitLine = (
        <WorkspaceGit
          // A collapsed card is one line, so its branch waits in the name's tooltip.
          branch={open ? workspace.branch : null}
          aheadBehind={cards.gitStatus ? workspace.git_ahead_behind : null}
          changed={cards.gitStatus ? (changedFiles.get(workspace.workspace_id) ?? 0) : 0}
          worktrees={trees}
          onOpenWorktrees={openWorktrees}
        />
      );
      // The name line's end: everything that fits beside the name while collapsed.
      const headEnd = (
        <>
          {open ? (
            <PortsMark ports={listening} />
          ) : (
            <>
              {gitLine}
              <QueueChip queue={queue} onOpen={openQueue} />
              <PinnedTabs tabs={pinnedTabs} />
              <LoopMark tags={loopTags(own)} />
            </>
          )}
          {cards.agentStatus && <AgentTally agents={own} marks={marks} />}
        </>
      );
      return (
        <li
          key={workspace.workspace_id}
          className={[drag.rowClass(index, shownWorkspaces.length), parent && "worktree-child"].filter(Boolean).join(" ") || undefined}
        >
          {/* A worktree hangs off its main checkout's card. */}
          {parent && <span className="worktree-link" aria-hidden="true" />}
          <div
            className={["workspace", workspace.focused && "current", needsYou && "needs-you", colored && "colored", filtering && index === 0 && "filter-first"].filter(Boolean).join(" ")}
            style={colored ? ({ "--hue": workspaceHue(workspace, slots) } as CSSProperties) : undefined}
            title={parent ? `A worktree of ${parent.label}` : undefined}
            {...drag.handlers(index)}
            onContextMenu={(event) => {
              event.preventDefault();
              const folder = folderOf(workspace);
              const rename: MenuItem = {
                label: "Rename…",
                icon: <RenameIcon />,
                onSelect: () => setRenaming(workspace.workspace_id),
              };
              // The agents as they stand now: one that finishes again before
              // the pick has a new sequence, so its mark stays.
              const finished = unseenDone(own);
              const markSeen: MenuItem = {
                label: "Mark as Seen",
                icon: <CheckIcon />,
                // Stays when there is nothing to mark, so the rows below don't jump.
                disabled: finished.length === 0,
                onSelect: () => onMarkSeen(finished),
              };
              // A worktree wears its main checkout's color, and only a local
              // workspace has a root to keep the choice under.
              const root = rootOf(workspace);
              const colors = root !== null && !parent ? [colorSwatches("Workspace color", "Automatic", slots.get(workspace.workspace_id) ?? null, (slot) => onChooseColor(colorKey(root, workspace.label), slot))] : [];
              const key = root !== null && !parent ? colorKey(root, workspace.label) : null;
              const current = groupOf.get(workspace.workspace_id) ?? null;
              // A worktree goes where its main checkout goes, and a remote one has no key to keep.
              const move: MenuItem[] =
                key === null || sort !== "manual"
                  ? []
                  : [
                      {
                        label: "Move to Group",
                        items: [
                          groupNames(groups).map((name) => ({
                            label: name,
                            icon: name === current ? <CheckIcon /> : undefined,
                            disabled: name === current,
                            onSelect: () => onSetGroups([[key, name]]),
                          })),
                          [
                            { label: "New Group…", onSelect: () => setNewGroupFor(key) },
                            ...(current === null ? [] : [{ label: "Remove from Group", onSelect: () => onSetGroups([[key, null]]) }]),
                          ],
                        ],
                      },
                    ];
              const items = [[rename, markSeen, ...colors, ...move]];
              if (path && folder) {
                const queue: MenuItem = {
                  label: "Add to Queue…",
                  icon: <QueueIcon />,
                  onSelect: () => onOpenQueue(workspace.workspace_id),
                };
                items.push([newTeam(workspace.workspace_id, folder), queue], folderMenu(controller, path));
              }
              setMenu({ x: event.clientX, y: event.clientY, items });
            }}
          >
            {/* While its name is edited the card is a plain box: a field cannot sit in a button. */}
            {renaming === workspace.workspace_id ? (
              <div className="workspace-main">
                <span className="workspace-head">
                  <RenameField
                    className="workspace-rename"
                    label="Workspace name"
                    initial={workspace.label}
                    onDone={(label) => {
                      setRenaming(null);
                      controller.focusTerminal();
                      if (label !== null && label !== workspace.label) {
                        controller.request("workspace.rename", { workspace_id: workspace.workspace_id, label });
                        const root = rootOf(workspace);
                        const slot = slots.get(workspace.workspace_id);
                        if (root !== null && slot && !parent) onMoveColor(colorKey(root, workspace.label), colorKey(root, label), slot);
                    const group = root !== null && !parent ? groups[colorKey(root, workspace.label)] : undefined;
                    if (root !== null && group) onSetGroups([[colorKey(root, label), group], [colorKey(root, workspace.label), null]]);
                      }
                    }}
                  />
                  {headEnd}
                </span>
                {open && gitLine}
              </div>
            ) : (
              <button
                className="workspace-main"
                aria-current={workspace.focused ? "true" : undefined}
                onClick={focus}
                onDoubleClick={() => setRenaming(workspace.workspace_id)}
              >
                <span className="workspace-head">
                  <span className="workspace-label" title={[path, shownBranch(workspace.branch)].filter(Boolean).join("\n") || undefined}>
                    {workspace.label}
                  </span>
                  {headEnd}
                </span>
                {open && gitLine}
              </button>
            )}
            {/* Beside the card's button, not in it, as is everything below:
                a row can be a button of its own. */}
            {expandable && hasChevron(cards.details) && (
              <button
                className="workspace-chevron"
                title={open ? "Hide details" : "Show details"}
                aria-label={`${open ? "Hide" : "Show"} details of ${workspace.label}`}
                aria-expanded={open}
                onClick={() => toggleOpen(workspace.workspace_id)}
              >
                <ChevronIcon />
              </button>
            )}
            {snapshot &&
              (open ? (
                <>
                  <div className="workspace-tray" onClick={focus}>
                    <QueueChip queue={queue} onOpen={openQueue} />
                    <PinnedTabs tabs={pinnedTabs} />
                    <LoopMark tags={loopTags(own)} />
                  </div>
                  <CardDetails
                    controller={controller}
                    snapshot={snapshot}
                    agents={listed}
                    worktrees={trees}
                    ports={listening}
                    openOn={(worktree) => workspaceOn(worktree, workspaces, folderOf)}
                    onOpenWorktrees={openWorktrees}
                    land={land}
                  />
                </>
              ) : (
                <AttentionRows
                  controller={controller}
                  snapshot={snapshot}
                  agents={own}
                  onExpand={cards.details === "never" ? null : () => toggleOpen(workspace.workspace_id)}
                />
              ))}
            {landed && <LandNote land={landed[1]} onDismiss={() => lands?.dismiss(landed[0])} />}
          </div>
        </li>
      );
  };
  // A group's header: a click folds or unfolds it, and folded it carries its
  // workspaces' agent tally, so nothing waiting on you goes unseen.
  const groupHead = (name: string, members: Row[], folded: boolean) => {
    const own = members.flatMap((row) => agents.get(row.workspace.workspace_id) ?? []);
    const marks = workspaceMarks(own, "unknown");
    const toggle = () => {
      const next = new Set(collapsed);
      if (!next.delete(name)) next.add(name);
      fold(next);
    };
    const names = [...new Set(groupOf.values())];
    return (
      <li
        key={`group:${name}`}
        className={["group-head", folded && "folded"].filter(Boolean).join(" ")}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({
            x: event.clientX,
            y: event.clientY,
            items: [
              [
                { label: "Show Only This Group", onSelect: () => fold(new Set(names.filter((other) => other !== name))) },
                { label: "Show All Groups", disabled: collapsed.size === 0, onSelect: () => fold(new Set()) },
              ],
              [
                { label: "Rename Group…", icon: <RenameIcon />, onSelect: () => setRenamingGroup(name) },
                { label: "Ungroup", hint: "Workspaces stay open", onSelect: () => onSetGroups(renameGroup(groups, name, null)) },
              ],
            ],
          });
        }}
      >
        {renamingGroup === name ? (
          <RenameField
            className="group-rename"
            label="Group name"
            initial={name}
            onDone={(label) => {
              setRenamingGroup(null);
              controller.focusTerminal();
              if (label === null || label === name) return;
              onSetGroups(renameGroup(groups, name, label));
              if (collapsed.has(name)) fold(new Set([...collapsed].filter((other) => other !== name).concat(label)));
            }}
          />
        ) : (
          <button className="group-toggle" aria-expanded={!folded} title={folded ? "Show this group" : "Hide this group"} onClick={toggle}>
            <ChevronIcon />
            {folded && <FolderIcon />}
            <span className="group-name">{name}</span>
            {folded && <span className="group-hidden">{members.length} hidden</span>}
          </button>
        )}
        {folded && cards.agentStatus && <AgentTally agents={own} marks={marks} />}
      </li>
    );
  };
  return (
    <nav className={view === "agents" ? "sidebar agents-tab" : "sidebar"} aria-label="Workspaces">
      <div className="sidebar-brand" title={fullTitle} data-tauri-drag-region>
        <span data-tauri-drag-region>{title}</span>
      </div>
      <header className="sidebar-head">
        {showAgents ? (
          <div className="sidebar-tabs" role="tablist" aria-label="Sidebar view">
            <button
              role="tab"
              className="sidebar-tab"
              aria-selected={view === "workspaces"}
              title="Workspaces by folder (⌘⇧G switches)"
              onClick={() => showView("workspaces")}
            >
              Workspaces
            </button>
            <button
              role="tab"
              className="sidebar-tab"
              aria-selected={view === "agents"}
              title="Agents by status (⌘⇧G switches)"
              onClick={() => showView("agents")}
            >
              Agents
              {needsYouCount > 0 && <StatusMark status="blocked" count={needsYouCount} />}
            </button>
          </div>
        ) : (
          <span>Workspaces</span>
        )}
        {view === "workspaces" && (
          <>
            <button
              className="icon-button sidebar-search"
              title="Find a workspace (⌘⇧F)"
              aria-label="Find a workspace"
              aria-pressed={filter !== null}
              onClick={() => (filter === null ? openFilter() : closeFilter())}
            >
              <SearchIcon />
            </button>
            <button
              className="icon-button sort-toggle"
              title={sort === "manual" ? "Sorted by hand. Click to sort by attention" : "Sorted by attention. Click to sort by hand"}
              aria-label={sort === "manual" ? "Sort by attention" : "Sort by hand"}
              aria-pressed={sort === "attention"}
              onClick={toggleSort}
            >
              {sort === "manual" ? <HandOrderIcon /> : <AttentionOrderIcon />}
            </button>
          </>
        )}
        <button
          className="icon-button"
          title="New workspace"
          aria-label="New workspace"
          disabled={!snapshot}
          // Typing goes to the workspace this opens: the press must not take
          // focus from the terminal.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => controller.run("new_workspace")}
        >
          +
        </button>
      </header>
      {view === "workspaces" && (
        <>
          {filter !== null && (
            <div className="workspace-filter">
              <input
                ref={filterField}
                aria-label="Find a workspace"
                placeholder="Name, folder, branch, tab or agent"
                autoFocus
                spellCheck={false}
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                // An empty field has nothing to keep it open.
                onBlur={() => filter === "" && setFilter(null)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    closeFilter();
                  } else if (event.key === "Enter") {
                    // Enter goes to the first match, the one marked in the list.
                    event.preventDefault();
                    const first = shownWorkspaces[0];
                    if (!first) return;
                    controller.request("workspace.focus", { workspace_id: first.workspace_id });
                    closeFilter();
                  }
                }}
              />
            </div>
          )}
          <ol
            className={["workspace-list", cards.compact && "compact", !hasChevron(cards.details) && "no-chevrons"].filter(Boolean).join(" ")}
            ref={drag.list}
          >
            {newGroupFor !== null && (
              <li className="group-head">
                <RenameField
                  className="group-rename"
                  label="New group name"
                  initial=""
                  onDone={(name) => {
                    setNewGroupFor(null);
                    controller.focusTerminal();
                    if (name !== null) onSetGroups([[newGroupFor, name]]);
                  }}
                />
              </li>
            )}
            {sections.flatMap((section) => {
              const head = section.name === null ? [] : [groupHead(section.name, section.rows, section.folded)];
              return [...head, ...section.shown.map((row) => card(row, shownRows.indexOf(row)))];
            })}
          </ol>
          {snapshot && workspaces.length === 0 && <p className="empty">No workspaces. Press + to open one.</p>}
          {snapshot && workspaces.length > 0 && filtering && matching.length === 0 && <p className="empty">No workspace matches.</p>}
        </>
      )}
      {snapshot && view === "agents" && (
        <AgentsView
          controller={controller}
          snapshot={snapshot}
          sections={statuses}
          closed={closedAsks}
          doneFolded={viewState.doneFolded}
          onFoldDone={(doneFolded) => changeView((state) => ({ ...state, doneFolded }))}
        />
      )}
      {snapshot && focused && focusedFolder && (
        <TeamSection
          controller={controller}
          snapshot={snapshot}
          workspace={focused}
          hue={workspaceHue(focused, slots)}
          directory={focusedFolder}
          team={teamOf(focused)}
        />
      )}
      {menu && <ContextMenu menu={menu} onClose={closeMenu} />}
      {asking?.[1].phase === "asking" && (
        <LandDialog
          plan={asking[1].plan}
          path={asking[1].worktree.path}
          openIn={workspaceOn(asking[1].worktree, workspaces, folderOf)?.label ?? null}
          onCancel={() => lands?.cancel(asking[0])}
          onConfirm={() => void lands?.confirm(asking[0])}
        />
      )}
    </nav>
  );
}

/// Pointer travel before a press on a row becomes a drag rather than a click.
const DRAG_THRESHOLD = 4;

/// Dragging rows of a list into a new order, by pointer rather than HTML drag
/// and drop, which Tauri's file-drop handling swallows. While it runs, the
/// dragged row dims and a line marks the gap it would land in; releasing
/// calls `onDrop` with the row's index and that gap, 0 to the row count.
function useRowDrag(enabled: boolean, onDrop: (from: number, slot: number) => void) {
  const list = useRef<HTMLOListElement>(null);
  const press = useRef<{ from: number; startY: number; active: boolean } | null>(null);
  const dragged = useRef(false);
  const [state, setState] = useState<{ from: number; slot: number } | null>(null);

  const slotAt = (y: number) =>
    dropSlot(
      y,
      // A group's header is not a row: only workspaces count toward the gaps.
      [...(list.current?.children ?? [])].filter((row) => !row.classList.contains("group-head")).map((row) => row.getBoundingClientRect()),
    );

  const end = () => {
    press.current = null;
    setState(null);
    document.body.classList.remove("reordering");
  };

  return {
    list,
    rowClass(index: number, count: number): string | undefined {
      if (!state) return undefined;
      const classes = [];
      if (index === state.from) classes.push("row-dragged");
      if (state.slot === index) classes.push("drop-before");
      if (state.slot === count && index === count - 1) classes.push("drop-after");
      return classes.join(" ") || undefined;
    },
    handlers: (index: number) =>
      enabled
        ? {
            onPointerDown(event: PointerEvent<HTMLElement>) {
              if (event.button !== 0) return;
              press.current = { from: index, startY: event.clientY, active: false };
            },
            onPointerMove(event: PointerEvent<HTMLElement>) {
              const current = press.current;
              if (!current) return;
              if (!current.active) {
                if (Math.abs(event.clientY - current.startY) < DRAG_THRESHOLD) return;
                current.active = true;
                event.currentTarget.setPointerCapture(event.pointerId);
                document.body.classList.add("reordering");
              }
              setState({ from: current.from, slot: slotAt(event.clientY) });
            },
            onPointerUp(event: PointerEvent<HTMLElement>) {
              const current = press.current;
              if (current?.active) {
                dragged.current = true;
                onDrop(current.from, slotAt(event.clientY));
              }
              end();
            },
            onLostPointerCapture: end,
          }
        : {},
    /// True once after a drag, so the click its release fires does not focus the row.
    consumeClick(): boolean {
      const was = dragged.current;
      dragged.current = false;
      return was;
    },
  };
}

/// Its agents by status, beside the name: the badge for those waiting on you,
/// then each other live status's mark with how many when more than one.
/// Hovering gives the whole count.
function AgentTally({ agents, marks }: { agents: Agent[]; marks: { status: AgentStatus; count: number }[] }) {
  const shown = marks.filter(({ status }) => status !== "unknown");
  if (shown.length === 0) return null;
  const label = agents.length > 0 ? `${agents.length} ${agents.length === 1 ? "agent" : "agents"}` : undefined;
  return (
    <span className="agent-tally" title={label}>
      {shown.map(({ status, count }) =>
        status === "blocked" ? (
          <StatusMark key={status} status={status} count={count} />
        ) : (
          <span key={status} className="tally">
            <StatusMark status={status} />
            {count > 1 && count}
          </span>
        ),
      )}
    </span>
  );
}

/// A pin when the workspace has pinned tabs, with their count when more than
/// one; hovering names them.
function PinnedTabs({ tabs }: { tabs: Tab[] }) {
  if (tabs.length === 0) return null;
  const label = `Pinned: ${tabs.map((tab) => tab.label).join(", ")}`;
  return (
    <span className="pinned-tabs" title={label} aria-label={label}>
      <PinIcon />
      {tabs.length > 1 && tabs.length}
    </span>
  );
}

/// The Git facts, as herdr-gpui's folder card has them: the branch unless it is
/// `main` or `master`, commits to push and pull, how many files are changed, and
/// how many linked worktrees the checkout has. Only what is non-zero shows, and
/// they are gone when that leaves nothing. A `null` branch leaves the name out.
function WorkspaceGit({
  branch,
  aheadBehind,
  changed,
  worktrees,
  onOpenWorktrees,
}: {
  branch: string | null;
  aheadBehind: [number, number] | null;
  changed: number;
  worktrees: Worktree[];
  onOpenWorktrees: () => void;
}) {
  const [ahead, behind] = aheadBehind ?? [0, 0];
  if (!hasGitLine(branch, [ahead, behind, changed, worktrees.length])) return null;
  const name = shownBranch(branch);
  return (
    <span className="workspace-branch">
      {name && <span className="workspace-branch-name">{name}</span>}
      <GitAhead count={ahead} />
      <GitBehind count={behind} />
      <GitChanged count={changed} />
      <Worktrees worktrees={worktrees} onOpen={onOpenWorktrees} />
    </span>
  );
}
