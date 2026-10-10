import { expect, test } from 'bun:test';
import { booksFrom, cardInput, entryInput } from '../src/model';
import { MAX_PORTABLE_BYTES, normalizePublicCharacter, normalizePublicLorebook, parseCharacterUrl, parsePngCard, parsePortableJson, publicStarterCard } from '../src/portable';

const characterId = '11111111-1111-4111-8111-111111111111';
const characterUrl = `https://janitorai.com/characters/${characterId}_character-explorer`;
const card = {
  name: 'The explorer', description: '{{char}} studies the northern lights.', first_mes: 'Welcome, {{user}}.',
  alternate_greetings: ['The expedition starts today.'], creator: 'Fixture author', tags: ['adventure'],
  system_prompt: 'Write short replies.', post_history_instructions: 'Keep the expedition coherent.',
  character_version: '2.4',
  extensions: { theme: 'winter' },
  character_book: { name: 'Expedition atlas', entries: [{ id: 4, keys: ['aurora'], content: 'The aurora lights the northern sky.', insertion_order: 20, enabled: false }] },
};

test('portable v2 and v3 cards preserve data and map embedded World Books for import', () => {
  for (const spec of ['chara_card_v2', 'chara_card_v3']) {
    const supplied = { spec, spec_version: spec.endsWith('v3') ? '3.0' : '2.0', data: card };
    const rec = parsePortableJson(supplied, 'expedition.json');
    expect(cardInput(rec)).toMatchObject({ name: card.name, description: card.description, first_mes: card.first_mes, creator: 'Fixture author', alternate_greetings: card.alternate_greetings });
    expect(rec.rawInput).toBe(supplied);
    expect(rec.character?.systemPrompt).toBe(card.system_prompt);
    expect(rec.character?.characterVersion).toBe('2.4');
    expect(rec.character?.extensions).toEqual({ theme: 'winter' });
    const book = booksFrom(rec)[0]!;
    expect(book.name).toBe('Expedition atlas');
    expect(entryInput(book.entries[0], 0)).toMatchObject({ uid: '4', key: ['aurora'], content: 'The aurora lights the northern sky.', order_value: 20, disabled: true });
  }
});

test('plain cards and JAR-shaped supplied records normalize greetings and book entries', () => {
  const rec = parsePortableJson({ character: { name: 'Observer', description: 'A patient observer.', firstMessage: 'Hello.', alternateGreetings: ['Welcome.', 'Welcome.'] }, publicLorebooks: [{ title: 'Observatory', worldInfo: { entries: { 8: { key: 'telescope, dome', content: 'The dome contains a telescope.' } } } }] });
  expect(cardInput(rec).alternate_greetings).toEqual(['Welcome.']);
  expect(booksFrom(rec)[0]!.entries[0].key).toEqual(['telescope', 'dome']);
});

test('a supplied public-view export keeps rendered fields and canonical Janitor character identity', () => {
  const marker = { url: `${characterUrl}?from=profile#definition`, source: 'rendered-public-definition' };
  const supplied = {
    spec: 'chara_card_v2', spec_version: '2.0',
    data: { ...card, extensions: { ...card.extensions, janitor_public_view: marker } },
  };
  const rec = parsePortableJson(supplied, 'public-view.json');
  expect(rec.source).toBe('janitor-public');
  expect(rec.url).toBe(`https://janitorai.com/characters/${characterId}`);
  expect(rec.characterId).toBe(characterId);
  expect(rec.publicDefinitionDeclared).toBe(true);
  expect(rec.definitionAvailable).toBe(true);
  expect(rec.character?.definitionSource).toBe('janitor-public-view');
  expect(cardInput(rec)).toMatchObject({
    description: card.description, first_mes: card.first_mes, alternate_greetings: card.alternate_greetings,
    extensions: { theme: 'winter', janitor_public_view: marker },
  });
  expect(rec.rawInput).toBe(supplied);
  expect(rec.warnings.some(warning => warning.includes('user-supplied') && warning.includes('rendered public definition text') && warning.includes('Formatting may differ'))).toBe(true);
  expect(rec.warnings.join(' ')).not.toMatch(/hidden|private|recovered/i);
});

