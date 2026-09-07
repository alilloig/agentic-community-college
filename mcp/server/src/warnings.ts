// Warning types shared by the MCP tools. Every member listed here has a
// producer in mcp/server/src; add a member together with the code that emits
// it, and delete it with that code.

/** The eight kinds registry.ts emits while scanning a lessons root. */
export type RegistryWarning =
  | { kind: 'no-paths-dir'; message: string; path?: string; dir?: string }
  | { kind: 'empty-paths-dir'; message: string; path?: string; dir?: string }
  | { kind: 'missing-path-json'; message: string; path?: string; dir?: string }
  | { kind: 'malformed-path-json'; message: string; path?: string; dir?: string }
  | { kind: 'invalid-path-json'; message: string; path?: string; dir?: string }
  | { kind: 'missing-chapters-json'; message: string; path?: string; dir?: string }
  | { kind: 'malformed-chapters-json'; message: string; path?: string; dir?: string }
  | { kind: 'invalid-chapters-json'; message: string; path?: string; dir?: string };

/** state.ts classification, surfaced by `start` and `selectLesson`. */
export interface StateCorruptWarning {
  kind: 'state-corrupt';
  message: string;
  archivedTo?: string;
}

export interface StateSchemaMismatchWarning {
  kind: 'state-schema-mismatch';
  message: string;
  foundVersion?: number;
}

export type StateWarning = StateCorruptWarning | StateSchemaMismatchWarning;

/** outputStyle.ts: what stopped ACC from reading `~/.claude/settings.json`. */
export interface SettingsFileMissingWarning {
  kind: 'settings-file-missing';
  message: string;
}

export interface SettingsReadErrorWarning {
  kind: 'settings-read-error';
  message: string;
}

export interface SettingsParseErrorWarning {
  kind: 'settings-parse-error';
  message: string;
}

export type OutputStyleWarning =
  | SettingsFileMissingWarning
  | SettingsReadErrorWarning
  | SettingsParseErrorWarning;

/** verifyChapter: the chapter passed but the conductor had not written the artifact. */
export interface ArtifactMissingWarning {
  kind: 'artifact-missing';
  message: string;
}
