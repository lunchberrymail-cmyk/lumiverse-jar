import { test, expect } from 'bun:test';
import { endpoint, entryInput, booksFrom, cardInput } from '../src/model';
const storage = new Map(), characters = new Map(), books = new Map(), entries = new Map();
let handler: any, replies = new Map(), next = 0, failEntry = false, avatarCalls = 0;
let hasCompanion = true, corsCalls = 0, tokenReads = 0;
let publicReply: any = null, publicHttpReply: any = null, avatarReply: any = null, generationContent: string | null = null, generationCalls = 0;
const enclaveSecrets = new Map<string, string>(), httpTraffic: { url: string; options: any }[] = [];
let httpOverride: ((url: string, options: any) => any) | null = null;
const rec = { id: 'fixture-1', characterId: 'jai-1', url: 'https://janitorai.com/characters/jai-1', characterName: 'Test explorer', character: { name: 'Test explorer', description: 'Explorer {{char}}', firstMessage: 'Hello {{user}}', alternateGreetings: ['Welcome'] }, avatarBase64: 'data:image/png;base64,aGk=', publicLorebooks: [{ id: 'book-1', title: 'Explorer lore', accessible: true, worldInfo: { entries: { 0: { key: ['castle'], content: 'The castle is old.', disable: true, order: 12 }, 1: { key: ['forest'], content: 'The forest is green.' } } } }] };
const clone = (v: any) => structuredClone(v);
(globalThis as any).spindle = {
  userStorage: { getJson: async (p: string, o: any) => clone(storage.get(o.userId + p) ?? o.fallback), setJson: async (p: string, v: any, o: any) => { storage.set(o.userId + p, clone(v)); } },
  enclave: {
    get: async (key: string, user: string) => { if (key === 'jar_token') { tokenReads++; return hasCompanion ? 'secret' : null; } return enclaveSecrets.get(`${user}:${key}`) ?? null; },
    has: async (key: string, user: string) => key === 'jar_token' ? hasCompanion : enclaveSecrets.has(`${user}:${key}`),
    put: async (key: string, value: string, user: string) => { if (key !== 'jar_token') enclaveSecrets.set(`${user}:${key}`, value); },
    delete: async (key: string, user: string) => enclaveSecrets.delete(`${user}:${key}`),
  },
  cors: async (url: string, options: any = {}) => {
    corsCalls++; httpTraffic.push({ url, options: clone(options) });
    if (url === 'https://auth.janitorai.com/auth/v1/settings' && options.method === 'GET' && Array.isArray(options.allowedOrigins) && options.allowedOrigins.length === 0)
      throw new Error('URL origin is not allowed: https://auth.janitorai.com');
    const override = httpOverride as ((url: string, options: any) => any) | null;
    if (override) return override(url, options);
    return url.startsWith('https://ella.janitorai.com/') ? avatarReply : url.includes('/hampter/') ? publicHttpReply ?? (publicReply ? { status: 200, body: JSON.stringify(publicReply) } : { status: 403, body: '<html>Cloudflare challenge</html>' }) : { status: 200, body: JSON.stringify(rec) };
  },
  characters: {
    list: async (o: any) => ({ data: [...characters.values()].filter(c => c.user === o.userId), total: [...characters.values()].filter(c => c.user === o.userId).length }),
    get: async (id: string, user: string) => { const c = characters.get(id); return c?.user === user ? clone(c) : null; },
    create: async (input: any, user: string) => { const c = { ...input, id: `char-${++next}`, user, world_book_ids: ['existing-book'] }; characters.set(c.id, c); return clone(c); },
    update: async (id: string, input: any, user: string) => { expect(characters.get(id).user).toBe(user); Object.assign(characters.get(id), input); return clone(characters.get(id)); },
    setAvatar: async (_id: string, avatar: any) => { expect(avatar.data).toBeInstanceOf(Uint8Array); avatarCalls++; },
  },
  world_books: {
    list: async (o: any) => { const data = [...books.values()].filter(b => b.user === o.userId); return { data: clone(data), total: data.length }; },
    get: async (id: string, user: string) => books.get(id)?.user === user ? clone(books.get(id)) : null,
    create: async (input: any, user: string) => { const b = { ...input, id: `book-${++next}`, user }; books.set(b.id, b); return clone(b); },
    entries: {
      list: async (bookId: string, o: any) => { expect(books.get(bookId).user).toBe(o.userId); const data = [...entries.values()].filter(e => e.bookId === bookId); return { data: clone(data), total: data.length }; },
      create: async (bookId: string, input: any, user: string) => { expect(books.get(bookId).user).toBe(user); if (failEntry && input.content.includes('forest')) { failEntry = false; throw new Error('Entry creation interrupted'); } const e = { ...input, bookId, id: `entry-${++next}` }; entries.set(e.id, e); return clone(e); },
    },
  },
  generate: { quiet: async (input: any) => { generationCalls++; expect(input.userId).toBe('alice'); return { content: generationContent ?? '[{"key":["island"],"content":"An island."}]' }; } },
  onFrontendMessage: (h: any) => { handler = h; },
  sendToFrontend: (r: any, user: string, opts: any) => { expect(opts.frontendSessionId).toBe('document-' + user); replies.get(r.requestId)(r); },
};
await import('../src/backend');
async function request(action: string, data: any = {}, user = 'alice') {
  const requestId = crypto.randomUUID(); const p = new Promise<any>(resolve => replies.set(requestId, resolve));
  handler({ type: 'jar_request', requestId, action, ...data }, user, 'document-' + user); const r = await p; replies.delete(requestId); if (r.error) throw Error(r.error); return r.result;
}
const authOrigin = 'https://auth.janitorai.com';
const jsonResponse = (body: any, status = 200) => ({ status, body: JSON.stringify(body) });
const authSession = (name = 'alice') => ({ access_token: `test-access-${name}`, refresh_token: `test-refresh-${name}`, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer' });
function savedTestSession(user = 'alice', session = authSession(user)) {
  const key = `${user}:janitor_session`, previous = enclaveSecrets.get(key);
  enclaveSecrets.set(key, JSON.stringify(session));
  return () => { previous === undefined ? enclaveSecrets.delete(key) : enclaveSecrets.set(key, previous); };
}
test('remote HTTP and credential-bearing URLs are rejected', () => {
  expect(endpoint('http://localhost:4577')).toBe('http://localhost:4577');
  expect(() => endpoint('http://remote.example')).toThrow(); expect(() => endpoint('https://user:password@example.com')).toThrow();
});
test('Janitor creator credit and alternate greetings are preserved', () => {
  const card = cardInput({ ...rec, meta: { creator_name: 'Source author' } });
  expect(card.creator).toBe('Source author'); expect(card.alternate_greetings).toEqual(['Welcome']);
});

test('server and browser can use separate companion addresses', async () => {
  await request('saveConfig', { url: 'http://127.0.0.1:4577', workspaceUrl: 'https://jar.example' });
  const config = await request('config');
  expect(config.url).toBe('http://127.0.0.1:4577');
  expect(config.workspaceUrl).toBe('https://jar.example');
  await expect(request('saveConfig', { url: 'http://127.0.0.1:4577', workspaceUrl: 'https://user:secret@jar.example' })).rejects.toThrow();
  await request('saveConfig', { url: 'http://127.0.0.1:4577' });
  expect((await request('config')).workspaceUrl).toBe('');
});
test('World Info rules are mapped and stale reconstructions excluded', () => {
  const mapped = entryInput({ key: 'one,two', content: 'Lore', order: 8, disable: true, selectiveLogic: 2, scanDepth: 7, probability: 25, group: 'a' }, 0);
  expect(mapped).toMatchObject({ key: ['one', 'two'], order_value: 8, disabled: true, selective_logic: 2, scan_depth: 7, probability: 25, group_name: 'a' });
  expect(booksFrom({ publicLorebooks: [{ isJs: true, reconstructionStale: true, reconstructedWorldInfo: { entries: { 0: {} } } }] })).toEqual([]);
});
test('partial imports resume without duplicates and preserve attachments', async () => {
  failEntry = true;
  const pick = { captureId: rec.id, character: true, avatar: true, books: { 'public:book-1': [0, 1] } };
  await expect(request('import', pick)).rejects.toThrow('interrupted');
  const r = await request('import', pick); expect(characters.size).toBe(1); expect(books.size).toBe(1); expect(entries.size).toBe(2);
  expect(characters.get(r.characterId).world_book_ids).toEqual(['existing-book', ...r.bookIds]);
  const c = characters.get(r.characterId); c.description = 'User edited description';
  await request('import', pick); expect(entries.size).toBe(2); expect(books.size).toBe(1); expect(c.description).toBe('User edited description'); expect(avatarCalls).toBeGreaterThan(0);
});
test('users have separate imports and response routing', async () => {
  const r = await request('import', { captureId: rec.id, character: true, books: {} }, 'bob'); expect(characters.get(r.characterId).user).toBe('bob'); expect(characters.size).toBe(2);
});
test('Lumi uses the requesting user and persists a previewable reconstruction', async () => {
  const r = await request('reconstruct', { captureId: rec.id, messages: [{ role: 'user', content: 'fixture lore' }] }); expect(r.books.some((b: any) => b.key === 'lumi')).toBe(true);
});

test('basic card and embedded World Book import work without JAR, credentials, or HTTP', async () => {
  hasCompanion = false; const calls = corsCalls, reads = tokenReads;
  try {
    const text = JSON.stringify({ spec: 'chara_card_v2', data: { name: 'Portable explorer', description: 'An explorer.', first_mes: 'Hello.', system_prompt: 'Speak plainly.', character_version: '2', extensions: { author_data: { credit: 'Fixture' } }, character_book: { name: 'Portable island', entries: [{ keys: ['island'], content: 'A quiet island.' }] } } });
    const staged = await request('stageJson', { text });
    expect(staged.source).toBe('portable'); expect(staged.card.system_prompt).toBe('Speak plainly.'); expect(staged.books).toHaveLength(1);
    const again = await request('stageJson', { text }); expect(again.id).toBe(staged.id);
    const pick = { captureId: staged.id, character: true, books: { 'public:embedded': [0] } };
    const imported = await request('import', pick);
    expect(characters.get(imported.characterId).extensions.author_data.credit).toBe('Fixture');
    expect(characters.get(imported.characterId).world_book_ids).toContain(imported.bookIds[0]);
    const count = entries.size;
    expect((await request('import', pick)).characterId).toBe(imported.characterId); expect(entries.size).toBe(count);
    expect(corsCalls).toBe(calls); expect(tokenReads).toBe(reads);
    await expect(request('preview', { captureId: staged.id }, 'bob')).rejects.toThrow('not found for this user');
  } finally { hasCompanion = true; }
});

test('supplied lore can use Lumi and book-only import without contacting JAR', async () => {
  hasCompanion = false; const calls = corsCalls;
  try {
    const staged = await request('stageLore', { name: 'An island', text: 'An island has one village.' });
    const prompt = await request('portablePrompt', { captureId: staged.id });
    expect(prompt.messages[1].content).toContain('An island has one village.');
    const result = await request('reconstruct', { captureId: staged.id, messages: prompt.messages });
    expect(result.card).toBeNull(); expect(result.books[0].entries).toHaveLength(1);
    const imported = await request('import', { captureId: staged.id, character: false, books: { lumi: [0] } });
    expect(imported.characterId).toBeNull(); expect(imported.bookIds).toHaveLength(1); expect(corsCalls).toBe(calls);
  } finally { hasCompanion = true; }
});

test('no-JAR URL fetching rejects missing sessions before HTTP or staging, including claimed browser login', async () => {
  const calls = corsCalls, records = storage.size, count = characters.size, bookCount = books.size;
  const reads = tokenReads, generations = generationCalls;
  const url = 'https://janitorai.com/characters/11111111-1111-4111-8111-111111111111';
  expect(await request('janitorStatus')).toEqual({ connected: false });
  await expect(request('publicFetch', { url })).rejects.toThrow('JanitorAI login required');
  await expect(request('publicFetch', { url, loggedIn: true, connected: true, authenticated: true })).rejects.toThrow('does not connect this extension');
  expect(corsCalls).toBe(calls); expect(storage.size).toBe(records);
  expect(characters.size).toBe(count); expect(books.size).toBe(bookCount);
  expect(tokenReads).toBe(reads); expect(generationCalls).toBe(generations);
});

test('authenticated public URL mode reports browser protection and never fabricates an import', async () => {
  const restore = savedTestSession();
  const count = characters.size;
  try {
    await expect(request('publicFetch', { url: 'https://janitorai.com/characters/11111111-1111-4111-8111-111111111111' })).rejects.toThrow('Cloudflare');
    expect(characters.size).toBe(count);
    await expect(request('publicFetch', { url: 'http://127.0.0.1:9999/' })).rejects.toThrow('JanitorAI');
  } finally { restore(); }
});

test('public import identity is independent of optional companion configuration', async () => {
  const restore = savedTestSession();
  const previousConfig = storage.get('aliceconfig.json'); hasCompanion = false;
  publicReply = { id: '12345678-1234-1234-1234-123456789abc', name: 'Public explorer', showdefinition: true, personality: 'A public explorer.', first_messages: ['Hello.'] };
  try {
    const staged = await request('publicFetch', { url: 'https://janitorai.com/characters/12345678-1234-1234-1234-123456789abc' });
    const calls = corsCalls, pick = { captureId: staged.id, character: true, books: {} };
    const imported = await request('import', pick);
    storage.set('aliceconfig.json', { url: 'https://another-companion.example' });
    expect((await request('import', pick)).characterId).toBe(imported.characterId);
    expect(characters.get(imported.characterId).extensions.jar_companion.source).toBe('janitorai:12345678-1234-1234-1234-123456789abc');
    expect(corsCalls).toBe(calls);
  } finally { restore(); publicReply = null; hasCompanion = true; storage.set('aliceconfig.json', previousConfig); }
});

test('Lumi empty entries are rejected before being cached or imported', async () => {
  const staged = await request('stageLore', { name: 'Empty output check', text: 'A village has one road.' });
  generationContent = '[{"key":["village"],"content":"   "}]';
  try {
    await expect(request('reconstruct', { captureId: staged.id, messages: [{ role: 'user', content: 'Supplied lore' }] })).rejects.toThrow('invalid lore entries');
    expect((await request('preview', { captureId: staged.id })).books).toHaveLength(0);
  } finally { generationContent = null; }
});

test('hidden public profiles are visible and require an explicit starter import without JAR or a model', async () => {
  const restore = savedTestSession();
  hasCompanion = false; const reads = tokenReads, generations = generationCalls;
  publicReply = { id: '22222222-2222-4222-8222-222222222222', name: 'Public starter fixture', showdefinition: false, description: 'Public profile text.', first_messages: ['Public greeting.', 'Alternate greeting.'], creator_name: 'Public author', personality: 'Hidden personality must not be imported.', scenario: 'Hidden scenario.' };
  try {
    const staged = await request('publicFetch', { url: `https://janitorai.com/characters/${publicReply.id}` });
    expect(staged.card).toBeNull(); expect(staged.cardCompleteness).toBe('public-starter');
    expect(staged.publicProfile.firstMessage).toBe('Public greeting.');
    expect(staged.starterCard).toMatchObject({ description: 'Public profile text.', personality: '', scenario: '', first_mes: 'Public greeting.', alternate_greetings: ['Alternate greeting.'] });
    const count = characters.size;
    await expect(request('import', { captureId: staged.id, character: true, books: {} })).rejects.toThrow('definition');
    expect(characters.size).toBe(count);
    const pick = { captureId: staged.id, character: true, characterMode: 'public-starter', books: {} };
    const imported = await request('import', pick), calls = corsCalls;
    expect(characters.get(imported.characterId).extensions.jar_companion.completeness).toBe('public-starter');
    expect(imported.message).toContain('definition not included');
    expect((await request('import', pick)).characterId).toBe(imported.characterId);
    expect(corsCalls).toBe(calls); expect(tokenReads).toBe(reads); expect(generationCalls).toBe(generations);
  } finally { restore(); publicReply = null; hasCompanion = true; }
});

test('fresh public notes and greetings produce a fresh staged preview', async () => {
  const restore = savedTestSession();
  publicReply = { id: '23456789-1234-1234-1234-123456789abc', name: 'Updated public fixture', showdefinition: false, description: 'First profile.', first_message: 'First greeting.' };
  try {
    const url = `https://janitorai.com/characters/${publicReply.id}`;
    const first = await request('publicFetch', { url });
    publicReply.description = 'Changed public profile.'; publicReply.first_message = 'Changed greeting.';
    const second = await request('publicFetch', { url });
    expect(second.id).not.toBe(first.id); expect(second.starterCard.description).toBe('Changed public profile.');
    expect(second.publicProfile.firstMessage).toBe('Changed greeting.');
  } finally { restore(); publicReply = null; }
});

test('public avatars use the fixed Janitor CDN and can be assigned without JAR', async () => {
  const restore = savedTestSession();
  hasCompanion = false;
  publicReply = { id: '3456789a-1234-1234-1234-123456789abc', name: 'Avatar fixture', showdefinition: false, first_message: 'Hello.', avatar: 'public-avatar.png' };
  avatarReply = { status: 200, headers: { 'content-type': 'image/png' }, encoding: 'base64', body: 'aGk=' };
  try {
    const staged = await request('publicFetch', { url: `https://janitorai.com/characters/${publicReply.id}` });
    expect(staged.avatar).toBe('data:image/png;base64,aGk=');
    const count = avatarCalls;
    await request('import', { captureId: staged.id, character: true, characterMode: 'public-starter', avatar: true, books: {} });
    expect(avatarCalls).toBe(count + 1);
    publicReply.avatar = 'http://127.0.0.1:7860/private';
    const calls = corsCalls;
    expect((await request('publicFetch', { url: `https://janitorai.com/characters/${publicReply.id}` })).avatar).toBe('');
    expect(corsCalls).toBe(calls + 1);
  } finally { restore(); publicReply = avatarReply = null; hasCompanion = true; }
});

test('HTTP errors are reported accurately instead of treating all HTML as Cloudflare', async () => {
  const restore = savedTestSession();
  publicHttpReply = { status: 404, body: '<html>Not found</html>' };
  try {
    const url = 'https://janitorai.com/characters/456789ab-1234-1234-1234-123456789abc';
    await expect(request('publicFetch', { url })).rejects.toThrow('HTTP 404');
    publicHttpReply = { status: 503, body: '<html><title>Just a moment</title>Cloudflare challenge</html>' };
    const count = characters.size;
    await expect(request('publicFetch', { url })).rejects.toThrow('Use JAR');
    expect(characters.size).toBe(count);
  }
  finally { restore(); publicHttpReply = null; }
});

test('a later definition upgrades untouched starter fields and preserves user edits', async () => {
  const restore = savedTestSession();
  publicReply = { id: '56789abc-1234-1234-1234-123456789abc', name: 'Upgrade fixture', showdefinition: false, description: 'Public notes.', first_messages: ['Public greeting.', 'Public alternate.'], custom_tags: ['Public tag'] };
  try {
    const url = `https://janitorai.com/characters/${publicReply.id}`;
    const staged = await request('publicFetch', { url });
    const imported = await request('import', { captureId: staged.id, character: true, characterMode: 'public-starter', books: {} });
    characters.get(imported.characterId).first_mes = 'User edited greeting.';
    characters.get(imported.characterId).extensions.theme = 'User edited theme';
    publicReply.showdefinition = true; publicReply.personality = 'The recovered personality.'; publicReply.scenario = 'The recovered scenario.';
    publicReply.first_messages = ['Full greeting.']; delete publicReply.custom_tags;
    const full = await request('publicFetch', { url });
    storage.get(`alicestaged/${full.id}.json`).character.extensions = { theme: 'Source theme', new_source_field: 'New value' };
    expect((await request('import', { captureId: full.id, character: true, books: {} })).characterId).toBe(imported.characterId);
    const result = characters.get(imported.characterId);
    expect(result.description).toBe('The recovered personality.'); expect(result.scenario).toBe('The recovered scenario.');
    expect(result.first_mes).toBe('User edited greeting.'); expect(result.extensions.jar_companion.completeness).toBe('definition');
    expect(result.alternate_greetings).toEqual(['Public alternate.']); expect(result.tags).toEqual(['Public tag']);
    expect(result.extensions.theme).toBe('User edited theme'); expect(result.extensions.new_source_field).toBe('New value');
  } finally { restore(); publicReply = null; }
});

test('rendered public card handoff uses canonical Janitor identity without JAR, HTTP, or a model', async () => {
  hasCompanion = false;
  const calls = corsCalls, reads = tokenReads, generations = generationCalls;
  const characterId = '6789abcd-1234-1234-1234-123456789abc';
  const canonicalUrl = `https://janitorai.com/characters/${characterId}`;
  const text = JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: {
    name: 'Rendered public explorer', description: 'A public explorer studies the northern lights.',
    first_mes: 'Welcome to the observatory.', creator_notes: 'Public author notes.',
    extensions: { janitor_public_view: { url: `${canonicalUrl}_character-rendered-explorer?from=public#definition`, source: 'rendered-public-definition' } },
  } });
  try {
    const staged = await request('stageJson', { text, name: 'rendered-public.json' });
    expect(staged.source).toBe('janitor-public'); expect(staged.url).toBe(canonicalUrl);
    expect(staged.publicDefinitionDeclared).toBe(true);
    expect(staged.card).toMatchObject({ description: 'A public explorer studies the northern lights.', first_mes: 'Welcome to the observatory.' });
    const pick = { captureId: staged.id, character: true, books: {} };
    const imported = await request('import', pick);
    expect(characters.get(imported.characterId).extensions.jar_companion).toMatchObject({ source: `janitorai:${characterId}`, url: canonicalUrl, completeness: 'definition' });
    const again = await request('stageJson', { text, name: 'same-public-export.json' });
    expect(again.id).toBe(staged.id);
    expect((await request('import', { ...pick, captureId: again.id })).characterId).toBe(imported.characterId);
    expect(corsCalls).toBe(calls); expect(tokenReads).toBe(reads); expect(generationCalls).toBe(generations);
  } finally { hasCompanion = true; }
});

