/** Open state of the Project Structure dialog and the backend's module model. */
import { create } from "zustand";
import type { ProjectModules } from "@/bindings";
import { call, commands, isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { notifications } from "@/workbench/contributions";
import { tx } from "@/platform/i18n";
import { beginStaging, discardStaged } from "@/features/settings/model/staging";

export type ProjectStructurePage = "project" | "modules" | "libraries" | "sdks";

export type ModuleTab = "sources" | "paths" | "dependencies";

export const PROJECT_STRUCTURE_PAGES: readonly ProjectStructurePage[] = ["project", "modules", "libraries", "sdks"];

interface ProjectStructureState {
  open: boolean;
  page: ProjectStructurePage;
  /** Selected module / library by name. */
  module: string | null;
  library: string | null;
  /** Tab of the module page; kept while switching modules, as in IDEA. */
  moduleTab: ModuleTab;
  /** Imported (and last saved) modules and libraries; null until loaded. */
  model: ProjectModules | null;
  loading: boolean;
  error: string | null;
}

export const useProjectStructureDialog = create<ProjectStructureState>(() => ({
  open: false,
  page: "modules",
  module: null,
  library: null,
  moduleTab: "sources",
  model: null,
  loading: false,
  error: null,
}));

const EMPTY: ProjectModules = { modules: [], libraries: [] };

export async function loadModules(): Promise<void> {
  if (!isTauri()) {
    useProjectStructureDialog.setState({ model: EMPTY, loading: false });
    return;
  }
  useProjectStructureDialog.setState({ loading: true, error: null });
  try {
    const model = await call(commands.sdkProjectModules());
    useProjectStructureDialog.setState({ model, loading: false });
  } catch (e) {
    useProjectStructureDialog.setState({
      model: EMPTY,
      loading: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** `page` is a page id, optionally `modules:<name>` / `libraries:<name>` to select one. */
export function parsePageTarget(target: unknown): { page: ProjectStructurePage; name: string | null } | null {
  if (typeof target !== "string" || !target) return null;
  const [page, ...rest] = target.split(":");
  if (!PROJECT_STRUCTURE_PAGES.includes(page as ProjectStructurePage)) return null;
  return { page: page as ProjectStructurePage, name: rest.length ? rest.join(":") : null };
}

/** File › Project Structure… (`beginStaging` of the settings model is the dialog's edit buffer). */
export function openProjectStructure(target?: unknown) {
  if (!useProject.getState().project) {
    notifications().notify({ level: "info", title: tx("Open a project to configure its structure.") });
    return;
  }
  const t = parsePageTarget(target);
  beginStaging();
  useProjectStructureDialog.setState((s) => ({
    open: true,
    page: t?.page ?? s.page,
    module: t?.page === "modules" ? t.name : s.module,
    library: t?.page === "libraries" ? t.name : s.library,
  }));
  void loadModules();
}

export function closeProjectStructure() {
  discardStaged();
  useProjectStructureDialog.setState({ open: false });
}
