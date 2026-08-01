/**
 * Regression test: server-side tools must survive the masking pipeline
 * byte-identical.
 *
 * `stripDescriptionsAndInjectSyntheticTools()` blanks client-authored tool
 * descriptions so no caller fingerprint reaches Anthropic. It used to do that
 * with an unconditional `{ ...t, description: note ?? '' }` over every entry in
 * `tools[]` — including SERVER-SIDE tools (`bash_20250124`, `web_search_*`,
 * `advisor_20260301`, …), which are identified by a `type` other than "custom".
 *
 * Those tools have closed schemas. Adding a key Anthropic doesn't expect makes
 * it reject the whole request:
 *
 *   400 tools.N.advisor_20260301.description: Extra inputs are not permitted
 *
 * They also carry no client-authored description to strip, so there was never
 * anything to gain. `applyClaudeOAuthTransform` already skips them for the same
 * reason ("Skip built-in tools (they have a `type` field)", oauth-claude.ts);
 * this locks the masking pass to the same rule.
 */

import { describe, expect, it } from 'vitest';
import { stripDescriptionsAndInjectSyntheticTools } from '../cc-tools';

const serverTools = () => [
  { type: 'advisor_20260301', name: 'advisor', model: 'claude-sonnet-5' },
  { type: 'bash_20250124', name: 'bash' },
  { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
];

describe('stripDescriptionsAndInjectSyntheticTools — server-side tools', () => {
  it('passes server tools through untouched (no injected description key)', () => {
    const input = serverTools();
    const out = stripDescriptionsAndInjectSyntheticTools({ tools: input });

    for (const original of input) {
      const emitted = out.tools.find(
        (t: any) => t.name === original.name && t.type === original.type
      );
      expect(emitted, `server tool ${original.type} missing from output`).toBeDefined();
      // The key itself must be absent — `description: ''` is what upstream rejects.
      expect(Object.hasOwn(emitted, 'description')).toBe(false);
      expect(emitted).toEqual(original);
    }
  });

  it('still strips descriptions from custom tools alongside server tools', () => {
    const out = stripDescriptionsAndInjectSyntheticTools({
      tools: [
        { type: 'advisor_20260301', name: 'advisor', model: 'claude-sonnet-5' },
        { name: 'MyTool', description: 'client authored', input_schema: { type: 'object' } },
        { type: 'custom', name: 'MyOtherTool', description: 'also client authored' },
      ],
    });

    const advisor = out.tools.find((t: any) => t.type === 'advisor_20260301');
    expect(Object.hasOwn(advisor, 'description')).toBe(false);

    // type-less and type:"custom" tools are still blanked — the fingerprint
    // stripping this function exists for must not regress.
    expect(out.tools.find((t: any) => t.name === 'MyTool').description).toBe('');
    expect(out.tools.find((t: any) => t.name === 'MyOtherTool').description).toBe('');
  });

  it('leaves a body without tools[] untouched', () => {
    const body = { messages: [] };
    expect(stripDescriptionsAndInjectSyntheticTools(body)).toBe(body);
  });
});
