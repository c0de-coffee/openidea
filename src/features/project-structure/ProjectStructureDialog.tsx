/**
 * File › Project Structure… (⌘; / Ctrl+Alt+Shift+S): IDEA's Project Structure
 * dialog. Project Settings › Project / Modules / Libraries and Platform
 * Settings › SDKs on the left, the selected page on the right, OK / Cancel /
 * Apply below.
 *
 * Maven and Gradle modules and their libraries are imported from the build and
 * read-only here (their build file is the place to change them). Modules and
 * project libraries added here are stored in `.openidea/settings.toml`
 * (`projectStructure.modules` / `.libraries`); edits are staged in the
 * settings model until Apply / OK, like the Settings dialog.
 */
import { useId, useMemo, useState, type ReactNode } from "react";
import clsx from "clsx";
import {
  Button,
  Checkbox,
  Dialog,
  Icon,
  IconButton,
  Input,
  List,
  Select,
  Spinner,
  Tabs,
  type DialogButton,
  type IconName,
  type SelectOption,
  T,
} from "@/ui";
import { call, commands, isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { tx, useTx } from "@/platform/i18n";
import {
  DEPENDENCY_SCOPES,
  type DependencyScope,
  type LibraryValid,
  type ModuleDependencyKind,
  type ModuleValid,
} from "@/platform/languageSettings";
import { revealRange } from "@/editor/api";
import { promptInput } from "@/workbench/inputDialogs";
import { confirm } from "@/workbench/messages";
import { PageContext, useSetting } from "@/features/settings/components/context";
import { applySettings, pendingChanges, useSettingsDialog } from "@/features/settings/model/staging";
import { ProjectStructurePage as SourcesTab } from "@/features/settings/languages/ProjectStructurePage";
import { SdkField, tildify, useDetected } from "@/features/settings/languages/components";
import { choosePath } from "@/features/settings/languages/api";
import {
  LANGUAGE_LEVELS,
  addDependencies,
  addLibraryPaths,
  isImported,
  languageLevelLabel,
  libraryNameFor,
  libraryRows,
  moduleRows,
  moveDependency,
  nameProblem,
  newModule,
  originLabel,
  projectPath,
  removeDependency,
  removeLibrary,
  removeModule,
  renameLibrary,
  renameModule,
  updateDependency,
  updateLibrary,
  updateModule,
  type DependencyRow,
  type LibraryRow,
  type ModuleRow,
} from "./model";
import {
  closeProjectStructure,
  loadModules,
  useProjectStructureDialog,
  type ModuleTab,
  type ProjectStructurePage,
} from "./store";
import styles from "./ProjectStructure.module.css";

/** The settings page id staged edits are recorded under. */
const PAGE_ID = "projectStructure";

/** The compiler output folder when none is set (a folder name, not UI text). */
const DEFAULT_OUTPUT = "out";

const SCOPE_LABELS: Record<DependencyScope, string> = {
  compile: "Compile",
  test: "Test",
  runtime: "Runtime",
  provided: "Provided",
};

const NAV: Array<{ group: string; pages: Array<{ id: ProjectStructurePage; label: string; icon: IconName }> }> = [
  {
    group: "Project Settings",
    pages: [
      { id: "project", label: "Project", icon: "folder" },
      { id: "modules", label: "Modules", icon: "module" },
      { id: "libraries", label: "Libraries", icon: "library" },
    ],
  },
  { group: "Platform Settings", pages: [{ id: "sdks", label: "SDKs", icon: "package" }] },
];

function useStaged<T>(key: string): [T, (v: T) => void] {
  return useSetting<T>(key, "project");
}

function useModules(): [ModuleValid[], (v: ModuleValid[]) => void] {
  const [v, set] = useStaged<ModuleValid[] | undefined>("projectStructure.modules");
  return [v ?? [], set];
}

function useLibraries(): [LibraryValid[], (v: LibraryValid[]) => void] {
  const [v, set] = useStaged<LibraryValid[] | undefined>("projectStructure.libraries");
  return [v ?? [], set];
}

/** Jars (or class folders) picked with the system dialog, as stored paths. */
async function chooseClasspath(root: string | null, title: string, directory: boolean): Promise<string[]> {
  if (!isTauri()) return [];
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    title: tx(title),
    directory,
    multiple: true,
    defaultPath: root ?? undefined,
    filters: directory ? undefined : [{ name: "JAR", extensions: ["jar", "zip"] }],
  });
  const list = picked === null ? [] : Array.isArray(picked) ? picked : [picked];
  return list.map((p) => projectPath(root, p));
}

/** Restarts the Java language server so it picks up the new classpath. */
async function restartJdtls() {
  if (!isTauri()) return;
  try {
    const servers = await call(commands.lspServers());
    await Promise.all(
      servers.filter((s) => s.name === "jdtls").map((s) => call(commands.lspRestart(s.id)).catch(() => {})),
    );
  } catch {
    // No language servers in this window.
  }
}