test('public-view source markers reject invalid Janitor URLs instead of assigning a source identity', () => {
  for (const url of [
    `https://janitorai.com.evil.example/characters/${characterId}`,
    `https://janitorai.com/scripts/${characterId}`,
    `http://janitorai.com/characters/${characterId}`,
    `https://user:pass@janitorai.com/characters/${characterId}`,
    '',
  ]) {
    expect(() => parsePortableJson({ spec: 'chara_card_v2', data: { ...card, extensions: { janitor_public_view: { url, source: 'rendered-public-definition' } } } }))
      .toThrow('public-view export marker contains an invalid character URL');
  }
  for (const marker of [null, {}, { url: characterUrl, source: 'private-capture' }]) {
    expect(() => parsePortableJson({ spec: 'chara_card_v2', data: { ...card, extensions: { janitor_public_view: marker } } }))
      .toThrow('public-view export marker must contain');
  }
});

test('standalone World Books accept object or array entries and keep rules', () => {
  for (const supplied of [{ name: 'Atlas', entries: { 10: { keys: ['north'], content: 'The north is cold.', constant: true, probability: 25 } } }, [{ keys: ['north'], content: 'The north is cold.', constant: true, probability: 25 }]]) {
    const rec = parsePortableJson(supplied, 'Atlas');
    expect(rec.character).toBeNull();
    const entries = booksFrom(rec)[0]!.entries;
    expect(entryInput(entries[0], 0)).toMatchObject({ key: ['north'], content: 'The north is cold.', constant: true, probability: 25 });
  }
});

test('raw lore remains staged text until an explicit Lumi reconstruction', () => {
  const lore = 'The northern road ends at a quiet observatory.';
  const rec = parsePortableJson(lore, 'Notes');
  expect(rec.lorebookText).toBe(lore);
  expect(booksFrom(rec)).toEqual([]);
  expect(rec.warnings[0]).toContain('review');
  expect(parsePortableJson({ lorebookText: lore }).lorebookText).toBe(lore);
});

test('invalid empty cards, books, oversized inputs, and executable objects are rejected', () => {
  for (const input of [{}, null, { name: 'Empty', description: '' }, { entries: [] }, { entries: [{ content: ' ' }] }, { spec: 'unknown', data: card }, { fn: () => 'not JSON' }]) expect(() => parsePortableJson(input)).toThrow();
  expect(() => parsePortableJson('x'.repeat(MAX_PORTABLE_BYTES))).toThrow('6 MB');
  expect(() => parsePortableJson({ entries: Array.from({ length: 2001 }, () => ({ content: 'Entry' })) })).toThrow('2000');
  const cyclic: any = {}; cyclic.self = cyclic;
  expect(() => parsePortableJson(cyclic)).toThrow('circular');
  let getterCalled = false;
  const executable = { get name() { getterCalled = true; return 'Explorer'; } };
  expect(() => parsePortableJson(executable)).toThrow('accessors');
  expect(getterCalled).toBe(false);
});

test('an empty embedded World Book does not prevent importing a valid character', () => {
  const rec = parsePortableJson({ spec: 'chara_card_v2', data: { ...card, character_book: { entries: [] } } });
  expect(cardInput(rec).name).toBe(card.name);
  expect(booksFrom(rec)).toEqual([]);
  expect(rec.warnings[0]).toContain('empty');
});

test('character URLs normalize slugs and reject other hosts, routes, credentials, and insecure schemes', () => {
  expect(parseCharacterUrl(`${characterUrl}?utm_source=test#details`)).toEqual({ id: characterId, url: `https://janitorai.com/characters/${characterId}` });
  for (const url of [`https://janitorai.com.evil.example/characters/${characterId}`, `https://janitorai.com/scripts/${characterId}`, `https://user:pass@janitorai.com/characters/${characterId}`, `http://janitorai.com/characters/${characterId}`, `https://janitorai.com:9000/characters/${characterId}`, 'https://janitorai.com/characters/not-an-id']) expect(() => parseCharacterUrl(url)).toThrow();
});

test('public Janitor metadata follows upstream field mapping without changing character macros', () => {
  const rec = normalizePublicCharacter({ id: characterId, name: 'Observer', showdefinition: true, personality: '{{char}} studies the sky.', scenario: 'At the observatory.', description: 'Creator page notes.', first_messages: ['Hello.', 'Welcome.'], first_message: 'Hello.', example_dialogs: 'Example conversation.', creator_name: 'Public author', custom_tags: ['astronomy'], scripts: [{ id: 'book-id', title: 'Sky atlas', type: 'lorebook' }] }, characterUrl);
  expect(rec.source).toBe('janitor-public');
  expect(rec.publicDefinitionDeclared).toBe(true);
  expect(rec.cardCompleteness).toBe('public-definition');
  expect(rec.character).toMatchObject({ description: '{{char}} studies the sky.', personality: '', scenario: 'At the observatory.', creatorNotes: 'Creator page notes.', firstMessage: 'Hello.', alternateGreetings: ['Welcome.'] });
  expect(rec.publicLorebooks[0]).toMatchObject({ accessible: false, title: 'Sky atlas' });
  expect(booksFrom(rec)).toEqual([]);
});

