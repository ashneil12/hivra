import { POST } from '../route';
import { auth } from '@clerk/nextjs/server';
import { enforceAuthenticatedRouteRateLimit } from '@/lib/authenticated-rate-limit';

jest.mock('@clerk/nextjs/server', () => ({
  auth: jest.fn(),
}));

jest.mock('@/lib/authenticated-rate-limit', () => ({
  RATE_LIMIT_PRESETS: {
    uploadWrite: {},
  },
  enforceAuthenticatedRouteRateLimit: jest.fn(),
}));

describe('POST /api/avatar-crop-suggestion', () => {
  const originalScopedApiKey = process.env.AVATAR_CROP_OPENAI_API_KEY;
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  const mockedAuth = auth as jest.MockedFunction<typeof auth>;
  const mockedRateLimit = enforceAuthenticatedRouteRateLimit as jest.MockedFunction<
    typeof enforceAuthenticatedRouteRateLimit
  >;
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  let consoleWarnSpy: jest.SpyInstance;

  function buildRequest(formData: FormData) {
    return {
      formData: jest.fn().mockResolvedValue(formData),
    } as unknown as Request;
  }

  // 8-byte PNG signature + 4 padding bytes so detectImageType's 12-byte
  // minimum is satisfied. Use this as the file body any time the test
  // expects validateAvatarFile to accept the upload.
  const PNG_SIGNATURE = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 0,
  ]);
  const realPngFile = () => new File([PNG_SIGNATURE], 'avatar.png', { type: 'image/png' });

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.AVATAR_CROP_OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    mockedAuth.mockResolvedValue({ userId: 'user_123' } as Awaited<ReturnType<typeof auth>>);
    mockedRateLimit.mockReturnValue(null);
    fetchMock = jest.spyOn(global, 'fetch');
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalScopedApiKey === undefined) {
      delete process.env.AVATAR_CROP_OPENAI_API_KEY;
    } else {
      process.env.AVATAR_CROP_OPENAI_API_KEY = originalScopedApiKey;
    }

    if (originalOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    }

    fetchMock.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  it('returns 401 when unauthenticated', async () => {
    mockedAuth.mockResolvedValue({ userId: null } as Awaited<ReturnType<typeof auth>>);

    const response = await POST(buildRequest(new FormData()));

    expect(response.status).toBe(401);
  });

  it('falls back to a centered crop when no server key is configured', async () => {
    const formData = new FormData();
    formData.set('file', realPngFile());

    const response = await POST(buildRequest(formData));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(json.data).toEqual({
      centerX: 0.5,
      centerY: 0.5,
      size: 1,
      source: 'default',
    });
  });

  it('returns a model-provided crop suggestion when OpenAI succeeds', async () => {
    process.env.AVATAR_CROP_OPENAI_API_KEY = 'crop-key';
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            centerX: 0.48,
            centerY: 0.36,
            size: 0.58,
          }),
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );

    const formData = new FormData();
    formData.set('file', realPngFile());

    const response = await POST(buildRequest(formData));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toEqual({
      centerX: 0.48,
      centerY: 0.36,
      size: 0.58,
      source: 'model',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/responses',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer crop-key',
        }),
      })
    );
  });

  it('rejects files larger than 1MB before calling OpenAI', async () => {
    process.env.AVATAR_CROP_OPENAI_API_KEY = 'crop-key';

    // 1.5MB blob — over the 1MB cap.
    const oversized = new Uint8Array(1_572_864);
    const formData = new FormData();
    formData.set('file', new File([oversized], 'big.png', { type: 'image/png' }));

    const response = await POST(buildRequest(formData));

    expect(response.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back cleanly when OpenAI rejects the crop request', async () => {
    process.env.OPENAI_API_KEY = 'shared-openai-key';
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'secret-reason' } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const formData = new FormData();
    formData.set('file', realPngFile());

    const response = await POST(buildRequest(formData));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toEqual({
      centerX: 0.5,
      centerY: 0.5,
      size: 1,
      source: 'default',
    });
    expect(JSON.stringify(consoleWarnSpy.mock.calls)).not.toContain('secret-reason');
  });

  it('rejects an upload whose bytes do NOT match the claimed image type (forged Content-Type)', async () => {
    process.env.AVATAR_CROP_OPENAI_API_KEY = 'crop-key';
    // HTML bytes labeled image/png. Both the extension and Content-Type
    // pass the surface checks; only the magic-byte sniff catches it.
    const forged = new File([
      new Uint8Array([
        0x3c, 0x21, 0x44, 0x4f, 0x43, 0x54, 0x59, 0x50, 0x45, 0x20, 0x68, 0x74,
      ]),
    ], 'evil.png', { type: 'image/png' });
    const formData = new FormData();
    formData.set('file', forged);

    const response = await POST(buildRequest(formData));

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards the sniffed MIME type to OpenAI, not the client-supplied one', async () => {
    process.env.AVATAR_CROP_OPENAI_API_KEY = 'crop-key';
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ output_text: JSON.stringify({ centerX: 0.5, centerY: 0.5, size: 1 }) }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    // Client claims image/gif but body is PNG bytes; the sniffed type wins.
    const formData = new FormData();
    formData.set('file', new File([PNG_SIGNATURE], 'avatar.gif', { type: 'image/gif' }));

    const response = await POST(buildRequest(formData));
    expect(response.status).toBe(200);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [unknown, RequestInit])[1].body));
    type ImagePart = { type?: string; image_url?: string };
    const imagePart = (body.input?.[1]?.content as ImagePart[] | undefined)?.find(
      (part) => part?.type === 'input_image'
    );
    expect(imagePart?.image_url?.startsWith('data:image/png;base64,')).toBe(true);
    expect(imagePart?.image_url?.startsWith('data:image/gif;base64,')).toBe(false);
  });
});