test('declared-public null metadata can upgrade a starter from rendered public JSON while preserving edited notes', async () => {
  const restore = savedTestSession();
  hasCompanion = false;
  const reads = tokenReads, generations = generationCalls;
  const characterId = '789abcde-1234-1234-1234-123456789abc';
  const url = `https://janitorai.com/characters/${characterId}`;
  publicReply = {
    id: characterId, name: 'Public null-shape explorer', showdefinition: true,
    description: 'Public profile notes for an explorer.', creator_name: 'Public author', custom_tags: ['Exploration'],
    personality: null, scenario: null, example_dialogs: null,
    first_message: null, first_messages: null, alternate_greetings: null,
  };
  try {
    const staged = await request('publicFetch', { url });
    expect(staged.publicDefinitionDeclared).toBe(true);
    expect(staged.card).toBeNull(); expect(staged.cardCompleteness).toBe('public-starter');
    expect(staged.publicProfile.firstMessage).toBe('');
    expect(staged.starterCard).toMatchObject({ description: 'Public profile notes for an explorer.', personality: '', scenario: '', first_mes: '' });
    expect(staged.warnings.join(' ')).toContain('public');
    expect(staged.warnings.join(' ')).not.toMatch(/hidden|private/i);
    // Legacy 0.2.1 previews inferred missing fields meant a hidden definition.
    const legacy = storage.get(`alicestaged/${staged.id}.json`);
    delete legacy.publicDefinitionDeclared;
    legacy.warnings = [
      'This definition is hidden or unavailable. Public page text is not a recovered definition; JAR is needed to attempt capture.',
      'A public starter card is available using only the public page notes and greetings. It does not include the hidden character personality, scenario, examples, or private lore.',
      'Unrelated source note remains unchanged.',
    ];
    const reopened = await request('preview', { captureId: staged.id });
    expect(reopened.publicDefinitionDeclared).toBe(true);
    expect(reopened.card).toBeNull(); expect(reopened.cardCompleteness).toBe('public-starter');
    expect(reopened.warnings.join(' ')).not.toMatch(/hidden|private/i);
    expect(reopened.warnings).toContain('Unrelated source note remains unchanged.');
    const imported = await request('import', { captureId: staged.id, character: true, characterMode: 'public-starter', books: {} });
    expect(imported.message).toContain('definition not included');
    characters.get(imported.characterId).creator_notes = 'User edited notes to preserve.';
    const calls = corsCalls, count = characters.size;
    const handoff = await request('stageJson', { name: 'public-definition.json', text: JSON.stringify({
      spec: 'chara_card_v2', spec_version: '2.0', data: {
        name: 'Public null-shape explorer', description: 'The explorer follows the aurora across the northern mountains.',
        scenario: 'At a quiet observatory.', first_mes: 'The expedition is ready.', creator_notes: 'Notes from the public definition export.',
        extensions: { janitor_public_view: { url: `${url}_character-public-explorer`, source: 'rendered-public-definition' } },
      },
    }) });
    expect(handoff.source).toBe('janitor-public'); expect(handoff.url).toBe(url);
    expect(handoff.publicDefinitionDeclared).toBe(true);
    const upgraded = await request('import', { captureId: handoff.id, character: true, books: {} });
    expect(upgraded.characterId).toBe(imported.characterId); expect(characters.size).toBe(count);
    const character = characters.get(upgraded.characterId);
    expect(character).toMatchObject({
      description: 'The explorer follows the aurora across the northern mountains.', scenario: 'At a quiet observatory.',
      first_mes: 'The expedition is ready.', creator_notes: 'User edited notes to preserve.',
    });
    expect(character.extensions.jar_companion).toMatchObject({ source: `janitorai:${characterId}`, completeness: 'definition', upgradedFromStarter: true });
    expect((await request('import', { captureId: handoff.id, character: true, books: {} })).characterId).toBe(imported.characterId);
    expect(corsCalls).toBe(calls); expect(tokenReads).toBe(reads); expect(generationCalls).toBe(generations);
  } finally { restore(); publicReply = null; hasCompanion = true; }
});

