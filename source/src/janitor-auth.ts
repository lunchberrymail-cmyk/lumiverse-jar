// This is JanitorAI's published anonymous auth configuration, not a user session.
const PUBLISHED_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1jbXp4dHpvbW1wbnhreW5kZGJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MjgzNzA3NDAsImV4cCI6MjA0Mzk0Njc0MH0.UfRPni4ga9Lmin8j0JjV5ouuK9bXp8tsqPJ8pMTDDAI';
const AUTH_ORIGIN = 'https://auth.janitorai.com';
const SESSION_KEY = 'janitor_session';
const RECONNECT = 'Your JanitorAI session has expired or is unavailable. Connect again before fetching; signing in on JanitorAI in another tab does not connect Lumiverse.';
const SIGN_IN_FAILED = 'JanitorAI could not verify this email sign-in code. Request a new code on JanitorAI and try again.';
const SESSION_FAILED = 'JanitorAI did not return a usable sign-in session. Try again, or request a new email sign-in code.';
const NETWORK_FAILED = 'Could not contact JanitorAI for authentication. Try again.';
const STORAGE_FAILED = 'Could not access the encrypted JanitorAI connection. Try again.';
const CHALLENGE_FAILED = 'JanitorAI returned a CAPTCHA or Cloudflare check during authentication. Complete the check on JanitorAI and try a new email sign-in code.';
const RATE_LIMITED = 'JanitorAI is limiting authentication attempts. Wait before requesting or submitting another email sign-in code.';
const ORIGIN_RESTRICTION_REQUIRED = 'This Lumiverse build needs the included CORS origin-restriction patch before Janitor sign-in. No login credentials were sent.';

interface AuthResponse { status: number; body: string }
interface Enclave {
  get(key: string, userId: string): Promise<string | null>;
  put(key: string, value: string, userId: string): Promise<void>;
  delete(key: string, userId: string): Promise<unknown>;
}
interface Dependencies {
  httpJson(url: string, options: Record<string, any>): Promise<AuthResponse>;
  enclave: Enclave;
  now?: () => number;
}
interface Session { access_token: string; refresh_token: string; expires_at: number }
type AuthHeaders = Record<string, string>;
const safeToken = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 16384 && /^[A-Za-z0-9._~+/=-]+$/.test(value);

