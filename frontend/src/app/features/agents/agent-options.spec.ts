import { MODEL_PRESETS, parseCommand, presetLabel, presetOf } from './agent-options';

describe('agent-options', () => {
  it('parses commands from text or JSON', () => {
    expect(parseCommand('  ')).toBeNull();
    expect(parseCommand('claude -p {prompt}')).toEqual(['claude', '-p', '{prompt}']);
    expect(parseCommand('["copilot", "-p", "mit leerzeichen"]')).toEqual(['copilot', '-p', 'mit leerzeichen']);
    expect(() => parseCommand('[1, 2]')).toThrow(/Array aus Textwerten/);
  });

  it('recognises presets and labels their cost', () => {
    const copilot = MODEL_PRESETS.find((preset) => preset.id === 'copilot')!;
    expect(presetOf(` ${copilot.command} `)).toBe('copilot');
    expect(presetOf('claude --eigene-flags')).toBe('custom');
    expect(presetLabel(MODEL_PRESETS.find((preset) => preset.tier === 0)!)).toMatch(/Kostenlos$/);
    expect(presetLabel(copilot)).toMatch(/\$\$$/);
  });

  it('keeps presets ordered by provider, then by cost', () => {
    const providers = MODEL_PRESETS.map((preset) => preset.id.split('-')[0]);
    expect(providers[0]).toBe('local');
    expect(providers.indexOf('gemini')).toBeGreaterThan(providers.lastIndexOf('claude'));
  });
});
