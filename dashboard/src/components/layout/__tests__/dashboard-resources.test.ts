import { filterDashboardResources, parseAttachedDashboardResources, parseDashboardResources, resourceMatchesPath } from '../dashboard-resources';

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

  // The shell's sidebar and Cmd-K list the agents added to computers too, each
  // opening its computer's Chat tab (or the progress while it is being added).
  it('lists an agent added to a computer by its own uid, opening that computer', () => {
    const computerId = '11111111-1111-4111-8111-111111111111';
    const rows = parseAttachedDashboardResources({ success: true, data: { enabled: true, agents: [
      { id: '77777777-7777-4777-8777-777777777777', phase: 'attached', agentName: 'Codex', computerId, computerName: 'MY_UBUNTU_DESKTOP', computerStatus: 'running', api_token: 'hidden' },
      { id: '88888888-8888-4888-8888-888888888888', phase: 'claimed', agentName: 'Codex', computerId, computerName: 'MY_UBUNTU_DESKTOP', computerStatus: 'running' },
    ] } });
    expect(rows[0]).toMatchObject({ uid: 'a-77777777-7777-4777-8777-777777777777', source: 'hivra', kind: 'agent', name: 'Codex on MY_UBUNTU_DESKTOP',
      status: 'running', href: `/dashboard/agent/${computerId}?tab=chat`, hostUid: `x-${computerId}` });
    expect(rows[1]).toMatchObject({ status: 'provisioning', href: `/dashboard/agent/${computerId}?tab=manage` });
    expect(JSON.stringify(rows)).not.toContain('hidden');
    expect(parseAttachedDashboardResources({ success: true, data: { enabled: false, agents: [] } })).toEqual([]);
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
