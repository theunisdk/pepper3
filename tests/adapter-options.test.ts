import { describe, expect, it } from 'vitest';
import { buildThreadOptions } from '../src/engine/codex/adapter.js';

describe('buildThreadOptions', () => {
  it('sets the unattended sandbox posture', () => {
    const o = buildThreadOptions({ workspacePath: '/ws' });
    expect(o.workingDirectory).toBe('/ws');
    expect(o.sandboxMode).toBe('workspace-write');
    expect(o.approvalPolicy).toBe('never');
    expect(o.networkAccessEnabled).toBe(true);
    expect(o.skipGitRepoCheck).toBe(true);
  });

  it('passes writable roots through as additionalDirectories', () => {
    const o = buildThreadOptions({ workspacePath: '/ws', additionalDirectories: ['/home/x/.config/gws'] });
    expect(o.additionalDirectories).toEqual(['/home/x/.config/gws']);
  });

  it('omits additionalDirectories when empty', () => {
    const o = buildThreadOptions({ workspacePath: '/ws', additionalDirectories: [] });
    expect(o.additionalDirectories).toBeUndefined();
  });

  it('includes the model only when set', () => {
    expect(buildThreadOptions({ workspacePath: '/ws' }).model).toBeUndefined();
    expect(buildThreadOptions({ workspacePath: '/ws', model: 'm' }).model).toBe('m');
  });
});
