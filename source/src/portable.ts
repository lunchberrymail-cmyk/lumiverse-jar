import type { Json } from './model';

export const MAX_PORTABLE_BYTES = 6 * 1024 * 1024;
export const MAX_PORTABLE_ENTRIES = 2000;

export interface PortableRecord extends Json {
  id: string;
  source: 'portable' | 'janitor-public';
  url: string;
  characterName: string;
  character: Json | null;
  publicLorebooks: Json[];
  warnings: string[];
  rawInput: unknown;
}

const object = (value: unknown): Json | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const firstText = (...values: unknown[]): string => values.map(text).find(value => value.trim()) || '';
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item.trim()) : typeof value === 'string' ? value.split(',').map(item => item.trim()).filter(Boolean) : [];
const utf8 = new TextEncoder();

function checkedJson(value: unknown): void {
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (depth > 64) throw new Error('The supplied JSON is nested too deeply.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object') throw new Error('Supply JSON data; functions and executable objects are not supported.');
    if (seen.has(item)) throw new Error('The supplied JSON contains a circular reference.');
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error('Supply plain JSON objects.');
    seen.add(item);
    for (const key of Reflect.ownKeys(item)) {
      if (typeof key !== 'string') throw new Error('Supply plain JSON objects without symbol properties.');
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (descriptor.get || descriptor.set) throw new Error('Supply plain JSON data without executable property accessors.');
      visit(descriptor.value, depth + 1);
    }
    seen.delete(item);
  };
  visit(value, 0);
  if (utf8.encode(JSON.stringify(value)).length > MAX_PORTABLE_BYTES) throw new Error('Supplied JSON exceeds the 6 MB limit.');
}

function entriesFrom(value: unknown): Json[] {
  const entrySource = Array.isArray(value) ? value : object(value);
  if (!entrySource) throw new Error('World Book entries must be an array or JSON object.');
  const values = Array.isArray(entrySource) ? entrySource : Object.values(entrySource);
  if (values.length > MAX_PORTABLE_ENTRIES) throw new Error('A World Book can contain at most 2000 entries.');
  return values.map((entry, index) => {
    const raw = object(entry);
    if (!raw) throw new Error(`World Book entry ${index + 1} must be an object.`);
    const content = firstText(raw.content, raw.text);
    if (!content.trim()) throw new Error(`World Book entry ${index + 1} has no content.`);
    return {
      ...raw,
      uid: raw.uid ?? raw.id ?? index,
      content,
      key: strings(raw.key ?? raw.keys ?? raw.keywords ?? raw.keysRaw),
      keysecondary: strings(raw.keysecondary ?? raw.secondary_keys ?? raw.keySecondary),
    };
  });
}

function bookFrom(value: unknown, id: string, fallbackName: string): Json {
  const book = object(value);
  const entrySource = Array.isArray(value) ? value : book?.entries ?? book?.worldInfo?.entries;
  const entries = entriesFrom(entrySource);
  if (!entries.length) throw new Error('The supplied World Book is empty.');
  return {
    id, title: firstText(book?.name, book?.title, fallbackName), accessible: true,
    worldInfo: { ...(object(book?.worldInfo) || book || {}), entries },
  };
}

function normalizeCard(value: Json): Json {
  const greetings = [
    firstText(value.first_mes, value.firstMessage, value.first_message, value.char_greeting),
    ...strings(value.first_messages), ...strings(value.alternate_greetings ?? value.alternateGreetings),
  ].filter((greeting, index, all) => greeting.trim() && all.indexOf(greeting) === index);
  const character = {
    name: firstText(value.name, value.char_name),
    description: firstText(value.description, value.char_persona),
    personality: text(value.personality), scenario: text(value.scenario),
    firstMessage: greetings[0] || '', alternateGreetings: greetings.slice(1),
    exampleMessages: firstText(value.mes_example, value.exampleMessages, value.example_dialogue),
    creatorNotes: firstText(value.creator_notes, value.creatorNotes),
    creator: firstText(value.creator, value.creator_name), tags: strings(value.tags),
    systemPrompt: text(value.system_prompt), postHistoryInstructions: text(value.post_history_instructions),
    characterVersion: text(value.character_version), extensions: object(value.extensions) || {},
  };
  if (!character.name.trim()) throw new Error('The character has no name.');
  if (![character.description, character.personality, character.scenario, character.firstMessage, character.systemPrompt].some(field => field.trim()))
    throw new Error('The character has no definition or greeting to import.');
  return character;
}

