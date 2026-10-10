import { expect, test } from 'bun:test';
import { createJanitorAuth } from '../src/janitor-auth';

const at = 1800000000;
const activeSession = (name = 'alice', expiry = at + 3600) => ({
  access_token: `access-${name}`, refresh_token: `refresh-${name}`, expires_at: expiry, token_type: 'bearer',
  user: { email: `${name}@example.test`, arbitrary: 'not retained' },
});
function harness(reply: (url: string, options: any) => Promise<any> = async () => ({ status: 200, body: JSON.stringify(activeSession()) }), supportsOriginRestriction = true) {
  const secrets = new Map<string, string>();
  const calls: { url: string; options: any }[] = [];
  const probes: { url: string; options: any }[] = [];
  const writes: { key: string; userId: string; value: string }[] = [];
  const deletes: string[] = [];
  const auth = createJanitorAuth({
    now: () => at * 1000,
    httpJson: async (url, options) => {
      if (options.method === 'GET') {
        probes.push({ url, options });
        if (supportsOriginRestriction) throw new Error('URL origin is not allowed: https://auth.janitorai.com');
        return { status: 200, body: '{"published_settings":true}' };
      }
      calls.push({ url, options });
      return reply(url, options);
    },
    enclave: {
      get: async (key, userId) => secrets.get(`${userId}:${key}`) || null,
      put: async (key, value, userId) => { secrets.set(`${userId}:${key}`, value); writes.push({ key, userId, value }); },
      delete: async (key, userId) => { deletes.push(`${userId}:${key}`); return secrets.delete(`${userId}:${key}`); },
    },
  });
  return { auth, secrets, calls, probes, writes, deletes };
}

test('email-code connection uses the fixed official verification endpoint and only encrypted session fields persist', async () => {
  const { auth, calls, probes, writes } = harness();
  expect(await auth.status('alice')).toEqual({ connected: false });
  expect(await auth.headers('alice')).toEqual({});
  expect(await auth.connect('alice', ' Alice@Example.test ', '123456')).toEqual({ connected: true });
  expect(await auth.status('alice')).toEqual({ connected: true });
  expect(await auth.headers('alice')).toEqual({ Authorization: 'Bearer access-alice' });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe('https://auth.janitorai.com/auth/v1/verify');
  expect(calls[0]!.options.method).toBe('POST');
  expect(calls[0]!.options.headers['Content-Type']).toBe('application/json');
  expect(typeof calls[0]!.options.headers.apikey).toBe('string');
  expect(calls[0]!.options.headers.apikey).not.toBe('__PUBLISHED_JANITOR_ANON_KEY__');
  expect(calls[0]!.options.headers.Authorization).toBeUndefined();
  expect(calls[0]!.options.allowedOrigins).toEqual(['https://auth.janitorai.com']);
  expect(probes).toHaveLength(1);
  expect(probes[0]!).toEqual({ url: 'https://auth.janitorai.com/auth/v1/settings', options: { method: 'GET', headers: { Accept: 'application/json' }, allowedOrigins: [] } });
  expect(JSON.parse(calls[0]!.options.body)).toEqual({ email: 'alice@example.test', token: '123456', type: 'email' });
  expect(writes).toHaveLength(1);
  expect(writes[0]!.key).toBe('janitor_session');
  expect(writes[0]!.userId).toBe('alice');
  expect(JSON.parse(writes[0]!.value)).toEqual({ access_token: 'access-alice', refresh_token: 'refresh-alice', expires_at: at + 3600 });
  expect(writes[0]!.value).not.toContain('example.test');
  expect(writes[0]!.value).not.toContain('123456');
  expect(writes[0]!.value).not.toContain('arbitrary');
});

test('connection and local disconnect isolate different Lumiverse users without requesting codes or remote logout', async () => {
  const { auth, calls } = harness(async (_url, options) => {
    const name = JSON.parse(options.body).email.startsWith('bob') ? 'bob' : 'alice';
    return { status: 200, body: JSON.stringify(activeSession(name)) };
  });
  await auth.connect('alice', 'alice@example.test', '123456');
  expect(await auth.status('bob')).toEqual({ connected: false });
  await auth.connect('bob', 'bob@example.test', '654321');
  expect(await auth.headers('bob')).toEqual({ Authorization: 'Bearer access-bob' });
  expect(await auth.headers('alice')).toEqual({ Authorization: 'Bearer access-alice' });
  expect(await auth.disconnect('alice')).toEqual({ connected: false });
  expect(await auth.headers('alice')).toEqual({});
  expect(await auth.status('bob')).toEqual({ connected: true });
  expect(calls).toHaveLength(2);
  expect(calls.every(call => call.url.endsWith('/auth/v1/verify'))).toBe(true);
});

