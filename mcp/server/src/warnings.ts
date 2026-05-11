// Unified discriminated-union of all engine warnings.
// Resolves cycle 2 carry-forwards C017+C018.
// Cycle 4: tightened RegistryWarning to 8 literal kinds; dropped orphan interfaces.
// Cycle 5: added state-save-failed, auto-write-failed, output-style-disabled (non-registry kinds).
// Cycle 5.5: added 'path-traversal' to AutoWriteFailedWarning.kind_detail (C021/C022/C012 remediation).
// Cycle 6: added OutputStylePluginNotEnabledWarning (H002 fix).

// Registry warnings — discriminated union of the eight kinds registry.ts
// actually emits. Cycle-4 C006 fix: removed three orphan alias members
// (paths-missing / paths-empty / path-malformed) that no producer ever
// surfaced; they had been added to satisfy a substring grep but contradicted
// A12's "exactly the eight kinds" promise.
export type RegistryWarning =
  | { kind: 'no-paths-dir'; message: string; path?: string; dir?: string }
  | { kind: 'empty-paths-dir'; message: string; path?: string; dir?: string }
  | { kind: 'missing-path-json'; message: string; path?: string; dir?: string }
  | { kind: 'malformed-path-json'; message: string; path?: string; dir?: string }
  | { kind: 'invalid-path-json'; message: string; path?: string; dir?: string }
  | { kind: 'missing-phases-json'; message: string; path?: string; dir?: string }
  | { kind: 'malformed-phases-json'; message: string; path?: string; dir?: string }
  | { kind: 'invalid-phases-json'; message: string; path?: string; dir?: string };

// State warnings (formerly local to tools/start.ts)
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

// Output style warnings (from outputStyle.ts)
export interface SettingsFileMissingWarning {
  kind: 'settings-file-missing';
  message: string;
}

export interface SettingsParseErrorWarning {
  kind: 'settings-parse-error';
  message: string;
}

// Cycle 6: plugin-not-enabled warning emitted when the learning-output-style
// plugin key is absent, non-object, or not strictly === true.
export interface OutputStylePluginNotEnabledWarning {
  kind: 'output-style-plugin-not-enabled';
  message: string;
}

// Preflight warnings (new in cycle 3)
export interface PreflightFailWarning {
  kind: 'preflight-fail';
  message: string;
  probeId?: string;
}

export interface PreflightDeployPreconditionFailedWarning {
  kind: 'preflight-deploy-precondition-failed';
  message: string;
  probeId: string;
}

export interface PreflightDeployTimeoutWarning {
  kind: 'preflight-deploy-timeout';
  message: string;
  logs?: string[];
}

export type PreflightWarning =
  | PreflightFailWarning
  | PreflightDeployPreconditionFailedWarning
  | PreflightDeployTimeoutWarning;

// Phase-engine warnings (new in cycle 4)
export interface PhaseEngineLoadFailedWarning {
  kind: 'phase-engine-phases-load-failed';
  message: string;
  slug: string;
  reason: string;
}

export interface PersonalizationValidationFailedWarning {
  kind: 'personalization-validation-failed';
  message: string;
  errors: string[];
}

export interface VerificationModeUnsupportedWarning {
  kind: 'verification-mode-unsupported';
  message: string;
  mode: string;
}

export type PhaseEngineWarning =
  | PhaseEngineLoadFailedWarning
  | PersonalizationValidationFailedWarning
  | VerificationModeUnsupportedWarning;

// Cycle-5 non-registry warnings
export interface StateSaveFailedWarning {
  kind: 'state-save-failed';
  message: string;
}

export interface AutoWriteFailedWarning {
  kind: 'auto-write-failed';
  spotId: string;
  kind_detail:
    | 'target-file-missing'
    | 'target-range-invalid'
    | 'snapshot-write-failed'
    | 'overwrite-failed'
    | 'path-traversal';
  message: string;
}

export interface OutputStyleDisabledWarning {
  kind: 'output-style-disabled';
  tool: string;
}

export type Cycle5Warning =
  | StateSaveFailedWarning
  | AutoWriteFailedWarning
  | OutputStyleDisabledWarning;

// The full discriminated union
export type EngineWarning =
  | RegistryWarning
  | StateWarning
  | SettingsFileMissingWarning
  | SettingsParseErrorWarning
  | OutputStylePluginNotEnabledWarning
  | PreflightWarning
  | PhaseEngineWarning
  | Cycle5Warning;
