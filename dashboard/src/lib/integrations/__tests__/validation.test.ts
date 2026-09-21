import { validateCustomVariable } from '../config';

describe('validateCustomVariable', () => {
  it('should return valid for normal keys', () => {
    expect(validateCustomVariable('MY_API_KEY').valid).toBe(true);
    expect(validateCustomVariable('database_url').valid).toBe(true);
    expect(validateCustomVariable('CUSTOM_VAR_123').valid).toBe(true);
  });

  it('should return invalid for completely empty key', () => {
    const result = validateCustomVariable('');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Missing Variable Name/);
  });

  it('should return invalid for keys with invalid characters but eventually evaluates to empty', () => {
    const result = validateCustomVariable('!@#$%');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Invalid Variable Name/);
  });

  it('should return invalid for keys containing spaces or special characters', () => {
    const result = validateCustomVariable('MY VAR');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Invalid Variable Name/);
  });

  it('should block reserved prefixes', () => {
    const reserved = [
      'HERMES_CONFIG', 'API_SERVER_KEY', 'AWS_ACCESS_KEY', 'STRIPE_SECRET',
      'NEXT_PUBLIC_URL', 'SSH_AUTH', 'DOCKER_HOST', 'MYSQL_PWD', 'POSTGRES_USER', 'REDIS_URL'
    ];
    reserved.forEach(key => {
      const result = validateCustomVariable(key);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/is reserved for system use/);
    });
  });

  it('should block reserved exact keys like PORT and HOST', () => {
    expect(validateCustomVariable('PORT').valid).toBe(false);
    expect(validateCustomVariable('HOST').valid).toBe(false);
    expect(validateCustomVariable('port').valid).toBe(false);
    expect(validateCustomVariable('host').valid).toBe(false);
  });
});
