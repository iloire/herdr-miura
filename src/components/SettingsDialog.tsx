import { type CSSProperties, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { Controller } from "../app/controller";
import { CARD_DETAILS, type CardDetailsMode, LIMITS, type Settings, resolveTheme, saveSetting, themeNames } from "../app/settings";
import type { SettingsView } from "../app/useSettings";
import { css } from "../terminal/theme";
import { BUILTIN_NAMES, type NamedTheme, builtinTheme, parseThemeName } from "../themes/catalog";
import { TOKENS } from "../themes/chrome";

const BUILTIN = new Set(BUILTIN_NAMES);
const LIGHT = "(prefers-color-scheme: light)";

type Value = string | number | boolean | null;

const DETAILS: Record<CardDetailsMode, { label: string; hint: string }> = {
  manual: { label: "Manual", hint: "Each card's chevron opens and closes its details." },
  auto: { label: "Automatic", hint: "A card opens while an agent works, needs you or has finished unseen, and closes once it rests. Its chevron holds your choice until that next changes." },
  always: { label: "Always open", hint: "Every card with something to show keeps its details open." },
  never: { label: "Never", hint: "Cards stay on one line with no chevron. An agent that needs you still shows on its card." },
};

/// ⌘, : every setting the file holds, applied and written as it changes. There
/// is no Save: each change goes straight to config-tauri.toml, comments kept.
export function SettingsDialog({
  controller,
  settings,
  view,
  onClose,
}: {
  controller: Controller;
  settings: Settings;
  view: SettingsView;
  onClose: () => void;
}) {
  const save = (key: string, value: Value) => controller.act(saveSetting(key, value).then(view.reload));
  /// Saves a checkbox; its default removes the key.
  const saveFlag = (key: string, fallback: boolean) => (on: boolean) => save(key, on === fallback ? null : on);
  const cards = settings.workspaceCards;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onClose();
  };
  // Esc needs focus inside the dialog, and nothing in it always takes focus.
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => dialog.current?.focus(), []);
  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        ref={dialog}
        tabIndex={-1}
        className="palette settings-dialog"
        role="dialog"
        aria-labelledby="settings-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <header className="worktrees-head">
          <div className="worktrees-heading">
            <span className="worktrees-eyebrow">Herdr Tauri</span>
            <h2 id="settings-title">Settings</h2>
          </div>
          <button className="worktrees-close" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            ×
          </button>
        </header>
        {view.warnings.length > 0 && (
          <ul className="settings-dialog-warnings" role="status">
            {view.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
        <div className="settings-body">
          <section>
            <h3>Appearance</h3>
            <ThemePicker value={settings.theme} onChange={(theme) => save("theme", theme)} />
            <div className="settings-grid">
              <TextField
                label="Terminal font"
                value={settings.terminal.fontFamily}
                fallback="JetBrains Mono"
                onCommit={(value) => save("terminal.font_family", value === "JetBrains Mono" ? null : value || null)}
              />
              <NumberField label="Terminal size" limits={LIMITS["terminal.font_size"]} step={1} value={settings.terminal.fontSize} fallback={13} onCommit={(value) => save("terminal.font_size", value)} />
              <NumberField label="Line height" limits={LIMITS["terminal.line_height"]} step={0.05} value={settings.terminal.lineHeight} fallback={1.4} onCommit={(value) => save("terminal.line_height", value)} />
              <NumberField label="Interface text size" limits={LIMITS["ui.font_size"]} step={1} value={settings.ui.fontSize} fallback={13} onCommit={(value) => save("ui.font_size", value)} />
            </div>
          </section>
          <section>
            <h3>Tabs</h3>
            <Check
              label="Ask before closing a tab or pane with a working agent"
              hint="Closing stops the agent and anything it is running. Idle or finished agents, shells and servers close at once."
              checked={settings.confirmCloseTab}
              onChange={saveFlag("confirm_close_tab", true)}
            />
            <Check
              label="Wrap tabs onto more rows"
              hint="Off keeps one row of tabs, which scrolls sideways when they do not fit."
              checked={settings.tabsWrap}
              onChange={saveFlag("tabs.wrap", true)}
            />
            <div className="settings-grid">
              <TextField
                label="New tab command"
                placeholder="the shell"
                value={settings.newTabCommand ?? ""}
                fallback=""
                hint="Typed into the tab the strip's + or ⌘⇧T opens, e.g. claude. ⌥-click on + or ⌘T opens a plain tab."
                onCommit={(value) => save("new_tab.command", value || null)}
              />
            </div>
          </section>
          <section>
            <h3>Workspace cards</h3>
            <Check
              label="Show Git status"
              hint="Commits to push and pull and changed files, such as ↑27 ±1."
              checked={cards.gitStatus}
              onChange={saveFlag("workspace_cards.git_status", true)}
            />
            <Check
              label="Show agent status"
              hint="The status marks and tally beside the name. An agent that needs you still shows on its card."
              checked={cards.agentStatus}
              onChange={saveFlag("workspace_cards.agent_status", true)}
            />
            <Check
              label="Compact cards"
              hint="Tighter rows, so more workspaces fit."
              checked={cards.compact}
              onChange={saveFlag("workspace_cards.compact", false)}
            />
            <div className="settings-grid">
              <div className="settings-field wide">
                <span id="settings-card-details">Details</span>
                <div className="segmented" role="radiogroup" aria-labelledby="settings-card-details">
                  {CARD_DETAILS.map((mode) => (
                    <button key={mode} role="radio" aria-checked={cards.details === mode} onClick={() => save("workspace_cards.details", mode === "manual" ? null : mode)}>
                      {DETAILS[mode].label}
                    </button>
                  ))}
                </div>
                <small>{DETAILS[cards.details].hint}</small>
              </div>
            </div>
          </section>
        </div>
        <footer className="settings-foot">
          <span className="settings-path" title={view.path ?? undefined}>
            {view.path}
          </span>
        </footer>
      </div>
    </div>
  );
}

/// One theme, or a light and a dark one following macOS, with a preview of the
/// one under the pointer. Installed themes can run to hundreds, so they bring a search.
function ThemePicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const pair = parseThemeName(value) ?? { light: value, dark: value };
  const follows = /^\s*(light|dark):/.test(value);
  const systemLight = useMemo(() => window.matchMedia(LIGHT).matches, []);
  const [side, setSide] = useState<"light" | "dark">(systemLight ? "light" : "dark");
  const [names, setNames] = useState<string[]>(BUILTIN_NAMES);
  const [query, setQuery] = useState("");
  const current = follows ? pair[side] : pair.dark;
  const [shown, setShown] = useState(current);
  const [preview, setPreview] = useState<NamedTheme | null>(null);

  useEffect(() => {
    let live = true;
    void themeNames().then((list) => live && setNames(list));
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => setShown(current), [current]);
  useEffect(() => {
    let live = true;
    void resolveTheme(shown, true).then(({ theme }) => live && setPreview(theme));
    return () => {
      live = false;
    };
  }, [shown]);

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = names.filter((name) => words.every((word) => name.toLowerCase().includes(word)));
  const pick = (name: string) => {
    if (!follows) return onChange(name);
    onChange(side === "light" ? `light:${name},dark:${pair.dark}` : `light:${pair.light},dark:${name}`);
  };
  const setFollows = (on: boolean) => {
    if (on === follows) return;
    if (!on) return onChange(systemLight ? pair.light : pair.dark);
    const dark = builtinTheme(current)?.chrome.scheme !== "light";
    onChange(dark ? `light:GitHub Light Default,dark:${current}` : `light:${current},dark:Herdr Night`);
  };

  return (
    <div className="theme-picker">
      <div className="theme-picker-top">
        <div className="segmented" role="radiogroup" aria-label="Theme mode">
          <button role="radio" aria-checked={!follows} onClick={() => setFollows(false)}>
            One theme
          </button>
          <button role="radio" aria-checked={follows} onClick={() => setFollows(true)}>
            Match macOS
          </button>
        </div>
        {follows && (
          <div className="segmented" role="radiogroup" aria-label="Appearance">
            {(["light", "dark"] as const).map((which) => (
              <button key={which} role="radio" aria-checked={side === which} onClick={() => setSide(which)}>
                {which === "light" ? "Light" : "Dark"}: <b>{pair[which]}</b>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="theme-picker-main">
        <div className="theme-list-column">
          {names.length > BUILTIN_NAMES.length && (
            <input
              autoFocus
              className="theme-search"
              type="search"
              placeholder={`Search ${names.length} themes`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          )}
          <ul className="theme-list" role="listbox" aria-label="Themes" onMouseLeave={() => setShown(current)}>
            {matches.map((name) => (
              <li key={name}>
                <button
                  role="option"
                  aria-selected={name === current}
                  onMouseEnter={() => setShown(name)}
                  onFocus={() => setShown(name)}
                  onClick={() => pick(name)}
                >
                  <Swatch name={name} />
                  <span className="theme-name">{name}</span>
                  {!BUILTIN.has(name) && <span className="theme-origin">Ghostty</span>}
                </button>
              </li>
            ))}
            {matches.length === 0 && <li className="theme-none">No theme matches “{query}”.</li>}
          </ul>
        </div>
        {preview && <ThemePreview theme={preview} />}
      </div>
    </div>
  );
}

/// A built-in theme's background with its six hues; installed ones are read only on hover.
function Swatch({ name }: { name: string }) {
  const theme = BUILTIN.has(name) ? builtinTheme(name) : undefined;
  if (!theme) return <span className="theme-swatch empty" />;
  const { background, palette } = theme.terminal;
  return (
    <span className="theme-swatch" style={{ background: css(background) }}>
      {[1, 2, 3, 4, 5, 6].map((slot) => (
        <i key={slot} style={{ background: css(palette[slot]) }} />
      ))}
    </span>
  );
}

/// The theme's terminal colors and a sidebar card drawn in its chrome: the
/// tokens are set on this box alone, so the dialog around it keeps its own.
function ThemePreview({ theme }: { theme: NamedTheme }) {
  const style = Object.fromEntries(TOKENS.map((token) => [`--${token}`, theme.chrome.tokens[token]])) as CSSProperties;
  const { foreground, background, palette, cursor } = theme.terminal;
  const fg = (slot: number) => ({ color: css(palette[slot]) });
  return (
    <div className="theme-preview" style={{ ...style, colorScheme: theme.chrome.scheme }} aria-label={`Preview of ${theme.name}`}>
      <div className="preview-card">
        <span className="preview-card-name">herdr-tauri</span>
        <span className="preview-card-path">~/code/herdr-tauri</span>
        <span className="preview-card-marks">
          <i style={{ background: "var(--working)" }} /> working
          <i style={{ background: "var(--blocked)" }} /> 1
          <i style={{ background: "var(--done)" }} /> done
        </span>
      </div>
      <pre className="preview-terminal" style={{ background: css(background), color: css(foreground) }}>
        <span style={fg(2)}>➜</span> <span style={fg(6)}>herdr-tauri</span> <span style={fg(4)}>git:(</span>
        <span style={fg(1)}>main</span>
        <span style={fg(4)}>)</span> npm test{"\n"}
        <span style={fg(2)}> ✓</span> 161 passed <span style={fg(3)}>(2 skipped)</span>
        {"\n"}
        <span style={fg(5)}>const</span> theme = <span style={fg(3)}>"{theme.name}"</span>;{"\n"}
        <span className="preview-palette">
          {palette.slice(0, 16).map((color, slot) => (
            <i key={slot} style={{ background: css(color) }} />
          ))}
        </span>
        <span className="preview-cursor" style={{ background: css(cursor) }} />
      </pre>
    </div>
  );
}

/// A setting that is on or off, with what it means under its label.
function Check({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="settings-check">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>
        {label}
        <small>{hint}</small>
      </span>
    </label>
  );
}

/// A text setting, written when it loses focus or on Enter.
function TextField({
  label,
  value,
  fallback,
  placeholder,
  hint,
  onCommit,
}: {
  label: string;
  value: string;
  fallback: string;
  placeholder?: string;
  hint?: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft.trim() !== value && onCommit(draft.trim());
  return (
    <label className="settings-field wide">
      <span>{label}</span>
      <input
        value={draft}
        placeholder={placeholder ?? fallback}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => event.key === "Enter" && commit()}
      />
      {hint && <small>{hint}</small>}
    </label>
  );
}

/// A number setting in its range; the default removes the key.
function NumberField({
  label,
  limits: [min, max],
  step,
  value,
  fallback,
  onCommit,
}: {
  label: string;
  limits: readonly [number, number];
  step: number;
  value: number;
  fallback: number;
  onCommit: (value: number | null) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = (text: string) => {
    const number = Number(text);
    if (text.trim() === "" || !Number.isFinite(number)) return setDraft(String(value));
    const clamped = Math.round(Math.min(max, Math.max(min, number)) * 100) / 100;
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped === fallback ? null : clamped);
  };
  return (
    <label className="settings-field">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          // The stepper arrows commit at once; typing waits for blur or Enter.
          if ((event.nativeEvent as InputEvent).inputType === undefined) commit(event.target.value);
        }}
        onBlur={(event) => commit(event.target.value)}
        onKeyDown={(event) => event.key === "Enter" && commit(event.currentTarget.value)}
      />
    </label>
  );
}