test('native Janitor connection requires consent, isolates users, returns no credentials, and disconnects', async () => {
  hasCompanion = false;
  const calls = corsCalls, reads = tokenReads, generations = generationCalls;
  const session = authSession();
  httpOverride = (url: string, options: any) => {
    expect(url).toBe(`${authOrigin}/auth/v1/verify`); expect(options.method).toBe('POST');
    expect(options.allowedOrigins).toEqual([authOrigin]);
    expect(JSON.parse(options.body)).toEqual({ email: 'alice@example.test', token: '123456', type: 'email' });
    return jsonResponse(session);
  };
  try {
    expect(await request('janitorStatus')).toEqual({ connected: false });
    await expect(request('janitorConnect', { email: 'alice@example.test', code: '123456', consent: false })).rejects.toThrow('Approve');
    await expect(request('janitorConnect', { email: 'invalid-address', code: 'bad-code', consent: true })).rejects.toThrow('Enter');
    expect(corsCalls).toBe(calls); expect(enclaveSecrets.size).toBe(0);
    const connected = await request('janitorConnect', { email: ' Alice@Example.Test ', code: '123456', consent: true });
    expect(connected).toEqual({ connected: true });
    expect(await request('janitorStatus')).toEqual({ connected: true });
    expect(await request('janitorStatus', {}, 'bob')).toEqual({ connected: false });
    expect(JSON.parse(enclaveSecrets.get('alice:janitor_session')!)).toEqual({ access_token: session.access_token, refresh_token: session.refresh_token, expires_at: session.expires_at });
    expect(JSON.stringify(connected)).not.toContain(session.access_token); expect(JSON.stringify(connected)).not.toContain(session.refresh_token);
    expect(await request('janitorDisconnect', {}, 'bob')).toEqual({ connected: false });
    expect(await request('janitorStatus')).toEqual({ connected: true });
    expect(await request('janitorDisconnect')).toEqual({ connected: false });
    expect(enclaveSecrets.has('alice:janitor_session')).toBe(false);
    expect(await request('janitorStatus')).toEqual({ connected: false });
    expect(tokenReads).toBe(reads); expect(generationCalls).toBe(generations);
  } finally { enclaveSecrets.clear(); httpOverride = null; hasCompanion = true; }
});

