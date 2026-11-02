/**
 * Project Structure model: the backend's view of the project (Maven / Gradle
 * modules and their libraries, read-only) merged with the hand-made modules
 * and project libraries being edited (`projectStructure.modules` /
 * `projectStructure.libraries`, staged until Apply). Edits are pure functions
 * over the staged lists.
 */
import type { LibraryInfo, ModuleInfo, ModuleOrigin, ProjectModules } from "@/bindings";
import type {
  DependencyScope,
  LibraryValid,
  ModuleDependencyKind,
  ModuleDependencyValid,
  ModuleValid,
} from "@/platform/languageSettings";

/** A module as listed: imported ones from the backend, manual ones from the staged settings. */
export interface ModuleRow {
  name: string;
  contentRoot: string;
  origin: ModuleOrigin;
  buildFile: string | null;
  languageLevel: string;
  dependencies: DependencyRow[];
  /** The staged settings entry of a manual module. */
  settings: ModuleValid | null;
}

export interface DependencyRow {
  kind: ModuleDependencyKind;
  name: string;
  scope: DependencyScope;
  exported: boolean;
  transitive: boolean;
}

export interface LibraryRow {
  name: string;
  origin: ModuleOrigin;
  /** `group:artifact:version` of an imported library. */
  coordinate: string | null;
  classes: string[];
  sources: string[];
  usedBy: string[];
  settings: LibraryValid | null;
}

export const isImported = (origin: ModuleOrigin) => origin !== "manual";

export function originLabel(origin: ModuleOrigin): string {
  return origin === "maven" ? "Maven" : origin === "gradle" ? "Gradle" : "";
}

const importedModule = (m: ModuleInfo): ModuleRow => ({
  name: m.name,
  contentRoot: m.contentRoot,
  origin: m.origin,
  buildFile: m.buildFile,
  languageLevel: m.languageLevel === null ? "" : String(m.languageLevel),
  dependencies: m.dependencies.map((d) => ({ ...d })),
  settings: null,
});

const importedLibrary = (l: LibraryInfo): LibraryRow => ({
  name: l.name,
  origin: l.origin,
  coordinate: l.coordinate ? `${l.coordinate.groupId}:${l.coordinate.artifactId}:${l.coordinate.version}` : null,
  classes: l.classes,
  sources: l.sources,
  usedBy: l.usedBy,
  settings: null,
});

/** Imported modules first (build order), then the staged manual ones. */
export function moduleRows(model: ProjectModules | null, manual: readonly ModuleValid[]): ModuleRow[] {
  const imported = (model?.modules ?? []).filter((m) => isImported(m.origin)).map(importedModule);
  const taken = new Set(imported.map((m) => m.name));
  return [
    ...imported,
    ...manual
      .filter((m) => !taken.has(m.name))
      .map((m): ModuleRow => ({
        name: m.name,
        contentRoot: m.contentRoot,
        origin: "manual",
        buildFile: null,
        languageLevel: m.languageLevel,
        dependencies: m.dependencies.map((d) => ({ ...d, transitive: false })),
        settings: m,
      })),
  ];
}

/** Imported libraries (by name), then the staged project libraries, with the modules using each. */
export function libraryRows(
  model: ProjectModules | null,
  libraries: readonly LibraryValid[],
  modules: readonly ModuleValid[],
): LibraryRow[] {
  const imported = (model?.libraries ?? []).filter((l) => isImported(l.origin)).map(importedLibrary);
  const taken = new Set(imported.map((l) => l.name));
  const usedBy = (name: string) =>
    modules.filter((m) => m.dependencies.some((d) => d.kind === "library" && d.name === name)).map((m) => m.name);
  for (const lib of imported) lib.usedBy = [...new Set([...lib.usedBy, ...usedBy(lib.name)])];
  return [
    ...imported,
    ...libraries
      .filter((l) => !taken.has(l.name))
      .map((l): LibraryRow => ({
        name: l.name,
        origin: "manual",
        coordinate: null,
        classes: l.classes,
        sources: l.sources,
        usedBy: usedBy(l.name),
        settings: l,
      })),
  ];
}

/** Why `name` can't name a new (or renamed) module / library, or null. */
export function nameProblem(name: string, taken: readonly string[], current?: string): string | null {
  const n = name.trim();
  if (!n) return "Enter a name";
  if (n !== current && taken.includes(n)) return `'${n}' already exists`;
  return null;
}

// ---------------------------------------------------------------- modules

export function newModule(name: string, contentRoot: string): ModuleValid {
  return {
    name: name.trim(),
    contentRoot,
    sdk: "",
    languageLevel: "",
    customOutput: false,
    output: "",
    testOutput: "",
    dependencies: [],
  };
}

export function updateModule(
  modules: readonly ModuleValid[],
  name: string,
  patch: Partial<ModuleValid>,
): ModuleValid[] {
  return modules.map((m) => (m.name === name ? { ...m, ...patch } : m));
}

/** Removes a module and every module dependency on it. */
export function removeModule(modules: readonly ModuleValid[], name: string): ModuleValid[] {
  return modules
    .filter((m) => m.name !== name)
    .map((m) => ({ ...m, dependencies: m.dependencies.filter((d) => !(d.kind === "module" && d.name === name)) }));
}

