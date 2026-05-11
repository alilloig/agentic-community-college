import * as path from 'node:path';
import * as fsPromises from 'node:fs/promises';
import { loadState, saveState, STATE_SCHEMA_VERSION } from '../state.js';
import type { State } from '../schemas/state.js';
import { scanRegistry } from '../registry.js';
import { validatePath } from '../schemas/path.js';
import type { PathData } from '../schemas/path.js';
import { loadPhases } from '../phaseEngine.js';
import { probeOutputStyle } from '../outputStyle.js';
import { prepareWorkspace, WorkspacePrepareError } from '../workspace.js';
import type { WorkspaceOptions } from '../workspace.js';
import { resolvePathsRoot, resolvePathContentRoot } from '../pathsRoot.js';

export interface Prompt {
  name: string;
  type: 'integer' | 'enum';
  range?: { min: number; max: number; default: number };
  enum?: string[];
  default?: string | number;
}

export interface SelectPathResult {
  ok: boolean;
  personalizationPrompts?: Prompt[];
  /** F-002: rendered content of paths/<slug>/description.md, when present.
   * The course-engine skill displays this BEFORE prompting for
   * personalization, so the learner knows what they're signing up for. */
  description?: string;
  workspacePath?: string;
  workspaceCreated?: boolean;
  workspaceArchivedTo?: string;
  errors?: string[];
}

export interface SelectPathOptions {
  /** Forwarded to prepareWorkspace. Tests redirect basePath to a tmpdir and
   * stub the install command via spawn. Production callers leave undefined. */
  workspace?: WorkspaceOptions;
}

function buildPrompts(pathData: PathData): Prompt[] {
  const prompts: Prompt[] = [];

  for (const opt of pathData.personalization_options) {
    if (opt === 'poll_interval_ms') {
      const range = pathData.personalization_ranges?.poll_interval_ms ?? {
        min: 1000,
        max: 30000,
        default: 3000,
      };
      prompts.push({
        name: 'poll_interval_ms',
        type: 'integer',
        range: { min: range.min, max: range.max, default: range.default },
      });
    } else if (opt === 'pool_subset') {
      const ps = pathData.personalization_ranges?.pool_subset ?? {
        values: ['both', 'DEEP_SUI', 'SUI_USDC'],
        default: 'both',
      };
      prompts.push({
        name: 'pool_subset',
        type: 'enum',
        enum: ps.values,
        default: ps.default,
      });
    }
  }

  return prompts;
}

