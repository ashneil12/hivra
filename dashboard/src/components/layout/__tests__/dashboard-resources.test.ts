import type { HivraAgent } from '@/lib/hivra/agent-api';
import { unifyAll } from '@/lib/hivra/unified-agent';
import { filterDashboardResources, parseDashboardResources, resourceMatchesPath } from '../dashboard-resources';

const envelope = (source: string, rows: unknown[]) => ({ success: true, data: source === 'hermes' ? rows : { agents: rows } });

describe('dashboard resource projection', () => {
  it('keeps same IDs and names in separate source families and never carries access secrets', () => {
    const hermes = parseDashboardResources(envelope('hermes', [{ id: 'same', name: 'Writer', status: 'running', api_token: 'hidden' }]), 'hermes');
    const hivra = parseDashboardResources(envelope('hivra', [{ id: 'same', name: 'Writer', type: 'codex', status: 'stopped', api_token: 'hidden', chat_url: 'https://private.invalid' }]), 'hivra');
    expect(hermes[0]).toMatchObject({ uid: 'h-same', href: '/dashboard/instances/same' });
    expect(hivra[0]).toMatchObject({ uid: 'x-same', href: '/dashboard/agent/same' });
    expect(JSON.stringify([...hermes, ...hivra])).not.toMatch(/hidden|private\.invalid/);
    expect(filterDashboardResources([...hermes, ...hivra], 'x-same')).toEqual(hivra);
  });

  it('carries approval metadata without carrying its command text', () => {
    const [resource] = parseDashboardResources(envelope('hermes', [{ id: 'one', name: 'Writer', status: 'running', pendingPrompt: { promptId: 'prompt', kind: 'approval', summary: 'PRIVATE COMMAND' } }]), 'hermes');
    expect(resource.attention).toBe('approval');
    expect(JSON.stringify(resource)).not.toContain('PRIVATE COMMAND');
  });

  it('uses the actual computer profile and working desktop path, with no availability claim', () => {
    const [computer] = parseDashboardResources(envelope('hivra', [{ id: 'box', name: 'Work', type: 'linux-desktop', computer_profile: 'omarchy', status: 'running' }]), 'hivra');
    expect(computer).toMatchObject({ kind: 'computer', description: 'Omarchy', status: 'running', href: '/dashboard/agent/box?tab=desktop' });
  });

  it('classifies a provider agent with a desktop profile as the computer web Home shows', () => {
    // An agent type that carries a desktop profile is a computer on web Home
    // (unified-agent) and in the canonical resource shadow; the sidebar and the
    // native inventory must list it in the same group, on its desktop.
    const rows = [
      { id: 'provider-desktop', name: 'Provider box', type: 'claude-code', computer_profile: 'ubuntu-desktop', status: 'running' },
      { id: 'agent', name: 'Agent', type: 'claude-code', computer_profile: null, status: 'running' },
      { id: 'ubuntu', name: 'Ubuntu', type: 'linux-desktop', computer_profile: 'ubuntu-desktop', status: 'running' },
      { id: 'sandbox', name: 'Sandbox', type: 'linux-terminal', status: 'running' },
    ];
    const feed = parseDashboardResources(envelope('hivra', rows), 'hivra');
    const home = unifyAll([], rows as unknown as HivraAgent[]);
    expect(feed.find((resource) => resource.id === 'provider-desktop')).toMatchObject({
      kind: 'computer', description: 'Ubuntu Desktop', href: '/dashboard/agent/provider-desktop?tab=desktop',
    });
    for (const row of rows) {
      expect({ id: row.id, kind: feed.find((resource) => resource.id === row.id)?.kind })
        .toEqual({ id: row.id, kind: home.find((agent) => agent.id === row.id)?.resourceKind });
    }
  });

  it('opens Windows through the fast desktop handoff from native inventory', () => {
    const [computer] = parseDashboardResources(envelope('hivra', [{ id: 'win', name: 'Windows', type: 'linux-desktop', computer_profile: 'windows', status: 'running' }]), 'hivra');
    expect(computer.href).toBe('/dashboard/agent/win?tab=desktop&open=fast');
  });

  it('keeps unknown states truthful and removes deleted resources from either lifecycle field', () => {
    expect(parseDashboardResources(envelope('hermes', [
      { id: 'new', name: 'New state', status: 'awaiting_restore' },
      { id: 'gone', name: 'Gone', status: 'deleted' },
      { id: 'stale', name: 'Gone too', status: 'running', lifecycle_state: 'deleted' },
    ]), 'hermes')).toEqual([expect.objectContaining({ id: 'new', status: 'awaiting_restore' })]);
  });

  it('rejects malformed or duplicate records rather than claiming an empty source', () => {
    expect(() => parseDashboardResources({ success: false }, 'hermes')).toThrow();
    expect(() => parseDashboardResources(envelope('hivra', [{ id: 'a', name: 'A', status: 'running' }]), 'hivra')).toThrow();
    expect(() => parseDashboardResources(envelope('hermes', [
      { id: 'a', name: 'A', status: 'running' }, { id: 'a', name: 'B', status: 'stopped' },
    ]), 'hermes')).toThrow();
  });

  it('encodes identifiers and matches only the selected route boundary', () => {
    const [resource] = parseDashboardResources(envelope('hermes', [{ id: 'one/two', name: 'A', status: 'running' }]), 'hermes');
    expect(resource.href).toBe('/dashboard/instances/one%2Ftwo');
    expect(resourceMatchesPath(resource, `${resource.href}/console`)).toBe(true);
    expect(resourceMatchesPath(resource, `${resource.href}-different`)).toBe(false);
  });
});
