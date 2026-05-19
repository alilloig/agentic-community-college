// Plugin discovery for ACC course-content plugins.
//
// ACC is the framework; content lives in separate Claude Code plugins that
// declare `accContent: { lessons: "<rel-path>" }` in their `.claude-plugin/plugin.json`.
// At runtime we walk Claude Code's `installed_plugins.json` registry, follow
// each entry's installPath, and pick the ones whose manifest carries an
// `accContent` block.
//
// Layout (Claude Code v2 plugins registry):
//   ~/.claude/plugins/installed_plugins.json
//     {
//       "version": 2,
//       "plugins": {
//         "<plugin-key>@<marketplace>": [
//           { "scope": "user", "installPath": "<abs path>", "version": "...", ... },
//           ...
//         ]
//       }
//     }
// We read the FIRST entry for each plugin key (Claude Code uses scope priority
// at install time; reading the head is consistent with what the runtime loads).
//
// Tests inject a fake registry via `discoverCourses({ installedPluginsFile })`
// or via the `ACC_INSTALLED_PLUGINS_FILE` env var. There is no module-level
// state — every call re-reads the registry so a freshly-enabled course shows
// up on the next `start` without needing an MCP-server restart.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { validateCourseProbes, type CourseProbeDecl } from './schemas/courseProbes.js';
import {
  validateContentPaths,
  validateProbePathRefs,
  type ContentPathDecl,
} from './schemas/contentPaths.js';

/**
 * One discovered course. `name` is the plugin key from `installed_plugins.json`
 * (e.g. `acc-deepbook-course@local`). `dir` is the plugin install dir.
 * `lessonsRoot` is the absolute path to where lessons live inside that plugin.
 * `probes` are the course's declarative probe decls (empty array if none).
 * `paths` are the course's declarative path decls (empty array if none).
 */
export interface DiscoveredCourse {
  name: string;
  dir: string;
  lessonsRoot: string;
  probes: CourseProbeDecl[];
  paths: ContentPathDecl[];
}

export interface CourseDiscoveryWarning {
  kind:
    | 'installed-plugins-missing'
    | 'installed-plugins-malformed'
    | 'course-plugin-malformed'
    | 'course-plugin-install-missing'
    | 'course-plugin-lessons-missing'
    | 'course-plugin-acc-content-invalid'
    | 'course-plugin-probes-invalid'
    | 'course-plugin-paths-invalid';
  message: string;
  pluginKey?: string;
  path?: string;
}

export interface CourseDiscoveryResult {
  courses: DiscoveredCourse[];
  warnings: CourseDiscoveryWarning[];
}

export interface DiscoverCoursesOptions {
  /** Override the installed_plugins.json path (tests). */
  installedPluginsFile?: string;
}

const DEFAULT_INSTALLED_PLUGINS_REL = path.join('.claude', 'plugins', 'installed_plugins.json');

