//! The project's modules, their dependencies and the libraries they use
//! (Project Structure › Modules / Libraries).
//!
//! Maven and Gradle modules are imported from the build model and are
//! read-only: they change with the build files. Modules and libraries added by
//! hand come from `projectStructure.modules` / `projectStructure.libraries`.

use crate::BuildModel;
use crate::gradle::{self, ScriptTarget};
use crate::maven::MavenDependency;
use ide_core::settings::{DependencyScope, ModuleDependencyKind, ProjectStructureSettings};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectModules {
    pub modules: Vec<ModuleInfo>,
    /// Imported libraries first (sorted by name), then project libraries in settings order.
    pub libraries: Vec<LibraryInfo>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ModuleOrigin {
    Maven,
    Gradle,
    /// Added in Project Structure (editable).
    Manual,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ModuleInfo {
    pub name: String,
    /// Project-relative content root; `""` = the project folder.
    pub content_root: String,
    pub origin: ModuleOrigin,
    /// The `pom.xml` / build script it was imported from (project-relative).
    pub build_file: Option<String>,
    /// Java version the build compiles the module for.
    pub language_level: Option<u32>,
    pub dependencies: Vec<ModuleDependency>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ModuleDependency {
    pub kind: ModuleDependencyKind,
    /// Library or module name; the path for `jar`.
    pub name: String,
    pub scope: DependencyScope,
    pub exported: bool,
    /// Pulled in by another dependency rather than declared.
    pub transitive: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LibraryCoordinate {
    pub group_id: String,
    pub artifact_id: String,
    pub version: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LibraryInfo {
    /// `Maven: g:a:v`, `Gradle: g:a:v`, or the project library's name.
    pub name: String,
    pub origin: ModuleOrigin,
    pub coordinate: Option<LibraryCoordinate>,
    /// Jars / class folders. Imported libraries: the jar in the local repository, when downloaded.
    pub classes: Vec<String>,
    /// Source jars / folders.
    pub sources: Vec<String>,
    /// Names of the modules that depend on it.
    pub used_by: Vec<String>,
}

fn maven_scope(scope: &str) -> DependencyScope {
    match scope {
        "test" => DependencyScope::Test,
        "runtime" => DependencyScope::Runtime,
        "provided" | "system" => DependencyScope::Provided,
        _ => DependencyScope::Compile,
    }
}

/// Gradle configuration → scope, and whether it is exported (`api`).
fn gradle_scope(configuration: &str) -> (DependencyScope, bool) {
    let c = configuration;
    if c.starts_with("test") {
        (DependencyScope::Test, false)
    } else if c.ends_with("ompileOnly")
        || c.ends_with("ompileOnlyApi")
        || matches!(c, "annotationProcessor" | "kapt" | "ksp")
    {
        (DependencyScope::Provided, false)
    } else if c.ends_with("untimeOnly") || c == "runtime" || c == "developmentOnly" {
        (DependencyScope::Runtime, false)
    } else {
        (DependencyScope::Compile, c == "api" || c.ends_with("Api"))
    }
}

/// Collects libraries and the modules using them.
#[derive(Default)]
struct Libraries {
    by_name: BTreeMap<String, LibraryInfo>,
}

impl Libraries {
    fn use_imported(&mut self, origin: ModuleOrigin, c: LibraryCoordinate, module: &str) -> String {
        let tool = if origin == ModuleOrigin::Gradle { "Gradle" } else { "Maven" };
        let name = format!("{tool}: {}:{}:{}", c.group_id, c.artifact_id, c.version);
        let lib = self.by_name.entry(name.clone()).or_insert_with(|| LibraryInfo {
            name: name.clone(),
            origin,
            coordinate: Some(c),
            classes: Vec::new(),
            sources: Vec::new(),
            used_by: Vec::new(),
        });
        if !lib.used_by.iter().any(|m| m == module) {
            lib.used_by.push(module.to_owned());
        }
        name
    }
}

/// Unique module names: a repeated name gets its content root appended (`core (libs/core)`).
fn dedupe_names(modules: &mut [ModuleInfo]) {
    let mut count: HashMap<String, usize> = HashMap::new();
    for m in modules.iter() {
        *count.entry(m.name.clone()).or_default() += 1;
    }
    for m in modules.iter_mut() {
        if count[&m.name] > 1 && !m.content_root.is_empty() {
            m.name = format!("{} ({})", m.name, m.content_root);
        }
    }
}

fn version_of(d: &MavenDependency) -> Option<&str> {
    d.version.as_deref().filter(|v| !v.is_empty() && !v.contains("${"))
}

/// Modules and libraries of the project: imported from `model`, plus the ones in `ps`.
pub fn project_modules(root: &Path, model: &BuildModel, ps: &ProjectStructureSettings) -> ProjectModules {
    let mut modules = Vec::new();
    let mut libs = Libraries::default();

    if let Some(m) = &model.maven {
        let names: HashMap<String, String> = m.projects.iter().map(|p| (p.key(), p.artifact_id.clone())).collect();
        for p in &m.projects {
            let mut deps: Vec<ModuleDependency> = Vec::new();
            let mut seen: HashSet<String> = HashSet::new();
            // Breadth-first: declared dependencies first, then what they pull in.
            let mut queue: Vec<(&MavenDependency, bool)> = p.dependencies.iter().map(|d| (d, false)).collect();
            let mut i = 0;
            while i < queue.len() {
                let (d, transitive) = queue[i];
                i += 1;
                if !d.resolved() || d.kind == "pom" || d.scope == "import" {
                    continue;
                }
                queue.extend(d.children.iter().map(|c| (c, true)));
                let key = format!("{}:{}", d.group_id, d.artifact_id);
                if !seen.insert(key.clone()) {
                    continue;
                }
                let scope = maven_scope(&d.scope);
                let (kind, name) = if let Some(module) = names.get(&key) {
                    (ModuleDependencyKind::Module, module.clone())
                } else if let Some(version) = version_of(d) {
                    let c = LibraryCoordinate {
                        group_id: d.group_id.clone(),
                        artifact_id: d.artifact_id.clone(),
                        version: version.to_owned(),
                    };
                    (ModuleDependencyKind::Library, libs.use_imported(ModuleOrigin::Maven, c, &p.artifact_id))
                } else {
                    continue;
                };
                deps.push(ModuleDependency { kind, name, scope, exported: false, transitive });
            }
            modules.push(ModuleInfo {
                name: p.artifact_id.clone(),
                content_root: p.dir.clone(),
                origin: ModuleOrigin::Maven,
                build_file: Some(p.pom.clone()),
                language_level: p.java_version,
                dependencies: deps,
            });
        }
    }

    if let Some(g) = &model.gradle {
        let names: HashMap<&str, &str> = g.projects.iter().map(|p| (p.path.as_str(), p.name.as_str())).collect();
        for p in &g.projects {
            let text = p.build_file.as_ref().and_then(|f| std::fs::read_to_string(root.join(f)).ok());
            let mut deps: Vec<ModuleDependency> = Vec::new();
            for d in text.as_deref().map(gradle::script_declarations).unwrap_or_default() {
                let (scope, exported) = gradle_scope(&d.configuration);
                let (kind, name) = match d.target {
                    ScriptTarget::Project(path) => {
                        let Some(name) = names.get(path.as_str()) else { continue };
                        (ModuleDependencyKind::Module, (*name).to_owned())
                    }
                    ScriptTarget::External { group, artifact, version } => {
                        let c = LibraryCoordinate { group_id: group, artifact_id: artifact, version };
                        (ModuleDependencyKind::Library, libs.use_imported(ModuleOrigin::Gradle, c, &p.name))
                    }
                };
                if !deps.iter().any(|x| x.kind == kind && x.name == name) {
                    deps.push(ModuleDependency { kind, name, scope, exported, transitive: false });
                }
            }
            let level = text.as_deref().and_then(gradle::script_java_version).or(g.java_version);
            modules.push(ModuleInfo {
                name: p.name.clone(),
                content_root: p.dir.clone(),
                origin: ModuleOrigin::Gradle,
                build_file: p.build_file.clone(),
                language_level: level,
                dependencies: deps,
            });
        }
    }

    dedupe_names(&mut modules);

    let mut libraries: Vec<LibraryInfo> = libs.by_name.into_values().collect();
    for l in &ps.libraries {
        let name = l.name.trim();
        if name.is_empty() || libraries.iter().any(|x| x.name == name) {
            continue;
        }
        libraries.push(LibraryInfo {
            name: name.to_owned(),
            origin: ModuleOrigin::Manual,
            coordinate: None,
            classes: l.classes.clone(),
            sources: l.sources.clone(),
            used_by: Vec::new(),
        });
    }

    for m in &ps.modules {
        let name = m.name.trim();
        if name.is_empty() || modules.iter().any(|x| x.name == name) {
            continue;
        }
        let dependencies: Vec<ModuleDependency> = m
            .dependencies
            .iter()
            .filter(|d| !d.name.trim().is_empty())
            .map(|d| ModuleDependency {
                kind: d.kind,
                name: d.name.trim().to_owned(),
                scope: d.scope,
                exported: d.exported,
                transitive: false,
            })
            .collect();
        for d in dependencies.iter().filter(|d| d.kind == ModuleDependencyKind::Library) {
            if let Some(lib) = libraries.iter_mut().find(|l| l.name == d.name)
                && !lib.used_by.iter().any(|u| u == name)
            {
                lib.used_by.push(name.to_owned());
            }
        }
        modules.push(ModuleInfo {
            name: name.to_owned(),
            content_root: crate::normalize_rel(&m.content_root),
            origin: ModuleOrigin::Manual,
            build_file: None,
            language_level: m.language_level.trim().parse().ok(),
            dependencies,
        });
    }

    ProjectModules { modules, libraries }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gradle::{GradleModel, GradleProject};
    use crate::maven::{MavenModel, MavenProject};
    use ide_core::settings::{LibrarySettings, ModuleDependencySettings, ModuleSettings};

    fn dep(g: &str, a: &str, v: &str, scope: &str) -> MavenDependency {
        MavenDependency {
            group_id: g.into(),
            artifact_id: a.into(),
            version: Some(v.into()),
            kind: "jar".into(),
            scope: scope.into(),
            ..Default::default()
        }
    }

    #[test]
    fn maven_reactor_modules_libraries_and_transitive_deps() {
        let mut guava = dep("com.google.guava", "guava", "33.0", "compile");
        guava.children = vec![dep("com.google.guava", "failureaccess", "1.0", "compile")];
        let core = MavenProject {
            pom: "core/pom.xml".into(),
            dir: "core".into(),
            group_id: "g".into(),
            artifact_id: "core".into(),
            dependencies: vec![guava, dep("junit", "junit", "4.13", "test")],
            java_version: Some(17),
            ..Default::default()
        };
        let app = MavenProject {
            pom: "app/pom.xml".into(),
            dir: "app".into(),
            group_id: "g".into(),
            artifact_id: "app".into(),
            dependencies: vec![dep("g", "core", "1.0", "compile"), dep("junit", "junit", "4.13", "test")],
            ..Default::default()
        };
        let model =
            BuildModel { maven: Some(MavenModel { projects: vec![core, app], ..Default::default() }), gradle: None };
        let pm = project_modules(Path::new("/nonexistent"), &model, &ProjectStructureSettings::default());
        assert_eq!(pm.modules.len(), 2);
        let core = &pm.modules[0];
        assert_eq!(core.language_level, Some(17));
        let names: Vec<(&str, DependencyScope, bool)> =
            core.dependencies.iter().map(|d| (d.name.as_str(), d.scope, d.transitive)).collect();
        assert_eq!(
            names,
            vec![
                ("Maven: com.google.guava:guava:33.0", DependencyScope::Compile, false),
                ("Maven: junit:junit:4.13", DependencyScope::Test, false),
                ("Maven: com.google.guava:failureaccess:1.0", DependencyScope::Compile, true),
            ]
        );
        let app = &pm.modules[1];
        assert_eq!(app.dependencies[0].kind, ModuleDependencyKind::Module);
        assert_eq!(app.dependencies[0].name, "core");
        let junit = pm.libraries.iter().find(|l| l.name == "Maven: junit:junit:4.13").unwrap();
        assert_eq!(junit.used_by, vec!["core", "app"]);
        assert_eq!(pm.libraries.len(), 3);
    }

    #[test]
    fn gradle_configurations_map_to_scopes() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("app")).unwrap();
        std::fs::write(
            tmp.path().join("app/build.gradle"),
            "dependencies {\n  api 'a:b:1'\n  implementation project(':lib')\n  compileOnly 'c:d:2'\n  testImplementation(\"e:f:3\")\n  runtimeOnly 'g:h:4'\n}\n",
        )
        .unwrap();
        let model = BuildModel {
            maven: None,
            gradle: Some(GradleModel {
                projects: vec![
                    GradleProject {
                        path: ":app".into(),
                        name: "app".into(),
                        dir: "app".into(),
                        build_file: Some("app/build.gradle".into()),
                        tasks: vec![],
                    },
                    GradleProject { path: ":lib".into(), name: "lib".into(), dir: "lib".into(), ..Default::default() },
                ],
                ..Default::default()
            }),
        };
        let pm = project_modules(tmp.path(), &model, &ProjectStructureSettings::default());
        let deps: Vec<(&str, DependencyScope, bool)> =
            pm.modules[0].dependencies.iter().map(|d| (d.name.as_str(), d.scope, d.exported)).collect();
        assert_eq!(
            deps,
            vec![
                ("Gradle: a:b:1", DependencyScope::Compile, true),
                ("lib", DependencyScope::Compile, false),
                ("Gradle: c:d:2", DependencyScope::Provided, false),
                ("Gradle: e:f:3", DependencyScope::Test, false),
                ("Gradle: g:h:4", DependencyScope::Runtime, false),
            ]
        );
    }

    #[test]
    fn manual_modules_and_libraries() {
        let ps = ProjectStructureSettings {
            libraries: vec![LibrarySettings {
                name: "commons".into(),
                classes: vec!["lib/commons.jar".into()],
                sources: vec!["lib/commons-sources.jar".into()],
            }],
            modules: vec![ModuleSettings {
                name: "tool".into(),
                content_root: "./tool/".into(),
                language_level: "21".into(),
                dependencies: vec![
                    ModuleDependencySettings { name: "commons".into(), ..Default::default() },
                    ModuleDependencySettings {
                        kind: ModuleDependencyKind::Jar,
                        name: "/opt/x.jar".into(),
                        scope: DependencyScope::Test,
                        exported: false,
                    },
                ],
                ..Default::default()
            }],
            ..Default::default()
        };
        let pm = project_modules(Path::new("/p"), &BuildModel::default(), &ps);
        assert_eq!(pm.modules[0].content_root, "tool");
        assert_eq!(pm.modules[0].language_level, Some(21));
        assert_eq!(pm.libraries[0].used_by, vec!["tool"]);
        assert_eq!(
            ps.manual_classpath(),
            vec![
                ("lib/commons.jar".to_owned(), Some("lib/commons-sources.jar".to_owned())),
                ("/opt/x.jar".to_owned(), None),
            ]
        );
    }
}