/** Creates a separate user-approved session; never reads JanitorAI browser credentials. */
export function createJanitorAuth({ httpJson, enclave, now = Date.now }: Dependencies) {
  const locks = new Map<string, Promise<unknown>>();
  const refreshing = new Map<string, Promise<AuthHeaders>>();
  let originRestrictionCheck: Promise<void> | null = null;
  const seconds = () => Math.floor(now() / 1000);

  function serialized<T>(userId: string, operation: () => Promise<T>): Promise<T> {
    if (!userId) return Promise.reject(new Error(STORAGE_FAILED));
    const previous = locks.get(userId) || Promise.resolve();
    const task = previous.then(operation, operation);
    const tail = task.then(() => undefined, () => undefined);
    locks.set(userId, tail);
    void tail.then(() => { if (locks.get(userId) === tail) locks.delete(userId); });
    return task;
  }

  async function remove(userId: string) {
    try { await enclave.delete(SESSION_KEY, userId); }
    catch { throw new Error(STORAGE_FAILED); }
  }

  async function load(userId: string): Promise<Session | null> {
    let saved: string | null;
    try { saved = await enclave.get(SESSION_KEY, userId); }
    catch { throw new Error(STORAGE_FAILED); }
    if (!saved) return null;
    try {
      const session = JSON.parse(saved);
      if (!session || !safeToken(session.access_token) || !safeToken(session.refresh_token)
        || !Number.isFinite(session.expires_at) || session.expires_at <= 0) throw new Error();
      return { access_token: session.access_token, refresh_token: session.refresh_token, expires_at: session.expires_at };
    } catch {
      await remove(userId);
      throw new Error(RECONNECT);
    }
  }

  async function save(userId: string, session: Session) {
    try { await enclave.put(SESSION_KEY, JSON.stringify(session), userId); }
    catch { throw new Error(STORAGE_FAILED); }
  }

  function requireOriginRestriction(): Promise<void> {
    if (!originRestrictionCheck) originRestrictionCheck = (async () => {
      try {
        // An empty allowlist must reject before networking. Older hosts silently
        // ignored this option; their harmless settings response is not approval.
        await httpJson(AUTH_ORIGIN + '/auth/v1/settings', {
          method: 'GET', headers: { Accept: 'application/json' }, allowedOrigins: [],
        });
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('URL origin is not allowed:')) return;
      }
      throw new Error(ORIGIN_RESTRICTION_REQUIRED);
    })();
    return originRestrictionCheck;
  }

  async function request(path: '/auth/v1/verify' | '/auth/v1/token?grant_type=refresh_token', body: Record<string, string>) {
    await requireOriginRestriction();
    let response: AuthResponse;
    try {
      response = await httpJson(AUTH_ORIGIN + path, {
        method: 'POST', headers: { apikey: PUBLISHED_ANON_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body), allowedOrigins: [AUTH_ORIGIN],
      });
    } catch { throw new Error(NETWORK_FAILED); }
    const successfulJson = response.status >= 200 && response.status < 300 && response.body.trim().startsWith('{');
    if (!successfulJson && /cloudflare|captcha|turnstile|just a moment/i.test(response.body)) throw new Error(CHALLENGE_FAILED);
    if (response.status === 429) throw new Error(RATE_LIMITED);
    if (response.status >= 500 || response.status === 403 && !response.body.trim().startsWith('{')) throw new Error(NETWORK_FAILED);
    return response;
  }

  function sessionFromResponse(response: AuthResponse): Session | null {
    try {
      const value = JSON.parse(response.body);
      if (!value || !safeToken(value.access_token) || !safeToken(value.refresh_token)
        || value.token_type && value.token_type.toLowerCase() !== 'bearer') return null;
      const expiry = typeof value.expires_at === 'number' ? value.expires_at
        : typeof value.expires_in === 'number' ? seconds() + value.expires_in : NaN;
      if (!Number.isFinite(expiry) || expiry <= seconds()) return null;
      return { access_token: value.access_token, refresh_token: value.refresh_token, expires_at: expiry };
    } catch { return null; }
  }

  function rejectedRefresh(response: AuthResponse): boolean {
    if (response.status === 401) return true;
    if (![400, 403, 422].includes(response.status)) return false;
    try {
      const value = JSON.parse(response.body);
      const code = value?.code || value?.error_code || value?.error;
      return ['refresh_token_not_found', 'refresh_token_already_used', 'session_not_found', 'session_expired', 'bad_jwt', 'invalid_grant'].includes(code)
        || /invalid refresh token|refresh token (?:not found|has expired|already used)|session (?:not found|has expired)/i.test(value?.msg || value?.error_description || '');
    } catch { return false; }
  }

  async function renew(userId: string, session: Session): Promise<Session> {
    const response = await request('/auth/v1/token?grant_type=refresh_token', { refresh_token: session.refresh_token });
    if (rejectedRefresh(response)) {
      await remove(userId);
      throw new Error(RECONNECT);
    }
    if (response.status < 200 || response.status >= 300) throw new Error(NETWORK_FAILED);
    const renewed = sessionFromResponse(response);
    if (!renewed) {
      await remove(userId);
      throw new Error(RECONNECT);
    }
    await save(userId, renewed);
    return renewed;
  }

  const bearer = (session: Session): AuthHeaders => ({ Authorization: `Bearer ${session.access_token}` });
  return {
    async transportStatus(): Promise<{ supported: boolean; reason?: string }> {
      try { await requireOriginRestriction(); return { supported: true }; }
      catch { return { supported: false, reason: ORIGIN_RESTRICTION_REQUIRED }; }
    },
    status(userId: string): Promise<{ connected: boolean }> {
      return serialized(userId, async () => ({ connected: !!await load(userId) }));
    },
    connect(userId: string, email: string, code: string): Promise<{ connected: boolean }> {
      return serialized(userId, async () => {
        const address = typeof email === 'string' ? email.trim().toLowerCase() : '';
        const token = typeof code === 'string' ? code.trim() : '';
        if (address.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || !/^\d{6,10}$/.test(token))
          throw new Error('Enter your JanitorAI email address and a 6–10 digit email sign-in code.');
        const response = await request('/auth/v1/verify', { email: address, token, type: 'email' });
        if (response.status === 403) throw new Error(NETWORK_FAILED);
        if (response.status < 200 || response.status >= 300) throw new Error(SIGN_IN_FAILED);
        const session = sessionFromResponse(response);
        if (!session) throw new Error(SESSION_FAILED);
        await save(userId, session);
        return { connected: true };
      });
    },
    headers(userId: string): Promise<AuthHeaders> {
      return serialized(userId, async () => {
        let session = await load(userId);
        if (!session) return {};
        // Existing sessions must also stay protected after a host downgrade.
        await requireOriginRestriction();
        if (session.expires_at - seconds() < 60) session = await renew(userId, session);
        return bearer(session);
      });
    },
    /** Force a refresh after a fixed JanitorAI request returns 401. */
    refresh(userId: string): Promise<AuthHeaders> {
      const existing = refreshing.get(userId);
      if (existing) return existing;
      const task = serialized(userId, async () => {
        const session = await load(userId);
        if (!session) throw new Error(RECONNECT);
        return bearer(await renew(userId, session));
      });
      refreshing.set(userId, task);
      void task.then(() => { if (refreshing.get(userId) === task) refreshing.delete(userId); },
        () => { if (refreshing.get(userId) === task) refreshing.delete(userId); });
      return task;
    },
    disconnect(userId: string): Promise<{ connected: boolean }> {
      return serialized(userId, async () => { await remove(userId); return { connected: false }; });
    },
  };
}