export function discoverCourses(opts: DiscoverCoursesOptions = {}): CourseDiscoveryResult {
  const installedPluginsFile =
    opts.installedPluginsFile ??
    process.env.ACC_INSTALLED_PLUGINS_FILE ??
    path.join(os.homedir(), DEFAULT_INSTALLED_PLUGINS_REL);

  const courses: DiscoveredCourse[] = [];
  const warnings: CourseDiscoveryWarning[] = [];

  let raw: string;
  try {
    raw = fs.readFileSync(installedPluginsFile, 'utf8');
  } catch {
    return {
      courses,
      warnings: [
        {
          kind: 'installed-plugins-missing',
          message: `Claude Code installed_plugins.json not found at ${installedPluginsFile}`,
          path: installedPluginsFile,
        },
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      courses,
      warnings: [
        {
          kind: 'installed-plugins-malformed',
          message: `Failed to parse ${installedPluginsFile}: ${err instanceof Error ? err.message : String(err)}`,
          path: installedPluginsFile,
        },
      ],
    };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return {
      courses,
      warnings: [
        {
          kind: 'installed-plugins-malformed',
          message: `installed_plugins.json is not a JSON object`,
          path: installedPluginsFile,
        },
      ],
    };
  }

  const pluginsField = (parsed as Record<string, unknown>)['plugins'];
  if (typeof pluginsField !== 'object' || pluginsField === null) {
    return {
      courses,
      warnings: [
        {
          kind: 'installed-plugins-malformed',
          message: `installed_plugins.json missing 'plugins' object`,
          path: installedPluginsFile,
        },
      ],
    };
  }

  const seenLessonsRoots = new Set<string>();

  for (const [pluginKey, entries] of Object.entries(pluginsField as Record<string, unknown>)) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const head = entries[0];
    if (typeof head !== 'object' || head === null) continue;

    const installPath = (head as Record<string, unknown>)['installPath'];
    if (typeof installPath !== 'string' || installPath.length === 0) continue;

    if (!fs.existsSync(installPath)) {
      warnings.push({
        kind: 'course-plugin-install-missing',
        message: `Plugin ${pluginKey} install path does not exist: ${installPath}`,
        pluginKey,
        path: installPath,
      });
      continue;
    }

    const manifestPath = path.join(installPath, '.claude-plugin', 'plugin.json');
    if (!fs.existsSync(manifestPath)) {
      // Not every installed plugin is a course; skip silently.
      continue;
    }

    let manifestRaw: string;
    try {
      manifestRaw = fs.readFileSync(manifestPath, 'utf8');
    } catch {
      warnings.push({
        kind: 'course-plugin-malformed',
        message: `Could not read manifest for ${pluginKey}: ${manifestPath}`,
        pluginKey,
        path: manifestPath,
      });
      continue;
    }

    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestRaw);
    } catch (err) {
      warnings.push({
        kind: 'course-plugin-malformed',
        message: `Failed to parse ${manifestPath} for ${pluginKey}: ${err instanceof Error ? err.message : String(err)}`,
        pluginKey,
        path: manifestPath,
      });
      continue;
    }

    if (typeof manifest !== 'object' || manifest === null) continue;
    const accContent = (manifest as Record<string, unknown>)['accContent'];
    if (accContent === undefined) {
      // Not a course plugin. Most plugins fall here.
      continue;
    }

    if (typeof accContent !== 'object' || accContent === null) {
      warnings.push({
        kind: 'course-plugin-acc-content-invalid',
        message: `${pluginKey} declares accContent but it is not an object`,
        pluginKey,
        path: manifestPath,
      });
      continue;
    }

    const lessonsField = (accContent as Record<string, unknown>)['lessons'];
    if (typeof lessonsField !== 'string' || lessonsField.length === 0) {
      warnings.push({
        kind: 'course-plugin-acc-content-invalid',
        message: `${pluginKey} accContent.lessons must be a non-empty string`,
        pluginKey,
        path: manifestPath,
      });
      continue;
    }

    // Resolve and normalize. Reject path-escape attempts (a malicious or
    // typo'd manifest declaring "../../../etc" must not let the registry walk
    // outside the plugin install dir).
    const lessonsResolved = path.resolve(installPath, lessonsField);
    const installNormalized = path.resolve(installPath);
    if (
      lessonsResolved !== installNormalized &&
      !lessonsResolved.startsWith(installNormalized + path.sep)
    ) {
      warnings.push({
        kind: 'course-plugin-acc-content-invalid',
        message: `${pluginKey} accContent.lessons escapes the plugin install dir`,
        pluginKey,
        path: manifestPath,
      });
      continue;
    }

    if (!fs.existsSync(lessonsResolved)) {
      warnings.push({
        kind: 'course-plugin-lessons-missing',
        message: `${pluginKey} lessons directory does not exist: ${lessonsResolved}`,
        pluginKey,
        path: lessonsResolved,
      });
      continue;
    }

    // Dedup by lessons root — two registry entries pointing at the same
    // install dir should only produce one course.
    if (seenLessonsRoots.has(lessonsResolved)) continue;
    seenLessonsRoots.add(lessonsResolved);

    // Optional accContent.paths — declarative named filesystem paths the
    // course's probes / reference apps reference via `${paths.<id>}`. Parsed
    // before probes so we can cross-reference them in the same pass.
    let paths: ContentPathDecl[] = [];
    let pathsValid = true;
    if ((accContent as Record<string, unknown>)['paths'] !== undefined) {
      const pathsValidation = validateContentPaths(
        (accContent as Record<string, unknown>)['paths'],
      );
      if (!pathsValidation.ok) {
        warnings.push({
          kind: 'course-plugin-paths-invalid',
          message: `${pluginKey}: ${pathsValidation.error}`,
          pluginKey,
          path: manifestPath,
        });
        pathsValid = false;
      } else {
        paths = pathsValidation.value;
      }
    }

    // Optional accContent.probes — declarative prerequisite checks.
    let probes: CourseProbeDecl[] = [];
    if ((accContent as Record<string, unknown>)['probes'] !== undefined) {
      const probesValidation = validateCourseProbes(
        (accContent as Record<string, unknown>)['probes'],
      );
      if (!probesValidation.ok) {
        warnings.push({
          kind: 'course-plugin-probes-invalid',
          message: `${pluginKey}: ${probesValidation.error}`,
          pluginKey,
          path: manifestPath,
        });
        // Continue without probes; the course is still usable for lessons
        // that don't declare prerequisites.
      } else {
        probes = probesValidation.value;
      }
    }

    // Cross-reference: every `${paths.<id>}` inside a probe must match a
    // declared id on the same manifest. If paths failed earlier or any
    // reference is unresolved, drop the probes so a learner gets a clear
    // "no probe declared" error instead of a runtime substitution crash.
    if (probes.length > 0) {
      const declaredIds = new Set(paths.map((p) => p.id));
      const xref = validateProbePathRefs(declaredIds, probes);
      if (!xref.ok) {
        warnings.push({
          kind: 'course-plugin-paths-invalid',
          message: `${pluginKey}: ${xref.error}`,
          pluginKey,
          path: manifestPath,
        });
        probes = [];
      } else if (!pathsValid) {
        // paths validation failed *and* the course shipped probes — any of
        // those probes referencing the (now-empty) paths block would surface
        // a confusing "no probe declared" error. Drop them defensively.
        // No additional warning: the earlier paths-invalid warning is the
        // root cause and surfaces in the conductor.
        probes = [];
      }
    }

    courses.push({
      name: pluginKey,
      dir: installNormalized,
      lessonsRoot: lessonsResolved,
      probes,
      paths,
    });
  }

  // Deterministic order so tools render consistently across calls.
  courses.sort((a, b) => a.name.localeCompare(b.name));

  return { courses, warnings };
}