test('authenticated public fetching sends a session only to fixed character and script endpoints, never the avatar CDN', async () => {
  hasCompanion = false;
  const reads = tokenReads, generations = generationCalls;
  const session = authSession('public-route');
  const characterId = '89abcdef-1234-1234-1234-123456789abc', bookId = '9abcdef0-1234-1234-1234-123456789abc';
  const characterEndpoint = `https://janitorai.com/hampter/characters/${characterId}`, scriptEndpoint = `https://janitorai.com/hampter/script/${bookId}`;
  httpOverride = (url: string) => {
    if (url === `${authOrigin}/auth/v1/verify`) return jsonResponse(session);
    if (url === characterEndpoint) return jsonResponse({ id: characterId, name: 'Authenticated public explorer', showdefinition: true, personality: 'A public explorer studies the sea.', first_messages: ['Welcome aboard.'], avatar: 'public-fixture.png', scripts: [{ id: bookId, title: 'Sea atlas', type: 'lorebook', is_public: true }] });
    if (url === scriptEndpoint) return jsonResponse({ id: bookId, is_public: true, is_code_public: true, script: JSON.stringify([{ key: ['harbor'], content: 'The harbor faces the eastern sea.' }]) });
    if (url.startsWith('https://ella.janitorai.com/bot-avatars/')) return { status: 200, headers: { 'content-type': 'image/png' }, encoding: 'base64', body: 'aGk=' };
    throw new Error('Unexpected destination in authenticated fetch test.');
  };
  try {
    await request('janitorConnect', { email: 'alice@example.test', code: '123456', consent: true });
    const start = httpTraffic.length;
    const staged = await request('publicFetch', { url: `https://janitorai.com/characters/${characterId}` });
    expect(staged.fetchAuthenticated).toBe(true); expect(staged.card.description).toBe('A public explorer studies the sea.');
    expect(staged.books[0].entries[0].content).toBe('The harbor faces the eastern sea.');
    expect(staged.avatar).toBe('data:image/png;base64,aGk=');
    const routes = httpTraffic.slice(start);
    expect(routes).toHaveLength(3);
    for (const route of routes.filter(item => item.url === characterEndpoint || item.url === scriptEndpoint)) expect(route.options.headers.Authorization).toBe(`Bearer ${session.access_token}`);
    expect(routes.find(item => item.url.startsWith('https://ella.janitorai.com/'))!.options.headers?.Authorization).toBeUndefined();
    expect(JSON.stringify(staged)).not.toContain(session.access_token); expect(JSON.stringify(staged)).not.toContain(session.refresh_token);
    const next = httpTraffic.length;
    const records = storage.size;
    expect(await request('janitorStatus', {}, 'bob')).toEqual({ connected: false });
    await expect(request('publicFetch', { url: `https://janitorai.com/characters/${characterId}`, connected: true }, 'bob')).rejects.toThrow('JanitorAI login required');
    expect(httpTraffic.length).toBe(next); expect(storage.size).toBe(records);
    expect(tokenReads).toBe(reads); expect(generationCalls).toBe(generations);
  } finally { enclaveSecrets.clear(); httpOverride = null; hasCompanion = true; }
});

