import { test, expect, afterAll } from 'bun:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const jarHome = process.env.JAR_HOME;
if (!jarHome) throw new Error('Set JAR_HOME to a JAR checkout with its dependencies installed before running companion tests.');
const express = require(jarHome + '/node_modules/express');
const { createService } = require('../../companion/service.cjs');
const token = 'test-token-'.repeat(5);
const jarApp = express();
let active = 0, maximum = 0;
jarApp.use(express.json());
jarApp.post('/api/inspect', async (req: any, res: any) => {
  active++; maximum = Math.max(maximum, active);
  await new Promise(resolve => setTimeout(resolve, 70)); active--;
  if (req.body.fail) return res.status(422).json({ error: 'Fixture failure' });
  res.json({ id: req.body.url });
});
jarApp.get('/api/captures/:id', (req: any, res: any) => res.json({ id: req.params.id }));
const service = createService({ express, jarApp, token, port: 0 });
const address = await service.start();
const origin = `http://127.0.0.1:${address.port}`;
async function call(path: string, body?: unknown, auth = token) {
  return fetch(origin + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function done(id: string) {
  for (let i = 0; i < 100; i++) { const r: any = await (await call('/bridge/v1/jobs/' + id)).json(); if (['failed', 'succeeded'].includes(r.state)) return r; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Job did not complete');
}
afterAll(() => { service.server.closeAllConnections(); service.server.close(); });
test('health is authenticated and does not invoke browser work', async () => {
  expect((await call('/bridge/v1/health', undefined, 'wrong')).status).toBe(401);
  const r: any = await (await call('/bridge/v1/health')).json(); expect(r.service).toBe('jar-companion'); expect(active).toBe(0);
});
test('jobs and native UI writes share one serialized queue', async () => {
  const one: any = await (await call('/bridge/v1/jobs', { operation: 'inspect', input: { url: 'one' } })).json();
  const two: any = await (await call('/bridge/v1/jobs', { operation: 'inspect', input: { url: 'two' } })).json();
  const native = call('/api/inspect', { url: 'native' });
  expect((await done(one.id)).result.id).toBe('one'); expect((await done(two.id)).result.id).toBe('two'); await native;
  expect(maximum).toBe(1);
});
test('failed jobs release queue and are inspectable', async () => {
  const j: any = await (await call('/bridge/v1/jobs', { operation: 'inspect', input: { fail: true } })).json();
  expect((await done(j.id)).error).toBe('Fixture failure'); expect((await call('/api/inspect', { url: 'after failure' })).status).toBe(200);
});
test('unknown operations, cross-origin writes, and traversal are blocked', async () => {
  expect((await call('/bridge/v1/jobs', { operation: '__proto__' })).status).toBe(400);
  expect((await call('/api/captures/a%2Fb')).status).toBe(400);
  expect((await fetch(origin + '/api/inspect', { method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.example' } })).status).toBe(403);
});
test('native workspace pairing uses an opaque HttpOnly session', async () => {
  const r = await fetch(origin + '/pair', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }), redirect: 'manual' });
  expect(r.status).toBe(302); const cookie = r.headers.get('set-cookie')!;
  expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=Strict'); expect(cookie).not.toContain(token);
  expect((await fetch(origin + '/bridge/v1/health', { headers: { Cookie: cookie.split(';')[0] } })).status).toBe(200);
});

test('HTTPS proxy pairing accepts only the configured origin and sets Secure cookies', async () => {
  const remote = createService({ express, jarApp, token, port: 0, publicOrigin: 'https://jar.example' });
  const addr = await remote.start(); const target = `http://127.0.0.1:${addr.port}`;
  try {
    const r = await fetch(target + '/pair', { method: 'POST', headers: { Origin: 'https://jar.example', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }), redirect: 'manual' });
    expect(r.status).toBe(302); expect(r.headers.get('set-cookie')).toContain('; Secure');
    const denied = await fetch(target + '/pair', { method: 'POST', headers: { Origin: 'https://evil.example', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'evil.example', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }), redirect: 'manual' });
    expect(denied.status).toBe(403);
    expect((await fetch(target + '/bridge/v1/health', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
  } finally { remote.server.closeAllConnections(); remote.server.close(); }
  expect(() => createService({ express, jarApp, token, publicOrigin: 'http://jar.example' })).toThrow();
});
