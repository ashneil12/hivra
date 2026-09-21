import { ApiKeySchema } from '../app/api/vault/schema';

describe('Vault API Key Schema', () => {
  it('accepts valid new API keys with name and provider', () => {
    const validPayload = {
      name: 'Honcho Test Key',
      provider: 'honcho',
      key: 'sk_test_12345',
    };
    
    const result = ApiKeySchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  it('rejects keys missing provider', () => {
    const invalidPayload = {
      name: 'Honcho Test Key',
      key: 'sk_test_12345',
    };
    
    const result = ApiKeySchema.safeParse(invalidPayload);
    expect(result.success).toBe(false);
  });

  it('rejects keys missing name', () => {
    const invalidPayload = {
      provider: 'honcho',
      key: 'sk_test_12345',
    };
    
    const result = ApiKeySchema.safeParse(invalidPayload);
    expect(result.success).toBe(false);
  });

  it('accepts an update payload without the actual key string', () => {
    const validUpdatePayload = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: 'Honcho Production Key',
      provider: 'honcho',
    };
    
    const result = ApiKeySchema.safeParse(validUpdatePayload);
    expect(result.success).toBe(true);
  });
});