test('authenticated metadata stays truthful and cached when the server omits visible fields', async () => {
  hasCompanion = false;
  const session = authSession('pending'), characterId = 'abcdef01-1234-1234-1234-123456789abc';
  const metadata = { id: characterId, name: 'Authentication mode fixture', showdefinition: true, description: 'Public profile.', personality: null, scenario: null, example_dialogs: null, first_messages: null };
  httpOverride = (url: string) => url === `${authOrigin}/auth/v1/verify` ? jsonResponse(session) : jsonResponse(metadata);
  try {
    const url = `https://janitorai.com/characters/${characterId}`;
    const calls = corsCalls, records = storage.size;
    await expect(request('publicFetch', { url })).rejects.toThrow('JanitorAI login required');
    expect(corsCalls).toBe(calls); expect(storage.size).toBe(records);
    await request('janitorConnect', { email: 'alice@example.test', code: '123456', consent: true });
    const count = characters.size;
    const authenticated = await request('publicFetch', { url });
    expect(authenticated.fetchAuthenticated).toBe(true);
    expect(authenticated.card).toBeNull(); expect(authenticated.publicDefinitionDeclared).toBe(true);
    expect(authenticated.warnings.join(' ')).not.toContain('unauthenticated request');
    expect(authenticated.warnings.join(' ')).toContain('authenticated API response');
    expect((await request('publicFetch', { url })).id).toBe(authenticated.id);
    expect(characters.size).toBe(count);
  } finally { enclaveSecrets.clear(); httpOverride = null; hasCompanion = true; }
});

