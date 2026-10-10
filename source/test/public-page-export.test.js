import { expect, test } from 'bun:test';
import { createPublicPageExporter, publicPageExportBookmarklet } from '../public-page-export.js';
import { parsePortableJson } from '../src/portable';
import { cardInput } from '../src/model';

const id = '22222222-2222-4222-8222-222222222222';
const url = `https://janitorai.com/characters/${id}_character-fixture?x=1#public`;

function fixture({ greetings = ['{{char}} greets {{user}}.', 'A second greeting.', ''], start = 1, hidden = false, stuck = false, badCounter = false } = {}) {
  let index = start, downloads = 0, networkCalls = 0;
  const titleText = { PERSONALITY: '{{char}} protects {{user}}.\nTwo paragraphs.', SCENARIO: '', 'EXAMPLE DIALOGS': '', 'INITIAL MESSAGES': '' };
  const controls = Object.keys(titleText).map((title, position) => ({
    title, expanded: false, disabled: false, innerText: `${title} (${title === 'SCENARIO' || title === 'EXAMPLE DIALOGS' ? '0' : '20'} TOKENS)`,
    getAttribute(name) { return name === 'aria-controls' ? `panel-info-${position}` : name === 'aria-expanded' ? String(this.expanded) : null; },
    click() { this.expanded = !this.expanded; },
  }));
  const previous = { get disabled() { return index === 1; }, getAttribute() { return null; }, click() { if (!stuck && index > 1) index--; } };
  const next = { get disabled() { return index === greetings.length; }, getAttribute() { return null; }, click() { if (!stuck && index < greetings.length) index++; } };
  const panels = controls.map(control => ({
    querySelector(selector) {
      if (selector.includes('characterInfoMarkdownContent')) return { get innerText() { return control.title === 'INITIAL MESSAGES' ? greetings[index - 1] : titleText[control.title]; } };
      if (control.title !== 'INITIAL MESSAGES' || greetings.length === 1) return null;
      if (selector.includes('messageNavigation')) return { get innerText() { return badCounter ? 'unknown' : `${index} / ${greetings.length}`; } };
      if (selector.includes('Previous message')) return previous;
      if (selector.includes('Next message')) return next;
      return null;
    },
  }));
  const anchors = [];
  const host = {
    location: { href: url }, Blob,
    document: {
      querySelectorAll(selector) { return selector === 'button' ? hidden ? controls.filter(control => control.title === 'INITIAL MESSAGES') : controls : []; },
      getElementById(value) { const position = Number(value.slice(-1)); return controls[position]?.expanded ? panels[position] : null; },
      querySelector(selector) { return selector === 'h2.chakra-heading' ? { innerText: 'Public fixture | alternate' } : null; },
      createElement(tag) { if (tag !== 'a') throw Error('Unexpected element'); const anchor = { click() { downloads++; }, remove() {}, href: '', download: '' }; anchors.push(anchor); return anchor; },
      body: { append() {} },
    },
    URL: { createObjectURL(blob) { host.lastBlob = blob; return 'blob:local-export'; }, revokeObjectURL() {} },
    setTimeout(callback) { callback(); },
    fetch() { networkCalls++; throw Error('No network calls permitted'); },
  };
  return { host, controls, titleText, anchors, get index() { return index; }, get downloads() { return downloads; }, get networkCalls() { return networkCalls; } };
}

test('public page exporter uses every rendered greeting slot and preserves macros without network access', async () => {
  const page = fixture({ start: 2 });
  const card = await createPublicPageExporter(page.host).collect({ wait: async () => {} });
  expect(card.data.description).toBe('{{char}} protects {{user}}.\nTwo paragraphs.');
  expect(card.data.first_mes).toBe('{{char}} greets {{user}}.');
  expect(card.data.alternate_greetings).toEqual(['A second greeting.']);
  expect(card.data.scenario).toBe('');
  expect(card.data.extensions.janitor_public_view).toMatchObject({
    url: `https://janitorai.com/characters/${id}`, source: 'rendered-public-definition', greeting_slots: 3, empty_greeting_slots: 1, world_books_included: false,
  });
  expect(page.index).toBe(2);
  expect(page.controls.every(control => control.expanded)).toBe(true);
  expect(page.networkCalls).toBe(0);
  expect(page.downloads).toBe(0);
  expect(cardInput(parsePortableJson(card))).toMatchObject({ name: 'Public fixture | alternate', description: card.data.description, first_mes: card.data.first_mes, alternate_greetings: card.data.alternate_greetings });
});

test('public page exporter downloads a locally importable JSON card only after successful collection', async () => {
  const page = fixture({ greetings: ['One rendered greeting.'] });
  const card = await createPublicPageExporter(page.host).run({ wait: async () => {} });
  expect(page.downloads).toBe(1);
  expect(page.anchors[0].href).toBe('blob:local-export');
  expect(page.anchors[0].download).toBe('Public fixture _ alternate.json');
  expect(JSON.parse(await page.host.lastBlob.text())).toEqual(card);
  expect(page.networkCalls).toBe(0);
});

test('private sections, empty definitions, and broken message navigation fail without exporting a fabricated card', async () => {
  const hidden = fixture({ hidden: true });
  await expect(createPublicPageExporter(hidden.host).run({ wait: async () => {} })).rejects.toThrow('public personality section is unavailable');
  expect(hidden.downloads).toBe(0);
  const empty = fixture(); empty.titleText.PERSONALITY = '';
  await expect(createPublicPageExporter(empty.host).run({ wait: async () => {} })).rejects.toThrow('No public definition text');
  expect(empty.downloads).toBe(0);
  for (const options of [{ stuck: true }, { badCounter: true }]) {
    const broken = fixture(options);
    await expect(createPublicPageExporter(broken.host).run({ wait: async () => {} })).rejects.toThrow();
    expect(broken.downloads).toBe(0);
    expect(broken.networkCalls).toBe(0);
  }
});

test('public page exporter refuses other sites and deduplicates only identical greetings', () => {
  const api = createPublicPageExporter();
  for (const badUrl of ['http://janitorai.com/characters/' + id, 'https://janitorai.com.evil.test/characters/' + id, 'https://user:secret@janitorai.com/characters/' + id, 'https://janitorai.com/chats/' + id]) expect(() => api.canonicalSource(badUrl)).toThrow();
  const card = api.buildCard({ url, name: 'Fixture', personality: '{{char}} has a public persona.', greetings: ['Same.', 'Same.', '', 'Different.'] });
  expect(card.data.first_mes).toBe('Same.');
  expect(card.data.alternate_greetings).toEqual(['Different.']);
  expect(publicPageExportBookmarklet.startsWith('javascript:')).toBe(true);
  const source = decodeURIComponent(publicPageExportBookmarklet.slice('javascript:'.length));
  expect(source).not.toMatch(/\b(?:fetch|XMLHttpRequest|localStorage|sessionStorage|cookie)\s*(?:\(|\.|=)/);
  expect(source).toContain('rendered-public-definition');
});
