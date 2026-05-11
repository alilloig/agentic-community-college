import { probeOutputStyle } from '../outputStyle.js';
import { scanCourses } from '../registry.js';
import type { LessonInfo, RegistryWarning } from '../registry.js';
import { discoverCourses } from '../pluginsRoot.js';
import type { CourseDiscoveryWarning } from '../pluginsRoot.js';
import { loadState } from '../state.js';
import type { State } from '../state.js';
import type { StateWarning } from '../warnings.js';

export type { StateWarning };

export interface StartResult {
  outputStyleOk: boolean;
  preflight: { skipped: true; reason: 'cycle-1' };
  /** Public lesson catalog, aggregated across every discovered course plugin. */
  lessons: LessonInfo[];
  /** Names of course plugins ACC sees enabled in `~/.claude/plugins/installed_plugins.json`. */
  courses: string[];
  state: State | null;
  warnings: (RegistryWarning | StateWarning | CourseDiscoveryWarning)[];
}

export async function runStart({ projectRoot }: { projectRoot: string }): Promise<StartResult> {
  const styleResult = await probeOutputStyle();
  const discovery = discoverCourses();
  const registry = await scanCourses(discovery.courses);

  if (!styleResult.ok) {
    const warnings: StartResult['warnings'] = [
      ...discovery.warnings,
      ...registry.warnings,
    ];
    if (styleResult.warning) {
      warnings.unshift(styleResult.warning as StateWarning);
    }
    return {
      outputStyleOk: false,
      preflight: { skipped: true, reason: 'cycle-1' },
      lessons: registry.lessons,
      courses: discovery.courses.map((c) => c.name),
      state: null,
      warnings,
    };
  }

  // Only load state when outputStyleOk === true.
  const stateResult = await loadState(projectRoot);

  const warnings: StartResult['warnings'] = [
    ...discovery.warnings,
    ...registry.warnings,
  ];
  let state: State | null = null;

  switch (stateResult.kind) {
    case 'absent':
      break;

    case 'ok':
      state = stateResult.state;
      break;

    case 'corrupt': {
      const warning: StateWarning = stateResult.archivedTo !== undefined
        ? { kind: 'state-corrupt', message: stateResult.message, archivedTo: stateResult.archivedTo }
        : { kind: 'state-corrupt', message: stateResult.message };
      warnings.push(warning);
      break;
    }

    case 'schema-mismatch':
      warnings.push({
        kind: 'state-schema-mismatch',
        message: stateResult.message,
        foundVersion: stateResult.foundVersion,
      });
      break;
  }

  return {
    outputStyleOk: true,
    preflight: { skipped: true, reason: 'cycle-1' },
    lessons: registry.lessons,
    courses: discovery.courses.map((c) => c.name),
    state,
    warnings,
  };
}
