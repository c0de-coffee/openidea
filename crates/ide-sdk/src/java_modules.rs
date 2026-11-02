//! Project Structure modules for jdtls in projects without a Maven / Gradle build.
//!
//! Like IDEA, each module compiles on its own: its source folders, its jars and
//! libraries, and the modules it depends on. jdtls models that with one Eclipse
//! project per module, so we generate them (`.project` with linked source
//! folders, `.classpath`, compiler settings) in the app's data folder and make
//! that folder jdtls' only workspace folder. Nothing is written to the user's
//! project, and Eclipse files lying around in it (old `.project` / `.classpath`
//! with machine-specific paths) are not imported.

use crate::apply::{merge_init_options, setting_path};
use ide_core::settings::{DependencyScope, ModuleDependencyKind, ProjectStructureSettings, Settings};
use ide_language::LanguageServerConfig;
use serde_json::json;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

/// Build files that own the classpath: Maven / Gradle projects are imported from them.
const BUILD_FILES: &[&str] = &["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"];

/// Whether jdtls gets its projects from Project Structure (hand-made modules, no build tool).
pub fn active(root: &Path, s: &Settings) -> bool {
    !s.project_structure.modules.is_empty() && !BUILD_FILES.iter().any(|f| root.join(f).is_file())
}

/// One generated Eclipse project: its folder name and files.
#[derive(Debug, Clone, PartialEq)]
pub struct ModuleProject {
    pub name: String,
    pub dot_project: String,
    pub classpath: String,
    /// `.settings/org.eclipse.jdt.core.prefs`, when the module has a language level.
    pub prefs: Option<String>,
}

/// `/`-separated, no leading `./` or `/`, no trailing `/`; `""` = the project folder.
fn rel(p: &str) -> String {
    let p = p.trim().replace('\\', "/");
    let p = p.trim_start_matches("./").trim_matches('/');
    if p == "." { String::new() } else { p.to_owned() }
}

fn inside(p: &str, dir: &str) -> bool {
    dir.is_empty() || p == dir || p.starts_with(&format!("{dir}/"))
}

/// Eclipse resource names cannot contain these.
fn resource_name(s: &str) -> String {
    let n: String = s.chars().map(|c| if "/\\:*?\"<>|".contains(c) || c.is_control() { '_' } else { c }).collect();
    let n = n.trim().trim_matches('.').to_owned();
    if n.is_empty() { "module".to_owned() } else { n }
}

