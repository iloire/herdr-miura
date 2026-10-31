import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, fontStack, parseSettings } from "../settings";

describe("parseSettings", () => {
  it("reads workspace colors keyed by folder, and is quiet without the table", () => {
    const { settings, warnings } = parseSettings({ workspace_colors: { "/code/my.app": "red", "/code/notes": "cyan" } });
    expect(settings.workspaceColors).toEqual({ "/code/my.app": "red", "/code/notes": "cyan" });
    expect(warnings).toEqual([]);
    expect(parseSettings({}).settings.workspaceColors).toEqual({});
  });

  it("warns about a bad slot and keeps the good ones", () => {
    for (const bad of ["pink", "Red", 3, ""]) {
      const { settings, warnings } = parseSettings({ workspace_colors: { "/a": bad, "/b": "blue" } });
      expect(settings.workspaceColors).toEqual({ "/b": "blue" });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("/a");
    }
  });

  it("warns when workspace_colors is not a table", () => {
    const { settings, warnings } = parseSettings({ workspace_colors: "red" });
    expect(settings.workspaceColors).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("[workspace_colors]");
  });

  it("gives every default for an empty or missing file", () => {
    for (const values of [{}, undefined, null, "junk"]) {
      expect(parseSettings(values)).toEqual({ settings: DEFAULT_SETTINGS, warnings: [] });
    }
    expect(DEFAULT_SETTINGS).toMatchObject({
      theme: "Herdr Night",
      terminal: { fontFamily: "JetBrains Mono", fontSize: 13, lineHeight: 1.4 },
      ui: { fontSize: 13 },
      confirmCloseTab: true,
      newTabCommand: null,
      workspaceCards: { gitStatus: true, agentStatus: true, details: "manual", compact: false },
    });
  });

  it("reads every starting key", () => {
    const { settings, warnings } = parseSettings({
      theme: "light:GitHub Light Default,dark:Herdr Night",
      terminal: { font_family: "Menlo", font_size: 15, line_height: 1.2 },
      ui: { font_size: 14 },
      confirm_close_tab: false,
      new_tab: { command: " claude " },
      tabs: { wrap: false },
      workspace_colors: { "/code/notes": "cyan" },
      workspace_cards: { git_status: false, agent_status: false, details: "never", compact: true },
    });
    expect(warnings).toEqual([]);
    expect(settings).toEqual({
      theme: "light:GitHub Light Default,dark:Herdr Night",
      terminal: { fontFamily: "Menlo", fontSize: 15, lineHeight: 1.2 },
      ui: { fontSize: 14 },
      confirmCloseTab: false,
      tabsWrap: false,
      newTabCommand: "claude",
      workspaceColors: { "/code/notes": "cyan" },
      workspaceCards: { gitStatus: false, agentStatus: false, details: "never", compact: true },
    });
  });

  it("reads each details mode, and leaves the rest of the cards at their defaults", () => {
    for (const details of ["manual", "auto", "always", "never"]) {
      const { settings, warnings } = parseSettings({ workspace_cards: { details } });
      expect(settings.workspaceCards).toEqual({ ...DEFAULT_SETTINGS.workspaceCards, details });
      expect(warnings).toEqual([]);
    }
  });

  it("keeps manual for a details value it does not know", () => {
    for (const details of ["sometimes", "Always", "", true, 2, ["never"]]) {
      const { settings, warnings } = parseSettings({ workspace_cards: { details } });
      expect(settings.workspaceCards.details).toBe("manual");
      expect(warnings).toEqual(['`workspace_cards.details` should be one of manual, auto, always, never; using "manual".']);
    }
  });

  it("keeps each card flag's default for a bad value and says which key", () => {
    const { settings, warnings } = parseSettings({ workspace_cards: { git_status: "no", agent_status: 0, compact: "yes" } });
    expect(settings.workspaceCards).toEqual(DEFAULT_SETTINGS.workspaceCards);
    expect(warnings).toEqual([
      "`workspace_cards.git_status` should be true or false; using true.",
      "`workspace_cards.agent_status` should be true or false; using true.",
      "`workspace_cards.compact` should be true or false; using false.",
    ]);
  });

  it("warns about an unknown card key, and when workspace_cards is not a table", () => {
    expect(parseSettings({ workspace_cards: { gitstatus: false } }).warnings).toEqual(["`workspace_cards.gitstatus` is not a setting, so it does nothing."]);
    const { settings, warnings } = parseSettings({ workspace_cards: "compact" });
    expect(settings.workspaceCards).toEqual(DEFAULT_SETTINGS.workspaceCards);
    expect(warnings).toEqual(["`workspace_cards` should be a [workspace_cards] table; its settings are at their defaults."]);
  });

  it("keeps the default for a bad value and says which key", () => {
    const { settings, warnings } = parseSettings({
      theme: "light:Nord",
      terminal: { font_size: 64, line_height: "tall", font_family: "" },
      ui: { font_size: 9 },
      confirm_close_tab: "yes",
      new_tab: { command: "claude\nrm -rf ~" },
      tabs: { wrap: "no" },
    });
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(warnings).toHaveLength(8);
    for (const key of ["theme", "terminal.font_size", "terminal.line_height", "terminal.font_family", "ui.font_size", "confirm_close_tab", "new_tab.command", "tabs.wrap"]) {
      expect(warnings.some((warning) => warning.startsWith(`\`${key}\``)), key).toBe(true);
    }
    expect(warnings.find((w) => w.startsWith("`terminal.font_size`"))).toContain("from 8 to 32; using 13");
  });

  it("warns about keys that are not settings and still reads the rest", () => {
    const { settings, warnings } = parseSettings({
      theme: "Nord",
      thme: "Dracula",
      terminal: { font_size: 14, cursor_blink: true },
      keys: { quit: "cmd-q" },
      ui: 3,
    });
    expect(settings.theme).toBe("Nord");
    expect(settings.terminal.fontSize).toBe(14);
    expect(warnings).toEqual([
      "`thme` is not a setting, so it does nothing.",
      "`terminal.cursor_blink` is not a setting, so it does nothing.",
      "`keys` is not a setting, so it does nothing.",
      "`ui` should be a [ui] table; its settings are at their defaults.",
    ]);
  });

  it("turns a file that does not parse into a warning over the defaults", () => {
    const { settings, warnings } = parseSettings({}, "TOML parse error at line 1");
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(warnings).toEqual(["The settings file does not parse, so every setting is at its default: TOML parse error at line 1"]);
  });
});

describe("fontStack", () => {
  it("puts the chosen face before the fallbacks, quoting a single name", () => {
    expect(fontStack("Fira Code")).toMatch(/^"Fira Code", .*monospace$/);
    expect(fontStack('"Iosevka", Menlo')).toMatch(/^"Iosevka", Menlo, /);
  });
});
