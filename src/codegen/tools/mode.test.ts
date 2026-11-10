import { describe, expect, it } from 'vitest';
import { isToolsMode, resolveToolsMode } from './mode.js';

describe('resolveToolsMode', () => {
  it('prefers the explicit flag over environment and CI', () => {
    expect(resolveToolsMode({
      flag: 'integrity',
      env: { GLIRASTES_TOOLS_MODE: 'write', CI: 'true' },
    })).toBe('integrity');
  });

  it('uses GLIRASTES_TOOLS_MODE before CI', () => {
    expect(resolveToolsMode({ env: { GLIRASTES_TOOLS_MODE: 'integrity', CI: 'true' } }))
      .toBe('integrity');
    expect(resolveToolsMode({ env: { GLIRASTES_TOOLS_MODE: ' write ', CI: 'true' } }))
      .toBe('write');
  });

  it.each(['true', '1', 'yes'])('checks frozen when CI=%s', (ci) => {
    expect(resolveToolsMode({ env: { CI: ci } })).toBe('frozen');
  });

  it.each(['', '0', 'false', 'FALSE'])('writes locally when CI=%j', (ci) => {
    expect(resolveToolsMode({ env: { CI: ci } })).toBe('write');
  });

  it('writes when nothing is configured', () => {
    expect(resolveToolsMode({ env: {} })).toBe('write');
  });

  it('rejects an unknown GLIRASTES_TOOLS_MODE with E-TOOLS-003', () => {
    expect(() => resolveToolsMode({ env: { GLIRASTES_TOOLS_MODE: 'dry' } }))
      .toThrowError(expect.objectContaining({ code: 'E-TOOLS-003' }));
  });

  it('recognizes only the three mode names', () => {
    expect(isToolsMode('frozen')).toBe(true);
    expect(isToolsMode('check')).toBe(false);
  });
});