/** Parse supplied content as data only. No supplied text or script is executed. */
export function parsePortableJson(value: unknown, sourceLabel = 'Supplied content'): PortableRecord {
  checkedJson(value);
  const label = sourceLabel.trim() || 'Supplied content';
  const rec: PortableRecord = {
    id: 'portable', source: 'portable', url: '', characterName: label, character: null,
    publicLorebooks: [], warnings: [], rawInput: value,
  };
  if (typeof value === 'string') {
    if (!value.trim()) throw new Error('Supply some lore text first.');
    rec.lorebookText = value;
    rec.warnings.push('Raw lore needs a Lumi reconstruction and review before it can be imported as entries.');
    return rec;
  }
  const root = object(value);
  if (!root && !Array.isArray(value)) throw new Error('Supply a character card, World Book, or lore text.');
  if (root?.spec && !['chara_card_v2', 'chara_card_v3'].includes(root.spec)) throw new Error('This character-card format is not supported.');
  const card = root?.spec ? object(root.data) : object(root?.character) || root;
  const isCard = !!card && ([card.description, card.personality, card.scenario, card.first_mes, card.firstMessage, card.first_message, card.char_greeting, card.char_persona, card.system_prompt].some(field => typeof field === 'string') || Array.isArray(card.first_messages));
  if (isCard && card) {
    rec.character = normalizeCard(card);
    rec.characterName = rec.character.name;
    rec.cardPublic = true;
    rec.definitionAvailable = true;
    const publicViewMarker = rec.character.extensions.janitor_public_view;
    if (publicViewMarker !== undefined) {
      const marker = object(publicViewMarker);
      if (!marker || marker.source !== 'rendered-public-definition' || typeof marker.url !== 'string')
        throw new Error('The JanitorAI public-view export marker must contain a character URL and rendered-public-definition source.');
      let source;
      try { source = parseCharacterUrl(marker.url); }
      catch { throw new Error('The JanitorAI public-view export marker contains an invalid character URL. Use an HTTPS JanitorAI /characters/ URL.'); }
      rec.source = 'janitor-public';
      rec.url = source.url;
      rec.characterId = source.id;
      rec.publicDefinitionDeclared = true;
      rec.character.definitionSource = 'janitor-public-view';
      rec.warnings.push('This user-supplied export contains rendered public definition text. Formatting may differ from the original source.');
    }
    const embedded = card.character_book ?? root?.character_book;
    if (embedded) {
      const embeddedEntries = object(embedded)?.entries;
      if ((Array.isArray(embeddedEntries) || object(embeddedEntries)) && !Object.values(embeddedEntries).length)
        rec.warnings.push('The embedded World Book is empty; the character can still be imported.');
      else rec.publicLorebooks.push(bookFrom(embedded, 'embedded', `${rec.characterName} — World Book`));
    }
    const avatar = firstText(root?.avatarBase64, card.avatarBase64);
    if (avatar && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=\s]+$/.test(avatar)) rec.avatarBase64 = avatar;
  } else if (Array.isArray(value) || root?.entries || root?.worldInfo?.entries || root?.lorebook?.entries) {
    rec.publicLorebooks.push(bookFrom(root?.lorebook || value, 'supplied', label));
    rec.characterName = rec.publicLorebooks[0]!.title;
  }
  if (Array.isArray(root?.publicLorebooks)) {
    for (const [index, candidate] of root.publicLorebooks.entries()) {
      const book = object(candidate);
      if (book?.accessible === false || !book?.worldInfo?.entries) continue;
      rec.publicLorebooks.push(bookFrom(book, `supplied-${index}`, firstText(book.title, label)));
    }
  }
  const rawLore = firstText(root?.lorebookText, root?.lore_text);
  if (rawLore.trim()) {
    rec.lorebookText = rawLore;
    rec.warnings.push('Raw lore needs a Lumi reconstruction and review before it can be imported as entries.');
  }
  const entryCount = rec.publicLorebooks.reduce((count, book) => count + Object.values(book.worldInfo.entries).length, 0);
  if (entryCount > MAX_PORTABLE_ENTRIES) throw new Error('Supplied World Books can contain at most 2000 entries in total.');
  if (!rec.character && !rec.publicLorebooks.length && !rec.lorebookText) throw new Error('No usable character, World Book entries, or lore text were found in this JSON.');
  return rec;
}

