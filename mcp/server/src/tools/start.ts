import { getOutputStyleStatus, type OutputStyleStatus } from '../outputStyle.js';
import { scanCourses } from '../registry.js';
import type { LessonInfo, RegistryWarning } from '../registry.js';
import { discoverCourses } from '../pluginsRoot.js';
import type { CourseDiscoveryWarning } from '../pluginsRoot.js';
import { loadState } from '../state.js';
import type { State } from '../state.js';
import type { StateWarning } from '../warnings.js';

export type { StateWarning };

export interface StartResult {
  /** Advisory: the active Claude Code output style vs. the recommended one. */
  outputStyle: OutputStyleStatus;
  /** Public lesson catalog, aggregated across every discovered course plugin. */
  lessons: LessonInfo[];
  /** Names of course plugins ACC sees enabled in `~/.claude/plugins/installed_plugins.json`. */
  courses: string[];
  state: State | null;
  warnings: (RegistryWarning | StateWarning | CourseDiscoveryWarning)[];
}

export async function runStart({ projectRoot }: { projectRoot: string }): Promise<StartResult> {
  const outputStyle = getOutputStyleStatus();
  const discovery = discoverCourses();
  const registry = await scanCourses(discovery.courses);
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
    outputStyle,
    lessons: registry.lessons,
    courses: discovery.courses.map((c) => c.name),
    state,
    warnings,
  };
}