test('disconnect disables later URL fetching without HTTP, staging, or imports', async () => {
  const restore = savedTestSession();
  try {
    expect(await request('janitorStatus')).toEqual({ connected: true });
    expect(await request('janitorDisconnect')).toEqual({ connected: false });
    const calls = corsCalls, records = storage.size, count = characters.size;
    await expect(request('publicFetch', { url: 'https://janitorai.com/characters/abcdef01-1234-1234-1234-123456789abc' })).rejects.toThrow('JanitorAI login required');
    expect(corsCalls).toBe(calls); expect(storage.size).toBe(records); expect(characters.size).toBe(count);
  } finally { restore(); }
});

test('Janitor status refreshes expired sessions without fetching character data or returning credentials', async () => {
  const expired = { ...authSession('expired-status'), expires_at: Math.floor(Date.now() / 1000) - 60 };
  const renewed = authSession('renewed-status'), restore = savedTestSession('alice', expired);
  let refreshes = 0;
  httpOverride = (url: string, options: any) => {
    expect(url).toBe(`${authOrigin}/auth/v1/token?grant_type=refresh_token`);
    expect(options.allowedOrigins).toEqual([authOrigin]);
    expect(JSON.parse(options.body).refresh_token).toBe(expired.refresh_token);
    refreshes++; return jsonResponse(renewed);
  };
  try {
    const records = storage.size, count = characters.size;
    const result = await request('janitorStatus');
    expect(result).toEqual({ connected: true }); expect(refreshes).toBe(1);
    expect(JSON.stringify(result)).not.toContain(renewed.access_token); expect(JSON.stringify(result)).not.toContain(renewed.refresh_token);
    expect(JSON.parse(enclaveSecrets.get('alice:janitor_session')!).access_token).toBe(renewed.access_token);
    expect(storage.size).toBe(records); expect(characters.size).toBe(count);
  } finally { restore(); httpOverride = null; }
});

