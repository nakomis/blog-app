import { configFor, resolveConfig } from '../lib/config';

describe('resolveConfig', () => {
  test('defaults to prod when NPM_ENVIRONMENT is unset', () => {
    expect(resolveConfig(undefined).deployEnv).toBe('prod');
    expect(resolveConfig('').deployEnv).toBe('prod');
  });

  test('selects sandbox and prod explicitly', () => {
    expect(resolveConfig('sandbox')).toBe(configFor('sandbox'));
    expect(resolveConfig('prod')).toBe(configFor('prod'));
  });

  test('rejects an unknown environment', () => {
    expect(() => resolveConfig('staging')).toThrow(/NPM_ENVIRONMENT/);
  });

  test('prod keeps the names the live stacks were deployed with', () => {
    const prod = configFor('prod');
    expect(prod.accountId).toBe('637423226886');
    expect(prod.domainName).toBe('blog.nakomis.com');
    expect(prod.legacyDomain?.domainName).toBe('blog.nakom.is');
    expect(prod.bucketName).toBe('blog-nakom-is-eu-west-2-637423226886');
    expect(prod.suffix).toBe('');
  });

  test('sandbox lives in the sandbox account and zone', () => {
    const sandbox = configFor('sandbox');
    expect(sandbox.accountId).toBe('975050268859');
    expect(sandbox.domainName).toBe('blog.sandbox.nakomis.com');
    expect(sandbox.hostedZoneName).toBe('sandbox.nakomis.com');
    expect(sandbox.legacyDomain).toBeUndefined();
    expect(sandbox.blogSearchApi).toBe(false);
  });
});
