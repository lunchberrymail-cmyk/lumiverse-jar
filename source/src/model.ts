export type Json = Record<string, any>;
export function endpoint(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('Use a companion origin, for example http://127.0.0.1:4577');
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!local && url.protocol !== 'https:') throw new Error('Remote companions require HTTPS (or use an SSH tunnel to localhost)');
  return url.origin;
}
export function cardInput(rec: Json): Json {
  const c = rec.character || {};
  if (![c.description, c.personality, c.scenario, c.firstMessage, c.systemPrompt].some(value => typeof value === 'string' && value.trim())) throw new Error('No complete character definition is available. Use JAR to inspect or capture it.');
  return {
    name: c.name || rec.characterName || 'JAR character', description: c.description || '',
    personality: c.personality || '', scenario: c.scenario || '', first_mes: c.firstMessage || '',
    mes_example: c.exampleMessages || '', creator_notes: c.creatorNotes || '',
    tags: Array.isArray(c.tags) ? c.tags : String(c.tags || '').split(',').map((s: string) => s.trim()).filter(Boolean),
    alternate_greetings: Array.isArray(c.alternateGreetings) ? c.alternateGreetings : [],
    creator: c.creator || rec.meta?.creator_name || rec.meta?.creator?.username || '',
    system_prompt: c.systemPrompt || '', post_history_instructions: c.postHistoryInstructions || '',
    character_version: c.characterVersion || '', extensions: c.extensions || {},
  };
}
export function entryInput(raw: Json, index: number): Json {
  const keys = (value: unknown) => Array.isArray(value) ? value.map(String) : typeof value === 'string' ? value.split(',').map(s => s.trim()).filter(Boolean) : [];
  const out: Json = {
    uid: String(raw.uid ?? index), key: keys(raw.key || raw.keys || raw.keywords), keysecondary: keys(raw.keysecondary || raw.secondary_keys),
    comment: raw.comment || raw.title || raw.name || `Entry ${index + 1}`, content: String(raw.content || raw.text || ''),
  };
  const aliases: Record<string, string> = {
    order: 'order_value', disable: 'disabled', group: 'group_name', groupOverride: 'group_override',
    groupWeight: 'group_weight', scanDepth: 'scan_depth', caseSensitive: 'case_sensitive',
    matchWholeWords: 'match_whole_words', automationId: 'automation_id', useProbability: 'use_probability',
    selectiveLogic: 'selective_logic', excludeRecursion: 'exclude_recursion', preventRecursion: 'prevent_recursion',
    delayUntilRecursion: 'delay_until_recursion',
  };
  for (const key of ['position', 'depth', 'role', 'selective', 'constant', 'probability', 'sticky', 'cooldown', 'delay', 'priority', 'vectorized', 'use_regex', 'exclude_greeting'])
    if (raw[key] != null) out[key] = raw[key];
  for (const [from, to] of Object.entries(aliases)) if (raw[from] != null) out[to] = raw[from];
  if (raw.enabled === false) out.disabled = true;
  if (raw.insertion_order != null && out.order_value == null) out.order_value = raw.insertion_order;
  out.extensions = { jar_companion: { original: raw } };
  return out;
}
export function booksFrom(rec: Json): Json[] {
  const books: Json[] = [];
  for (const b of rec.publicLorebooks || []) {
    const wi = b.accessible ? b.worldInfo : (!b.reconstructionStale ? b.reconstructedWorldInfo : null);
    if (wi?.entries) books.push({ key: `public:${b.id}`, name: b.title || 'Public lorebook', reconstructed: !b.accessible, entries: Object.values(wi.entries) });
  }
  const privateBook = rec.privateLorebookReconstruction;
  if (privateBook?.worldInfo?.entries) books.push({ key: 'private', name: `${rec.characterName || 'Character'} — captured lore`, reconstructed: true, entries: Object.values(privateBook.worldInfo.entries) });
  return books;
}
export async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
}
