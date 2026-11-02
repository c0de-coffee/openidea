/**
 * File › Project Structure… (IDEA's Project Structure dialog): Project,
 * Modules (Sources / Paths / Dependencies), Libraries and SDKs.
 * `executeAction("file.projectStructure", "modules:<name>")` opens a page.
 */
import { registerActions } from "@/platform/actions";
import { lazyComponent } from "@/ui";
import { registerOverlay } from "@/workbench/contributions";
import { openProjectStructure } from "./store";

const ProjectStructureDialogHost = lazyComponent(() =>
  import("./ProjectStructureDialog").then((m) => m.ProjectStructureDialogHost),
);

export function activate(): () => void {
  const disposers = [
    registerOverlay({ id: "projectStructure.dialog", component: ProjectStructureDialogHost }),
    registerActions([
      {
        id: "file.projectStructure",
        title: "Project Structure…",
        category: "File",
        icon: "module",
        keywords: ["modules", "libraries", "dependencies", "sdk", "jdk", "facets", "language level", "classpath"],
        run: ({ arg }) => openProjectStructure(arg),
      },
    ]),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
