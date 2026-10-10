// src/frontend.ts
function setup(ctx) {
  const tab = ctx.ui.registerDrawerTab({ id: "jar", title: "Janitor Import", shortName: "Janitor", keywords: ["jar", "janitor", "import", "lorebook", "card"] });
  const root = document.createElement("section");
  root.className = "jar-panel";
  tab.root.append(root);
  const removeStyle = ctx.dom.addStyle(`.jar-panel{padding:16px;display:grid;gap:12px;font:inherit;color:inherit;overflow-wrap:anywhere}.jar-panel h2,.jar-panel h3{margin:4px 0}.jar-panel label{display:grid;gap:5px}.jar-panel input,.jar-panel select,.jar-panel textarea,.jar-panel button{font:inherit;color:inherit;border:1px solid #8886;border-radius:8px;padding:9px;background:transparent;box-sizing:border-box;max-width:100%}.jar-panel button{cursor:pointer}.jar-panel button:disabled{opacity:.45;cursor:wait}.jar-panel textarea{width:100%;min-height:130px}.jar-panel .jar-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.jar-panel .jar-check{display:flex;align-items:center;gap:8px}.jar-panel details{border:1px solid #8884;border-radius:10px;padding:10px}.jar-panel summary{cursor:pointer}.jar-panel pre{white-space:pre-wrap;max-height:280px;overflow:auto;font-size:12px}.jar-panel img{width:64px;height:64px;object-fit:cover;border-radius:10px}.jar-panel .jar-status{padding:10px;border-left:3px solid #a98be9;background:#a98be910;white-space:pre-wrap}.jar-panel .jar-entry{display:grid;grid-template-columns:auto 1fr;gap:8px;padding:8px 0;border-bottom:1px solid #8883}.jar-panel .jar-entry p{margin:3px 0;font-size:.9em;opacity:.8;white-space:pre-wrap;max-height:100px;overflow:auto}`);
  const pending = new Map;
  let disposed = false, busy = false, jarReady = false, janitorReady = false, selected = null, lastExport = null, prompt = null;
  const jobsKey = "jar_companion_pending_job";
  const node = (tag, text = "") => {
    const el = document.createElement(tag);
    el.textContent = text;
    return el;
  };
  const status = node("div", "Choose a character source.");
  status.className = "jar-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  root.append(status);
  function request(action, payload = {}) {
    if (disposed)
      return Promise.reject(new Error("JAR panel closed"));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("Request timed out. Refresh before retrying an import; completed records are reused."));
      }, 10 * 60000);
      pending.set(requestId, { resolve, reject, timer });
      ctx.sendToBackend({ type: "jar_request", requestId, action, ...payload });
    });
  }
  const unsubscribe = ctx.onBackendMessage((raw) => {
    const msg = raw;
    if (msg?.type !== "jar_reply")
      return;
    const item = pending.get(msg.requestId);
    if (!item)
      return;
    clearTimeout(item.timer);
    pending.delete(msg.requestId);
    msg.error ? item.reject(new Error(msg.error)) : item.resolve(msg.result);
  });
  const buttons = [];
  function button(text, fn, parent = root, requiresJar = false) {
    const el = node("button", text);
    el.type = "button";
    buttons.push(el);
    parent.append(el);
    if (requiresJar)
      el.dataset.requiresJar = "true";
    el.disabled = requiresJar && !jarReady;
    el.addEventListener("click", () => {
      run(fn);
    });
    return el;
  }
  async function run(fn) {
    if (busy)
      return;
    busy = true;
    for (const b of buttons)
      b.disabled = true;
    try {
      await fn();
    } catch (e) {
      status.textContent = e.message || String(e);
    } finally {
      busy = false;
      for (const b of buttons)
        b.disabled = !!b.dataset.unavailable || !!b.dataset.requiresJar && !jarReady;
    }
  }
  function field(parent, label, type = "text", value = "") {
    const wrap = node("label", label), input = node("input");
    input.type = type;
    input.value = value;
    wrap.append(input);
    parent.append(wrap);
    return input;
  }
  function details(title, open = false) {
    const d = node("details");
    d.open = open;
    d.append(node("summary", title));
    root.append(d);
    return d;
  }
  const browserFlow = details("Janitor URL · no JAR", true);
  const publicUrl = field(browserFlow, "JanitorAI character URL (public content only)", "url");
  const loginRequired = "Direct fetching is unavailable: this version has no JanitorAI login connector for Lumiverse. Signing into the website cannot enable this fetch. Connect JAR below and use JAR capture instead.";
  const browserLoginHelp = "A Janitor login is connected to Lumiverse. Fetching can still omit public fields or encounter a browser check.";
  const loginPrompt = node("p", "Checking Janitor login connection…");
  loginPrompt.className = "jar-status";
  loginPrompt.setAttribute("role", "note");
  browserFlow.append(loginPrompt);
  const loginLinks = node("div");
  loginLinks.className = "jar-row";
  const browserLogin = node("a", "Open JanitorAI website");
  browserLogin.href = "https://janitorai.com/login";
  browserLogin.target = "_self";
  browserLogin.rel = "noreferrer";
  loginLinks.append(browserLogin);
  const characterPage = node("a", "Open character page");
  characterPage.target = "_self";
  characterPage.rel = "noreferrer";
  loginLinks.append(characterPage);
  browserFlow.append(loginLinks);
  browserFlow.append(node("p", "Website links may leave Lumiverse. Return here afterward. They open the website only and do not connect a login."));
  for (const link of [browserLogin, characterPage]) {
    link.style.display = "inline-block";
    link.style.padding = "8px";
    link.style.marginRight = "8px";
    link.style.marginBottom = "8px";
    link.style.border = "1px solid #a98be980";
    link.style.borderRadius = "8px";
    link.style.textDecoration = "underline";
  }
  function updateCharacterLink() {
    try {
      const value = new URL(publicUrl.value.trim());
      const match = value.pathname.match(/^\/characters\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[^/]*)?\/?$/i);
      if (value.protocol !== "https:" || !["janitorai.com", "www.janitorai.com"].includes(value.hostname) || value.port || value.username || value.password || !match)
        throw new Error;
      characterPage.href = `https://janitorai.com/characters/${match[1].toLowerCase()}`;
      characterPage.removeAttribute("aria-disabled");
      characterPage.title = "Open this character in your JanitorAI browser";
    } catch {
      characterPage.removeAttribute("href");
      characterPage.setAttribute("aria-disabled", "true");
      characterPage.title = "Enter a valid JanitorAI character URL first";
    }
  }
  publicUrl.addEventListener("input", updateCharacterLink);
  publicUrl.addEventListener("change", updateCharacterLink);
  updateCharacterLink();
  function showIncompleteFetch() {
    loginPrompt.textContent = "The request did not return the complete character. Use the JAR connection to inspect or capture the missing fields.";
    loginPrompt.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  const publicFetchButton = button("Fetch character · unavailable", async () => {
    if (!await checkJanitorAccess())
      throw new Error(loginRequired);
    selected = null;
    list.value = "";
    selections.clear();
    previewRoot.replaceChildren();
    updateImportAvailability();
    status.textContent = publicResult.textContent = "Requesting public content…";
    try {
      const data = await request("publicFetch", { url: publicUrl.value });
      renderPreview(data);
      await refresh(data.id, false);
      const missingFields = data.card ? [!String(data.card.description || data.card.personality || "").trim() && "personality", !String(data.card.first_mes || "").trim() && "greeting"].filter(Boolean) : [];
      loginPrompt.textContent = browserLoginHelp;
      publicResult.textContent = data.card ? missingFields.length ? `Public fields loaded, but no ${missingFields.join(" or ")} was returned. Use JAR for the missing fields.` : "Public personality and greetings loaded. Review them below, then import." : data.starterCard ? `Public profile loaded${data.publicProfile?.firstMessage ? " with a greeting" : "; no public greeting was returned"}. ${data.publicDefinitionDeclared ? "The definition is public, but this request omitted its fields." : "The definition was not returned."} Use JAR to inspect or capture the definition.` : "Metadata loaded; no character definition, public starter text, or greetings are available. Review any World Books below.";
      if (!data.card || missingFields.length)
        showIncompleteFetch();
      else
        previewRoot.scrollIntoView({ block: "start", behavior: "smooth" });
    } catch (e) {
      publicResult.textContent = e.message || String(e);
      if (await checkJanitorAccess()) {
        if (/sign-in|sign in|browser|cloudflare|session|definition/i.test(publicResult.textContent))
          showIncompleteFetch();
      }
      throw e;
    }
  }, browserFlow);
  publicFetchButton.dataset.unavailable = "true";
  publicFetchButton.disabled = true;
  const publicResult = node("p");
  publicResult.setAttribute("role", "status");
  publicResult.setAttribute("aria-live", "polite");
  browserFlow.append(publicResult);
  function setJanitorAccess(connected, error = "") {
    janitorReady = connected;
    if (connected)
      delete publicFetchButton.dataset.unavailable;
    else
      publicFetchButton.dataset.unavailable = "true";
    publicFetchButton.disabled = busy || !connected;
    publicFetchButton.textContent = connected ? "Fetch character" : "Fetch character · unavailable";
    loginPrompt.textContent = connected ? browserLoginHelp : error ? `${loginRequired} ${error}` : loginRequired;
  }
  async function checkJanitorAccess() {
    setJanitorAccess(false);
    try {
      const janitor = await request("janitorStatus");
      setJanitorAccess(janitor.connected === true);
    } catch (e) {
      setJanitorAccess(false, e.message || "The login connection could not be checked.");
    }
    return janitorReady;
  }
  const connection = details("Optional JAR connection");
  const url = field(connection, "Companion URL (reachable from the Lumiverse server)", "url", "http://127.0.0.1:4577");
  const workspaceUrl = field(connection, "Full workspace URL (reachable from this browser; optional)", "url");
  workspaceUrl.placeholder = "https://jar.your-domain.example";
  const token = field(connection, "Companion token (stored encrypted by Lumiverse)", "password");
  token.autocomplete = "off";
  button("Save and test connection", async () => {
    await request("saveConfig", { url: url.value, workspaceUrl: workspaceUrl.value, token: token.value });
    token.value = "";
    updateWorkspaceLink();
    jarReady = true;
    status.textContent = "Connected. Sign into JanitorAI on the companion machine, then inspect a character.";
    connection.open = false;
    await refresh();
  }, connection);
  const native = node("a", "Open full JAR workspace");
  native.target = "_self";
  native.rel = "noreferrer";
  native.href = "http://127.0.0.1:4577/pair";
  connection.append(native);
  connection.append(node("p", "The workspace link may leave Lumiverse. Return here afterward."));
  function updateWorkspaceLink() {
    try {
      const u = new URL(workspaceUrl.value.trim() || url.value);
      if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.pathname !== "/" || u.search || u.hash)
        throw new Error("Invalid workspace origin");
      native.href = u.origin + "/pair";
      native.removeAttribute("aria-disabled");
    } catch {
      native.removeAttribute("href");
      native.setAttribute("aria-disabled", "true");
    }
  }
  url.addEventListener("change", updateWorkspaceLink);
  workspaceUrl.addEventListener("change", updateWorkspaceLink);
  connection.append(node("p", "Pairing authorizes a connection to JAR on another device. The companion URL must be reachable by the Lumiverse server. Set a separate workspace URL when your phone/browser reaches JAR through a different address. Pairing does not create a network tunnel. JanitorAI sign-in stays on the JAR device."));
  connection.append(node("p", "The full workspace has advanced capture controls, Saucepan, source editing, script reconstruction, and all JAR exports. Enter the same companion token there."));
  const capture = details("JAR capture · companion required");
  button("Sign into JanitorAI", async () => {
    const r = await job("login");
    status.textContent = r.loggedIn ? "JanitorAI sign-in confirmed." : "Finish signing into the browser window, then retry sign-in to verify.";
  }, capture, true);
  const characterUrl = field(capture, "JanitorAI character URL");
  button("Inspect character", async () => {
    const r = await job("inspect", { url: characterUrl.value });
    await refresh(r.id);
  }, capture, true);
  const custom = field(capture, "Extra capture keywords (optional)");
  button("Capture hidden definition and triggered lore", async () => {
    if (!selected || selected.id.startsWith("local-"))
      throw new Error("Select a character inspected with JAR first.");
    await job("capture", { id: selected.id, force: !!custom.value, trigger: { customText: custom.value } });
    await load(selected.id);
  }, capture, true);
  capture.append(node("p", "Capture opens JAR’s browser and sends probe messages using your JanitorAI account. More keywords can trigger more entries; reconstruction cannot guarantee a complete original lorebook."));
  const row = node("div");
  row.className = "jar-row";
  root.append(row);
  const list = node("select");
  list.setAttribute("aria-label", "Import source");
  row.append(list);
  button("Refresh sources", async () => refresh(), row);
  list.addEventListener("change", () => {
    if (list.value)
      run(() => load(list.value));
    else {
      selected = null;
      selections.clear();
      previewRoot.replaceChildren();
      updateImportAvailability();
      status.textContent = "Select an import source or load a new one.";
    }
  });
  const previewRoot = node("div");
  root.append(previewRoot);
  const selections = new Map;
  const importCharacter = node("input");
  importCharacter.type = "checkbox";
  importCharacter.checked = true;
  const importAvatar = node("input");
  importAvatar.type = "checkbox";
  importAvatar.checked = true;
  function check(parent, text, input) {
    const label = node("label", text);
    label.className = "jar-check";
    label.prepend(input);
    parent.append(label);
  }
  function updateImportAvailability() {
    const available = selected && (importCharacter.checked && !importCharacter.disabled || [...selections.values()].some((inputs) => inputs.some((input) => input.checked)));
    if (available)
      delete importButton.dataset.unavailable;
    else
      importButton.dataset.unavailable = "true";
    importButton.disabled = busy || !available;
  }
  importCharacter.addEventListener("change", updateImportAvailability);
  function readablePublicProfile(value) {
    if (!/<\/?(?:div|p|span|br|h[1-6]|strong|em|img|style|section|article|ul|ol|li|table)\b/i.test(value))
      return value;
    const template = node("template");
    template.innerHTML = value;
    template.content.querySelectorAll("script,style,noscript,template").forEach((element) => element.remove());
    template.content.querySelectorAll("br").forEach((element) => element.replaceWith(`
`));
    template.content.querySelectorAll("div,p,h1,h2,h3,h4,h5,h6,section,article,li,tr").forEach((element) => element.append(`
`));
    return (template.content.textContent || "").trim();
  }
  function renderPreview(data) {
    selected = data;
    prompt = null;
    promptArea.value = "";
    selections.clear();
    previewRoot.replaceChildren();
    raw.disabled = data.id.startsWith("local-");
    if (raw.disabled)
      raw.checked = false;
    previewRoot.append(node("h3", data.characterName || "Capture preview"));
    if (/^data:image\/(png|jpeg|webp|gif);base64,/.test(data.avatar)) {
      const img = node("img");
      img.src = data.avatar;
      img.alt = data.source === "janitor-public" ? "Public avatar" : "Captured avatar";
      previewRoot.append(img);
    }
    const starterOnly = !data.card && !!data.starterCard;
    if (data.publicProfile) {
      const profile = node("details");
      profile.open = true;
      profile.append(node("summary", data.publicProfile.firstMessage ? "Public profile and greetings" : "Public profile"));
      if (data.publicProfile.creator)
        profile.append(node("p", `Creator: ${data.publicProfile.creator}`));
      if (data.publicProfile.tags?.length)
        profile.append(node("p", `Tags: ${data.publicProfile.tags.join(", ")}`));
      if (data.publicProfile.description)
        profile.append(node("h4", "Public profile text"), node("pre", readablePublicProfile(data.publicProfile.description)));
      if (data.publicProfile.firstMessage)
        profile.append(node("h4", "First greeting"), node("pre", data.publicProfile.firstMessage));
      else if (!data.card)
        profile.append(node("p", "No greeting was returned by the direct request. Use JAR to read the available messages."));
      for (const [index, greeting] of (data.publicProfile.alternateGreetings || []).entries())
        profile.append(node("h4", `Alternate greeting ${index + 1}`), node("pre", greeting));
      previewRoot.append(profile);
    }
    if (starterOnly)
      previewRoot.append(node("p", "This starter contains only the returned profile text and greetings. The definition is missing. Use JAR to capture it, or explicitly select this incomplete starter."));
    if (data.card) {
      const fields = node("details");
      fields.open = true;
      fields.append(node("summary", "Definition and greetings"));
      const definition = [data.card.description, data.card.personality].filter(Boolean).join(`

`);
      if (definition)
        fields.append(node("h4", "Character definition"), node("pre", definition));
      if (data.card.first_mes)
        fields.append(node("h4", "First greeting"), node("pre", data.card.first_mes));
      for (const [index, greeting] of (data.card.alternate_greetings || []).entries())
        fields.append(node("h4", `Alternate greeting ${index + 1}`), node("pre", greeting));
      previewRoot.append(fields);
    }
    check(previewRoot, starterOnly ? "Import public starter card (incomplete)" : "Import character (reuses an earlier import; preserves its edited fields)", importCharacter);
    importCharacter.disabled = !data.card && !data.starterCard;
    importCharacter.checked = !!data.card;
    check(previewRoot, "Assign available avatar", importAvatar);
    importAvatar.disabled = !data.avatar;
    importAvatar.checked = !!data.avatar;
    if (data.card || data.starterCard) {
      const pre = node("pre", JSON.stringify(data.card || data.starterCard, null, 2));
      const d = node("details");
      d.append(node("summary", starterOnly ? "Public starter card fields" : "Character fields"), pre);
      previewRoot.append(d);
    } else
      previewRoot.append(node("p", data.cardError));
    for (const book of data.books) {
      const d = node("details");
      d.open = true;
      d.append(node("summary", `${book.name} · ${book.entries.length} entries${book.reconstructed ? " · reconstructed" : ""}`));
      const inputs = [];
      const choose = node("div");
      choose.className = "jar-row";
      for (const [text, checked] of [["Select all", true], ["Select none", false]]) {
        const b = node("button", text);
        b.type = "button";
        b.addEventListener("click", () => {
          for (const input of inputs)
            input.checked = checked;
          updateImportAvailability();
        });
        choose.append(b);
      }
      d.append(choose);
      for (const [index, entry] of book.entries.entries()) {
        const label = node("label");
        label.className = "jar-entry";
        const input = node("input");
        input.type = "checkbox";
        input.checked = true;
        inputs[index] = input;
        input.addEventListener("change", updateImportAvailability);
        const keys = entry.key || entry.keys || [];
        const text = node("span");
        text.append(node("strong", entry.comment || entry.title || `Entry ${index + 1}`), node("p", `Keys: ${Array.isArray(keys) ? keys.join(", ") : keys}`), node("p", entry.content || ""));
        label.append(input, text);
        d.append(label);
      }
      selections.set(book.key, inputs);
      previewRoot.append(d);
    }
    const warnings = (data.warnings || []).map((warning) => /public-page export|supplied card/i.test(warning) ? "Definition fields were omitted by this request. Use JAR to inspect or capture the character." : warning);
    for (const warning of new Set(warnings))
      previewRoot.append(node("p", warning));
    for (const book of data.unavailableBooks || [])
      previewRoot.append(node("p", `${book.title || "Attached World Book"}: ${book.reason}`));
    if (!data.books.length)
      previewRoot.append(node("p", "No World Book entries in this source."));
    status.textContent = starterOnly ? `Public starter preview: ${data.characterName}. ${data.publicDefinitionDeclared ? "Definition is public, but its fields were omitted by this request." : "Definition not included."} Use JAR for the definition, or select this incomplete starter.` : !data.card && !data.books.length && !data.hasLoreText ? "Metadata only. This source has no importable character fields or World Book entries." : `Preview ready: ${data.books.length} World Book(s). Select content, then import.`;
    updateImportAvailability();
  }
  async function load(id) {
    renderPreview(await request("preview", { captureId: id }));
  }
  async function refresh(id, includeJar = true) {
    const records = (await request("localList")).filter((record) => record.source === "janitor-public");
    const chosen = id || list.value;
    if (jarReady && includeJar) {
      try {
        records.push(...await request("list"));
      } catch (e) {
        jarReady = false;
        status.textContent = `JAR unavailable. ${e.message}`;
      }
    }
    list.replaceChildren(node("option", "Select an import source"));
    list.options[0].value = "";
    for (const rec of records) {
      const o = node("option", rec.characterName || rec.id);
      o.value = rec.id;
      list.append(o);
    }
    if (chosen && records.some((r) => r.id === chosen)) {
      list.value = chosen;
      await load(chosen);
    } else if (!records.length)
      status.textContent = janitorReady ? "Fetch a Janitor character or inspect one with JAR." : "Connect JAR below, then inspect a character to begin.";
  }
  async function waitJob(jobId) {
    sessionStorage.setItem(jobsKey, jobId);
    while (!disposed) {
      let value;
      try {
        value = await request("poll", { jobId });
      } catch (e) {
        if (/expired|restarted/i.test(e.message))
          sessionStorage.removeItem(jobsKey);
        throw e;
      }
      if (value.state === "failed") {
        sessionStorage.removeItem(jobsKey);
        throw new Error(value.error);
      }
      if (value.state === "succeeded") {
        sessionStorage.removeItem(jobsKey);
        return value.result;
      }
      status.textContent = `JAR ${value.operation}: waiting for completion. Finish any sign-in or Cloudflare check on the companion machine.`;
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    throw new Error("Panel closed; the companion job continues.");
  }
  async function job(operation, input = {}) {
    const result = await request("job", { operation, input });
    return waitJob(result.id);
  }
  const lumi = details("Reconstruct captured lore with Lumi");
  const raw = node("input");
  raw.type = "checkbox";
  check(lumi, "Use full raw prompt for advanced scripts (may include character context)", raw);
  const promptArea = node("textarea");
  promptArea.readOnly = true;
  promptArea.setAttribute("aria-label", "Reconstruction prompt");
  button("Preview what Lumi will receive", async () => {
    if (!selected || selected.id.startsWith("local-"))
      throw new Error("Select a JAR capture to reconstruct its lore.");
    const r = await job("preview", { id: selected.id, fromRaw: raw.checked });
    prompt = r.messages;
    promptArea.value = JSON.stringify(prompt, null, 2);
    status.textContent = "Review the prompt. Reconstruct sends it to your default Lumiverse connection and uses its tokens.";
  }, lumi);
  lumi.append(promptArea);
  button("Reconstruct with default Lumi connection", async () => {
    if (!selected || !prompt)
      throw new Error("Preview the reconstruction prompt first.");
    const id = selected.id;
    status.textContent = "Lumi is reconstructing lore…";
    renderPreview(await request("reconstruct", { captureId: id, messages: prompt }));
  }, lumi);
  const importButton = button("Import selected content into Lumiverse", async () => {
    if (!selected)
      throw new Error("Select a capture first.");
    const books = Object.fromEntries([...selections].map(([key, inputs]) => [key, inputs.flatMap((input, index) => input.checked ? [index] : [])]));
    status.textContent = "Importing selected content…";
    const result = await request("import", { captureId: selected.id, character: importCharacter.checked && !importCharacter.disabled, characterMode: !selected.card && selected.starterCard ? "public-starter" : "definition", avatar: importAvatar.checked, books });
    status.textContent = result.message;
  });
  updateImportAvailability();
  const conversations = details("JAR conversation export · companion required");
  const chatUrl = field(conversations, "JanitorAI chat or message URL");
  button("Fetch conversation export", async () => {
    lastExport = await job("chatExport", { chat: chatUrl.value });
    status.textContent = `${lastExport.messageCount} messages ready. Download JSONL, then use Lumiverse’s chat importer for the matching character.`;
  }, conversations, true);
  function download(filename, value, mime) {
    const href = URL.createObjectURL(new Blob([value], { type: mime }));
    const a = node("a");
    a.href = href;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }
  button("Download chat JSONL", async () => {
    if (!lastExport)
      throw new Error("Fetch a conversation first.");
    download(`jar-${lastExport.chatId}.jsonl`, lastExport.jsonl, "application/jsonl");
  }, conversations);
  button("Download raw chat JSON", async () => {
    if (!lastExport)
      throw new Error("Fetch a conversation first.");
    download(`jar-${lastExport.chatId}.json`, JSON.stringify(lastExport.raw, null, 2), "application/json");
  }, conversations);
  conversations.append(node("p", "JSONL preserves alternate replies as swipes. Staging currently requires its built-in importer to create the chat."));
  run(async () => {
    await checkJanitorAccess();
    const config = await request("config");
    url.value = config.url;
    workspaceUrl.value = config.workspaceUrl || "";
    updateWorkspaceLink();
    await refresh(undefined, false);
    if (!config.hasToken)
      return;
    try {
      await request("health");
      jarReady = true;
      connection.open = false;
      await refresh();
    } catch (e) {
      jarReady = false;
      status.textContent = `JAR is unavailable. ${e.message}`;
      return;
    }
    const jobId = sessionStorage.getItem(jobsKey);
    if (jobId) {
      await waitJob(jobId);
      await refresh();
      status.textContent = "Previous JAR job completed. Refresh or select its capture.";
    }
  });
  return () => {
    disposed = true;
    unsubscribe();
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Extension unloaded"));
    }
    pending.clear();
    removeStyle();
    tab.destroy();
  };
}
export {
  setup
};
