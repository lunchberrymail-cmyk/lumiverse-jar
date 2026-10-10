/**
 * User-run export of JanitorAI's rendered public definition.
 * No requests, credentials, application state, or browser storage are read.
 * The bookmarklet opens ordinary accordions and uses message navigation, then
 * downloads a local JSON card. It does not capture private definitions or lore.
 */
export function createPublicPageExporter(host = globalThis) {
  const tidy = value => String(value || '').replace(/\r\n?/g, '\n').trim();
  const label = value => tidy(value).replace(/\s+/g, ' ').toUpperCase();
  const defaultWait = milliseconds => new Promise(resolve => host.setTimeout(resolve, milliseconds));

  function canonicalSource(value) {
    let url;
    try { url = new URL(value); } catch { throw new Error('Open a JanitorAI character page before exporting.'); }
    const match = url.pathname.match(/^\/characters\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[^/]*)?\/?$/i);
    if (url.protocol !== 'https:' || !['janitorai.com', 'www.janitorai.com'].includes(url.hostname) || url.port || url.username || url.password || !match)
      throw new Error('This export runs only on an HTTPS JanitorAI character page.');
    return `https://janitorai.com/characters/${match[1].toLowerCase()}`;
  }

  function buildCard(fields) {
    const url = canonicalSource(fields.url), name = tidy(fields.name);
    const description = tidy(fields.personality), scenario = tidy(fields.scenario), examples = tidy(fields.examples);
    if (!name) throw new Error('The character heading was not found. No card was exported.');
    if (![description, scenario, examples].some(Boolean))
      throw new Error('No public definition text is rendered. Sign in and open a character with a public definition; no card was exported.');
    const greetings = (fields.greetings || []).map(tidy).filter((greeting, index, all) => greeting && all.indexOf(greeting) === index);
    return {
      spec: 'chara_card_v2', spec_version: '2.0',
      data: {
        name, description, personality: '', scenario, first_mes: greetings[0] || '',
        alternate_greetings: greetings.slice(1), mes_example: examples, creator_notes: '',
        system_prompt: '', post_history_instructions: '', creator: '', character_version: '', tags: [],
        extensions: { janitor_public_view: {
          url, source: 'rendered-public-definition', captured_at: new Date().toISOString(),
          captured_fields: ['personality', 'scenario', 'example_dialogs', 'initial_messages'],
          greeting_slots: fields.greetingSlots ?? greetings.length,
          empty_greeting_slots: fields.emptyGreetingSlots ?? 0,
          world_books_included: false,
        } },
      },
    };
  }

  async function collect(options = {}) {
    const doc = host.document;
    if (!doc) throw new Error('A JanitorAI page is required.');
    const url = canonicalSource(options.url || host.location?.href || '');
    const wait = options.wait || defaultWait;
    const buttons = () => [...doc.querySelectorAll('button')];
    function accordion(title) {
      const button = buttons().find(item => item.getAttribute('aria-controls') && new RegExp(`^${title}(?:\\s|\\(|$)`).test(label(item.innerText || item.textContent)));
      if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true')
        throw new Error(`The public ${title.toLowerCase()} section is unavailable. Sign in and use a character whose definition is public; no card was exported.`);
      return button;
    }
    // Require the public definition controls, rather than exporting a greeting
    // or catalog introduction as though it were the missing character persona.
    const controls = Object.fromEntries(['PERSONALITY', 'SCENARIO', 'EXAMPLE DIALOGS', 'INITIAL MESSAGES'].map(title => [title, accordion(title)]));
    async function open(title) {
      const button = controls[title], id = button.getAttribute('aria-controls');
      if (button.getAttribute('aria-expanded') !== 'true') button.click();
      for (let attempt = 0; attempt < 20; attempt++) {
        const panel = doc.getElementById(id);
        if (panel && button.getAttribute('aria-expanded') === 'true') return panel;
        await wait(100);
      }
      throw new Error(`The ${title.toLowerCase()} section did not open. No card was exported.`);
    }
    function content(panel, title) {
      const element = panel.querySelector('.characterInfoMarkdownContent') || panel.querySelector('[class*="characterInfoMarkdownContent"]');
      if (!element) {
        if (/\(\s*0\s+TOKENS?\s*\)/.test(label(controls[title].innerText || controls[title].textContent))) return '';
        throw new Error(`The rendered ${title.toLowerCase()} text could not be located. No card was exported.`);
      }
      return tidy(element.innerText ?? element.textContent);
    }
    const personality = content(await open('PERSONALITY'), 'PERSONALITY');
    const scenario = content(await open('SCENARIO'), 'SCENARIO');
    const examples = content(await open('EXAMPLE DIALOGS'), 'EXAMPLE DIALOGS');
    const messagePanel = await open('INITIAL MESSAGES');
    function navigation() {
      const currentPanel = doc.getElementById(controls['INITIAL MESSAGES'].getAttribute('aria-controls')) || messagePanel;
      const element = currentPanel.querySelector('[class*="messageNavigation"]');
      const match = tidy(element?.innerText ?? element?.textContent).match(/^(\d+)\s*\/\s*(\d+)$/);
      const previous = currentPanel.querySelector('button[aria-label="Previous message"]');
      const next = currentPanel.querySelector('button[aria-label="Next message"]');
      if (!element) {
        if (previous || next) throw new Error('Initial-message navigation changed. No card was exported.');
        return { panel: currentPanel, index: 1, total: 1, previous: null, next: null };
      }
      if (!match || Number(match[1]) < 1 || Number(match[2]) < 1 || Number(match[1]) > Number(match[2]) || Number(match[2]) > 100)
        throw new Error('The initial-message counter could not be read safely. No card was exported.');
      return { panel: currentPanel, index: Number(match[1]), total: Number(match[2]), previous, next };
    }
    async function move(direction, expectedIndex) {
      const before = navigation(), button = before[direction];
      if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true')
        throw new Error('Initial-message navigation ended before every visible slot was visited. No card was exported.');
      button.click();
      for (let attempt = 0; attempt < 20; attempt++) {
        await wait(100);
        const after = navigation();
        if (after.index === expectedIndex && after.total === before.total) {
          // Allow the accordion's rendered message to update with its counter.
          await wait(100);
          return after;
        }
      }
      throw new Error('The initial message did not change after navigation. No card was exported.');
    }
    const initial = navigation();
    let nav = initial;
    while (nav.index > 1) nav = await move('previous', nav.index - 1);
    const greetings = [], emptySlots = [];
    for (let slot = 1; slot <= nav.total; slot++) {
      const greeting = content(nav.panel, 'INITIAL MESSAGES');
      if (greeting) greetings.push(greeting); else emptySlots.push(slot);
      if (slot < nav.total) nav = await move('next', slot + 1);
    }
    if (nav.total > 1 && (!nav.next || (!nav.next.disabled && nav.next.getAttribute('aria-disabled') !== 'true')))
      throw new Error('The final initial-message slot could not be confirmed. No card was exported.');
    // Restore the user's initial message selection with the same ordinary UI.
    while (nav.index > initial.index) nav = await move('previous', nav.index - 1);
    const heading = doc.querySelector('h2.chakra-heading') || doc.querySelector('h1');
    return buildCard({ url, name: heading?.innerText ?? heading?.textContent, personality, scenario, examples, greetings,
      greetingSlots: initial.total, emptyGreetingSlots: emptySlots.length });
  }

  async function run(options = {}) {
    const card = await collect(options);
    const body = JSON.stringify(card, null, 2);
    if (new TextEncoder().encode(body).length > 6 * 1024 * 1024) throw new Error('The rendered card exceeds the 6 MB import limit. No card was exported.');
    const objectUrl = host.URL.createObjectURL(new host.Blob([body], { type: 'application/json' }));
    const anchor = host.document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = `${card.data.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100) || 'janitor-character'}.json`;
    host.document.body.append(anchor);
    anchor.click();
    anchor.remove();
    host.setTimeout(() => host.URL.revokeObjectURL(objectUrl), 1000);
    return card;
  }
  return { canonicalSource, buildCard, collect, run };
}

// This string contains the self-contained exporter, not a remote script loader.
export const publicPageExportBookmarklet = 'javascript:' + encodeURIComponent(
  `(${createPublicPageExporter.toString()})(globalThis).run().catch(error => globalThis.alert(error.message || String(error)));`
);
