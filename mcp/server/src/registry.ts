import * as fs from 'node:fs';
import * as path from 'node:path';
import { validatePath } from './schemas/path.js';
import { validatePhases } from './schemas/phases.js';
import type { RegistryWarning } from './warnings.js';

export type { RegistryWarning };

export interface PathInfo {
  slug: string;
  title: string;
  summary: string;
  personalization_options: string[];
  build_command: string;
}

export interface RegistryResult {
  paths: PathInfo[];
  warnings: RegistryWarning[];
}

export async function scanRegistry(scanRoot: string): Promise<RegistryResult> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(scanRoot, { withFileTypes: true });
  } catch {
    return {
      paths: [],
      warnings: [
        {
          kind: 'no-paths-dir',
          message: `Paths directory not found: ${scanRoot}`,
        },
      ],
    };
  }

  // Filter out non-directory entries silently
  const dirEntries = entries.filter((e) => e.isDirectory());

  if (dirEntries.length === 0) {
    return {
      paths: [],
      warnings: [
        {
          kind: 'empty-paths-dir',
          message: `Paths directory exists but contains no path subdirectories: ${scanRoot}`,
        },
      ],
    };
  }

  const paths: PathInfo[] = [];
  const warnings: RegistryWarning[] = [];

  for (const entry of dirEntries) {
    const slugDir = path.join(scanRoot, entry.name);
    const pathJsonFile = path.join(slugDir, 'path.json');

    // Check if path.json exists
    if (!fs.existsSync(pathJsonFile)) {
      warnings.push({
        kind: 'missing-path-json',
        message: `No path.json found in ${slugDir}`,
        path: slugDir,
      });
      continue;
    }

    // Try to read and parse path.json
    let raw: string;
    try {
      raw = fs.readFileSync(pathJsonFile, 'utf8');
    } catch (err) {
      warnings.push({
        kind: 'malformed-path-json',
        message: `Failed to read ${pathJsonFile}: ${err instanceof Error ? err.message : String(err)}`,
        path: pathJsonFile,
      });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      warnings.push({
        kind: 'malformed-path-json',
        message: `Failed to parse ${pathJsonFile}: ${err instanceof Error ? err.message : String(err)}`,
        path: pathJsonFile,
      });
      continue;
    }

    // Validate schema
    const validation = validatePath(parsed);
    if (!validation.ok) {
      warnings.push({
        kind: 'invalid-path-json',
        message: `Schema validation failed for ${pathJsonFile}: ${validation.error}`,
        path: pathJsonFile,
      });
      continue;
    }

    // Phases.json is also load-bearing: cycle 4 consumes phases as part of
    // the path manifest, so the registry must vouch for both files together.
    // Cluster C001 from cycle 1's review caught the missing integration.
    const phasesJsonFile = path.join(slugDir, 'phases.json');
    let phasesRaw: string;
    try {
      phasesRaw = fs.readFileSync(phasesJsonFile, 'utf8');
    } catch {
      warnings.push({
        kind: 'missing-phases-json',
        message: `No phases.json found in ${slugDir}`,
        path: slugDir,
      });
      continue;
    }

    let phasesParsed: unknown;
    try {
      phasesParsed = JSON.parse(phasesRaw);
    } catch (err) {
      warnings.push({
        kind: 'malformed-phases-json',
        message: `Failed to parse ${phasesJsonFile}: ${err instanceof Error ? err.message : String(err)}`,
        path: phasesJsonFile,
      });
      continue;
    }

    const phasesValidation = validatePhases(phasesParsed);
    if (!phasesValidation.ok) {
      warnings.push({
        kind: 'invalid-phases-json',
        message: `Schema validation failed for ${phasesJsonFile}: ${phasesValidation.error}`,
        path: phasesJsonFile,
      });
      continue;
    }

    paths.push({
      slug: validation.value.slug,
      title: validation.value.title,
      summary: validation.value.summary,
      personalization_options: validation.value.personalization_options,
      build_command: validation.value.build_command,
    });
  }

  return { paths, warnings };
}