/** Writes the staged edits; true when everything was saved. */
async function apply(): Promise<boolean> {
  const changes = pendingChanges(useSettingsDialog.getState());
  if (!changes.length) return true;
  const ok = await applySettings();
  const java = changes.some((c) => c.key.startsWith("projectStructure.") || c.key.startsWith("languages.java."));
  if (ok) {
    await loadModules();
    if (java) void restartJdtls();
  }
  return ok;
}

export function ProjectStructureDialogHost() {
  const open = useProjectStructureDialog((s) => s.open);
  return open ? <ProjectStructureDialog /> : null;
}

function ProjectStructureDialog() {
  const page = useProjectStructureDialog((s) => s.page);
  const pending = useSettingsDialog((s) => pendingChanges(s).length > 0);
  const saving = useSettingsDialog((s) => s.saving);
  const error = useSettingsDialog((s) => s.error);
  const buttons: DialogButton[] = [
    {
      label: "OK",
      role: "default",
      disabled: saving,
      onClick: () => void apply().then((ok) => ok && closeProjectStructure()),
    },
    { label: "Cancel", role: "cancel", onClick: closeProjectStructure },
    { label: "Apply", role: "extra", disabled: !pending || saving, onClick: () => void apply() },
  ];
  return (
    <Dialog
      open
      title="Project Structure"
      onClose={closeProjectStructure}
      width={1080}
      className={styles.dialog}
      buttons={buttons}
      footerStart={error ? <span className={styles.error}>{error}</span> : undefined}
    >
      <PageContext.Provider value={{ pageId: PAGE_ID, scope: "project" }}>
        <div className={styles.layout}>
          <nav className={styles.nav} aria-label={tx("Project Structure")}>
            {NAV.map((g) => (
              <div key={g.group} className={styles.navGroup}>
                <div className={styles.navTitle}>
                  <T>{g.group}</T>
                </div>
                {g.pages.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={clsx(styles.navItem, page === p.id && styles.navActive)}
                    aria-current={page === p.id ? "page" : undefined}
                    data-autofocus={page === p.id ? "" : undefined}
                    onClick={() => useProjectStructureDialog.setState({ page: p.id })}
                  >
                    <Icon name={p.icon} size={16} />
                    <T>{p.label}</T>
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div className={styles.content}>
            {page === "project" && <ProjectPage />}
            {page === "modules" && <ModulesPage />}
            {page === "libraries" && <LibrariesPage />}
            {page === "sdks" && <SdksPage />}
          </div>
        </div>
      </PageContext.Provider>
    </Dialog>
  );
}

// ---------------------------------------------------------------- shared

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  const tr = useTx();
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{tr(label)}</span>
      <span className={styles.fieldControl}>
        {children}
        {hint && <span className={styles.hint}>{hint}</span>}
      </span>
    </div>
  );
}

function LanguageLevelSelect({
  value,
  onChange,
  emptyLabel,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  emptyLabel: string;
  disabled?: boolean;
}) {
  const options = useMemo<SelectOption[]>(
    () => [
      { value: "", label: emptyLabel },
      ...LANGUAGE_LEVELS.map((l) => ({ value: l, label: languageLevelLabel(l) })),
    ],
    [emptyLabel],
  );
  return (
    <Select
      value={value}
      options={options}
      onChange={onChange}
      disabled={disabled}
      aria-label="Language level"
      className={styles.select}
    />
  );
}

function ImportedNote({ origin, buildFile }: { origin: ModuleRow["origin"]; buildFile: string | null }) {
  const root = useProject((s) => s.project?.root ?? null);
  const tool = originLabel(origin);
  return (
    <div className={styles.banner} role="note">
      <Icon name={origin === "gradle" ? "toolwindow-gradle" : "toolwindow-maven"} size={16} />
      <span>{tx`Imported from ${tool}: changes are made in the build file and picked up on the next sync.`}</span>
      {buildFile && root && (
        <Button
          size="small"
          variant="ghost"
          onClick={() => {
            closeProjectStructure();
            void revealRange(`${root}/${buildFile}`, { start: { line: 0, col: 0 } });
          }}
        >
          {tx`Open ${buildFile}`}
        </Button>
      )}
    </div>
  );
}

function Toolbar({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className={styles.toolbar} role="toolbar" aria-label={tx(label)}>
      {children}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className={styles.empty}>{children}</div>;
}

// ---------------------------------------------------------------- Project

function ProjectPage() {
  const name = useProject((s) => s.project?.name ?? "");
  const root = useProject((s) => s.project?.root ?? null);
  const [jdk, setJdk] = useStaged<string>("languages.java.jdk");
  const [level, setLevel] = useStaged<string>("projectStructure.languageLevel");
  const [output, setOutput] = useStaged<string>("projectStructure.compilerOutput");
  const outputId = useId();
  return (
    <div className={styles.page}>
      <h2 className={styles.heading}>
        <T>Project</T>
      </h2>
      <p className={styles.note}>
        <T>
          Default settings for all modules. Configure these parameters for each module on the module page as needed.
        </T>
      </p>
      <Field label="Name:">
        <Input value={name} readOnly aria-label={tx("Project name")} className={styles.input} />
      </Field>
      <Field label="SDK:">
        <SdkField
          kind="jdk"
          value={jdk ?? ""}
          onChange={setJdk}
          emptyLabel="Auto"
          emptyDetail="per module, the JDK of its Java version"
          directory
          browseTitle="Select JDK Home Directory"
          aria-label="Project SDK"
        />
      </Field>
      <Field label="Language level:">
        <LanguageLevelSelect value={level ?? ""} onChange={setLevel} emptyLabel="SDK default" />
      </Field>
      <Field
        label="Compiler output:"
        hint={<T>Used for module subdirectories, Production and Test directories for the corresponding sources.</T>}
      >
        <span className={styles.pathRow}>
          <Input
            id={outputId}
            value={output ?? ""}
            placeholder={DEFAULT_OUTPUT}
            onChange={(e) => setOutput(e.target.value)}
            aria-label={tx("Compiler output")}
            className={styles.input}
          />
          <IconButton
            icon="folder"
            title={tx("Browse…")}
            onClick={() =>
              void choosePath({ directory: true, title: "Compiler Output", defaultPath: root ?? undefined }).then(
                (p) => p && setOutput(projectPath(root, p)),
              )
            }
          />
        </span>
      </Field>
    </div>
  );
}

// ---------------------------------------------------------------- Modules

function ModulesPage() {
  const root = useProject((s) => s.project?.root ?? null);
  const model = useProjectStructureDialog((s) => s.model);
  const loading = useProjectStructureDialog((s) => s.loading);
  const loadError = useProjectStructureDialog((s) => s.error);
  const selected = useProjectStructureDialog((s) => s.module);
  const [modules, setModules] = useModules();
  const rows = useMemo(() => moduleRows(model, modules), [model, modules]);
  const index = Math.max(
    0,
    rows.findIndex((r) => r.name === selected),
  );
  const current = rows[index] ?? null;
  const select = (name: string | null) => useProjectStructureDialog.setState({ module: name });

  const [creating, setCreating] = useState(false);
  const create = (name: string, contentRoot: string) => {
    setModules([...modules, newModule(name, contentRoot)]);
    select(name);
  };
  const remove = async () => {
    if (!current?.settings) return;
    const ok = await confirm({
      title: "Remove Module",
      message: tx`Remove module '${current.name}' from the project? No files will be deleted.`,
      ok: "Remove",
      icon: "warning",
    });
    if (!ok) return;
    setModules(removeModule(modules, current.name));
    select(null);
  };

  return (
    <div className={styles.master}>
      <div className={styles.masterList}>
        <Toolbar label="Modules">
          <IconButton icon="plus" title={tx("New Module…")} onClick={() => setCreating(true)} />
          <IconButton
            icon="minus"
            title={tx("Remove Module")}
            disabled={!current?.settings}
            onClick={() => void remove()}
          />
          {loading && <Spinner size={14} />}
        </Toolbar>
        <List
          items={rows}
          getKey={(r) => r.name}
          activeIndex={rows.length ? index : -1}
          onActiveChange={(i) => select(rows[i]?.name ?? null)}
          rowHeight={24}
          className={styles.list}
          aria-label="Modules"
          empty={
            <Empty>
              <T>No modules. Maven and Gradle modules are imported from the build; add others with +.</T>
            </Empty>
          }
          renderItem={(r) => (
            <div className={styles.row}>
              <Icon name="module" size={16} />
              <span className={styles.rowName}>{r.name}</span>
              {isImported(r.origin) && <span className={styles.rowHint}>{originLabel(r.origin)}</span>}
            </div>
          )}
        />
        {loadError && <div className={styles.error}>{loadError}</div>}
      </div>
      <div className={styles.detail}>
        {current ? (
          <ModuleDetail key={current.name} module={current} rows={rows} />
        ) : (
          <Empty>
            <T>Select a module to view or edit its sources, paths and dependencies.</T>
          </Empty>
        )}
      </div>
      {creating && (
        <NewModuleDialog
          root={root}
          taken={rows.map((r) => r.name)}
          onCreate={create}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}

/**
 * IDEA's New Module: name and location in one form. The location follows the
 * name until edited; the folder picker opens only from its Browse button, so
 * Enter never lands in a native dialog (where Windows keeps the pointer hidden
 * after typing).
 */
function NewModuleDialog({
  root,
  taken,
  onCreate,
  onClose,
}: {
  root: string | null;
  taken: string[];
  onCreate: (name: string, contentRoot: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [location, setLocation] = useState<string | null>(null);
  const shown = location ?? name.trim();
  const contentRoot = shown
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "");
  const outside = /^([a-zA-Z]:|\/)/.test(contentRoot) || contentRoot.split("/").includes("..");
  const problem = nameProblem(name, taken) ?? (outside ? "The content root must be inside the project folder." : null);
  const submit = async () => {
    if (problem) return;
    if (root && isTauri()) {
      // Like IDEA: the module folder with a `src` source folder (fails harmlessly when it exists).
      const dir = contentRoot ? `${root}/${contentRoot}` : root;
      await call(commands.fsCreateDir(`${dir}/src`)).catch(() => {});
    }
    onCreate(name.trim(), contentRoot);
    onClose();
  };
  const browse = () =>
    void choosePath({ directory: true, title: "Content Root", defaultPath: root ?? undefined }).then(
      (p) => p && setLocation(projectPath(root, p)),
    );
  return (
    <Dialog
      open
      title="New Module"
      onClose={onClose}
      width={520}
      buttons={[
        { label: "Create", role: "default", disabled: !!problem, onClick: () => void submit() },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.form}>
        <Field label="Name:">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label={tx("Module name")}
            className={styles.input}
            data-autofocus=""
          />
        </Field>
        <Field
          label="Content root:"
          hint={
            name.trim() && problem ? (
              <span className={styles.error}>{tx(problem)}</span>
            ) : (
              <T>Relative to the project folder; created with a src folder if missing.</T>
            )
          }
        >
          <span className={styles.pathRow}>
            <Input
              value={shown}
              onChange={(e) => setLocation(e.target.value)}
              aria-label={tx("Content root")}
              className={styles.input}
            />
            <IconButton icon="folder" title={tx("Browse…")} onClick={browse} />
          </span>
        </Field>
      </div>
    </Dialog>
  );
}

function ModuleDetail({ module, rows }: { module: ModuleRow; rows: ModuleRow[] }) {
  const tab = useProjectStructureDialog((s) => s.moduleTab);
  const setTab = (moduleTab: ModuleTab) => useProjectStructureDialog.setState({ moduleTab });
  const [modules, setModules] = useModules();
  const [libraries, setLibraries] = useLibraries();
  const [draftName, setDraftName] = useState(module.name);
  const readOnly = !module.settings;
  const problem = readOnly
    ? null
    : nameProblem(
        draftName,
        rows.map((r) => r.name),
        module.name,
      );
  const commitName = () => {
    if (readOnly || problem || draftName.trim() === module.name) return;
    const name = draftName.trim();
    setModules(renameModule(modules, module.name, name));
    useProjectStructureDialog.setState({ module: name });
  };
  return (
    <div className={styles.moduleDetail}>
      <Field label="Name:" hint={problem ? <span className={styles.error}>{tx(problem)}</span> : undefined}>
        <Input
          value={draftName}
          readOnly={readOnly}
          onChange={(e) => setDraftName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => e.key === "Enter" && commitName()}
          aria-label={tx("Module name")}
          className={styles.input}
        />
      </Field>
      {readOnly && <ImportedNote origin={module.origin} buildFile={module.buildFile} />}
      <Tabs
        variant="compact"
        aria-label="Module settings"
        items={[
          { id: "sources", label: tx("Sources") },
          { id: "paths", label: tx("Paths") },
          { id: "dependencies", label: tx("Dependencies") },
        ]}
        activeId={tab}
        onSelect={(id) => setTab(id as ModuleTab)}
      />
      <div className={styles.tabBody}>
        {tab === "sources" && <SourcesTab module={{ contentRoot: module.contentRoot, name: module.name }} />}
        {tab === "paths" && <PathsTab module={module} modules={modules} setModules={setModules} />}
        {tab === "dependencies" && (
          <DependenciesTab
            module={module}
            rows={rows}
            modules={modules}
            setModules={setModules}
            libraries={libraries}
            setLibraries={setLibraries}
          />
        )}
      </div>
    </div>
  );
}

function PathsTab({
  module,
  modules,
  setModules,
}: {
  module: ModuleRow;
  modules: ModuleValid[];
  setModules: (v: ModuleValid[]) => void;
}) {
  const root = useProject((s) => s.project?.root ?? null);
  const [projectOutput] = useStaged<string>("projectStructure.compilerOutput");
  const m = module.settings;
  if (!m) {
    const out = module.origin === "maven" ? "target/classes, target/test-classes" : "build/classes";
    return (
      <div className={styles.page}>
        <p className={styles.note}>{tx`Compiler output is determined by ${originLabel(module.origin)}: ${out}.`}</p>
      </div>
    );
  }
  const base = (projectOutput || DEFAULT_OUTPUT).replace(/\/+$/, "");
  const set = (patch: Partial<ModuleValid>) => setModules(updateModule(modules, m.name, patch));
  const browse = (key: "output" | "testOutput") =>
    void choosePath({ directory: true, title: "Output Directory", defaultPath: root ?? undefined }).then(
      (p) => p && set({ [key]: projectPath(root, p) }),
    );
  return (
    <div className={styles.page}>
      <div className={styles.section}>
        <T>Compiler Output</T>
      </div>
      <label className={styles.radio}>
        <input type="radio" checked={!m.customOutput} onChange={() => set({ customOutput: false })} />
        <T>Inherit project compile output path</T>
        <span className={styles.rowHint}>
          {base}/production/{m.name}
        </span>
      </label>
      <label className={styles.radio}>
        <input type="radio" checked={m.customOutput} onChange={() => set({ customOutput: true })} />
        <T>Use module compile output path</T>
      </label>
      <Field label="Output path:">
        <span className={styles.pathRow}>
          <Input
            value={m.output}
            disabled={!m.customOutput}
            onChange={(e) => set({ output: e.target.value })}
            aria-label={tx("Output path")}
            className={styles.input}
          />
          <IconButton icon="folder" title={tx("Browse…")} disabled={!m.customOutput} onClick={() => browse("output")} />
        </span>
      </Field>
      <Field label="Test output path:">
        <span className={styles.pathRow}>
          <Input
            value={m.testOutput}
            disabled={!m.customOutput}
            onChange={(e) => set({ testOutput: e.target.value })}
            aria-label={tx("Test output path")}
            className={styles.input}
          />
          <IconButton
            icon="folder"
            title={tx("Browse…")}
            disabled={!m.customOutput}
            onClick={() => browse("testOutput")}
          />
        </span>
      </Field>
    </div>
  );
}

const DEP_ICONS: Record<ModuleDependencyKind, IconName> = { library: "library", module: "module", jar: "file-archive" };

function DependenciesTab({
  module,
  rows,
  modules,
  setModules,
  libraries,
  setLibraries,
}: {
  module: ModuleRow;
  rows: ModuleRow[];
  modules: ModuleValid[];
  setModules: (v: ModuleValid[]) => void;
  libraries: LibraryValid[];
  setLibraries: (v: LibraryValid[]) => void;
}) {
  const root = useProject((s) => s.project?.root ?? null);
  const model = useProjectStructureDialog((s) => s.model);
  const [projectLevel] = useStaged<string>("projectStructure.languageLevel");
  const [active, setActive] = useState(0);
  const [chooser, setChooser] = useState<"library" | "module" | null>(null);
  const m = module.settings;
  const deps: DependencyRow[] = module.dependencies;
  const scopeOptions = useMemo<SelectOption<DependencyScope>[]>(
    () => DEPENDENCY_SCOPES.map((s) => ({ value: s, label: tx(SCOPE_LABELS[s]) })),
    [],
  );
  const allLibraries = useMemo(() => libraryRows(model, libraries, modules), [model, libraries, modules]);

  const addJars = async (directory: boolean) => {
    if (!m) return;
    const paths = await chooseClasspath(root, directory ? "Attach Class Folders" : "Attach JARs", directory);
    if (paths.length)
      setModules(
        addDependencies(
          modules,
          m.name,
          paths.map((name) => ({ kind: "jar", name })),
        ),
      );
  };
  const newLibrary = async () => {
    if (!m) return;
    const classes = await chooseClasspath(root, "New Project Library", false);
    if (!classes.length) return;
    const taken = allLibraries.map((l) => l.name);
    const name = await promptInput({
      title: "New Project Library",
      label: "Library name:",
      initial: libraryNameFor(classes[0]!),
      validate: (v) => nameProblem(v, taken),
    });
    if (!name) return;
    setLibraries([...libraries, { name: name.trim(), classes, sources: [] }]);
    setModules(addDependencies(modules, m.name, [{ kind: "library", name: name.trim() }]));
  };

  return (
    <div className={styles.page}>
      {m ? (
        <>
          <Field label="Module SDK:">
            <SdkField
              kind="jdk"
              value={m.sdk}
              onChange={(sdk) => setModules(updateModule(modules, m.name, { sdk }))}
              emptyLabel="Project SDK"
              directory
              browseTitle="Select JDK Home Directory"
              aria-label="Module SDK"
            />
          </Field>
          <Field label="Language level:">
            <LanguageLevelSelect
              value={m.languageLevel}
              onChange={(languageLevel) => setModules(updateModule(modules, m.name, { languageLevel }))}
              emptyLabel={projectLevel ? tx`Project default (${projectLevel})` : tx("Project default")}
            />
          </Field>
        </>
      ) : (
        module.languageLevel && (
          <Field label="Language level:">
            <Input value={module.languageLevel} readOnly aria-label={tx("Language level")} className={styles.input} />
          </Field>
        )
      )}
      {m && (
        <Toolbar label="Dependencies">
          <Button size="small" variant="ghost" icon="plus" onClick={() => void addJars(false)}>
            <T>JARs…</T>
          </Button>
          <Button size="small" variant="ghost" icon="plus" onClick={() => void addJars(true)}>
            <T>Directories…</T>
          </Button>
          <Button size="small" variant="ghost" icon="plus" onClick={() => setChooser("library")}>
            <T>Library…</T>
          </Button>
          <Button size="small" variant="ghost" icon="plus" onClick={() => void newLibrary()}>
            <T>New Library…</T>
          </Button>
          <Button size="small" variant="ghost" icon="plus" onClick={() => setChooser("module")}>
            <T>Module Dependency…</T>
          </Button>
          <span className={styles.toolbarGap} />
          <IconButton
            icon="minus"
            title={tx("Remove")}
            disabled={!deps[active]}
            onClick={() => {
              setModules(removeDependency(modules, m.name, active));
              setActive(Math.max(0, active - 1));
            }}
          />
          <IconButton
            icon="chevron-up"
            title={tx("Move Up")}
            disabled={active <= 0}
            onClick={() => {
              setModules(moveDependency(modules, m.name, active, -1));
              setActive(active - 1);
            }}
          />
          <IconButton
            icon="chevron-down"
            title={tx("Move Down")}
            disabled={active >= deps.length - 1}
            onClick={() => {
              setModules(moveDependency(modules, m.name, active, 1));
              setActive(active + 1);
            }}
          />
        </Toolbar>
      )}
      <div className={styles.table} role="table" aria-label={tx("Dependencies")}>
        <div className={clsx(styles.tableRow, styles.tableHead)} role="row">
          <span role="columnheader">
            <T>Export</T>
          </span>
          <span role="columnheader">
            <T>Dependency</T>
          </span>
          <span role="columnheader">
            <T>Scope</T>
          </span>
        </div>
        <div className={clsx(styles.tableRow, styles.fixedRow)} role="row">
          <span />
          <span className={styles.depName}>
            <Icon name="package" size={16} />
            {m?.sdk ? tildify(m.sdk) : tx("< Module SDK >")}
          </span>
          <span />
        </div>
        <div className={clsx(styles.tableRow, styles.fixedRow)} role="row">
          <span />
          <span className={styles.depName}>
            <Icon name="folder" size={16} />
            <T>{"< Module source >"}</T>
          </span>
          <span />
        </div>
        {deps.map((d, i) => (
          <div
            key={`${d.kind}:${d.name}`}
            role="row"
            aria-selected={m ? i === active : undefined}
            className={clsx(styles.tableRow, m && i === active && styles.activeRow, d.transitive && styles.transitive)}
            onClick={() => setActive(i)}
          >
            <span>
              <Checkbox
                checked={d.exported}
                disabled={!m}
                onChange={(exported) => m && setModules(updateDependency(modules, m.name, i, { exported }))}
                aria-label={tx`Export ${d.name}`}
              />
            </span>
            <span className={styles.depName} title={d.name}>
              <Icon name={DEP_ICONS[d.kind]} size={16} />
              {d.kind === "jar" ? d.name.split("/").pop() : d.name}
              {d.kind === "jar" && <span className={styles.rowHint}>{d.name}</span>}
              {d.transitive && (
                <span className={styles.rowHint}>
                  <T>transitive</T>
                </span>
              )}
            </span>
            <span>
              {m ? (
                <Select
                  value={d.scope}
                  options={scopeOptions}
                  onChange={(scope) => setModules(updateDependency(modules, m.name, i, { scope }))}
                  aria-label={tx`Scope of ${d.name}`}
                  className={styles.scopeSelect}
                />
              ) : (
                tx(SCOPE_LABELS[d.scope])
              )}
            </span>
          </div>
        ))}
        {deps.length === 0 && (
          <Empty>
            <T>No dependencies.</T>
          </Empty>
        )}
      </div>
      {m && chooser === "library" && (
        <ChooserDialog
          title="Choose Libraries"
          items={allLibraries
            .filter((l) => !deps.some((d) => d.kind === "library" && d.name === l.name))
            .map((l) => ({ name: l.name, icon: "library" as IconName, hint: originLabel(l.origin) }))}
          empty="No libraries to add. Create one with New Library…"
          onClose={() => setChooser(null)}
          onChoose={(names) =>
            setModules(
              addDependencies(
                modules,
                m.name,
                names.map((name) => ({ kind: "library", name })),
              ),
            )
          }
        />
      )}
      {m && chooser === "module" && (
        <ChooserDialog
          title="Choose Modules"
          items={rows
            .filter((r) => r.name !== m.name && !deps.some((d) => d.kind === "module" && d.name === r.name))
            .map((r) => ({ name: r.name, icon: "module" as IconName, hint: originLabel(r.origin) }))}
          empty="No other modules."
          onClose={() => setChooser(null)}
          onChoose={(names) =>
            setModules(
              addDependencies(
                modules,
                m.name,
                names.map((name) => ({ kind: "module", name })),
              ),
            )
          }
        />
      )}
    </div>
  );
}

function ChooserDialog({
  title,
  items,
  empty,
  onChoose,
  onClose,
}: {
  title: string;
  items: Array<{ name: string; icon: IconName; hint: string }>;
  empty: string;
  onChoose: (names: string[]) => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const toggle = (name: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      width={420}
      buttons={[
        {
          label: "Add Selected",
          role: "default",
          disabled: picked.size === 0,
          onClick: () => {
            onChoose([...picked]);
            onClose();
          },
        },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.chooserBody}>
        <div className={styles.chooser}>
          {items.length === 0 && <Empty>{tx(empty)}</Empty>}
          {items.map((it) => (
            <div key={it.name} className={styles.chooserRow}>
              <Checkbox
                checked={picked.has(it.name)}
                onChange={() => toggle(it.name)}
                label={
                  <span className={styles.depName}>
                    <Icon name={it.icon} size={16} />
                    {it.name}
                    {it.hint && <span className={styles.rowHint}>{it.hint}</span>}
                  </span>
                }
              />
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Libraries

function LibrariesPage() {
  const root = useProject((s) => s.project?.root ?? null);
  const model = useProjectStructureDialog((s) => s.model);
  const selected = useProjectStructureDialog((s) => s.library);
  const [modules, setModules] = useModules();
  const [libraries, setLibraries] = useLibraries();
  const rows = useMemo(() => libraryRows(model, libraries, modules), [model, libraries, modules]);
  const index = Math.max(
    0,
    rows.findIndex((r) => r.name === selected),
  );
  const current = rows[index] ?? null;
  const select = (name: string | null) => useProjectStructureDialog.setState({ library: name });

  const add = async () => {
    const classes = await chooseClasspath(root, "New Project Library", false);
    if (!classes.length) return;
    const name = await promptInput({
      title: "New Project Library",
      label: "Library name:",
      initial: libraryNameFor(classes[0]!),
      validate: (v) =>
        nameProblem(
          v,
          rows.map((r) => r.name),
        ),
    });
    if (!name) return;
    setLibraries([...libraries, { name: name.trim(), classes, sources: [] }]);
    select(name.trim());
  };
  const remove = async () => {
    if (!current?.settings) return;
    const users = current.usedBy.length;
    const ok = await confirm({
      title: "Remove Library",
      message:
        users > 0
          ? tx`Remove library '${current.name}'? It is used by ${users} module(s); their dependencies on it are removed too.`
          : tx`Remove library '${current.name}'?`,
      ok: "Remove",
      icon: "warning",
    });
    if (!ok) return;
    const next = removeLibrary(libraries, modules, current.name);
    setLibraries(next.libraries);
    setModules(next.modules);
    select(null);
  };

  return (
    <div className={styles.master}>
      <div className={styles.masterList}>
        <Toolbar label="Libraries">
          <IconButton icon="plus" title={tx("New Project Library…")} onClick={() => void add()} />
          <IconButton
            icon="minus"
            title={tx("Remove Library")}
            disabled={!current?.settings}
            onClick={() => void remove()}
          />
        </Toolbar>
        <List
          items={rows}
          getKey={(r) => r.name}
          activeIndex={rows.length ? index : -1}
          onActiveChange={(i) => select(rows[i]?.name ?? null)}
          rowHeight={24}
          className={styles.list}
          aria-label="Libraries"
          empty={
            <Empty>
              <T>Nothing to show</T>
            </Empty>
          }
          renderItem={(r) => (
            <div className={styles.row}>
              <Icon name="library" size={16} />
              <span className={styles.rowName}>{r.name}</span>
            </div>
          )}
        />
      </div>
      <div className={styles.detail}>
        {current ? (
          <LibraryDetail
            key={current.name}
            library={current}
            rows={rows}
            libraries={libraries}
            setLibraries={setLibraries}
            modules={modules}
            setModules={setModules}
          />
        ) : (
          <Empty>
            <T>Select a library to view or edit its contents.</T>
          </Empty>
        )}
      </div>
    </div>
  );
}

function LibraryDetail({
  library,
  rows,
  libraries,
  setLibraries,
  modules,
  setModules,
}: {
  library: LibraryRow;
  rows: LibraryRow[];
  libraries: LibraryValid[];
  setLibraries: (v: LibraryValid[]) => void;
  modules: ModuleValid[];
  setModules: (v: ModuleValid[]) => void;
}) {
  const root = useProject((s) => s.project?.root ?? null);
  const [draftName, setDraftName] = useState(library.name);
  const editable = !!library.settings;
  const usedBy = library.usedBy.join(", ");
  const problem = editable
    ? nameProblem(
        draftName,
        rows.map((r) => r.name),
        library.name,
      )
    : null;
  const commitName = () => {
    if (!editable || problem || draftName.trim() === library.name) return;
    const next = renameLibrary(libraries, modules, library.name, draftName);
    setLibraries(next.libraries);
    setModules(next.modules);
    useProjectStructureDialog.setState({ library: draftName.trim() });
  };
  const addPaths = async (part: "classes" | "sources", directory: boolean) => {
    const paths = await chooseClasspath(root, part === "classes" ? "Attach Classes" : "Attach Sources", directory);
    if (paths.length) setLibraries(addLibraryPaths(libraries, library.name, part, paths));
  };
  const removePath = (part: "classes" | "sources", path: string) =>
    setLibraries(updateLibrary(libraries, library.name, { [part]: library[part].filter((p) => p !== path) }));

  const section = (part: "classes" | "sources", title: string, icon: IconName) => (
    <div className={styles.libSection}>
      <div className={styles.section}>
        <Icon name={icon} size={16} />
        <T>{title}</T>
        {editable && (
          <>
            <span className={styles.toolbarGap} />
            <Button size="small" variant="ghost" icon="plus" onClick={() => void addPaths(part, false)}>
              <T>JARs…</T>
            </Button>
            <Button size="small" variant="ghost" icon="plus" onClick={() => void addPaths(part, true)}>
              <T>Directories…</T>
            </Button>
          </>
        )}
      </div>
      {library[part].length === 0 && (
        <div className={styles.note}>
          {isImported(library.origin) && part === "classes" ? (
            <T>Not downloaded to the local repository yet. Sync the build to download it.</T>
          ) : (
            <T>None</T>
          )}
        </div>
      )}
      {library[part].map((p) => (
        <div key={p} className={styles.pathItem}>
          <Icon name={/\.(jar|zip)$/i.test(p) ? "file-archive" : "folder"} size={14} />
          <span className={styles.rowName} title={p}>
            {tildify(projectPath(root, p))}
          </span>
          {editable && (
            <IconButton
              icon="close"
              size="small"
              iconSize={12}
              title={tx`Remove ${p}`}
              onClick={() => removePath(part, p)}
            />
          )}
        </div>
      ))}
    </div>
  );

  return (
    <div className={styles.page}>
      <Field label="Name:" hint={problem ? <span className={styles.error}>{tx(problem)}</span> : undefined}>
        <Input
          value={draftName}
          readOnly={!editable}
          onChange={(e) => setDraftName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => e.key === "Enter" && commitName()}
          aria-label={tx("Library name")}
          className={styles.input}
        />
      </Field>
      {isImported(library.origin) && <ImportedNote origin={library.origin} buildFile={null} />}
      {section("classes", "Classes", "file-archive")}
      {section("sources", "Sources", "folder")}
      <div className={styles.note}>{usedBy ? tx`Used by: ${usedBy}` : tx("Not used by any module.")}</div>
    </div>
  );
}

// ---------------------------------------------------------------- SDKs

function SdksPage() {
  const { list, loading, refresh } = useDetected("jdk");
  const [projectJdk] = useStaged<string>("languages.java.jdk");
  const [active, setActive] = useState(0);
  const current = list[active];
  return (
    <div className={styles.master}>
      <div className={styles.masterList}>
        <Toolbar label="SDKs">
          <IconButton icon="refresh" title={tx("Detect Again")} onClick={refresh} />
          {loading && <Spinner size={14} />}
        </Toolbar>
        <List
          items={list}
          getKey={(s) => s.path}
          activeIndex={list.length ? Math.min(active, list.length - 1) : -1}
          onActiveChange={setActive}
          rowHeight={24}
          className={styles.list}
          aria-label="SDKs"
          empty={
            <Empty>
              {loading ? <T>Detecting JDKs…</T> : <T>No JDKs found. Download one from the Project page's SDK list.</T>}
            </Empty>
          }
          renderItem={(s) => (
            <div className={styles.row}>
              <Icon name="package" size={16} />
              <span className={styles.rowName}>{s.name}</span>
              {(s.home ?? s.path) === projectJdk && (
                <span className={styles.rowHint}>
                  <T>Project SDK</T>
                </span>
              )}
            </div>
          )}
        />
      </div>
      <div className={styles.detail}>
        {current ? (
          <div className={styles.page}>
            <Field label="Name:">
              <Input value={current.name} readOnly aria-label={tx("SDK name")} className={styles.input} />
            </Field>
            <Field label="Version:">
              <Input value={current.version ?? ""} readOnly aria-label={tx("SDK version")} className={styles.input} />
            </Field>
            <Field label="JDK home path:">
              <Input
                value={current.home ?? current.path}
                readOnly
                aria-label={tx("JDK home path")}
                className={styles.input}
              />
            </Field>
            <p className={styles.note}>
              <T>Choose the Project SDK on the Project page, or a Module SDK on a module's Dependencies tab.</T>
            </p>
          </div>
        ) : (
          <Empty>
            <T>Nothing to show</T>
          </Empty>
        )}
      </div>
    </div>
  );
}
