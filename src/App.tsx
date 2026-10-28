import { useEffect, useMemo, useSyncExternalStore } from "react";
import { Controller } from "./app/controller";
import { Palette } from "./components/Palette";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TabBar } from "./components/TabBar";
import { Terminal } from "./components/Terminal";

export default function App() {
  const controller = useMemo(() => new Controller(), []);
  const state = useSyncExternalStore(controller.subscribe, controller.getState);

  useEffect(() => {
    controller.loadCatalog().catch(() => {});
    // Shortcuts work wherever focus is, not only in the terminal.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !(event.metaKey || event.ctrlKey)) return;
      if (controller.shortcut(event)) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [controller]);

  useEffect(() => {
    document.title = state.title ? `${state.title} — Herdr` : "Herdr";
  }, [state.title]);

  const paletteCommands = useMemo(
    // `focus_tab_3` and friends are shortcuts, not things anyone searches for.
    () => state.commands.filter((command) => !/_\d$/.test(command.name)),
    [state.commands],
  );

  return (
    <div className={`app ${state.sidebar ? "" : "no-sidebar"}`}>
      {state.sidebar && <Sidebar controller={controller} snapshot={state.snapshot} />}
      <main className="main">
        <TabBar controller={controller} snapshot={state.snapshot} />
        <Terminal controller={controller} fontSize={state.fontSize} />
        <StatusBar controller={controller} state={state} />
      </main>
      {state.palette && <Palette controller={controller} commands={paletteCommands} />}
    </div>
  );
}