export function parseCharacterUrl(value: string): { id: string; url: string } {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('Paste a JanitorAI character URL.'); }
  const match = url.pathname.match(/^\/characters\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[^/]*)?\/?$/i);
  if (url.protocol !== 'https:' || !['janitorai.com', 'www.janitorai.com'].includes(url.hostname) || url.port || url.username || url.password || !match)
    throw new Error('Use an HTTPS JanitorAI /characters/ URL.');
  const id = match[1]!.toLowerCase();
  return { id, url: `https://janitorai.com/characters/${id}` };
}

function publicProfileFromMeta(meta: Json): Json {
  const greetings = [...strings(meta.first_messages), text(meta.first_message), ...strings(meta.alternate_greetings)]
    .filter((greeting, index, all) => greeting.trim() && all.indexOf(greeting) === index);
  return {
    name: text(meta.name), description: text(meta.description),
    firstMessage: greetings[0] || '', alternateGreetings: greetings.slice(1),
    creator: firstText(meta.creator_name, meta.creator?.username), tags: strings(meta.custom_tags),
    avatarUrl: firstText(meta.avatar, meta.avatar_url),
  };
}

/** An incomplete starter from public page text; hidden definition fields are never copied. */
export function publicStarterCard(rec: Json): Json | null {
  if (rec.source !== 'janitor-public') return null;
  const profile = object(rec.publicProfile) || publicProfileFromMeta(object(rec.meta) || {});
  const name = text(profile.name), description = text(profile.description);
  const greetings = [text(profile.firstMessage), ...strings(profile.alternateGreetings)]
    .filter((greeting, index, all) => greeting.trim() && all.indexOf(greeting) === index);
  if (!name.trim() || (!description.trim() && !greetings.length)) return null;
  return {
    name, description, personality: '', scenario: '',
    firstMessage: greetings[0] || '', alternateGreetings: greetings.slice(1),
    exampleMessages: '', creatorNotes: description,
    creator: text(profile.creator), tags: strings(profile.tags),
    definitionSource: 'janitor-public-starter', cardCompleteness: 'public-starter', definitionAvailable: false,
  };
}

/** Normalize JanitorAI catalog metadata; fields omitted by the source stay pending. */
export function normalizePublicCharacter(raw: unknown, sourceUrl: string): PortableRecord {
  checkedJson(raw);
  const { id, url } = parseCharacterUrl(sourceUrl);
  const root = object(raw);
  const meta = object(root?.data) || object(root?.character) || root;
  if (!meta || !text(meta.name).trim()) throw new Error('JanitorAI returned no usable character metadata.');
  if (meta.id && String(meta.id).toLowerCase() !== id) throw new Error('The returned character does not match this URL.');
  const publicDefinitionDeclared = meta.showdefinition === true;
  const definitionAvailable = publicDefinitionDeclared && [meta.personality, meta.scenario].some(field => text(field).trim());
  const publicProfile = publicProfileFromMeta(meta);
  const greetings = [publicProfile.firstMessage, ...publicProfile.alternateGreetings].filter(Boolean);
  const rec: PortableRecord = {
    id: `public-${id}`, source: 'janitor-public', url, characterId: id,
    characterName: meta.name, character: null, publicLorebooks: [], warnings: [], rawInput: raw,
    meta, cardPublic: definitionAvailable, cardPending: !definitionAvailable, definitionAvailable, publicDefinitionDeclared,
    publicProfile, publicGreeting: greetings[0] || '', publicGreetings: greetings, avatarUrl: publicProfile.avatarUrl,
  };
  rec.publicCard = publicStarterCard(rec);
  rec.cardCompleteness = definitionAvailable ? 'public-definition' : rec.publicCard ? 'public-starter' : 'metadata-only';
  if (definitionAvailable) rec.character = {
    name: meta.name, description: text(meta.personality), personality: '', scenario: text(meta.scenario),
    firstMessage: greetings[0] || '', alternateGreetings: greetings.slice(1),
    exampleMessages: text(meta.example_dialogs), creatorNotes: text(meta.description),
    creator: firstText(meta.creator_name, meta.creator?.username), tags: strings(meta.custom_tags),
    definitionSource: 'janitor-public',
  };
  else {
    rec.warnings.push(publicDefinitionDeclared
      ? 'The creator has made this definition public, but its fields were not returned by this unauthenticated request. Public page text is not the character definition. A signed-in JanitorAI browser can expose the public definition; JAR is optional for importing a supplied card.'
      : 'This definition is hidden or unavailable. Public page text is not a recovered definition; JAR is needed to attempt capture.');
    rec.warnings.push(rec.publicCard
      ? 'A public starter card is available using only the supplied page notes and greetings. It does not include the character personality, scenario, examples, or World Book contents.'
      : 'No public description or greeting was supplied, so this metadata cannot produce a starter card.');
  }
  if (Array.isArray(meta.scripts)) rec.publicLorebooks = meta.scripts
    .filter((script: unknown) => { const book = object(script); return book && ['lorebook', 'advanced'].includes(book.type) && typeof book.id === 'string'; })
    .map((book: Json) => ({ id: book.id, title: firstText(book.title, 'Attached World Book'), type: book.type, accessible: false, isPublic: book.is_public !== false }));
  return rec;
}