test('near-expiry concurrent reads serialize refresh rotation and use the renewed token once', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { auth, secrets, calls, writes } = harness(async () => {
    await gate;
    return { status: 200, body: JSON.stringify(activeSession('rotated')) };
  });
  secrets.set('alice:janitor_session', JSON.stringify(activeSession('old', at + 59)));
  const requests = [auth.headers('alice'), auth.headers('alice'), auth.headers('alice')];
  release();
  expect(await Promise.all(requests)).toEqual(Array(3).fill({ Authorization: 'Bearer access-rotated' }));
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe('https://auth.janitorai.com/auth/v1/token?grant_type=refresh_token');
  expect(calls[0]!.options.allowedOrigins).toEqual(['https://auth.janitorai.com']);
  expect(JSON.parse(calls[0]!.options.body)).toEqual({ refresh_token: 'refresh-old' });
  expect(writes).toHaveLength(1);
  expect(JSON.parse(secrets.get('alice:janitor_session')!).refresh_token).toBe('refresh-rotated');
});

test('force refresh for a 401 retry coalesces concurrent requests even with a locally unexpired token', async () => {
  const { auth, secrets, calls } = harness(async () => ({ status: 200, body: JSON.stringify(activeSession('retry')) }));
  secrets.set('alice:janitor_session', JSON.stringify(activeSession('rejected')));
  const first = auth.refresh('alice'), second = auth.refresh('alice');
  expect(first).toBe(second);
  expect(await first).toEqual({ Authorization: 'Bearer access-retry' });
  expect(await second).toEqual({ Authorization: 'Bearer access-retry' });
  expect(calls).toHaveLength(1);
  expect(await auth.headers('alice')).toEqual({ Authorization: 'Bearer access-retry' });
});

test('disconnect queued behind refresh leaves the account disconnected after token rotation', async () => {
  const { auth, secrets, calls } = harness(async () => ({ status: 200, body: JSON.stringify(activeSession('rotated')) }));
  secrets.set('alice:janitor_session', JSON.stringify(activeSession('old', at + 10)));
  const headers = auth.headers('alice');
  const disconnect = auth.disconnect('alice');
  expect(await headers).toEqual({ Authorization: 'Bearer access-rotated' });
  expect(await disconnect).toEqual({ connected: false });
  expect(await auth.status('alice')).toEqual({ connected: false });
  expect(calls).toHaveLength(1);
});

test('invalid codes and malformed sign-in responses return fixed errors without sensitive response content', async () => {
  for (const response of [
    { status: 401, body: 'alice@example.test 123456 access-secret refresh-secret' },
    { status: 200, body: 'not JSON access-secret' },
    { status: 200, body: JSON.stringify({ ...activeSession(), access_token: 'injected\r\nAuthorization: secret' }) },
    { status: 200, body: JSON.stringify({ ...activeSession(), expires_at: at - 1 }) },
    { status: 200, body: JSON.stringify({ access_token: 'access-secret', refresh_token: 'refresh-secret' }) },
  ]) {
    const { auth, secrets } = harness(async () => response);
    const error = await auth.connect('alice', 'alice@example.test', '123456').catch(error => error);
    expect(error.message).toContain(response.status === 401 ? 'could not verify' : 'did not return a usable sign-in session');
    expect(error.message).not.toMatch(/example\.test|123456|access-secret|refresh-secret|injected|not JSON/);
    expect(secrets.size).toBe(0);
  }
});

test('invalid input makes no HTTP request and failed replacement does not delete a valid connection', async () => {
  const { auth, secrets, calls } = harness(async () => ({ status: 400, body: 'bad-code-raw' }));
  await expect(auth.connect('alice', 'invalid email', '123456')).rejects.toThrow('email address');
  await expect(auth.connect('alice', 'alice@example.test', 'not-a-code')).rejects.toThrow('email sign-in code');
  expect(calls).toHaveLength(0);
  secrets.set('alice:janitor_session', JSON.stringify(activeSession()));
  await expect(auth.connect('alice', 'alice@example.test', '123456')).rejects.toThrow('could not verify');
  expect(await auth.status('alice')).toEqual({ connected: true });
});

