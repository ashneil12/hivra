import { attentionFallbackReason, attentionLabel, needsOwnerAttention, resourceAttention } from '../resource-attention';

it('only exposes a real, unexpired prompt kind', () => {
  expect(resourceAttention('running')).toBeNull();
  expect(resourceAttention('running', { kind: 'approval' })).toBeNull();
  expect(resourceAttention('running', { promptId: 'p1', kind: 'approval', expiresAt: '2000-01-01' })).toBeNull();
  expect(resourceAttention('running', { promptId: 'p1', kind: 'approval', expiresAt: 'invalid' })).toBeNull();
  expect(resourceAttention('running', { promptId: 'p1', kind: 'approval', expiresAt: '2099-01-01' })).toBe('approval');
  expect(resourceAttention('running', { promptId: 'p1', kind: 'clarify' })).toBe('clarify');
});

it('keeps healthy and stopped resources quiet, and failures actionable', () => {
  expect(resourceAttention('stopped')).toBeNull();
  expect(resourceAttention('error')).toBe('error');
  expect(resourceAttention('failed')).toBe('error');
  expect(attentionLabel('approval')).toBe('Needs approval');
  expect(attentionLabel('clarify')).toBe('Needs your input');
});

it('counts a row as needing the owner exactly when it has an attention kind', () => {
  expect(needsOwnerAttention({ attention: resourceAttention('error') })).toBe(true);
  expect(needsOwnerAttention({ attention: resourceAttention('failed') })).toBe(true);
  expect(needsOwnerAttention({ attention: resourceAttention('running') })).toBe(false);
  expect(needsOwnerAttention({})).toBe(false);
});

it('has a plain fallback reason for every kind', () => {
  expect(attentionFallbackReason('error')).toBe('Something went wrong and it stopped working.');
  expect(attentionFallbackReason('approval')).toMatch(/approve/);
  expect(attentionFallbackReason('clarify')).toMatch(/answer/);
});