fn xml(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn abs(root: &Path, p: &str) -> Option<String> {
    setting_path(root, p).map(|p| p.to_string_lossy().replace('\\', "/"))
}

/// Eclipse compliance for a Java feature version (`"8"` → `"1.8"`).
fn compliance(level: &str) -> Option<String> {
    let n: u32 = level.trim().trim_start_matches("1.").parse().ok()?;
    Some(if n <= 8 { format!("1.{n}") } else { n.to_string() })
}

struct Root {
    path: String,
    test: bool,
}

/// The Eclipse projects for the hand-made modules of the project at `root`.
pub fn module_projects(root: &Path, ps: &ProjectStructureSettings) -> Vec<ModuleProject> {
    let contents: Vec<String> = ps.modules.iter().map(|m| rel(&m.content_root)).collect();
    // A marked folder belongs to the innermost module containing it.
    let owner = |p: &str| (0..contents.len()).filter(|&i| inside(p, &contents[i])).max_by_key(|&i| contents[i].len());
    let marked: Vec<Root> = ps
        .source_roots
        .iter()
        .map(|p| Root { path: rel(p), test: false })
        .chain(ps.test_roots.iter().map(|p| Root { path: rel(p), test: true }))
        .collect();
    let excluded: Vec<String> = ps.excluded.iter().map(|p| rel(p)).filter(|p| !p.is_empty()).collect();

    // Unique project names, referenced by the modules depending on them.
    let mut names: Vec<String> = Vec::new();
    for m in &ps.modules {
        let base = resource_name(&m.name);
        let mut name = base.clone();
        let mut n = 2;
        while names.iter().any(|x| x.eq_ignore_ascii_case(&name)) {
            name = format!("{base}_{n}");
            n += 1;
        }
        names.push(name);
    }
    let project_of = |module: &str| ps.modules.iter().position(|m| m.name.trim() == module.trim()).map(|i| &names[i]);
    let all_roots: Vec<&str> = marked.iter().map(|r| r.path.as_str()).collect();

    let mut out = Vec::new();
    for (i, m) in ps.modules.iter().enumerate() {
        let dir = &contents[i];
        let mut roots: Vec<Root> = marked
            .iter()
            .filter(|r| owner(&r.path) == Some(i))
            .map(|r| Root { path: r.path.clone(), test: r.test })
            .collect();
        if roots.is_empty() {
            // Like IDEA's new module: `<module>/src`, else the module folder itself
            // (unless other modules live inside it).
            let src = if dir.is_empty() { "src".to_owned() } else { format!("{dir}/src") };
            if root.join(&src).is_dir() {
                roots.push(Root { path: src, test: false });
            } else if !contents.iter().any(|c| c != dir && inside(c, dir)) {
                roots.push(Root { path: dir.clone(), test: false });
            }
        }

        let mut links = String::new();
        let mut entries = String::new();
        let mut used: Vec<String> = Vec::new();
        for r in &roots {
            let base = resource_name(if r.path.is_empty() { "root" } else { &r.path });
            let mut link = base.clone();
            let mut n = 2;
            while used.contains(&link) {
                link = format!("{base}_{n}");
                n += 1;
            }
            used.push(link.clone());
            let location = root.join(&r.path).to_string_lossy().replace('\\', "/");
            let _ = write!(
                links,
                "\t\t<link>\n\t\t\t<name>{}</name>\n\t\t\t<type>2</type>\n\t\t\t<location>{}</location>\n\t\t</link>\n",
                xml(&link),
                xml(&location)
            );
            // Excluded folders, and other source folders nested inside this one.
            let mut skip: Vec<String> = excluded
                .iter()
                .map(String::as_str)
                .chain(all_roots.iter().copied())
                .filter(|p| *p != r.path && inside(p, &r.path))
                .map(|p| format!("{}/", if r.path.is_empty() { p } else { &p[r.path.len() + 1..] }))
                .collect();
            skip.sort();
            skip.dedup();
            let excluding =
                if skip.is_empty() { String::new() } else { format!(" excluding=\"{}\"", xml(&skip.join("|"))) };
            let attrs = if r.test { TEST_ATTRS } else { "" };
            entries.push_str(&entry(&format!("kind=\"src\" path=\"{}\"{excluding}", xml(&link)), attrs));
        }
        entries.push_str("\t<classpathentry kind=\"con\" path=\"org.eclipse.jdt.launching.JRE_CONTAINER\"/>\n");
        let mut libs: Vec<String> = Vec::new();
        for d in &m.dependencies {
            // Runtime-only dependencies are not on the compile classpath.
            if d.scope == DependencyScope::Runtime {
                continue;
            }
            let attrs = if d.scope == DependencyScope::Test { TEST_ATTRS } else { "" };
            let exported = if d.exported { " exported=\"true\"" } else { "" };
            let mut lib = |classes: &str, source: Option<&str>| {
                let Some(classes) = abs(root, classes) else { return };
                if libs.contains(&classes) {
                    return;
                }
                let source = source.and_then(|s| abs(root, s)).map(|s| format!(" sourcepath=\"{}\"", xml(&s)));
                entries.push_str(&entry(
                    &format!("kind=\"lib\" path=\"{}\"{}{exported}", xml(&classes), source.unwrap_or_default()),
                    attrs,
                ));
                libs.push(classes);
            };
            match d.kind {
                ModuleDependencyKind::Jar => lib(&d.name, None),
                ModuleDependencyKind::Library => {
                    if let Some(l) = ps.libraries.iter().find(|l| l.name.trim() == d.name.trim()) {
                        for (k, c) in l.classes.iter().enumerate() {
                            lib(c, l.sources.get(k).map(String::as_str));
                        }
                    }
                }
                ModuleDependencyKind::Module => {
                    if let Some(p) = project_of(&d.name).filter(|p| **p != names[i]) {
                        entries.push_str(&entry(
                            &format!("combineaccessrules=\"false\" kind=\"src\" path=\"/{}\"{exported}", xml(p)),
                            attrs,
                        ));
                    }
                }
            }
        }
        entries.push_str("\t<classpathentry kind=\"output\" path=\"bin\"/>\n");

        let name = &names[i];
        let dot_project = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<projectDescription>\n\t<name>{name}</name>\n\t<comment>Generated by OpenIDEA from Project Structure (module {module}).</comment>\n\t<projects>\n\t</projects>\n\t<buildSpec>\n\t\t<buildCommand>\n\t\t\t<name>org.eclipse.jdt.core.javabuilder</name>\n\t\t\t<arguments>\n\t\t\t</arguments>\n\t\t</buildCommand>\n\t</buildSpec>\n\t<natures>\n\t\t<nature>org.eclipse.jdt.core.javanature</nature>\n\t</natures>\n\t<linkedResources>\n{links}\t</linkedResources>\n</projectDescription>\n",
            name = xml(name),
            module = xml(&m.name),
        );
        let classpath = format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<classpath>\n{entries}</classpath>\n");
        let level = if m.language_level.trim().is_empty() { &ps.language_level } else { &m.language_level };
        let prefs = compliance(level).map(|c| {
            format!(
                "eclipse.preferences.version=1\norg.eclipse.jdt.core.compiler.codegen.targetPlatform={c}\norg.eclipse.jdt.core.compiler.compliance={c}\norg.eclipse.jdt.core.compiler.source={c}\n"
            )
        });
        out.push(ModuleProject { name: name.clone(), dot_project, classpath, prefs });
    }
    out
}