test('rejected expired-session status clears login and later URL attempts make no character requests', async () => {
  const expired = { ...authSession('expired-rejected-status'), expires_at: Math.floor(Date.now() / 1000) - 60 };
  const restore = savedTestSession('alice', expired);
  let refreshes = 0;
  httpOverride = (url: string) => {
    expect(url).toBe(`${authOrigin}/auth/v1/token?grant_type=refresh_token`);
    refreshes++; return jsonResponse({ code: 'refresh_token_not_found' }, 401);
  };
  try {
    const records = storage.size, count = characters.size;
    await expect(request('janitorStatus')).rejects.toThrow('session has expired');
    expect(refreshes).toBe(1); expect(enclaveSecrets.has('alice:janitor_session')).toBe(false);
    expect(await request('janitorStatus')).toEqual({ connected: false });
    const calls = corsCalls;
    await expect(request('publicFetch', { url: 'https://janitorai.com/characters/abcdef01-1234-1234-1234-123456789abc' })).rejects.toThrow('JanitorAI login required');
    expect(corsCalls).toBe(calls); expect(storage.size).toBe(records); expect(characters.size).toBe(count);
  } finally { restore(); httpOverride = null; }
});

test('an expired session whose refresh is rejected blocks URL fetching before any character request', async () => {
  const expired = { ...authSession('expired-url'), expires_at: Math.floor(Date.now() / 1000) - 60 };
  const restore = savedTestSession('alice', expired);
  let refreshes = 0;
  httpOverride = (url: string) => {
    expect(url).toBe(`${authOrigin}/auth/v1/token?grant_type=refresh_token`);
    refreshes++; return jsonResponse({ code: 'refresh_token_not_found' }, 401);
  };
  try {
    const records = storage.size, count = characters.size;
    await expect(request('publicFetch', { url: 'https://janitorai.com/characters/abcdef01-1234-1234-1234-123456789abc' })).rejects.toThrow('session has expired');
    expect(refreshes).toBe(1); expect(await request('janitorStatus')).toEqual({ connected: false });
    expect(storage.size).toBe(records); expect(characters.size).toBe(count);
  } finally { restore(); httpOverride = null; }
});

