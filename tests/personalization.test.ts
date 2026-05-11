import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Modules under test — none of these exist yet at red phase. Import failures
// are the meaningful red signal.
import {
  validatePersonalizationValues,
  substitutePromptOnly,
} from '../mcp/server/src/personalization.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// The declared options shape mirrors what selectPath surfaces to the skill —
// derived from path.json's personalization_options + personalization_ranges.
const declaredOptions = {
  poll_interval_ms: { type: 'integer' as const, min: 1000, max: 30000, default: 3000 },
  pool_subset: {
    type: 'enum' as const,
    enum: ['both', 'DEEP_SUI', 'SUI_USDC'] as const,
    default: 'both',
  },
};

describe('validatePersonalizationValues — integer range', () => {
  it('T-201: accepts in-range integer values for poll_interval_ms', () => {
    for (const v of [1000, 3000, 15000, 30000]) {
      const result = validatePersonalizationValues({ poll_interval_ms: v }, declaredOptions);
      expect(result.ok, 'expected ok for ' + v + ', got ' + JSON.stringify(result)).toBe(true);
      expect((result as any).values).toEqual({ poll_interval_ms: v });
    }
  });

  it('T-202: rejects out-of-range poll_interval_ms (below min)', () => {
    const result = validatePersonalizationValues({ poll_interval_ms: 999 }, declaredOptions);
    expect(result.ok).toBe(false);
    expect(Array.isArray((result as any).errors)).toBe(true);
    const joined = (result as any).errors.join('|');
    expect(/poll_interval_ms|range|1000/i.test(joined)).toBe(true);
  });

  it('T-203: rejects out-of-range poll_interval_ms (above max)', () => {
    const result = validatePersonalizationValues({ poll_interval_ms: 30001 }, declaredOptions);
    expect(result.ok).toBe(false);
    expect(Array.isArray((result as any).errors)).toBe(true);
    const joined = (result as any).errors.join('|');
    expect(/poll_interval_ms|range|30000/i.test(joined)).toBe(true);
  });

  it('T-204: rejects wrong-type poll_interval_ms (string)', () => {
    const result = validatePersonalizationValues({ poll_interval_ms: '3000' as any }, declaredOptions);
    expect(result.ok).toBe(false);
    expect(Array.isArray((result as any).errors)).toBe(true);
    const joined = (result as any).errors.join('|');
    expect(/integer|number|type/i.test(joined)).toBe(true);
  });
});

describe('validatePersonalizationValues — enum', () => {
  it('T-205: accepts each enum value of pool_subset', () => {
    for (const v of ['both', 'DEEP_SUI', 'SUI_USDC']) {
      const result = validatePersonalizationValues({ pool_subset: v }, declaredOptions);
      expect(result.ok, 'expected ok for ' + v + ', got ' + JSON.stringify(result)).toBe(true);
      expect((result as any).values).toEqual({ pool_subset: v });
    }
  });

  it('T-206: rejects pool_subset not in the enum', () => {
    const result = validatePersonalizationValues({ pool_subset: 'BTC_USDC' }, declaredOptions);
    expect(result.ok).toBe(false);
    expect(Array.isArray((result as any).errors)).toBe(true);
    const joined = (result as any).errors.join('|');
    expect(/pool_subset|enum/i.test(joined)).toBe(true);
  });
});

describe('validatePersonalizationValues — unknown keys + empty', () => {
  it('T-207: rejects unknown keys', () => {
    const result = validatePersonalizationValues({ render_style: 'pretty' as any }, declaredOptions);
    expect(result.ok).toBe(false);
    expect(Array.isArray((result as any).errors)).toBe(true);
    const joined = (result as any).errors.join('|');
    expect(/render_style|unknown/i.test(joined)).toBe(true);
  });

  it('T-208: accepts an empty object (Use defaults path)', () => {
    const result = validatePersonalizationValues({}, declaredOptions);
    expect(result.ok).toBe(true);
    expect((result as any).values).toEqual({});
  });
});

describe('substitutePromptOnly', () => {
  const values = { poll_interval_ms: 3000, pool_subset: 'both' };

  it('T-209: resolves {{ poll_interval_ms }} (with whitespace) using state.personalization values', () => {
    const out = substitutePromptOnly('Poll every {{ poll_interval_ms }} ms', values);
    expect(out).toBe('Poll every 3000 ms');
  });

  it('T-210: resolves {{key}} without whitespace', () => {
    const out = substitutePromptOnly('Wire {{pool_subset}}', { pool_subset: 'DEEP_SUI', poll_interval_ms: 3000 });
    expect(out).toBe('Wire DEEP_SUI');
  });

  it('T-211: leaves unknown placeholders intact', () => {
    const input = 'Foo {{ unknown_key }} bar';
    const out = substitutePromptOnly(input, values);
    expect(out).toBe(input);
    expect(out.includes('undefined')).toBe(false);
  });

  it('T-212: resolves multiple distinct placeholders in one pass', () => {
    const out = substitutePromptOnly('Poll {{ poll_interval_ms }}ms, wire {{ pool_subset }}', {
      poll_interval_ms: 5000,
      pool_subset: 'DEEP_SUI',
    });
    expect(out).toBe('Poll 5000ms, wire DEEP_SUI');
  });

  it('T-213: is a no-op on a string with zero placeholders', () => {
    const input = 'plain text src/App.tsx 39-58';
    const out = substitutePromptOnly(input, values);
    expect(out).toBe(input);
  });
});

describe('substitutePromptOnly — substitution scope guards (AC-6.3)', () => {
  it('T-214: substitutePromptOnly is the only substitution surface — engine source contains zero {{...}} placeholders outside personalization.ts and tests/', () => {
    const SCAN_ROOT = path.join(REPO_ROOT, 'mcp', 'server', 'src');
    const PERSONALIZATION_FILE = path.join(SCAN_ROOT, 'personalization.ts');
    const placeholderRe = /\{\{\s*[a-zA-Z_]/;
    const offenders: string[] = [];

    function walk(dir: string): void {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        if (path.extname(entry.name) !== '.ts') continue;
        if (path.resolve(full) === path.resolve(PERSONALIZATION_FILE)) continue;
        const content = fs.readFileSync(full, 'utf8');
        if (placeholderRe.test(content)) offenders.push(full);
      }
    }
    walk(SCAN_ROOT);

    expect(offenders).toEqual([]);
  });

  it('T-215: no engine caller passes target_file/target_range/verification.command/verification.endpoint through substitutePromptOnly', () => {
    const SCAN_ROOT = path.join(REPO_ROOT, 'mcp', 'server', 'src');
    const PERSONALIZATION_FILE = path.join(SCAN_ROOT, 'personalization.ts');
    const offenders: { file: string; snippet: string }[] = [];
    const fields = ['target_file', 'target_range', 'verification.command', 'verification.endpoint'];

    function walk(dir: string): void {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        if (path.extname(entry.name) !== '.ts') continue;
        if (path.resolve(full) === path.resolve(PERSONALIZATION_FILE)) continue;
        const content = fs.readFileSync(full, 'utf8');
        const callRe = /substitutePromptOnly\s*\(/g;
        let m: RegExpExecArray | null;
        while ((m = callRe.exec(content)) !== null) {
          const start = Math.max(0, m.index - 40);
          const end = Math.min(content.length, m.index + 120);
          const window = content.slice(start, end);
          for (const f of fields) {
            if (window.includes(f)) {
              offenders.push({ file: full, snippet: window });
            }
          }
        }
      }
    }
    walk(SCAN_ROOT);

    expect(offenders).toEqual([]);
  });
});