test('hidden definitions remain pending even when greeting and catalog notes are public', () => {
  const rec = normalizePublicCharacter({ name: 'Observer', showdefinition: false, description: 'A public page introduction.', first_message: 'Welcome.' }, characterUrl);
  expect(rec.character).toBeNull();
  expect(rec.publicGreeting).toBe('Welcome.');
  expect(rec.cardPending).toBe(true);
  expect(rec.cardCompleteness).toBe('public-starter');
  expect(rec.publicDefinitionDeclared).toBe(false);
  expect(rec.warnings.some(warning => warning.includes('hidden or unavailable'))).toBe(true);
  expect(rec.warnings.some(warning => warning.includes('unauthenticated'))).toBe(false);
  expect(() => cardInput(rec)).toThrow();
  expect(() => normalizePublicCharacter({ id: 'wrong-id', name: 'Other' }, characterUrl)).toThrow('match');
});

test('a declared public definition with null fields is incomplete because the anonymous response omitted it', () => {
  const rec = normalizePublicCharacter({
    id: characterId, name: 'Public definition fixture', showdefinition: true,
    description: 'Public profile notes.', personality: null, scenario: null,
    example_dialogs: null, first_message: null, first_messages: null,
  }, characterUrl);
  expect(rec.publicDefinitionDeclared).toBe(true);
  expect(rec.definitionAvailable).toBe(false);
  expect(rec.cardPublic).toBe(false);
  expect(rec.cardPending).toBe(true);
  expect(rec.character).toBeNull();
  expect(rec.publicGreeting).toBe('');
  expect(rec.publicGreetings).toEqual([]);
  expect(rec.publicCard).toMatchObject({ description: 'Public profile notes.', personality: '', scenario: '', firstMessage: '', exampleMessages: '' });
  expect(rec.cardCompleteness).toBe('public-starter');
  expect(rec.warnings.some(warning => warning.includes('definition public') && warning.includes('not returned by this unauthenticated request'))).toBe(true);
  expect(rec.warnings.join(' ')).not.toMatch(/hidden|private/i);
});

test('public starter cards preserve exact public text and greetings without hidden definition fields', () => {
  const publicNotes = '  {{char}} meets {{user}} at the café.\n<p>Public creator notes.</p>  ';
  const greetings = [' First public greeting.\n', 'Second public greeting.', 'Second public greeting.'];
  const rec = normalizePublicCharacter({
    id: characterId, name: 'Observer', showdefinition: false, description: publicNotes,
    first_messages: greetings, first_message: greetings[0], alternate_greetings: ['Third public greeting.'],
    creator_name: 'Public author', custom_tags: ['astronomy', 'café'], avatar: 'https://example.test/public.png',
    personality: 'HIDDEN PERSONALITY', scenario: 'HIDDEN SCENARIO', example_dialogs: 'HIDDEN EXAMPLES',
    system_prompt: 'HIDDEN SYSTEM PROMPT', post_history_instructions: 'HIDDEN INSTRUCTIONS',
  }, characterUrl);
  const starter = publicStarterCard(rec)!;
  expect(rec.character).toBeNull();
  expect(rec.publicCard).toEqual(starter);
  expect(rec.publicProfile.description).toBe(publicNotes);
  expect(rec.publicGreetings).toEqual([greetings[0], greetings[1], 'Third public greeting.']);
  expect(starter).toMatchObject({
    name: 'Observer', description: publicNotes, creatorNotes: publicNotes,
    firstMessage: greetings[0], alternateGreetings: [greetings[1], 'Third public greeting.'],
    creator: 'Public author', tags: ['astronomy', 'café'],
    personality: '', scenario: '', exampleMessages: '',
    definitionSource: 'janitor-public-starter', cardCompleteness: 'public-starter', definitionAvailable: false,
  });
  expect(JSON.stringify(starter)).not.toContain('HIDDEN');
  expect(starter.systemPrompt).toBeUndefined();
  expect(starter.postHistoryInstructions).toBeUndefined();
  expect(cardInput({ ...rec, character: starter })).toMatchObject({
    description: publicNotes, first_mes: greetings[0], alternate_greetings: [greetings[1], 'Third public greeting.'],
    personality: '', scenario: '', mes_example: '',
  });
  expect(rec.warnings.some(warning => warning.includes('starter card'))).toBe(true);
});

