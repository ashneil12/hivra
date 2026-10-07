/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { ReleasesConsole } from '../ReleasesConsole';

const fetchMock = jest.fn();

const DIGEST_A = 'sha256:' + 'a'.repeat(64);
const DIGEST_B = 'sha256:' + 'b'.repeat(64);
const BOX_1 = '11111111-1111-4111-8111-111111111111';
const BOX_2 = '22222222-2222-4222-8222-222222222222';

function release(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rel-a',
    image_repo: 'ghcr.io/ash/hermes',
    version: '2026.10.07.1',
    digest: DIGEST_A,
    stage: 'canary',
    halted: false,
    halted_reason: null,
    halted_by: null,
    notes: null,
    created_at: '2026-10-07T10:00:00.000Z',
    boxes: 2,
    health: { succeededBoxes: 1, failedBoxes: 0 },
    ...overrides,
  };
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    releases: [
      release(),
      release({ id: 'rel-old', version: '2026.10.01.1', digest: DIGEST_B, stage: 'full', created_at: '2026-10-01T10:00:00.000Z', boxes: 7 }),
    ],
    attention: [],
    boxes: [
      { id: BOX_1, name: 'alpha', channel: 'stable', version: '2026.10.01.1' },
      { id: BOX_2, name: 'beta', channel: 'canary', version: '2026.10.07.1' },
    ],
    fleet: { total: 10, reporting: 8, onNewUpdateStack: 6 },
    ...overrides,
  };
}

function ok(data: unknown, status = 200) {
  return { ok: true, status, json: async () => ({ success: true, data }), text: async () => '' };
}

function fail(error: string, status = 400) {
  return { ok: false, status, json: async () => ({ success: false, error }), text: async () => JSON.stringify({ success: false, error }) };
}

/** GET returns `get()`; every other call is answered by `post(url, body)`. */
function mockApi(get: () => unknown, post: (url: string, body: Record<string, unknown>) => unknown = () => ok({})) {
  fetchMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    if (!init?.method || init.method === 'GET') return get();
    return post(url, JSON.parse(init.body ?? '{}'));
  });
}

function postCalls() {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
}

async function renderLoaded(data = payload()) {
  mockApi(() => ok(data));
  render(<ReleasesConsole />);
  await screen.findByRole('article', { name: 'Release 2026.10.07.1' });
}