/** A downloadable JanitorAI JSON lorebook; advanced JavaScript stays unavailable. */
export function normalizePublicLorebook(raw: unknown, ref: Json): Json {
  checkedJson(raw);
  const source = object(raw);
  const result: Json = {
    id: String(ref.id || ''), title: firstText(source?.title, ref.title, 'Attached World Book'),
    type: ref.type || 'lorebook', accessible: false,
  };
  if (!source) { result.error = 'The source was not a JSON object.'; return result; }
  if (source.id && String(source.id) !== result.id) throw new Error('The returned World Book does not match the requested source.');
  if (source.is_public === false || ref.isPublic === false || source.is_code_public === false) {
    result.error = 'The World Book source is private.'; return result;
  }
  // Current sources must explicitly expose their code. Older sources omitted
  // is_code_public; accept those only when this source confirms is_public=true.
  const publicPage = source.is_public === true || ref.isPublic === true;
  const publicSource = source.is_code_public === true && publicPage
    || source.is_code_public == null && source.is_public === true;
  if (!publicSource) { result.error = 'The source did not confirm public access.'; return result; }
  let entries = source.script ?? source.entries;
  if (typeof entries === 'string') {
    try { entries = JSON.parse(entries); }
    catch { result.error = 'This advanced script is not a structured JSON World Book. JAR can capture its triggered lore.'; return result; }
  }
  if (object(entries)?.entries) entries = entries.entries;
  if (!Array.isArray(entries) && !object(entries)) { result.error = 'No structured entries were supplied.'; return result; }
  const normalized = entriesFrom(entries);
  if (!normalized.length) { result.error = 'The World Book has no entries.'; return result; }
  return { ...result, accessible: true, isPublic: true, worldInfo: { entries: normalized }, entryCount: normalized.length };
}

/** Read uncompressed character-card metadata from PNG tEXt chunks. */
export function parsePngCard(bytes: Uint8Array, sourceLabel = 'Supplied PNG'): PortableRecord {
  if (bytes.length > MAX_PORTABLE_BYTES) throw new Error('The PNG exceeds the 6 MB limit.');
  if (bytes.length < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) throw new Error('This file is not a PNG.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let offset = 8, ended = false;
  const cards = new Map<string, string>();
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset), end = offset + 12 + length;
    if (end > bytes.length) throw new Error('The PNG contains a truncated chunk.');
    const kind = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (offset === 8 && (kind !== 'IHDR' || length !== 13 || !view.getUint32(offset + 8) || !view.getUint32(offset + 12))) throw new Error('The PNG has an invalid image header.');
    if (kind === 'tEXt') {
      const data = bytes.subarray(offset + 8, offset + 8 + length), split = data.indexOf(0);
      const keyword = split < 0 ? '' : String.fromCharCode(...data.subarray(0, Math.min(split, 80)));
      if (keyword === 'chara' || keyword === 'ccv3') cards.set(keyword, decoder.decode(data.subarray(split + 1)));
    }
    offset = end;
    if (kind === 'IEND') { ended = true; break; }
  }
  if (!ended) throw new Error('The PNG is incomplete.');
  const encoded = cards.get('ccv3') || cards.get('chara');
  if (!encoded) throw new Error('This PNG has no supported character-card metadata (chara or ccv3).');
  let input: unknown;
  try {
    const binary = atob(encoded.trim());
    const metadata = Uint8Array.from(binary, char => char.charCodeAt(0));
    input = JSON.parse(decoder.decode(metadata));
  } catch { throw new Error('The PNG character-card metadata is not valid base64 JSON.'); }
  const rec = parsePortableJson(input, sourceLabel);
  if (!rec.character) throw new Error('The PNG metadata does not contain a usable character card.');
  // Keep the original image, including its card metadata, as the assigned avatar.
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  rec.avatarBase64 = `data:image/png;base64,${btoa(binary)}`;
  return rec;
}
