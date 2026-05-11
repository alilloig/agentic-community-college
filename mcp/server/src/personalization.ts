// Personalization substitution — scoped exclusively to spot prompts.
// AC-6.3: substitutePromptOnly is the ONLY function that performs {{ ... }} substitution.
// It MUST NOT be called with target_file, target_range, verification.command, or
// verification.endpoint as the prompt argument.

// DeclaredOptionDecl shapes — used by callers building from path.json
export interface PersonalizationOptionDecl {
  name: string;
  type: 'integer' | 'enum';
  range?: { min: number; max: number; default: number };
  enum?: string[];
  default?: string | number;
}

// DeclaredOptions map format — used by test suite and as flat option descriptor
export interface IntegerOptionDesc {
  type: 'integer';
  min: number;
  max: number;
  default: number;
}

export interface EnumOptionDesc {
  type: 'enum';
  enum: readonly string[] | string[];
  default: string;
}

export type OptionDesc = IntegerOptionDesc | EnumOptionDesc;

// Accept either an array of PersonalizationOptionDecl or a Record<string, OptionDesc>
type DeclaredOptions = PersonalizationOptionDecl[] | Record<string, OptionDesc>;

type ValidationResult =
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; errors: string[] };

function normalizeToArray(declared: DeclaredOptions): PersonalizationOptionDecl[] {
  if (Array.isArray(declared)) {
    return declared;
  }
  // Convert Record<string, OptionDesc> → PersonalizationOptionDecl[]
  return Object.entries(declared).map(([name, desc]) => {
    if (desc.type === 'integer') {
      return {
        name,
        type: 'integer' as const,
        range: { min: desc.min, max: desc.max, default: desc.default },
      };
    } else {
      return {
        name,
        type: 'enum' as const,
        enum: Array.isArray(desc.enum) ? [...desc.enum] : [],
        default: desc.default,
      };
    }
  });
}

/**
 * Validate personalization values against declared options.
 * Empty values object is valid (Use defaults path).
 * Returns ok:true with the values map, or ok:false with an errors array.
 */
export function validatePersonalizationValues(
  values: Record<string, unknown>,
  declared: DeclaredOptions,
): ValidationResult {
  const options = normalizeToArray(declared);
  const errors: string[] = [];
  const declaredKeys = new Set(options.map((o) => o.name));

  // Check for unknown keys
  for (const key of Object.keys(values)) {
    if (!declaredKeys.has(key)) {
      errors.push(`Unknown personalization key: '${key}'`);
    }
  }

  // Validate known keys that are present
  for (const opt of options) {
    const val = values[opt.name];
    if (val === undefined) continue; // absent is valid (use defaults)

    if (opt.type === 'integer') {
      if (typeof val !== 'number' || !Number.isInteger(val)) {
        errors.push(
          `${opt.name} must be an integer, got ${typeof val}`,
        );
        continue;
      }
      if (opt.range !== undefined) {
        if (val < opt.range.min) {
          errors.push(
            `${opt.name} must be >= ${opt.range.min}, got ${val}`,
          );
        } else if (val > opt.range.max) {
          errors.push(
            `${opt.name} must be <= ${opt.range.max}, got ${val}`,
          );
        }
      }
    } else if (opt.type === 'enum') {
      if (typeof val !== 'string') {
        errors.push(`${opt.name} must be a string enum value, got ${typeof val}`);
        continue;
      }
      if (opt.enum !== undefined && !opt.enum.includes(val)) {
        errors.push(
          `${opt.name} must be one of [${opt.enum.join(', ')}], got '${val}'`,
        );
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, values };
}

/**
 * Substitute {{ key }} and {{key}} placeholders in a prompt string with values.
 * Leaves unknown placeholders intact (no error on missing key).
 * MUST ONLY be called on prompt strings — not target_file, target_range,
 * verification.command, or verification.endpoint.
 */
export function substitutePromptOnly(
  prompt: string,
  values: Record<string, unknown>,
): string {
  return prompt.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      return String(values[key]);
    }
    return _match; // leave unknown placeholders intact
  });
}