test('refresh auth failure clears the expired session and only asks the requesting user to reconnect', async () => {
  for (const status of [400, 401, 403, 422]) {
    const { auth, secrets, deletes } = harness(async () => ({ status, body: JSON.stringify({ code: 'refresh_token_not_found', msg: 'refresh-old access-secret alice@example.test' }) }));
    secrets.set('alice:janitor_session', JSON.stringify(activeSession('old', at - 10)));
    secrets.set('bob:janitor_session', JSON.stringify(activeSession('bob')));
    const error = await auth.headers('alice').catch(error => error);
    expect(error.message).toContain('Connect again');
    expect(error.message).not.toMatch(/refresh-old|access-secret|example\.test/);
    expect(await auth.status('alice')).toEqual({ connected: false });
    expect(await auth.status('bob')).toEqual({ connected: true });
    expect(deletes).toEqual(['alice:janitor_session']);
  }
});

test('transient auth network errors are sanitized without discarding a refreshable session', async () => {
  for (const reply of [
    async () => { throw new Error('private upstream error with access-secret alice@example.test'); },
    async () => ({ status: 503, body: 'private upstream response refresh-secret' }),
    async () => ({ status: 403, body: '<html>Request blocked access-secret</html>' }),
    async () => ({ status: 403, body: '{"code":"unclassified_protection","msg":"Forbidden access-secret"}' }),
    async () => ({ status: 400, body: 'Unknown upstream error refresh-secret' }),
  ]) {
    const { auth, secrets } = harness(reply);
    secrets.set('alice:janitor_session', JSON.stringify(activeSession('old', at + 10)));
    const error = await auth.headers('alice').catch(error => error);
    expect(error.message).toBe('Could not contact JanitorAI for authentication. Try again.');
    expect(await auth.status('alice')).toEqual({ connected: true });
  }
});

test('verification upstream and unknown protection failures do not imply that the user supplied a bad code', async () => {
  for (const response of [
    { status: 502, body: 'Gateway failed access-secret' },
    { status: 403, body: '<html>Request blocked alice@example.test</html>' },
    { status: 403, body: '{"code":"protection_failed","msg":"Request refused refresh-secret"}' },
  ]) {
    const { auth, secrets } = harness(async () => response);
    const error = await auth.connect('alice', 'alice@example.test', '123456').catch(error => error);
    expect(error.message).toBe('Could not contact JanitorAI for authentication. Try again.');
    expect(secrets.size).toBe(0);
  }
});

test('CAPTCHA, Cloudflare, and rate-limit responses are distinct sanitized failures and preserve a refreshable session', async () => {
  for (const response of [
    { status: 403, body: '<html>Just a moment. Cloudflare challenge access-secret</html>', message: 'CAPTCHA or Cloudflare' },
    { status: 400, body: '{"msg":"captcha verification failed for alice@example.test"}', message: 'CAPTCHA or Cloudflare' },
    { status: 429, body: 'Raw throttling response refresh-secret', message: 'limiting authentication attempts' },
  ]) {
    const { auth, secrets } = harness(async () => response);
    secrets.set('alice:janitor_session', JSON.stringify(activeSession('old', at + 10)));
    const error = await auth.headers('alice').catch(error => error);
    expect(error.message).toContain(response.message);
    expect(error.message).not.toMatch(/access-secret|refresh-secret|example\.test/);
    expect(await auth.status('alice')).toEqual({ connected: true });
    await expect(auth.connect('alice', 'alice@example.test', '123456')).rejects.toThrow(response.message);
  }
});

test('unusable refreshed sessions are cleared and stored malformed secrets never escape as errors', async () => {
  const { auth, secrets, deletes } = harness(async () => ({ status: 200, body: '{"access_token":"access-secret"}' }));
  secrets.set('alice:janitor_session', JSON.stringify(activeSession('old', at + 10)));
  await expect(auth.headers('alice')).rejects.toThrow('Connect again');
  expect(await auth.status('alice')).toEqual({ connected: false });
  secrets.set('alice:janitor_session', 'malformed-store-private-secret');
  const error = await auth.headers('alice').catch(error => error);
  expect(error.message).toContain('Connect again');
  expect(error.message).not.toContain('malformed-store-private-secret');
  expect(deletes).toHaveLength(2);
});