/** Renames a module and the module dependencies on it. */
export function renameModule(modules: readonly ModuleValid[], from: string, to: string): ModuleValid[] {
  const name = to.trim();
  return modules.map((m) => ({
    ...m,
    name: m.name === from ? name : m.name,
    dependencies: m.dependencies.map((d) => (d.kind === "module" && d.name === from ? { ...d, name } : d)),
  }));
}

// ---------------------------------------------------------------- dependencies

/** Appends dependencies a module doesn't have yet (and not on itself). */
export function addDependencies(
  modules: readonly ModuleValid[],
  module: string,
  added: ReadonlyArray<{ kind: ModuleDependencyKind; name: string }>,
): ModuleValid[] {
  return modules.map((m) => {
    if (m.name !== module) return m;
    const deps = [...m.dependencies];
    for (const a of added) {
      if (a.kind === "module" && a.name === module) continue;
      if (deps.some((d) => d.kind === a.kind && d.name === a.name)) continue;
      deps.push({ kind: a.kind, name: a.name, scope: "compile", exported: false });
    }
    return { ...m, dependencies: deps };
  });
}

export function removeDependency(modules: readonly ModuleValid[], module: string, index: number): ModuleValid[] {
  return modules.map((m) =>
    m.name === module ? { ...m, dependencies: m.dependencies.filter((_, i) => i !== index) } : m,
  );
}

export function updateDependency(
  modules: readonly ModuleValid[],
  module: string,
  index: number,
  patch: Partial<Pick<ModuleDependencyValid, "scope" | "exported">>,
): ModuleValid[] {
  return modules.map((m) =>
    m.name === module
      ? { ...m, dependencies: m.dependencies.map((d, i) => (i === index ? { ...d, ...patch } : d)) }
      : m,
  );
}

/** Moves a dependency up (`-1`) or down (`1`); out of range is a no-op. */
export function moveDependency(
  modules: readonly ModuleValid[],
  module: string,
  index: number,
  delta: -1 | 1,
): ModuleValid[] {
  return modules.map((m) => {
    const to = index + delta;
    if (m.name !== module || to < 0 || to >= m.dependencies.length) return m;
    const deps = [...m.dependencies];
    [deps[index], deps[to]] = [deps[to]!, deps[index]!];
    return { ...m, dependencies: deps };
  });
}

// ---------------------------------------------------------------- libraries

export function updateLibrary(
  libraries: readonly LibraryValid[],
  name: string,
  patch: Partial<LibraryValid>,
): LibraryValid[] {
  return libraries.map((l) => (l.name === name ? { ...l, ...patch } : l));
}

/** Adds paths to a library's classes or sources (no duplicates). */
export function addLibraryPaths(
  libraries: readonly LibraryValid[],
  name: string,
  part: "classes" | "sources",
  paths: readonly string[],
): LibraryValid[] {
  return libraries.map((l) => (l.name === name ? { ...l, [part]: [...new Set([...l[part], ...paths])] } : l));
}

/** Removes a project library and the dependencies on it. */
export function removeLibrary(
  libraries: readonly LibraryValid[],
  modules: readonly ModuleValid[],
  name: string,
): { libraries: LibraryValid[]; modules: ModuleValid[] } {
  return {
    libraries: libraries.filter((l) => l.name !== name),
    modules: modules.map((m) => ({
      ...m,
      dependencies: m.dependencies.filter((d) => !(d.kind === "library" && d.name === name)),
    })),
  };
}

/** Renames a project library and the dependencies on it. */
export function renameLibrary(
  libraries: readonly LibraryValid[],
  modules: readonly ModuleValid[],
  from: string,
  to: string,
): { libraries: LibraryValid[]; modules: ModuleValid[] } {
  const name = to.trim();
  return {
    libraries: libraries.map((l) => (l.name === from ? { ...l, name } : l)),
    modules: modules.map((m) => ({
      ...m,
      dependencies: m.dependencies.map((d) => (d.kind === "library" && d.name === from ? { ...d, name } : d)),
    })),
  };
}

/** Library name from a jar path: `lib/commons-io-2.15.jar` → `commons-io-2.15`. */
export function libraryNameFor(path: string): string {
  const file = path.replace(/\\/g, "/").split("/").pop() ?? path;
  return file.replace(/\.(jar|zip)$/i, "") || file;
}

/** Java feature versions offered as language levels. */
export const LANGUAGE_LEVELS: readonly string[] = Array.from({ length: 25 - 8 + 1 }, (_, i) => String(25 - i));

export function languageLevelLabel(level: string): string {
  return level === "8" ? "8 - Lambdas, type annotations etc." : level;
}

/**
 * `path` relative to the project when inside it, `/`-separated: how paths are
 * stored (settings stay portable) and shown.
 */
export function projectPath(root: string | null, path: string): string {
  const p = path.replace(/\\/g, "/");
  const r = root?.replace(/\\/g, "/");
  if (r && p === r) return "";
  if (r && p.startsWith(`${r}/`)) return p.slice(r.length + 1);
  return p;
}