test('an authenticated 401 refreshes once, retries with the rotated session, and never loops on another 401', async () => {
  hasCompanion = false;
  const old = authSession('old'), renewed = authSession('renewed'), characterId = 'bcdef012-1234-1234-1234-123456789abc';
  const endpoint = `https://janitorai.com/hampter/characters/${characterId}`;
  let fetches = 0, refreshes = 0, rejectEveryFetch = false;
  httpOverride = (url: string, options: any) => {
    if (url === `${authOrigin}/auth/v1/verify`) return jsonResponse(old);
    if (url === `${authOrigin}/auth/v1/token?grant_type=refresh_token`) { refreshes++; expect(options.allowedOrigins).toEqual([authOrigin]); expect(JSON.parse(options.body).refresh_token).toBe(refreshes === 1 ? old.refresh_token : renewed.refresh_token); return jsonResponse(renewed); }
    expect(url).toBe(endpoint); fetches++;
    if (rejectEveryFetch || fetches === 1) return jsonResponse({ message: 'Expired fixture request.' }, 401);
    return jsonResponse({ id: characterId, name: 'Session refresh fixture', showdefinition: true, personality: 'A public observer.', first_message: 'Hello.' });
  };
  try {
    await request('janitorConnect', { email: 'alice@example.test', code: '123456', consent: true });
    const start = httpTraffic.length;
    const staged = await request('publicFetch', { url: `https://janitorai.com/characters/${characterId}` });
    expect(staged.fetchAuthenticated).toBe(true); expect(fetches).toBe(2); expect(refreshes).toBe(1);
    expect(httpTraffic.slice(start).filter(item => item.url === endpoint).map(item => item.options.headers.Authorization)).toEqual([`Bearer ${old.access_token}`, `Bearer ${renewed.access_token}`]);
    expect(JSON.parse(enclaveSecrets.get('alice:janitor_session')!).access_token).toBe(renewed.access_token);
    rejectEveryFetch = true; fetches = 0;
    await expect(request('publicFetch', { url: `https://janitorai.com/characters/${characterId}` })).rejects.toThrow('saved-session request');
    expect(fetches).toBe(2); expect(refreshes).toBe(2);
    expect(await request('janitorStatus')).toEqual({ connected: false });
    expect(enclaveSecrets.has('alice:janitor_session')).toBe(false);
    const calls = corsCalls, records = storage.size;
    await expect(request('publicFetch', { url: `https://janitorai.com/characters/${characterId}` })).rejects.toThrow('JanitorAI login required');
    expect(corsCalls).toBe(calls); expect(storage.size).toBe(records);
    expect(fetches).toBe(2); expect(refreshes).toBe(2);
  } finally { enclaveSecrets.clear(); httpOverride = null; hasCompanion = true; }
});

test('native sign-in and refresh failures sanitize upstream credentials and clear rejected sessions', async () => {
  hasCompanion = false;
  const session = authSession('rejected'), email = 'alice@example.test', code = '123456';
  const sensitive = JSON.stringify({ access_token: session.access_token, refresh_token: session.refresh_token, email, code });
  let verifyFails = true, refreshes = 0;
  httpOverride = (url: string) => {
    if (url === `${authOrigin}/auth/v1/verify`) return verifyFails ? { status: 400, body: sensitive } : jsonResponse(session);
    if (url === `${authOrigin}/auth/v1/token?grant_type=refresh_token`) { refreshes++; return { status: 401, body: sensitive }; }
    return { status: 401, body: sensitive };
  };
  const assertNoCredentials = (message: string) => {
    for (const credential of [session.access_token, session.refresh_token, email, code]) expect(message).not.toContain(credential);
  };
  try {
    let error = '';
    try { await request('janitorConnect', { email, code, consent: true }); } catch (failure: any) { error = failure.message; }
    expect(error).toContain('could not verify'); assertNoCredentials(error);
    expect(await request('janitorStatus')).toEqual({ connected: false });
    verifyFails = false; await request('janitorConnect', { email, code, consent: true });
    error = '';
    try { await request('publicFetch', { url: 'https://janitorai.com/characters/cdef0123-1234-1234-1234-123456789abc' }); } catch (failure: any) { error = failure.message; }
    expect(error).toContain('session has expired'); assertNoCredentials(error);
    expect(refreshes).toBe(1); expect(await request('janitorStatus')).toEqual({ connected: false });
    expect(enclaveSecrets.has('alice:janitor_session')).toBe(false);
  } finally { enclaveSecrets.clear(); httpOverride = null; hasCompanion = true; }
});
