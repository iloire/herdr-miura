import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, fontStack, parseSettings } from "../settings";

describe("parseSettings", () => {
  it("gives every default for an empty or missing file", () => {
    for (const values of [{}, undefined, null, "junk"]) {
      expect(parseSettings(values)).toEqual({ settings: DEFAULT_SETTINGS, warnings: [] });
    }
    expect(DEFAULT_SETTINGS).toMatchObject({
      theme: "Herdr Night",
      terminal: { fontFamily: "JetBrains Mono", fontSize: 13, lineHeight: 1.4 },
      ui: { fontSize: 13 },
      confirmCloseTab: false,
      newTabCommand: null,
    });
  });

  it("reads every starting key", () => {
    const { settings, warnings } = parseSettings({
      theme: "light:GitHub Light Default,dark:Herdr Night",
      terminal: { font_family: "Menlo", font_size: 15, line_height: 1.2 },
      ui: { font_size: 14, sidebar_agents: true },
      confirm_close_tab: true,
      new_tab: { command: " claude " },
    });
    expect(warnings).toEqual([]);
    expect(settings).toEqual({
      theme: "light:GitHub Light Default,dark:Herdr Night",
      terminal: { fontFamily: "Menlo", fontSize: 15, lineHeight: 1.2 },
      ui: { fontSize: 14, sidebarAgents: true },
      confirmCloseTab: true,
      newTabCommand: "claude",
    });
  });

  it("keeps the default for a bad value and says which key", () => {
    const { settings, warnings } = parseSettings({
      theme: "light:Nord",
      terminal: { font_size: 64, line_height: "tall", font_family: "" },
      ui: { font_size: 9, sidebar_agents: "yes" },
      confirm_close_tab: "yes",
      new_tab: { command: "claude\nrm -rf ~" },
    });
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(warnings).toHaveLength(8);
    for (const key of ["theme", "terminal.font_size", "terminal.line_height", "terminal.font_family", "ui.font_size", "ui.sidebar_agents", "confirm_close_tab", "new_tab.command"]) {
      expect(warnings.some((warning) => warning.startsWith(`\`${key}\``)), key).toBe(true);
    }
    expect(warnings.find((w) => w.startsWith("`terminal.font_size`"))).toContain("from 8 to 32; using 13");
  });

  it("leaves the sidebar's Agents section off unless it is turned on", () => {
    expect(DEFAULT_SETTINGS.ui.sidebarAgents).toBe(false);
    expect(parseSettings({ ui: { font_size: 14 } }).settings.ui.sidebarAgents).toBe(false);
    expect(parseSettings({ ui: { sidebar_agents: true } }).settings.ui.sidebarAgents).toBe(true);
    expect(parseSettings({ ui: { sidebar_agents: false } })).toEqual({ settings: DEFAULT_SETTINGS, warnings: [] });

    const { settings, warnings } = parseSettings({ ui: { sidebar_agents: "yes" } });
    expect(settings.ui.sidebarAgents).toBe(false);
    expect(warnings).toEqual(["`ui.sidebar_agents` should be true or false; using false."]);
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