describe('ReleasesConsole', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    Object.defineProperty(global, 'fetch', { configurable: true, value: fetchMock });
  });

  it('shows the fleet summary and each release with its stage, boxes and health', async () => {
    await renderLoaded();

    expect(screen.getByText(/8 of 10 boxes report which version they run/)).toBeInTheDocument();
    expect(screen.getByText(/6 of 10 boxes are on the new update stack/)).toBeInTheDocument();

    const newest = screen.getByRole('article', { name: 'Release 2026.10.07.1' });
    expect(within(newest).getByText(/aaaaaaaaaaaa · ghcr.io\/ash\/hermes/)).toBeInTheDocument();
    expect(within(newest).getByText(/2 boxes run this release/)).toBeInTheDocument();
    expect(within(newest).getByText(/1 succeeded, 0 failed/)).toBeInTheDocument();
    const current = within(newest).getByRole('listitem', { current: 'step' });
    expect(current).toHaveTextContent('Early access');
    expect(within(newest).getByRole('button', { name: 'Promote to 1 box' })).toBeInTheDocument();

    const old = screen.getByRole('article', { name: 'Release 2026.10.01.1' });
    expect(within(old).getByRole('listitem', { current: 'step' })).toHaveTextContent('100%');
    expect(within(old).getByRole('button', { name: 'Promote' })).toBeDisabled();
    expect(within(old).getByText('Already at 100%.')).toBeInTheDocument();
  });

  it('lists releases newest first', async () => {
    await renderLoaded();
    const articles = screen.getAllByRole('article');
    expect(articles[0]).toHaveAccessibleName('Release 2026.10.07.1');
    expect(articles[1]).toHaveAccessibleName('Release 2026.10.01.1');
  });

  it('promotes one rung with an inline confirm step', async () => {
    mockApi(
      () => ok(payload({ releases: [release({ stage: 'ten_percent' })] })),
      () => ok({ release: release({ stage: 'full' }) })
    );
    render(<ReleasesConsole />);
    const card = await screen.findByRole('article', { name: 'Release 2026.10.07.1' });

    fireEvent.click(within(card).getByRole('button', { name: 'Promote to 100%' }));
    expect(postCalls()).toHaveLength(0);

    fireEvent.click(within(card).getByRole('button', { name: /Confirm: promote 2026.10.07.1 to 100%/ }));
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(postCalls()[0][0]).toBe('/api/ops/hermes-releases/rel-a');
    expect(JSON.parse(postCalls()[0][1].body)).toEqual({ action: 'promote' });
    // The list is refetched after the action.
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => !init?.method)).toHaveLength(2));
  });

  it('needs a pilot box before the pilot promotion is enabled', async () => {
    mockApi(() => ok(payload()), () => ok({ release: release({ stage: 'pilot' }) }));
    render(<ReleasesConsole />);
    const card = await screen.findByRole('article', { name: 'Release 2026.10.07.1' });

    const promote = within(card).getByRole('button', { name: 'Promote to 1 box' });
    expect(promote).toBeDisabled();
    expect(within(card).getByText('Choose a pilot box to enable promotion.')).toBeInTheDocument();
    expect(within(card).getByRole('option', { name: 'alpha (11111111), 2026.10.01.1' })).toBeInTheDocument();

    fireEvent.change(within(card).getByLabelText('Pilot box'), { target: { value: BOX_1 } });
    expect(promote).toBeEnabled();
    fireEvent.click(promote);
    fireEvent.click(within(card).getByRole('button', { name: /Confirm: promote/ }));

    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(JSON.parse(postCalls()[0][1].body)).toEqual({ action: 'promote', pilotInstanceId: BOX_1 });
  });

  it('blocks promotion on a halted release and shows the halt reason', async () => {
    await renderLoaded(
      payload({ releases: [release({ halted: true, halted_reason: 'Auto-halted: 1 of 1 reporting boxes failed', halted_by: 'auto' })] })
    );
    const card = screen.getByRole('article', { name: 'Release 2026.10.07.1' });
    expect(within(card).getByText('HALTED')).toBeInTheDocument();
    expect(within(card).getByText(/\(automatic\)/)).toBeInTheDocument();
    expect(within(card).getByText(/1 of 1 reporting boxes failed/)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Promote to 1 box' })).toBeDisabled();
    expect(within(card).getByText('Halted. Unhalt it before promoting.')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Halt' })).not.toBeInTheDocument();
  });

  it('requires a reason of at least 3 characters to halt', async () => {
    mockApi(() => ok(payload()), () => ok({ release: release({ halted: true }) }));
    render(<ReleasesConsole />);
    const card = await screen.findByRole('article', { name: 'Release 2026.10.07.1' });

    fireEvent.click(within(card).getByRole('button', { name: 'Halt' }));
    const confirm = within(card).getByRole('button', { name: 'Confirm halt' });
    expect(confirm).toBeDisabled();

    fireEvent.change(within(card).getByLabelText('Why halt this release?'), { target: { value: 'ab' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(card).getByLabelText('Why halt this release?'), { target: { value: 'boxes crash loop' } });
    expect(confirm).toBeEnabled();
    expect(postCalls()).toHaveLength(0);

    fireEvent.click(confirm);
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(JSON.parse(postCalls()[0][1].body)).toEqual({ action: 'halt', reason: 'boxes crash loop' });
  });

  it('unhalts a halted release', async () => {
    mockApi(
      () => ok(payload({ releases: [release({ halted: true, halted_reason: 'bad', halted_by: 'ash' })] })),
      () => ok({ release: release() })
    );
    render(<ReleasesConsole />);
    const card = await screen.findByRole('article', { name: 'Release 2026.10.07.1' });

    fireEvent.click(within(card).getByRole('button', { name: 'Unhalt' }));
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(postCalls()[0][0]).toBe('/api/ops/hermes-releases/rel-a');
    expect(JSON.parse(postCalls()[0][1].body)).toEqual({ action: 'unhalt' });
  });

  it('registers by tag with the repo prefilled from the newest release', async () => {
    mockApi(
      () => ok(payload()),
      () => ok({ release: release({ version: '2026.10.08.1', stage: 'registered' }), created: true }, 201)
    );
    render(<ReleasesConsole />);
    await screen.findByRole('article', { name: 'Release 2026.10.07.1' });

    const repo = screen.getByLabelText('Image repo') as HTMLInputElement;
    expect(repo.value).toBe('ghcr.io/ash/hermes');
    const submit = screen.getByRole('button', { name: 'Register release' });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Tag'), { target: { value: ' 2026.10.08.1 ' } });
    fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: 'new gateway' } });
    fireEvent.click(submit);

    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(postCalls()[0][0]).toBe('/api/ops/hermes-releases');
    expect(JSON.parse(postCalls()[0][1].body)).toEqual({
      imageRepo: 'ghcr.io/ash/hermes',
      tag: '2026.10.08.1',
      notes: 'new gateway',
    });
    expect(await screen.findByText('Registered 2026.10.08.1. Stage: Registered, not yet offered to any box.')).toBeInTheDocument();
  });

  it('shows the error text when registering fails', async () => {
    mockApi(() => ok(payload()), () => fail('Tag not found in the registry', 422));
    render(<ReleasesConsole />);
    await screen.findByRole('article', { name: 'Release 2026.10.07.1' });

    fireEvent.change(screen.getByLabelText('Tag'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Register release' }));

    expect(await screen.findByText('Tag not found in the registry')).toBeInTheDocument();
  });

  it('lists boxes needing attention', async () => {
    await renderLoaded(
      payload({
        attention: [
          {
            instanceId: BOX_1,
            name: 'alpha',
            updateHealth: 'rolled_back',
            detail: 'Health check failed after the update',
            at: new Date(Date.now() - 5 * 60_000).toISOString(),
            version: '2026.10.07.1',
          },
        ],
      })
    );
    const section = screen.getByRole('region', { name: 'Boxes needing attention' });
    expect(within(section).getByText('alpha (11111111)')).toBeInTheDocument();
    expect(within(section).getByText('rolled back')).toBeInTheDocument();
    expect(within(section).getByText('Health check failed after the update')).toBeInTheDocument();
    expect(within(section).getByText(/5 min ago · 2026.10.07.1/)).toBeInTheDocument();
  });

  it('shows the empty state when no box needs attention', async () => {
    await renderLoaded();
    expect(screen.getByText('No box has a paused or failed update stack.')).toBeInTheDocument();
  });

  it('moves a box between the stable and canary channels', async () => {
    mockApi(() => ok(payload()), () => ok({ id: BOX_1, channel: 'canary' }));
    render(<ReleasesConsole />);
    await screen.findByRole('article', { name: 'Release 2026.10.07.1' });

    fireEvent.click(screen.getByRole('button', { name: 'Move to early access: alpha (11111111)' }));
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(postCalls()[0][0]).toBe(`/api/ops/hermes-releases/boxes/${BOX_1}`);
    expect(JSON.parse(postCalls()[0][1].body)).toEqual({ channel: 'canary' });

    // Buttons are disabled while the first request is in flight.
    const second = screen.getByRole('button', { name: 'Move to stable: beta (22222222)' });
    await waitFor(() => expect(second).toBeEnabled());
    fireEvent.click(second);
    await waitFor(() => expect(postCalls()).toHaveLength(2));
    expect(postCalls()[1][0]).toBe(`/api/ops/hermes-releases/boxes/${BOX_2}`);
    expect(JSON.parse(postCalls()[1][1].body)).toEqual({ channel: 'stable' });
  });

  it('shows a failed action next to the release', async () => {
    mockApi(() => ok(payload({ releases: [release({ stage: 'ten_percent' })] })), () => fail('The release is already fully rolled out', 409));
    render(<ReleasesConsole />);
    const card = await screen.findByRole('article', { name: 'Release 2026.10.07.1' });

    fireEvent.click(within(card).getByRole('button', { name: 'Promote to 100%' }));
    fireEvent.click(within(card).getByRole('button', { name: /Confirm: promote/ }));

    expect(await within(card).findByRole('alert')).toHaveTextContent('The release is already fully rolled out');
  });

  it('shows an error when the releases cannot be loaded', async () => {
    mockApi(() => fail('Forbidden', 403));
    render(<ReleasesConsole />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load releases: Forbidden');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('shows a loading state and then an empty state with no releases', async () => {
    mockApi(() => ok(payload({ releases: [], boxes: [] })));
    render(<ReleasesConsole />);
    expect(screen.getByText('Loading releases…')).toBeInTheDocument();
    expect(await screen.findByText(/No releases yet/)).toBeInTheDocument();
    expect((screen.getByLabelText('Image repo') as HTMLInputElement).value).toBe('');
  });
});
