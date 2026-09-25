'use client';

import { useCallback } from 'react';
import { useReverification } from '@clerk/nextjs';
import { isReverificationCancelledError } from '@clerk/nextjs/errors';

/**
 * JSON requests that change a withdrawal destination (including verifying a
 * different wallet for a lock-wallet holder). The server answers them
 * with Clerk's reverification response (403) unless the user signed in or
 * confirmed it's them in the last few minutes; Clerk's useReverification then
 * shows its "confirm it's you" dialog and retries the request.
 */

export interface StepUpJsonResult {
  ok: boolean;
  status: number;
  // The route's JSON body ({ success, data, error }), or {} when unreadable.
  body: { success?: boolean; data?: Record<string, unknown>; error?: string } & Record<string, unknown>;
}

interface ClerkReverificationHint {
  clerk_error: { type: 'forbidden'; reason: 'reverification-error' };
}

function isClerkReverificationHint(value: unknown): value is ClerkReverificationHint {
  if (!value || typeof value !== 'object' || !('clerk_error' in value)) return false;
  const error = (value as { clerk_error?: { type?: unknown; reason?: unknown } }).clerk_error;
  return error?.type === 'forbidden' && error?.reason === 'reverification-error';
}

async function requestJson(url: string, init: RequestInit): Promise<StepUpJsonResult | ClerkReverificationHint> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  // Handed back as-is so useReverification recognises it and prompts.
  if (isClerkReverificationHint(body)) return body;
  return { ok: response.ok, status: response.status, body: body ?? {} };
}

/**
 * Returns a request function for destination changes. It resolves to null
 * when the user closes the "confirm it's you" dialog without confirming.
 */
export function useStepUpJsonRequest() {
  const request = useReverification(requestJson);
  return useCallback(
    async (url: string, init: RequestInit): Promise<StepUpJsonResult | null> => {
      try {
        return (await request(url, init)) as StepUpJsonResult;
      } catch (err) {
        if (isReverificationCancelledError(err)) return null;
        throw err;
      }
    },
    [request],
  );
}

export const STEP_UP_CANCELLED_MESSAGE = "Confirm it's you to save this address. Nothing was changed.";
export const STEP_UP_CANCELLED_VERIFY_MESSAGE = "Confirm it's you to verify this wallet. Nothing was changed.";