const TEST_ATTRS: &str = "\t\t<attributes>\n\t\t\t<attribute name=\"test\" value=\"true\"/>\n\t\t</attributes>\n";

fn entry(attrs: &str, children: &str) -> String {
    if children.is_empty() {
        format!("\t<classpathentry {attrs}/>\n")
    } else {
        format!("\t<classpathentry {attrs}>\n{children}\t</classpathentry>\n")
    }
}

fn fnv(h: &mut u64, bytes: &[u8]) {
    for b in bytes.iter().chain([&0u8]) {
        *h = (*h ^ u64::from(*b)).wrapping_mul(0x100000001b3);
    }
}

/// `file:` URI of a folder, as jdtls expects in `workspaceFolders`.
fn folder_uri(path: &Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/");
    let mut out = String::from("file://");
    if !s.starts_with('/') {
        out.push('/');
    }
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"/-._~:".contains(&b) {
            out.push(b as char);
        } else {
            let _ = write!(out, "%{b:02X}");
        }
    }
    out
}

/// Writes `projects` into `dir` (one folder each), replacing what is there.
pub fn write_projects(dir: &Path, projects: &[ModuleProject]) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    for p in projects {
        let folder = dir.join(&p.name);
        std::fs::create_dir_all(&folder)?;
        std::fs::write(folder.join(".project"), &p.dot_project)?;
        std::fs::write(folder.join(".classpath"), &p.classpath)?;
        let prefs = folder.join(".settings").join("org.eclipse.jdt.core.prefs");
        match &p.prefs {
            Some(text) => {
                std::fs::create_dir_all(folder.join(".settings"))?;
                std::fs::write(prefs, text)?;
            }
            None => {
                let _ = std::fs::remove_file(prefs);
            }
        }
    }
    Ok(())
}

