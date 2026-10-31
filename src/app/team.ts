// A workspace's team of agents: the roles its folder's `.herdr/team.json`
// names, each one a tab of that name running `claude --agent <agent>`. What
// each role is (its prompt, tools, model) lives in the repo's own
// `.claude/agents/<agent>.md`; this file only says which ones to start.

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { readFile } from "../files/listing";
import type { AgentStatus, Snapshot } from "../protocol";
import { PRIORITY, shownStatus } from "./attention";

export const TEAM_FILE = ".herdr/team.json";
/// As many as `team.rs` starts at once.
const MAX_MEMBERS = 12;
/// What `.claude/agents/<name>.md` can be called; `team.rs` refuses anything else.
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,31}$/;

export interface Member {
  /// The tab's name, and so how the sidebar finds it again.
  role: string;
  /// The Claude Code agent it runs; the role's name when the file gives none.
  agent: string;
}

/// Where a role stands: no tab yet, a tab with no agent in it, or its agent's status.
export type MemberState = "absent" | "shell" | AgentStatus;

export interface MemberRow {
  member: Member;
  state: MemberState;
  tabId: string | null;
}

/// The members `text` lists, or what is wrong with it.
export function parseTeam(text: string): Member[] | { error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: `${TEAM_FILE} is not JSON` };
  }
  const list = (data as { members?: unknown } | null)?.members;
  if (!Array.isArray(list) || list.length === 0) return { error: `${TEAM_FILE} has no "members" list` };
  if (list.length > MAX_MEMBERS) return { error: `${TEAM_FILE} lists more than ${MAX_MEMBERS} members` };
  const members: Member[] = [];
  for (const entry of list) {
    const { role, agent } = (entry ?? {}) as { role?: unknown; agent?: unknown };
    const name = agent ?? role;
    if (typeof role !== "string" || !NAME.test(role)) return { error: `${TEAM_FILE}: bad role ${JSON.stringify(role)}` };
    if (typeof name !== "string" || !NAME.test(name)) return { error: `${TEAM_FILE}: bad agent ${JSON.stringify(name)}` };
    if (members.some((m) => m.role === role)) return { error: `${TEAM_FILE}: role ${role} twice` };
    members.push({ role, agent: name });
  }
  return members;
}

/// Each member of a workspace's team with its tab, matched by name, and the
/// most urgent status among the agents in it.
export function teamRows(members: readonly Member[], workspaceId: string, snapshot: Snapshot): MemberRow[] {
  return members.map((member) => {
    const tab = snapshot.tabs.find((t) => t.workspace_id === workspaceId && t.label === member.role);
    if (!tab) return { member, state: "absent", tabId: null };
    const statuses = snapshot.agents.filter((a) => a.tab_id === tab.tab_id).map(shownStatus);
    const state = statuses.sort((a, b) => PRIORITY[b] - PRIORITY[a])[0] ?? "shell";
    return { member, state, tabId: tab.tab_id };
  });
}

/// A member's state in words, as the sidebar's Team list shows it.
export const STATE_WORDS: Record<MemberState, string> = {
  absent: "not started",
  shell: "shell",
  blocked: "waiting on you",
  working: "working",
  done: "done",
  idle: "idle",
  unknown: "running",
};

export type TeamState = { phase: "none" } | { phase: "ready"; members: Member[] } | { phase: "invalid"; error: string };

/// One folder's team: none without the file, or what is wrong with it.
async function readTeam(directory: string): Promise<TeamState> {
  try {
    const contents = await readFile(directory, TEAM_FILE);
    if (contents.type !== "text") return { phase: "invalid", error: `${TEAM_FILE} is not text` };
    const parsed = parseTeam(contents.text);
    return Array.isArray(parsed) ? { phase: "ready", members: parsed } : { phase: "invalid", ...parsed };
  } catch {
    return { phase: "none" };
  }
}

/// The team of each of `directories`, read when they change and again when
/// the window comes back, since the files are edited elsewhere. `version`
/// rereads them at once, after New team has written one.
export function useTeams(directories: readonly string[], version: number): Map<string, TeamState> {
  const [teams, setTeams] = useState<Map<string, TeamState>>(new Map());
  const key = directories.join("\0");
  useEffect(() => {
    const list = key ? key.split("\0") : [];
    let live = true;
    const refresh = () => {
      Promise.all(list.map(readTeam)).then((states) => {
        if (live) setTeams(new Map(list.map((directory, i) => [directory, states[i]])));
      });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      live = false;
      window.removeEventListener("focus", refresh);
    };
  }, [key, version]);
  return teams;
}

/// Writes the starter team into the folder `directory`; resolves with the files written.
export function createTeam(directory: string): Promise<string[]> {
  return invoke("create_team", { directory });
}

/// Opens a tab for each of `members` in the workspace and starts its agent.
export function startTeam(workspaceId: string, directory: string, members: Member[]): Promise<void> {
  return invoke("start_team", { workspaceId, directory, members });
}