export async function runSelectPath(
  {
    projectRoot,
    slug,
  }: {
    projectRoot: string;
    slug?: unknown;
  },
  opts: SelectPathOptions = {},
): Promise<SelectPathResult> {
  // L002 carry-forward: outputStyleOk gate runs BEFORE any state load
  const styleCheck = await probeOutputStyle();
  if (!styleCheck.ok) {
    return { ok: false, errors: ['output-style-disabled'] };
  }

  // Input validation
  if (slug === undefined || slug === null) {
    return { ok: false, errors: ['Missing required parameter: slug'] };
  }
  if (typeof slug !== 'string') {
    return { ok: false, errors: ['slug must be a string, got ' + typeof slug] };
  }
  if (slug.length === 0) {
    return { ok: false, errors: ['slug must not be empty'] };
  }

  // Load state — short-circuit on schema-mismatch; treat corrupt+archivedTo as absent (H003 fix)
  const stateResult = await loadState(projectRoot);
  if (stateResult.kind === 'corrupt') {
    // H003 / AC-7.2: if the corruption was archived successfully (archivedTo is
    // defined), treat the slot as absent and proceed to mint a fresh state.
    // If archivedTo is NOT defined (archive write failed), we cannot safely
    // recover — surface the error so the user can intervene manually.
    if (stateResult.archivedTo === undefined) {
      // Phase F round-2 fast-follow M001: name the manual-recovery escape so
      // the user is not silently wedged when archive emission also failed
      // (e.g. disk full / permissions). The .sui-deepbook-course/state.json
      // path is canonical and stable.
      return {
        ok: false,
        errors: [
          `State corrupt: ${stateResult.message}. Archive write also failed; ` +
            `delete .sui-deepbook-course/state.json manually and retry.`,
        ],
      };
    }
    // archivedTo is set — proceed as if the slot is absent (fall through)
  }
  if (stateResult.kind === 'schema-mismatch') {
    return { ok: false, errors: [`State schema mismatch: ${stateResult.message}`] };
  }

  // Scan registry to validate slug — F-001 routes through resolvePathsRoot
  // so the course works regardless of the user's cwd.
  const pathsRoot = resolvePathsRoot(projectRoot);
  const registry = await scanRegistry(pathsRoot);
  const pathInfo = registry.paths.find((p) => p.slug === slug);

  if (!pathInfo) {
    return { ok: false, errors: [`Unknown path slug: '${slug}'`] };
  }

  // Load path.json to get personalization_ranges
  let pathData: PathData;
  try {
    const pathJsonPath = path.join(resolvePathContentRoot(projectRoot, slug), 'path.json');
    const raw = await fsPromises.readFile(pathJsonPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const validation = validatePath(parsed);
    if (!validation.ok) {
      return { ok: false, errors: [`Invalid path.json: ${validation.error}`] };
    }
    pathData = validation.value;
  } catch (err) {
    return { ok: false, errors: [`Failed to load path.json: ${String(err)}`] };
  }

  // Load phases to get first phase/spot
  let phasesData: Awaited<ReturnType<typeof loadPhases>>;
  try {
    phasesData = await loadPhases(projectRoot, slug);
  } catch (err) {
    return { ok: false, errors: [`Failed to load phases: ${String(err)}`] };
  }

  const firstPhase = phasesData.phases[0];
  const firstSpot = firstPhase.spots[0];

  // Provision workspace BEFORE persisting state, so a failed prepare leaves no
  // dangling state pointing at a half-built workspace. Paths without a
  // workspace block keep working in legacy projectRoot mode (workspace_path
  // stays unset; verifySpot falls back to projectRoot).
  let workspacePath: string | undefined;
  let workspaceCreated: boolean | undefined;
  let workspaceArchivedTo: string | undefined;
  if (pathData.workspace) {
    try {
      const result = await prepareWorkspace(projectRoot, slug, pathData, opts.workspace);
      workspacePath = result.workspacePath;
      workspaceCreated = result.created;
      if (result.archivedTo) workspaceArchivedTo = result.archivedTo;
    } catch (err) {
      if (err instanceof WorkspacePrepareError) {
        return {
          ok: false,
          errors: [`workspace-prepare-failed (${err.kind}): ${err.message}`],
        };
      }
      throw err;
    }
  }

  // Build new state — for corrupt+archivedTo case, treat existingState as null
  // (same as the 'absent' case); for 'ok', carry forward existing personalization/history
  const existingState = stateResult.kind === 'ok' ? stateResult.state : null;
  const newState: State = {
    schema_version: STATE_SCHEMA_VERSION,
    selected_path: slug,
    personalization: existingState?.personalization ?? {},
    cursor: { phase_id: firstPhase.id, spot_id: firstSpot.id },
    ladder: {},
    history: existingState?.history ?? [],
  };
  if (workspacePath !== undefined) newState.workspace_path = workspacePath;

  // M002 carry-forward: wrap saveState in try/catch
  try {
    await saveState(projectRoot, newState);
  } catch (err) {
    const e = err as Error;
    return { ok: false, errors: [`state-save-failed: ${e.message}`] };
  }

  const prompts = buildPrompts(pathData);

  // F-002: best-effort load of description.md so the conductor can render it
  // before personalization. Missing or unreadable file is fine — the field
  // simply stays undefined.
  let description: string | undefined;
  try {
    const descPath = path.join(resolvePathContentRoot(projectRoot, slug), 'description.md');
    description = await fsPromises.readFile(descPath, 'utf8');
  } catch {
    /* description.md is optional */
  }

  const result: SelectPathResult = { ok: true, personalizationPrompts: prompts };
  if (description !== undefined) result.description = description;
  if (workspacePath !== undefined) result.workspacePath = workspacePath;
  if (workspaceCreated !== undefined) result.workspaceCreated = workspaceCreated;
  if (workspaceArchivedTo !== undefined) result.workspaceArchivedTo = workspaceArchivedTo;
  return result;
}

// Alias export expected by tests
export const selectPath = runSelectPath;