/// Points jdtls at the projects generated for the modules of `root` (see the
/// module docs). Each configuration gets its own folder and jdtls workspace, so
/// a changed module set starts from a clean import; older ones are removed.
pub fn configure(cfg: &mut LanguageServerConfig, root: &Path, s: &Settings, data_dir: &Path) {
    if cfg.name != "jdtls" || !active(root, s) {
        return;
    }
    let projects = module_projects(root, &s.project_structure);
    let mut key = 0xcbf29ce484222325u64;
    fnv(&mut key, root.to_string_lossy().as_bytes());
    let mut hash = key;
    for p in &projects {
        for part in [&p.name, &p.dot_project, &p.classpath] {
            fnv(&mut hash, part.as_bytes());
        }
        fnv(&mut hash, p.prefs.as_deref().unwrap_or("").as_bytes());
    }
    let base = data_dir.join("lsp").join("jdtls-modules");
    let prefix = format!("{key:016x}-");
    let dir: PathBuf = base.join(format!("{prefix}{hash:016x}"));
    if let Err(e) = write_projects(&dir.join("projects"), &projects) {
        tracing::warn!("jdtls: cannot write module projects to {}: {e}", dir.display());
        return;
    }
    // Earlier configurations of this project (their jdtls may still be shutting down: best effort).
    if let Ok(entries) = std::fs::read_dir(&base) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with(&prefix) && e.path() != dir {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
    merge_init_options(cfg, json!({ "workspaceFolders": [folder_uri(&dir.join("projects"))] }));
    if let Some(i) = cfg.args.iter().position(|a| a == "-data")
        && let Some(workspace) = cfg.args.get_mut(i + 1)
    {
        *workspace = dir.join("workspace").to_string_lossy().into_owned();
    } else {
        cfg.args.extend(["-data".to_owned(), dir.join("workspace").to_string_lossy().into_owned()]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::settings::{LibrarySettings, ModuleDependencySettings, ModuleSettings};

    fn module(name: &str, root: &str) -> ModuleSettings {
        ModuleSettings { name: name.into(), content_root: root.into(), ..Default::default() }
    }

    fn jdtls(args: Vec<String>) -> LanguageServerConfig {
        LanguageServerConfig {
            name: "jdtls".into(),
            command: "jdtls".into(),
            args,
            env: Default::default(),
            root_markers: vec![],
            require_root_marker: false,
            initialization_options: None,
            settings: None,
            install_hint: None,
            connect: None,
            fallback: false,
            max_java: None,
            launch_error: None,
        }
    }

    fn dep(kind: ModuleDependencyKind, name: &str) -> ModuleDependencySettings {
        ModuleDependencySettings { kind, name: name.into(), ..Default::default() }
    }

    #[test]
    fn each_module_becomes_a_project_with_its_own_sources_and_dependencies() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("app/src")).unwrap();
        let r = root.to_string_lossy().replace('\\', "/");
        let mut ps = ProjectStructureSettings {
            source_roots: vec!["common/java".into(), "app/src".into()],
            test_roots: vec!["common/tests".into()],
            excluded: vec!["app/src/gen".into()],
            language_level: "8".into(),
            libraries: vec![LibrarySettings {
                name: "log".into(),
                classes: vec!["lib/log.jar".into()],
                sources: vec!["lib/log-src.jar".into()],
            }],
            ..Default::default()
        };
        let mut app = module("app", "app");
        app.dependencies = vec![
            ModuleDependencySettings { exported: true, ..dep(ModuleDependencyKind::Module, "common") },
            dep(ModuleDependencyKind::Library, "log"),
            ModuleDependencySettings {
                scope: DependencyScope::Test,
                ..dep(ModuleDependencyKind::Jar, "lib/junit.jar")
            },
            ModuleDependencySettings {
                scope: DependencyScope::Runtime,
                ..dep(ModuleDependencyKind::Jar, "lib/rt.jar")
            },
        ];
        app.language_level = "17".into();
        ps.modules = vec![module("common", "common"), app];
        let projects = module_projects(root, &ps);
        assert_eq!(projects.len(), 2);

        let common = &projects[0];
        assert!(common.dot_project.contains(&format!("<location>{r}/common/java</location>")));
        assert!(common.classpath.contains("kind=\"src\" path=\"common_java\""));
        assert!(common.classpath.contains(
            "<classpathentry kind=\"src\" path=\"common_tests\">\n\t\t<attributes>\n\t\t\t<attribute name=\"test\" value=\"true\"/>"
        ));
        assert!(common.prefs.as_deref().unwrap().contains("compliance=1.8"));

        let app = &projects[1];
        assert!(app.dot_project.contains(&format!("<location>{r}/app/src</location>")));
        assert!(app.classpath.contains("kind=\"src\" path=\"app_src\" excluding=\"gen/\""));
        assert!(app.classpath.contains("combineaccessrules=\"false\" kind=\"src\" path=\"/common\" exported=\"true\""));
        assert!(
            app.classpath
                .contains(&format!("kind=\"lib\" path=\"{r}/lib/log.jar\" sourcepath=\"{r}/lib/log-src.jar\""))
        );
        assert!(app.classpath.contains(&format!("<classpathentry kind=\"lib\" path=\"{r}/lib/junit.jar\">")));
        assert!(!app.classpath.contains("rt.jar"));
        assert!(app.prefs.as_deref().unwrap().contains("compliance=17"));
        // The module's own sources come before its dependencies.
        assert!(app.classpath.find("app_src").unwrap() < app.classpath.find("/common").unwrap());
    }

    #[test]
    fn unmarked_modules_compile_their_src_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        for d in ["common/src", "server/src", "client", "outer/inner/src"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        let ps = ProjectStructureSettings {
            source_roots: vec!["server/java".into()],
            modules: vec![
                module("common", "common"),
                module("server", "server"),
                module("client", "client"),
                module("outer", "outer"),
                module("inner", "outer/inner"),
            ],
            ..Default::default()
        };
        let links: Vec<String> = module_projects(root, &ps)
            .iter()
            .map(|p| {
                p.classpath.lines().filter(|l| l.contains("kind=\"src\" path=\"") && !l.contains("path=\"/")).collect()
            })
            .collect();
        assert!(links[0].contains("common_src"));
        assert!(links[1].contains("server_java") && !links[1].contains("server_src"));
        assert!(links[2].contains("path=\"client\""));
        // A module around another one gets no folder of its own (it would nest the other's sources).
        assert_eq!(links[3], "");
        assert!(links[4].contains("outer_inner_src"));
    }

    #[test]
    fn configure_points_jdtls_at_generated_projects_only_without_a_build_tool() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("p");
        let data = tmp.path().join("data");
        std::fs::create_dir_all(root.join("a/src")).unwrap();
        let mut s = Settings::default();
        s.project_structure.modules = vec![module("a b", "a")];
        let mut cfg = jdtls(vec!["-data".into(), "/old".into()]);
        configure(&mut cfg, &root, &s, &data);
        let workspace = PathBuf::from(&cfg.args[1]);
        assert!(workspace.starts_with(data.join("lsp").join("jdtls-modules")));
        let projects = workspace.parent().unwrap().join("projects");
        assert!(projects.join("a b").join(".project").is_file());
        let options = serde_json::to_value(cfg.initialization_options).unwrap();
        let uri = options["workspaceFolders"][0].as_str().unwrap();
        assert!(uri.starts_with("file:///") && uri.ends_with("/projects"), "{uri}");

        // A new module set replaces the old generated folder.
        s.project_structure.modules.push(module("c", "c"));
        let mut again = jdtls(vec![]);
        configure(&mut again, &root, &s, &data);
        assert_ne!(again.args[1], cfg.args[1]);
        assert!(!projects.exists());

        // Maven owns the classpath.
        std::fs::write(root.join("pom.xml"), "<project/>").unwrap();
        let mut maven = jdtls(vec![]);
        configure(&mut maven, &root, &s, &data);
        assert!(maven.args.is_empty() && maven.initialization_options.is_none());
    }
}