test('encrypted storage errors never disclose enclave details or session values', async () => {
  const auth = createJanitorAuth({
    httpJson: async (_url, options) => {
      if (options.method === 'GET') throw new Error('URL origin is not allowed: https://auth.janitorai.com');
      return { status: 200, body: JSON.stringify(activeSession()) };
    },
    enclave: {
      get: async () => { throw new Error('enclave access-secret'); },
      put: async () => { throw new Error('enclave refresh-secret'); },
      delete: async () => { throw new Error('enclave alice@example.test'); },
    },
  });
  for (const operation of [auth.status('alice'), auth.headers('bob'), auth.disconnect('carol'), auth.connect('dave', 'dave@example.test', '123456')]) {
    const error = await operation.catch(error => error);
    expect(error.message).toBe('Could not access the encrypted JanitorAI connection. Try again.');
  }
});

test('hosts that ignore or cannot establish origin restrictions stop before credentials or tokens are posted', async () => {
  const { auth, secrets, calls, probes } = harness(undefined, false);
  await expect(auth.connect('alice', 'alice@example.test', '123456')).rejects.toThrow('CORS origin-restriction patch');
  expect(calls).toHaveLength(0);
  expect(secrets.size).toBe(0);
  expect(probes).toHaveLength(1);
  expect(probes[0]!.options.headers.apikey).toBeUndefined();
  expect(probes[0]!.options.headers.Authorization).toBeUndefined();
  expect(probes[0]!.options.body).toBeUndefined();
  secrets.set('bob:janitor_session', JSON.stringify(activeSession('bob', at + 10)));
  await expect(auth.headers('bob')).rejects.toThrow('No login credentials were sent');
  expect(calls).toHaveLength(0);
  expect(probes).toHaveLength(1);
  expect(await auth.status('bob')).toEqual({ connected: true });
  secrets.set('carol:janitor_session', JSON.stringify(activeSession('carol')));
  await expect(auth.headers('carol')).rejects.toThrow('No login credentials were sent');
  expect(calls).toHaveLength(0);
});

test('only the exact origin-rejection error confirms enforcement, while unrelated probe failures fail closed', async () => {
  for (const message of ['Network timed out URL origin is not allowed:', 'private host error', 'URL origin is not allowed']) {
    let postCount = 0;
    const auth = createJanitorAuth({
      httpJson: async (_url, options) => {
        if (options.method === 'GET') throw new Error(message);
        postCount++;
        return { status: 200, body: JSON.stringify(activeSession()) };
      },
      enclave: { get: async () => null, put: async () => {}, delete: async () => true },
    });
    const error = await auth.connect('alice', 'alice@example.test', '123456').catch(error => error);
    expect(error.message).toBe('This Lumiverse build needs the included CORS origin-restriction patch before Janitor sign-in. No login credentials were sent.');
    expect(postCount).toBe(0);
  }
});

test('successful JSON sessions are not rejected because account metadata mentions CAPTCHA or Cloudflare', async () => {
  const { auth, secrets } = harness(async () => ({ status: 200, body: JSON.stringify({ ...activeSession(), user: { email: 'cloudflare@example.test', display_name: 'Captcha observer' } }) }));
  expect(await auth.connect('alice', 'cloudflare@example.test', '123456')).toEqual({ connected: true });
  expect(await auth.headers('alice')).toEqual({ Authorization: 'Bearer access-alice' });
  expect(secrets.get('alice:janitor_session')).not.toContain('cloudflare@example.test');
});

test('sign-in response expires_in fallback is supported without retaining response user details', async () => {
  const response: any = activeSession();
  delete response.expires_at;
  response.expires_in = 3600;
  const { auth, writes } = harness(async () => ({ status: 200, body: JSON.stringify(response) }));
  await auth.connect('alice', 'alice@example.test', '12345678');
  expect(JSON.parse(writes[0]!.value)).toEqual({ access_token: 'access-alice', refresh_token: 'refresh-alice', expires_at: at + 3600 });
});
