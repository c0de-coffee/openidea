import { describe, expect, it } from "vitest";
import type { ProjectModules } from "@/bindings";
import type { LibraryValid, ModuleValid } from "@/platform/languageSettings";
import {
  addDependencies,
  addLibraryPaths,
  libraryNameFor,
  libraryRows,
  moduleRows,
  moveDependency,
  nameProblem,
  newModule,
  projectPath,
  removeDependency,
  removeLibrary,
  removeModule,
  renameLibrary,
  renameModule,
  updateDependency,
} from "./model";

const backend: ProjectModules = {
  modules: [
    {
      name: "core",
      contentRoot: "core",
      origin: "maven",
      buildFile: "core/pom.xml",
      languageLevel: 17,
      dependencies: [
        { kind: "library", name: "Maven: junit:junit:4.13", scope: "test", exported: false, transitive: false },
      ],
    },
    // The backend's copy of a manual module is replaced by the staged one.
    { name: "old", contentRoot: "", origin: "manual", buildFile: null, languageLevel: null, dependencies: [] },
  ],
  libraries: [
    {
      name: "Maven: junit:junit:4.13",
      origin: "maven",
      coordinate: { groupId: "junit", artifactId: "junit", version: "4.13" },
      classes: ["/m2/junit-4.13.jar"],
      sources: [],
      usedBy: ["core"],
    },
  ],
};

const tool = (): ModuleValid => ({
  ...newModule("tool", "tool"),
  dependencies: [
    { kind: "library", name: "commons", scope: "compile", exported: false },
    { kind: "module", name: "util", scope: "compile", exported: true },
    { kind: "jar", name: "lib/x.jar", scope: "test", exported: false },
  ],
});
const util = (): ModuleValid => newModule("util", "util");
const commons = (): LibraryValid => ({ name: "commons", classes: ["lib/commons.jar"], sources: [] });

describe("project structure model", () => {
  it("lists imported modules, then staged manual ones", () => {
    const rows = moduleRows(backend, [tool(), util()]);
    expect(rows.map((r) => [r.name, r.origin, r.languageLevel])).toEqual([
      ["core", "maven", "17"],
      ["tool", "manual", ""],
      ["util", "manual", ""],
    ]);
    expect(rows[0]!.settings).toBeNull();
    expect(rows[1]!.dependencies[1]).toEqual({
      kind: "module",
      name: "util",
      scope: "compile",
      exported: true,
      transitive: false,
    });
  });

  it("lists libraries with the modules using them", () => {
    const withJunit = {
      ...util(),
      dependencies: [{ kind: "library", name: "Maven: junit:junit:4.13", scope: "test", exported: false }],
    } as ModuleValid;
    const rows = libraryRows(backend, [commons()], [tool(), withJunit]);
    expect(rows.map((r) => [r.name, r.origin, r.usedBy])).toEqual([
      ["Maven: junit:junit:4.13", "maven", ["core", "util"]],
      ["commons", "manual", ["tool"]],
    ]);
    expect(rows[0]!.coordinate).toBe("junit:junit:4.13");
  });

  it("validates names", () => {
    expect(nameProblem("  ", [])).toBe("Enter a name");
    expect(nameProblem("core", ["core"])).toBe("'core' already exists");
    expect(nameProblem("core", ["core"], "core")).toBeNull();
    expect(nameProblem("new", ["core"])).toBeNull();
  });

  it("renames and removes modules with the dependencies on them", () => {
    const renamed = renameModule([tool(), util()], "util", "shared");
    expect(renamed.map((m) => m.name)).toEqual(["tool", "shared"]);
    expect(renamed[0]!.dependencies[1]!.name).toBe("shared");
    const removed = removeModule([tool(), util()], "util");
    expect(removed.map((m) => m.name)).toEqual(["tool"]);
    expect(removed[0]!.dependencies.map((d) => d.name)).toEqual(["commons", "lib/x.jar"]);
  });

  it("edits dependencies", () => {
    let mods = addDependencies([tool(), util()], "tool", [
      { kind: "jar", name: "lib/x.jar" },
      { kind: "jar", name: "lib/y.jar" },
      { kind: "module", name: "tool" },
    ]);
    expect(mods[0]!.dependencies.map((d) => d.name)).toEqual(["commons", "util", "lib/x.jar", "lib/y.jar"]);
    mods = moveDependency(mods, "tool", 3, -1);
    expect(mods[0]!.dependencies.map((d) => d.name)).toEqual(["commons", "util", "lib/y.jar", "lib/x.jar"]);
    expect(moveDependency(mods, "tool", 0, -1)).toEqual(mods);
    mods = updateDependency(mods, "tool", 0, { scope: "provided", exported: true });
    expect(mods[0]!.dependencies[0]).toMatchObject({ scope: "provided", exported: true });
    mods = removeDependency(mods, "tool", 1);
    expect(mods[0]!.dependencies.map((d) => d.name)).toEqual(["commons", "lib/y.jar", "lib/x.jar"]);
  });

  it("renames and removes project libraries with the dependencies on them", () => {
    const r = renameLibrary([commons()], [tool()], "commons", "apache-commons");
    expect(r.libraries[0]!.name).toBe("apache-commons");
    expect(r.modules[0]!.dependencies[0]!.name).toBe("apache-commons");
    const d = removeLibrary([commons()], [tool()], "commons");
    expect(d.libraries).toEqual([]);
    expect(d.modules[0]!.dependencies.map((x) => x.kind)).toEqual(["module", "jar"]);
    expect(addLibraryPaths([commons()], "commons", "classes", ["lib/commons.jar", "lib/b.jar"])[0]!.classes).toEqual([
      "lib/commons.jar",
      "lib/b.jar",
    ]);
  });

  it("names libraries and paths", () => {
    expect(libraryNameFor("C:\\libs\\commons-io-2.15.jar")).toBe("commons-io-2.15");
    expect(projectPath("C:/p", "C:\\p\\lib\\a.jar")).toBe("lib/a.jar");
    expect(projectPath("/p", "/p")).toBe("");
    expect(projectPath("/p", "/other/a.jar")).toBe("/other/a.jar");
  });
});