test('public starter cards require public notes or greetings, never only hidden fields', () => {
  const empty = normalizePublicCharacter({ name: 'Observer', showdefinition: false, description: '  ', personality: 'Hidden definition.', scenario: 'Hidden scene.', first_messages: [' '] }, characterUrl);
  expect(empty.publicCard).toBeNull();
  expect(empty.character).toBeNull();
  expect(empty.cardCompleteness).toBe('metadata-only');
  expect(publicStarterCard(empty)).toBeNull();
  expect(empty.warnings.some(warning => warning.includes('cannot produce a starter card'))).toBe(true);
  expect(publicStarterCard({ source: 'portable', meta: { name: 'Observer', description: 'Supplied card.' } })).toBeNull();
  for (const meta of [{ name: 'Observer', description: 'Public notes only.' }, { name: 'Observer', first_message: 'Public greeting only.' }]) {
    const rec = normalizePublicCharacter(meta, characterUrl);
    expect(rec.publicCard).not.toBeNull();
    expect(rec.character).toBeNull();
    expect(rec.cardCompleteness).toBe('public-starter');
  }
  expect(publicStarterCard({ source: 'janitor-public', meta: { name: 'Observer', description: 'Public notes only.', personality: 'Hidden.' } })?.description).toBe('Public notes only.');
});

test('public lore sources respect source privacy and never execute advanced JavaScript', () => {
  const ref = { id: 'atlas-id', title: 'Atlas', type: 'lorebook', isPublic: true };
  const source = { id: ref.id, is_public: true, is_code_public: true, script: JSON.stringify([{ keysRaw: 'north, aurora', content: 'Auroras occur to the north.', enabled: false }]) };
  const book = normalizePublicLorebook(source, ref);
  expect(book.accessible).toBe(true);
  expect(entryInput(book.worldInfo.entries[0], 0)).toMatchObject({ key: ['north', 'aurora'], disabled: true });
  expect(normalizePublicLorebook({ ...source, is_code_public: false }, ref).accessible).toBe(false);
  expect(normalizePublicLorebook({ id: ref.id, script: source.script }, ref).accessible).toBe(false);
  const { is_code_public: omitted, ...legacySource } = source;
  expect(normalizePublicLorebook(legacySource, ref).accessible).toBe(true);
  const wrapped = normalizePublicLorebook({ ...source, script: JSON.stringify({ entries: [{ keys: ['atlas'], content: 'A map of the sky.' }] }) }, ref);
  expect(wrapped.worldInfo.entries[0].content).toBe('A map of the sky.');
  expect(normalizePublicLorebook({ ...source, script: 'globalThis.portableExecuted = true;' }, ref).accessible).toBe(false);
  expect((globalThis as any).portableExecuted).toBeUndefined();
});

function pngWithCard(keyword: 'chara' | 'ccv3', value: unknown): Uint8Array {
  const base = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvZkAAAAASUVORK5CYII=', 'base64'));
  const encoded = Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
  const body = new TextEncoder().encode(`${keyword}\0${encoded}`);
  const chunk = new Uint8Array(body.length + 12), view = new DataView(chunk.buffer);
  view.setUint32(0, body.length); chunk.set([116, 69, 88, 116], 4); chunk.set(body, 8);
  const result = new Uint8Array(base.length + chunk.length);
  result.set(base.subarray(0, base.length - 12)); result.set(chunk, base.length - 12); result.set(base.subarray(base.length - 12), base.length - 12 + chunk.length);
  return result;
}

test('PNG chara and ccv3 metadata imports Unicode cards and retains the original avatar', () => {
  for (const keyword of ['chara', 'ccv3'] as const) {
    const bytes = pngWithCard(keyword, { spec: keyword === 'ccv3' ? 'chara_card_v3' : 'chara_card_v2', data: { ...card, name: 'Étoile 雪' } });
    const rec = parsePngCard(bytes, 'observer.png');
    expect(rec.character?.name).toBe('Étoile 雪');
    expect(booksFrom(rec)).toHaveLength(1);
    expect(Buffer.from(rec.avatarBase64.split(',')[1], 'base64')).toEqual(Buffer.from(bytes));
  }
});

test('PNG invalid signatures, missing card metadata, and truncated chunks give useful errors', () => {
  expect(() => parsePngCard(new Uint8Array(40))).toThrow('not a PNG');
  const plain = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvZkAAAAASUVORK5CYII=', 'base64'));
  expect(() => parsePngCard(plain)).toThrow('no supported');
  const png = pngWithCard('chara', card);
  expect(() => parsePngCard(png.subarray(0, png.length - 20))).toThrow('truncated');
});
