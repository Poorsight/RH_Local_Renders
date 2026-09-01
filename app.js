(() => {
  const $ = (id) => document.getElementById(id);
  const CLOSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>';
  const state = { status: null, models: [], metadata: null, materialAssets: [], renderEnvironment: "ue56", renderEnvironments: [], preflight: null, preflightTimer: null, batch: [], model: null, jobPath: null, poll: null, history: [], historyBatch: null, historySelection: new Set(), historyModel: null, galleryBatch: null, galleryMaterialIndex: 0, queueFocus: null, jobQueue: { state: "idle", items: [], pendingCount: 0, failedCount: 0 }, jobSelectionMode: false, selectedJobs: new Set() };
  const LOCAL_MODELS_ROOT = "D:\\GitHub\\RH_Local_Renders\\local\\models";
  const THEME_KEY = "rh-local-renders-theme";
  const THEME_CHROME = { light: "#dadada", dark: "#242424" };
  const applyTheme = (theme, remember = false) => {
    const allowed = ["light", "system", "dark"], value = allowed.includes(theme) ? theme : "system";
    document.documentElement.dataset.theme = value;
    document.querySelectorAll("[data-theme-value]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.themeValue === value)));
    // The media-scoped tags in the markup already follow the device; an explicit choice has
    // to overrule them, or a phone paints its address bar the colour the device asked for
    // while the page shows the other one.
    // Each tag is restored from the role it declares, never from the colour it currently
    // holds: reading the colour back loses the light one the moment both are darkened.
    for (const tag of document.querySelectorAll('meta[name="theme-color"][data-scheme]')) {
      const scheme = tag.dataset.scheme;
      if (value === "system") { tag.content = THEME_CHROME[scheme]; tag.setAttribute("media", `(prefers-color-scheme: ${scheme})`); }
      else { tag.removeAttribute("media"); tag.content = THEME_CHROME[value]; }
    }
    // Storing on every load would turn the default into a decision nobody made.
    if (remember) { try { localStorage.setItem(THEME_KEY, value); } catch {} }
  };
  const settings = {
    read(name) { try { return String(localStorage.getItem(name) || "").trim(); } catch { return ""; } },
    write(name, value) { try { value ? localStorage.setItem(name, value) : localStorage.removeItem(name); } catch {} }
  };
  let ACCESS_KEY = settings.read("rhAccessKey");
  const RENDER_ENVIRONMENT_KEY = "rhRenderEnvironment";
  const normalizeRenderEnvironment = value => String(value || "").toLowerCase().replace(/[\s._-]+/g, "") === "ue58" ? "ue58" : "ue56";
  state.renderEnvironment = normalizeRenderEnvironment(settings.read(RENDER_ENVIRONMENT_KEY));
  const renderEnvironmentProfile = value => state.renderEnvironments.find(environment => environment.id === normalizeRenderEnvironment(value))
    || { id: normalizeRenderEnvironment(value), label: normalizeRenderEnvironment(value) === "ue58" ? "UE 5.8 Beta" : "UE 5.6", engineVersion: normalizeRenderEnvironment(value) === "ue58" ? "5.8" : "5.6", beta: normalizeRenderEnvironment(value) === "ue58", available: true };
  const renderEnvironmentLabel = value => renderEnvironmentProfile(value).label;
  const renderEnvironmentBadge = value => normalizeRenderEnvironment(value) === "ue58"
    ? '<i class="environment-badge" aria-label="Unreal Engine 5.8 beta job">UE 5.8 · BETA</i>'
    : "";
  const syncRenderEnvironment = () => {
    const profile = renderEnvironmentProfile(state.renderEnvironment);
    document.documentElement.dataset.renderEnvironment = profile.id;
    document.querySelectorAll("button[data-render-environment]").forEach(button => {
      const environment = renderEnvironmentProfile(button.dataset.renderEnvironment), selected = environment.id === profile.id;
      button.setAttribute("aria-pressed", String(selected));
      button.dataset.available = String(environment.available !== false);
      button.title = `${environment.label} · ${environment.description || (environment.available === false ? "Not available" : "Render environment")}`;
    });
    $("shadowPipelineNote").textContent = profile.id === "ue58"
      ? "Fabric and Shadow run with Substrate enabled in separate Unreal processes. UE 5.8 uses the native Composite shadow alpha before previews, crop measurement, and delivery processing; no UE 5.6 LUT recovery is applied."
      : "Fabric and Shadow run with Substrate enabled in separate Unreal processes. UE 5.6 converts Legacy Composure Shadow RGB to visible alpha before previews, crop measurement, and delivery processing.";
    if (state.status) $("unrealState").textContent = profile.available === false ? "MISSING" : profile.beta ? "BETA READY" : "READY";
  };
  const API_BASE = (() => {
    const clean = value => String(value || "").trim().replace(/\/+$/, "");
    // Order matters. A deployed config.js carries the address of the tunnel that is up right
    // now, so it has to beat whatever this browser remembered from a tunnel that is gone.
    try {
      const asked = clean(new URLSearchParams(location.search).get("api"));
      if (asked) { localStorage.setItem("rhApiBase", asked); return asked; }
    } catch {}
    const deployed = clean(window.RH_API_BASE);
    if (deployed) return deployed;
    try { return clean(localStorage.getItem("rhApiBase")); } catch { return ""; }
  })();
  // A page on this machine can always reach the service; a page served from anywhere else
  // can too, but only once it has been told where the service lives.
  const canReachLocalService = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname) || Boolean(API_BASE);
  // Relative while the page and the service share an origin, absolute once the page is
  // served from somewhere else. Everything the server hands back is origin-relative.
  const apiUrl = path => API_BASE && String(path || "").startsWith("/") ? `${API_BASE}${path}` : path;
  const api = async (path, options = {}) => {
    const headers = { "Content-Type": "application/json", ...(ACCESS_KEY ? { Authorization: `Bearer ${ACCESS_KEY}` } : {}), ...(options.headers || {}) };
    const response = await fetch(apiUrl(path), { ...options, headers });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body;
  };
  const toast = (message, error = false) => {
    const node = $("toast"); node.textContent = message; node.className = `toast show${error ? " error" : ""}`;
    clearTimeout(toast.timer); toast.timer = setTimeout(() => node.className = "toast", 3200);
  };
  const setConnection = (online) => {
    const node = $("connection"); node.dataset.state = online ? "online" : "offline";
    if (API_BASE) node.title = `Service: ${API_BASE}`;
    node.lastChild.textContent = online ? "Local service online" : "Open with npm start for render controls";
  };
  const selected = (name) => [...document.querySelectorAll(`input[name=${name}]:checked`)].map(node => node.value);
  const materialRows = () => [...document.querySelectorAll("[data-material-group]")].map(row => ({
    meshes: JSON.parse(row.dataset.materialIds || "[]"),
    materials: [...row.querySelectorAll("[data-material-key]")].map(input => input.value.trim()),
    multiply: row.querySelector("[data-material-multiply]")?.getAttribute("aria-pressed") === "true"
  }));
  const materialInputs = () => [...document.querySelectorAll("[data-material-key]")];
  const materialAssignmentsReady = () => materialRows().length > 0 && materialRows().every(row => row.materials.length > 0 && row.materials.every(Boolean));
  const materialAsset = name => state.materialAssets.find(asset => asset.name.toLowerCase() === String(name || "").trim().toLowerCase());
  const normalizedMaterialId = id => {
    const value = String(id || ""), last = value.split(/[:_]/).filter(Boolean).pop() || value;
    return last.replace(/\d/g, "") || last;
  };
  const sectionalFormFactor = (name, side = "") => {
    const modelName = String(name || "").toUpperCase(), recorded = String(side || "").toUpperCase();
    if (/(?:^|_)U(?:_|$)/.test(modelName) || modelName.includes("U_SECTIONAL") || modelName.includes("U_CHAISE")) return "U";
    if (/(?:^|_)RIGHT_ARM(?:_|$)/.test(modelName)) return "R";
    if (/(?:^|_)LEFT_ARM(?:_|$)/.test(modelName)) return "L";
    if (recorded === "R" || recorded.includes("RIGHT")) return "R";
    if (recorded === "L" || recorded.includes("LEFT")) return "L";
    if (recorded === "U" || recorded.includes("U_SHAPE") || recorded.includes("U_SECTIONAL") || recorded.includes("U_CHAISE")) return "U";
    return "UNKNOWN";
  };
  const sideFromModel = () => {
    const value = $("sceneSide").value;
    if (value !== "auto") return value;
    const label = state.historyModel?.side || state.model?.side || "";
    return ["R", "L", "U"].includes(label) ? label : "R";
  };
  const payload = () => ({
    modelPath: state.model.path,
    models: state.batch.map(model => ({ modelPath: model.path, dimensions: model.dimensions, importYaw: model.importYaw })),
    category: $("category").value,
    renderEnvironment: state.renderEnvironment,
    // The dropdown decides what is being rendered; the folder a model sits in is evidence,
    // and preflight says so when the two disagree.
    productType: String($("category").value || "Sectionals").toLowerCase(),
    environment: $("environment").value,
    side: $("sceneSide").value, renderProfile: selected("renderProfile")[0] || "high", cropMode: selected("cropMode")[0] || "full",
    resolutions: frameOverrides(),
    dimensions: { width: +$("width").value, depth: +$("depth").value, height: +$("height").value },
    importYaw: +$("importYaw").value || 0,
    cameras: selected("camera"), layers: selected("layer"), materials: materialRows()
  });
  // Only the optimized mode keeps saved crops, so only there is there anything to drop.
  const syncCropActions = () => {
    const optimized = (selected("cropMode")[0] || "full") === "optimized";
    $("remeasureCrops").hidden = !optimized || !state.batch.length;
  };
  const remeasureCrops = async () => {
    const button = $("remeasureCrops");
    button.disabled = true; button.textContent = "Clearing…";
    try {
      const result = await api("/api/crops/forget", { method: "POST", body: JSON.stringify({
        models: state.batch.map(model => model.path) }) });
      toast(result.dropped
        ? `${result.dropped} saved crop${result.dropped === 1 ? "" : "s"} cleared for ${state.batch.length} model${state.batch.length === 1 ? "" : "s"}; the next run measures them again`
        : "Nothing saved for these models — the next run measures everything anyway");
      state.jobPath = null; $("jobResult").hidden = true;
      await refreshPreflight(); validate(false);
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; button.textContent = "Clear saved crops"; }
  };
  const syncLaunchAction = basicReady => {
    const button = $("launchRender"), queue = state.jobQueue || { state: "idle", items: [] }, count = queue.items?.length || 0;
    if (count) {
      const failed = queue.items.some(item => ["failed", "paused"].includes(item.state));
      button.textContent = queue.state === "running" ? `Queue running · ${count} left` : failed ? "Queue needs attention" : `Start queue · ${count} job${count === 1 ? "" : "s"}`;
      button.disabled = queue.state === "running" || failed;
      return;
    }
    button.textContent = "Launch render";
    button.disabled = !state.jobPath && !basicReady;
  };
  const syncActionButtons = basicReady => {
    const ready = basicReady && state.preflight?.ok === true;
    $("generateJob").disabled = !ready;
    syncLaunchAction(ready);
    syncCropActions();
  };
  const renderPreflight = result => {
    const panel = $("preflight"), checks = result?.checks || [];
    panel.dataset.state = result?.waiting ? "idle" : !result ? "checking" : result.ok ? "ready" : checks.some(check => check.level === "error") ? "error" : "warning";
    $("preflightState").textContent = result?.waiting ? "Waiting for setup" : !result ? "Checking…" : result.ok ? `${result.counts.expectedRenders} renders ready` : `${checks.filter(check => check.level === "error").length} issue${checks.filter(check => check.level === "error").length === 1 ? "" : "s"}`;
    const rank = { error: 0, warning: 1 }, ordered = checks.map((check, index) => ({ check, index }))
      .sort((a, b) => (rank[a.check.level] ?? 2) - (rank[b.check.level] ?? 2) || a.index - b.index).map(item => item.check);
    $("preflightChecks").innerHTML = ordered.length ? ordered.map(check => `<span data-level="${escapeHtml(check.level)}"><b>${escapeHtml(check.label)}</b><small>${escapeHtml(check.detail)}</small></span>`).join("") : `<span>${result?.waiting ? "Add models and material assignments to validate the job." : "Checking models, materials, lights, output, and Unreal…"}</span>`;
  };
  const refreshPreflight = async () => {
    const basicReady = canReachLocalService && state.batch.length > 0 && materialAssignmentsReady() && selected("camera").length && selected("layer").length;
    if (!basicReady) return false;
    renderPreflight(null);
    try { state.preflight = await api("/api/preflight", { method: "POST", body: JSON.stringify(payload()) }); }
    catch (error) { state.preflight = { ok: false, checks: [{ level: "error", label: "Local service", detail: error.message }], counts: { expectedRenders: 0 } }; }
    renderPreflight(state.preflight); syncActionButtons(basicReady); return state.preflight.ok;
  };
  // "Add models and material assignments" is no help once the models are added: it does not say
  // which half is missing. This lists what is actually outstanding.
  const outstanding = () => {
    const missing = [];
    if (!canReachLocalService) missing.push({ label: "Local service", detail: "The service is not answering, so nothing can be checked." });
    if (!state.batch.length) missing.push({ label: "Models", detail: "Drop an FBX or OBJ here, or pick one with Choose model." });
    const fields = materialInputs();
    const blank = fields.filter(node => !node.value.trim()).map(node => String(node.dataset.materialKey || "").toUpperCase());
    if (!fields.length) missing.push({ label: "Materials", detail: "Inspect a model to read its component IDs." });
    else if (blank.length) missing.push({ label: "Materials", detail: `Assign a material to ${blank.join(", ")}.` });
    if (!selected("camera").length) missing.push({ label: "Cameras", detail: "Pick at least one camera." });
    if (!selected("layer").length) missing.push({ label: "Layers", detail: "Pick at least one layer." });
    return missing.map(item => ({ level: "info", ...item }));
  };
  const validate = (runCheck = true) => {
    const ready = canReachLocalService && state.batch.length > 0 && materialAssignmentsReady() && selected("camera").length && selected("layer").length;
    if (!ready) { state.preflight = null; renderPreflight({ waiting: true, ok: false, checks: outstanding(), counts: { expectedRenders: 0 } }); }
    else if (runCheck) {
      state.preflight = null; renderPreflight(null); clearTimeout(state.preflightTimer);
      state.preflightTimer = setTimeout(refreshPreflight, 260);
    }
    if (!ready) state.jobPath = null;
    syncActionButtons(ready);
  };
  const updateMaterialStatus = input => {
    const asset = materialAsset(input.value), status = input.closest(".material-variant")?.querySelector("[data-material-status]");
    input.dataset.assetState = !input.value.trim() ? "empty" : asset ? "found" : "missing";
    if (status) { status.dataset.state = input.dataset.assetState; status.textContent = !input.value.trim() ? "Enter material" : asset ? "Found" : "Missing"; status.title = asset?.path || "No matching .uasset in the Unreal project"; }
  };
  const materialVariantMarkup = (item, value = "") => `<div class="material-variant"><span class="suggest-field"><input data-suggest="materialOptions" data-material-key="${escapeHtml(item.key)}" value="${escapeHtml(value)}" placeholder="Search Unreal materials" autocomplete="off"></span><em data-material-status>Enter material</em><button class="material-remove" type="button" data-remove-material aria-label="Remove material variant" title="Remove material variant">${CLOSE_ICON}</button></div>`;
  const bindMaterialInput = input => { updateMaterialStatus(input); input.addEventListener("input", () => { updateMaterialStatus(input); state.jobPath = null; validate(); }); };
  const syncMaterialGroup = group => {
    const variants = [...group.querySelectorAll(".material-variant")], count = group.querySelector("[data-material-count]");
    variants.forEach(variant => { variant.querySelector("[data-remove-material]").disabled = variants.length === 1; });
    if (count) count.textContent = `${variants.length} material variant${variants.length === 1 ? "" : "s"}`;
  };
  const setMaterialValues = (key, values, multiply = false) => {
    const group = [...document.querySelectorAll("[data-material-group]")].find(node => node.dataset.materialGroup === key);
    if (!group) return;
    const item = { key }, wanted = values?.length ? values : [""];
    const container = group.querySelector("[data-material-variants]");
    container.innerHTML = wanted.map(value => materialVariantMarkup(item, value)).join("");
    const multiplyButton = group.querySelector("[data-material-multiply]");
    if (multiplyButton) multiplyButton.setAttribute("aria-pressed", String(Boolean(multiply)));
    container.querySelectorAll("[data-material-key]").forEach(bindMaterialInput); syncMaterialGroup(group);
  };
  const renderMaterials = () => {
    const previous = new Map([...document.querySelectorAll("[data-material-group]")].map(group => [group.dataset.materialGroup, {
      values: [...group.querySelectorAll("[data-material-key]")].map(input => input.value),
      multiply: group.querySelector("[data-material-multiply]")?.getAttribute("aria-pressed") === "true"
    }]));
    const grouped = new Map();
    state.batch.forEach(model => model.materialIds.forEach(id => {
      const label = normalizedMaterialId(id), key = label.toLowerCase();
      if (!grouped.has(key)) grouped.set(key, { key, label, ids: new Set(), models: new Set() });
      grouped.get(key).ids.add(id); grouped.get(key).models.add(model.path);
    }));
    const rank = { uph: 0, stitches: 1, feet: 2 };
    const ids = [...grouped.values()].sort((left, right) => (rank[left.key] ?? 9) - (rank[right.key] ?? 9) || left.label.localeCompare(right.label));
    $("materialsEmpty").hidden = !!ids.length;
    $("materialsList").innerHTML = ids.map(item => {
      const sourceIds = [...item.ids], modelCount = item.models.size;
      const saved = previous.get(item.key), values = saved?.values?.length ? saved.values : [""];
      return `<div class="material-row" data-material-group="${escapeHtml(item.key)}" data-material-ids="${escapeHtml(JSON.stringify(sourceIds))}"><span class="material-id"><b>${escapeHtml(item.label)}</b><small><span>${modelCount} model${modelCount === 1 ? "" : "s"}</span><span>${sourceIds.length} component ID${sourceIds.length === 1 ? "" : "s"}</span></small></span><div class="material-variants"><div data-material-variants>${values.map(value => materialVariantMarkup(item, value)).join("")}</div><div class="material-variant-actions"><span class="material-action-buttons"><button class="secondary-button material-add" type="button" data-add-material>Add material</button><button class="quiet-button material-multiply" type="button" data-material-multiply aria-pressed="${saved?.multiply ? "true" : "false"}" title="Render this ID independently and multiply it with the other variant lists">Multiply</button></span><small data-material-count></small></div></div></div>`;
    }).join("");
    materialInputs().forEach(bindMaterialInput);
    document.querySelectorAll("[data-material-group]").forEach(group => {
      syncMaterialGroup(group);
    });
  };
  // Checks the models about to be rendered, not the whole library: what matters is whether
  // this batch will come out right.
  const LEVEL_ORDER = { error: 0, warning: 1, info: 2, ok: 3 };
  const checkRowFor = name => (state.modelCheck?.models || []).find(row => row.name === name);
  // A model is as bad as its worst finding, and that is what the batch row shows.
  const checkStateOf = name => {
    const row = checkRowFor(name);
    return !row ? "" : row.errors ? "error" : row.warnings ? "warning" : "ok";
  };
  const needsAttention = () => (state.modelCheck?.models || []).filter(row => row.errors || row.warnings);
  // The batch heading carries the verdict for the whole batch and walks to the next model
  // that wants looking at. Without it a problem far down a long list is invisible.
  const renderCheckSummary = () => {
    const chip = $("checkJump"), report = state.modelCheck;
    chip.hidden = !report;
    if (!report) return;
    const failing = needsAttention();
    // Verdicts come back for the models that have one, so some of the batch may carry none.
    // Saying "All sound" then would be a claim about models nobody has looked at.
    const seen = new Set((report.models || []).map(row => row.name));
    const unchecked = state.batch.filter(model => !seen.has(model.name)).length;
    chip.dataset.state = failing.some(row => row.errors) ? "error" : failing.length ? "warning" : unchecked ? "" : "ok";
    chip.textContent = failing.length ? `${failing.length} to look at` : unchecked ? `${unchecked} not checked` : "All sound";
    chip.disabled = !failing.length;
    chip.title = failing.length ? `Go to ${failing[0].name}`
      : unchecked ? `${seen.size} of ${state.batch.length} checked` : `${seen.size} checked, nothing wrong`;
  };
  // The report is shown for the model in hand. It used to list every model at once, which
  // ran past the bottom of its column and buried the one real problem in a wall of OK.
  const renderModelCheck = () => {
    const panel = $("modelCheck"), report = state.modelCheck;
    const row = report && state.model ? checkRowFor(state.model.name) : null;
    panel.hidden = !row;
    renderCheckSummary();
    $("repairModels").hidden = !(report?.models || []).some(item => (item.findings || []).some(finding => finding.repairable));
    if (!row) return;
    const findings = (row.findings || []).slice().sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
    const worst = findings[0]?.level || "ok";
    panel.dataset.worst = worst;
    $("modelCheckSummary").textContent = row.errors ? "Needs attention" : row.warnings ? "Worth a look" : "Checks out";
    $("modelCheckList").innerHTML = findings.map(finding =>
      `<div class="model-check-finding" data-level="${escapeHtml(finding.level)}"><i>${escapeHtml(finding.level)}</i><span>${escapeHtml(finding.label)}: ${escapeHtml(finding.detail)}</span></div>`).join("");
  };
  const checkModels = async () => {
    const names = state.batch.map(model => model.name);
    if (!names.length) { toast("Add models to the batch first", true); return; }
    const button = $("checkModels");
    button.disabled = true; button.textContent = "Checking…";
    try {
      const report = await api("/api/models/check", { method: "POST", body: JSON.stringify({ models: names }) });
      state.modelCheck = report; renderModelCheck(); renderBatch();
      const kept = report.reused ? ` · ${report.reused} unchanged since the last check` : "";
      toast(report.failing ? `${report.failing} model${report.failing === 1 ? "" : "s"} need attention${kept}` : `All models look sound${kept}`);
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; button.textContent = "Check models"; }
  };
  const repairModels = async () => {
    const names = (state.modelCheck?.models || [])
      .filter(row => (row.findings || []).some(finding => finding.repairable)).map(row => row.name);
    if (!names.length) return;
    const button = $("repairModels");
    button.disabled = true; button.textContent = "Repairing…";
    try {
      const result = await api("/api/models/repair", { method: "POST", body: JSON.stringify({ models: names }) });
      toast(`Repaired ${result.repaired} model${result.repaired === 1 ? "" : "s"}; re-checking`);
      await checkModels();
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; button.textContent = "Repair OBJ parts"; }
  };
  // Sofas are shot from four angles and only ever render Fabric; sectionals from three, with
  // a Shadow pass. Options that belong to the other type are taken off the page rather than
  // left to be ticked into a job that would reject them.
  const applyProductType = () => {
    const type = $("category").value || "Sectionals";
    for (const label of document.querySelectorAll("[data-for-type]")) {
      const allowed = label.dataset.forType.split(",").map(value => value.trim());
      const fits = allowed.includes(type);
      label.hidden = !fits;
      const input = label.querySelector("input");
      if (input && !fits && input.checked) input.checked = false;
      if (input && fits && input.name === "camera" && !input.checked) input.checked = true;
      // A hidden side would still be sent, so it goes back to being read from the model.
      const select = label.querySelector("select");
      if (select && !fits && select.id === "sceneSide") select.value = "auto";
    }
    validate(false);
  };
  // The same frames the server starts from, so the fields show what would be used and a
  // reset puts the profile's numbers back.
  const FRAME_PROFILES = {
    high: { Fabric: { res: [5000, 5000], sensor: [36, 36] }, Shadow: { res: [15000, 5000], sensor: [108, 36] } },
    low: { Fabric: { res: [500, 500], sensor: [36, 36] }, Shadow: { res: [1500, 500], sensor: [108, 36] } }
  };
  const FRAME_FIELDS = {
    Fabric: { res: ["fabricResX", "fabricResY"], sensor: ["fabricSensorX", "fabricSensorY"] },
    Shadow: { res: ["shadowResX", "shadowResY"], sensor: ["shadowSensorX", "shadowSensorY"] }
  };
  const currentProfile = () => (selected("renderProfile")[0] || "high");
  const fillFrameSize = () => {
    const profile = FRAME_PROFILES[currentProfile()] || FRAME_PROFILES.high;
    for (const [layer, fields] of Object.entries(FRAME_FIELDS)) {
      $(fields.res[0]).value = profile[layer].res[0]; $(fields.res[1]).value = profile[layer].res[1];
      $(fields.sensor[0]).value = profile[layer].sensor[0]; $(fields.sensor[1]).value = profile[layer].sensor[1];
    }
    describeFrameSize();
  };
  // Behind a button, a changed frame is easy to forget, so the trigger says when it differs
  // from the profile and what it was changed to.
  const describeFrameSize = () => {
    const profile = FRAME_PROFILES[currentProfile()] || FRAME_PROFILES.high;
    const custom = [];
    for (const [layer, fields] of Object.entries(FRAME_FIELDS)) {
      const res = [Number($(fields.res[0]).value), Number($(fields.res[1]).value)];
      const sensor = [Number($(fields.sensor[0]).value), Number($(fields.sensor[1]).value)];
      if (res.join() !== profile[layer].res.join() || sensor.join() !== profile[layer].sensor.join()) {
        custom.push(`${layer} ${res[0]}×${res[1]} · ${sensor[0]}×${sensor[1]} mm`);
      }
    }
    const summary = $("frameSizeSummary"), state = $("frameSizeState"), toggle = $("frameSizeToggle");
    // The trigger reads as two lines: the Fabric frame a render starts from, and whether that
    // came from the profile or was typed. The per-layer numbers are already on the layer
    // buttons and inside the panel, and crowding them in here is what made the old one-line
    // summary unreadable beside the button.
    summary.textContent = `${$("fabricResX").value} px · ${$("fabricSensorX").value} mm`;
    // The state sits beside the arrow on one line, so naming both layers would push the
    // value out of the control.
    state.textContent = !custom.length ? "From the profile"
      : custom.length > 1 ? "Changed on both"
      : `Changed on ${custom[0].split(" ")[0]}`;
    summary.dataset.state = state.dataset.state = toggle.dataset.state = custom.length ? "custom" : "profile";
    // The layer buttons carry the frame in their sublabel, so they have to follow the fields
    // rather than only the profile they were switched from.
    const short = px => {
      if (!Number.isFinite(px) || px <= 0) return "—";
      if (px < 1000) return String(px);
      const thousands = px / 1000;
      return Number.isInteger(thousands * 10) ? `${Number(thousands.toFixed(1))}K` : String(px);
    };
    const size = layer => {
      const fields = FRAME_FIELDS[layer];
      const x = Number($(fields.res[0]).value), y = Number($(fields.res[1]).value);
      return x === y ? short(x) : `${short(x)}×${short(y)}`;
    };
    $("fabricResolutionLabel").textContent = `Path Trace · ${size("Fabric")}`;
    $("shadowResolutionLabel").textContent = `Lumen · ${size("Shadow")}`;
  };
  // Puts a recorded frame back into the fields. fillFrameSize only knows the profile, and a
  // job that was given a frame of its own has to be reopened with that frame, not the
  // profile's -- otherwise editing it silently re-renders at a different size.
  const applyFrameSize = frame => {
    let applied = false;
    for (const [layer, fields] of Object.entries(FRAME_FIELDS)) {
      const asked = frame?.[layer];
      if (!asked?.Resolution || !asked?.SensorSize) continue;
      $(fields.res[0]).value = asked.Resolution.X; $(fields.res[1]).value = asked.Resolution.Y;
      $(fields.sensor[0]).value = asked.SensorSize.X; $(fields.sensor[1]).value = asked.SensorSize.Y;
      applied = true;
    }
    if (applied) describeFrameSize();
    return applied;
  };
  const frameOverrides = () => {
    const out = {};
    for (const [layer, fields] of Object.entries(FRAME_FIELDS)) {
      out[layer] = {
        Resolution: { X: Number($(fields.res[0]).value), Y: Number($(fields.res[1]).value) },
        SensorSize: { X: Number($(fields.sensor[0]).value), Y: Number($(fields.sensor[1]).value) }
      };
    }
    return out;
  };
  // A verdict already earned is shown straight away. The request runs nothing on the server:
  // it answers from store, so a batch of files checked yesterday lights up without a wait,
  // and only a new or replaced file is left blank for "Check models" to deal with.
  let cachedChecksFor = null;
  const loadCachedChecks = async () => {
    const signature = state.batch.map(model => model.path).sort().join("|");
    if (signature === cachedChecksFor) return;
    cachedChecksFor = signature;
    if (!state.batch.length) return;
    try {
      const stored = await api("/api/models/checks");
      if (signature !== cachedChecksFor) return;   // the batch moved on while we were asking
      const names = new Set(state.batch.map(model => model.name));
      const rows = (stored.models || []).filter(row => names.has(row.name));
      if (!rows.length) return;
      const report = { ...stored, models: rows, checked: rows.length, requested: state.batch.length,
        failing: rows.filter(row => row.errors).length, warning: rows.filter(row => row.warnings).length };
      state.modelCheck = report;
      renderModelCheck(); renderBatch();
    } catch { /* a stored verdict is a convenience; failing to fetch one changes nothing */ }
  };
  const renderBatch = () => {
    renderCheckSummary();
    $("modelBatch").hidden = !state.batch.length; $("batchCount").textContent = `${state.batch.length} model${state.batch.length === 1 ? "" : "s"}`;
    loadCachedChecks();
    $("batchList").innerHTML = state.batch.map(model => `<div class="batch-model${state.model?.path === model.path ? " active" : ""}" data-model-path="${escapeHtml(model.path)}"${checkStateOf(model.name) ? ` data-check="${checkStateOf(model.name)}"` : ""}><button class="batch-model-select" type="button" title="Select ${escapeHtml(model.name)}"><span>${escapeHtml(model.name)}</span><small>${model.dimensions.width} × ${model.dimensions.depth} × ${model.dimensions.height} cm · ${escapeHtml(model.materialIds.length)} IDs</small></button><button class="batch-model-info" type="button" data-focus-source="#modelDetails" data-focus-title="${escapeHtml(model.name)}" data-focus-kind="model" data-focus-move="self" aria-label="Open information for ${escapeHtml(model.name)}" title="Model information"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 10.5v6M12 7.5h.01"/></svg></button><button class="batch-model-remove" type="button" title="Remove ${escapeHtml(model.name)}" aria-label="Remove ${escapeHtml(model.name)}">${CLOSE_ICON}</button></div>`).join("");
  };
  const selectModel = model => {
    state.model = model; state.historyModel = null;
    $("modelEmpty").hidden = true; $("modelDetails").hidden = false;
    $("inspectedName").textContent = model.name; $("modelSide").textContent = model.side || "Unknown side";
    $("width").value = model.dimensions.width; $("depth").value = model.dimensions.depth; $("height").value = model.dimensions.height; $("importYaw").value = model.importYaw;
    $("modelPath").value = model.path;
    $("modelWarning").hidden = !model.warning; $("modelWarning").textContent = model.warning || "";
    renderModelCheck();
    renderBatch(); validate();
  };
  const applyModel = (model, quiet = false) => {
    state.jobPath = null;
    const index = state.batch.findIndex(item => item.path.toLowerCase() === model.path.toLowerCase());
    if (index >= 0) state.batch[index] = model; else state.batch.push(model);
    const groups = new Set(state.batch.map(item => String(item.group || "").toLowerCase()).filter(Boolean));
    if (groups.size === 1) {
      const implied = [...groups][0] === "sofas" ? "Sofas" : "Sectionals";
      if ($("category").value !== implied) { $("category").value = implied; applyProductType(); }
    }
    if (!state.models.some(item => item.path.toLowerCase() === model.path.toLowerCase())) {
      state.models.push({ name: model.name, path: model.path });
      $("modelCount").textContent = state.models.length;
      $("modelOptions").insertAdjacentHTML("beforeend", `<option value="${escapeHtml(model.path)}">${escapeHtml(model.name)}</option>`);
    }
    renderMaterials(); selectModel(model);
    const uph = document.querySelector('[data-material-key="uph"]'); if (uph && state.batch.length === 1) uph.focus();
    if (!quiet) toast(`${model.newlyAnalyzed ? "Analyzed and saved" : "Read"} ${model.materialIds.length} Material IDs from ${model.name}`);
  };
  const metadataModel = query => {
    const value = String(query || "").trim(), needle = value.split(/[\\/]/).pop().replace(/\.(fbx|obj)$/i, "").toLowerCase();
    const entries = Object.entries(state.metadata?.models || {});
    const match = entries.find(([name]) => name.toLowerCase() === needle) || entries.filter(([name]) => name.toLowerCase().includes(needle))[0];
    if (!match) throw new Error("This FBX is not listed in data/models.json. Add its model metadata before using it.");
    const [name, record] = match, materialIds = state.metadata.profiles?.[record.ids];
    if (!materialIds) throw new Error(`Material ID profile ${record.ids} is missing for ${name}`);
    const [width, depth, height] = record.dimensions;
    return { name, path: `${LOCAL_MODELS_ROOT}\\${name}.fbx`, side: sectionalFormFactor(name, record.side), materialIds: [...materialIds], dimensions: { width, depth, height }, importYaw: record.yaw, offsetUniformScale: record.scale, warning: record.warning || "" };
  };
  const loadModelMetadata = async () => {
    const response = await fetch("data/models.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`Model metadata returned ${response.status}`);
    state.metadata = await response.json();
    state.models = Object.keys(state.metadata.models || {}).map(name => ({ name, path: `${LOCAL_MODELS_ROOT}\\${name}.fbx` }));
    $("modelCount").textContent = state.models.length;
    $("modelOptions").innerHTML = state.models.map(model => `<option value="${escapeHtml(model.path)}">${escapeHtml(model.name)}</option>`).join("");
  };
  const applyMaterialAssets = result => {
    state.materialAssets = result.materials || [];
    $("materialOptions").innerHTML = state.materialAssets.map(asset => `<option value="${escapeHtml(asset.name)}">${escapeHtml(asset.path)}</option>`).join("");
    document.querySelectorAll("[data-material-key]").forEach(updateMaterialStatus);
  };
  const loadMaterialAssets = async () => {
    if (!canReachLocalService) return;
    applyMaterialAssets(await api(`/api/materials?environment=${encodeURIComponent(state.renderEnvironment)}`));
  };
  const refreshMaterials = async () => {
    const button = $("refreshMaterials"), label = button.textContent;
    button.disabled = true; button.textContent = "Refreshing…";
    try {
      const result = await api(`/api/materials/refresh?environment=${encodeURIComponent(state.renderEnvironment)}`, { method: "POST", body: "{}" });
      applyMaterialAssets(result); validate();
      const changes = [result.added ? `${result.added} new` : "", result.removed ? `${result.removed} removed` : ""].filter(Boolean).join(" · ");
      toast(`${renderEnvironmentLabel(state.renderEnvironment)} materials: ${result.count} found${changes ? ` · ${changes}` : " · list refreshed"}`);
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; button.textContent = label; }
  };
  const chooseRenderEnvironment = async (value, remember = true, quiet = false) => {
    const next = normalizeRenderEnvironment(value);
    if (state.status?.render?.state === "running") return toast("Finish the active render before changing Unreal environment", true);
    const changed = state.renderEnvironment !== next;
    state.renderEnvironment = next;
    if (remember) settings.write(RENDER_ENVIRONMENT_KEY, next);
    syncRenderEnvironment();
    if (state.status?.render) updateRender(state.status.render);
    if (!changed) return;
    state.jobPath = null; state.preflight = null; $("jobResult").hidden = true;
    try { await loadMaterialAssets(); } catch (error) { toast(`${renderEnvironmentLabel(next)} materials unavailable: ${error.message}`, true); }
    renderPreflight({ waiting: true, checks: [], counts: { expectedRenders: 0 } });
    validate(false);
    if (!quiet) {
      refreshPreflight();
      toast(`${renderEnvironmentLabel(next)} selected · new jobs stay pinned to this environment`);
    }
  };
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[ch]);
  const droppedFilePath = (file, transfer) => {
    const directPath = typeof file?.path === "string" ? file.path : "";
    if (/^[a-z]:[\\/].+\.(fbx|obj)$/i.test(directPath)) return directPath.replace(/\//g, "\\");
    const uris = String(transfer?.getData?.("text/uri-list") || "").split(/\r?\n/).filter(value => /^file:\/\/\/[a-z]:\//i.test(value));
    const uri = uris.find(value => { try { return decodeURIComponent(value).split("/").pop().toLowerCase() === String(file?.name || "").toLowerCase(); } catch { return false; } }) || (uris.length === 1 ? uris[0] : "");
    if (uri) { try { return decodeURIComponent(uri.replace(/^file:\/\/\//i, "")).replace(/\//g, "\\"); } catch {} }
    const name = String(file?.name || "").toLowerCase();
    const known = state.models.find(model => model.path.split(/[\\/]/).pop().toLowerCase() === name)?.path;
    return known || (canReachLocalService && name ? `${LOCAL_MODELS_ROOT}\\${file.name}` : "");
  };
  const inspectQuery = query => canReachLocalService ? api("/api/models/inspect", { method: "POST", body: JSON.stringify({ modelPath: query }) }) : Promise.resolve(metadataModel(query));
  const useDroppedModels = async (files, transfer = null) => {
    const status = $("modelDropStatus");
    const selectedFiles = [...(files || [])], fbxFiles = selectedFiles.filter(file => /\.(fbx|obj)$/i.test(file.name || ""));
    if (!fbxFiles.length) { status.dataset.state = "error"; status.textContent = "Choose one or more FBX or OBJ model files."; return toast(status.textContent, true); }
    $("inspectModel").disabled = true; $("chooseModel").disabled = true;
    let added = 0, failed = 0;
    for (let index = 0; index < fbxFiles.length; index++) {
      const file = fbxFiles[index], fullPath = droppedFilePath(file, transfer);
      status.dataset.state = "working"; status.textContent = `Inspecting ${index + 1} of ${fbxFiles.length}: ${file.name}`;
      if (!fullPath) { failed++; continue; }
      try { applyModel(await inspectQuery(fullPath), true); added++; } catch (error) { console.warn(`${file.name}: ${error.message}`); failed++; }
    }
    $("inspectModel").disabled = false; $("chooseModel").disabled = false;
    status.dataset.state = failed ? "error" : "success";
    status.textContent = `${added} model${added === 1 ? "" : "s"} added${failed ? ` · ${failed} failed` : ""}`;
    toast(status.textContent, !!failed);
  };
  const inspect = async () => {
    if ($("inspectModel").disabled) return;
    const query = $("modelPath").value.trim(); if (!query) return toast("Enter a model name or path", true);
    $("inspectModel").disabled = true; $("inspectModel").textContent = "Inspecting…";
    try {
      applyModel(await inspectQuery(query));
    } catch (error) { toast(error.message, true); }
    finally { $("inspectModel").disabled = false; $("inspectModel").textContent = "Inspect model"; }
  };
  const generate = async () => {
    if (!(await refreshPreflight())) return toast("Preflight found issues that must be fixed first", true);
    $("generateJob").disabled = true; $("generateJob").textContent = "Generating…";
    try {
      const result = await api("/api/jobs", { method: "POST", body: JSON.stringify(payload()) });
      state.jobPath = result.jobPath; $("jobResult").hidden = false; $("copyJobPath").textContent = result.jobPath;
      $("launchRender").disabled = false; toast(`Job ready: ${result.modelCount || 1} model${result.modelCount === 1 ? "" : "s"} · ${result.cameraCount} views · ${result.lightSource}`); loadHistory();
    } catch (error) { toast(error.message, true); }
    finally { $("generateJob").textContent = "Generate job"; validate(false); }
  };
  const launch = async (resume = false) => {
    const resuming = resume === true;
    const button = $("launchRender");
    if (!resuming && state.jobQueue?.items?.length) {
      try {
        state.jobQueue = await api("/api/job-queue", { method: "POST", body: JSON.stringify({ action: "start" }) });
        renderJobQueue(); toast(`Queue started · ${state.jobQueue.items.length} job${state.jobQueue.items.length === 1 ? "" : "s"}`); startPolling();
      } catch (error) { toast(error.message, true); }
      return;
    }
    if (!state.jobPath && !resuming) {
      button.disabled = true; button.textContent = "Preparing job…";
      try { await generate(); } finally { button.textContent = "Launch render"; }
      // generate() reports its own failure; without a job there is nothing to start.
      if (!state.jobPath) return validate(false);
    }
    try {
      const result = await api("/api/renders", { method: "POST", body: JSON.stringify({ jobPath: state.jobPath, resume: resuming }) });
      toast(resuming ? "Resuming incomplete models in Unreal" : `Unreal started (PID ${result.pid})`); updateRender(result); startPolling();
    } catch (error) { toast(error.message, true); }
  };
  const formatDuration = seconds => {
    if (!Number.isFinite(seconds) || seconds <= 0) return "less than a minute";
    const minutes = Math.max(1, Math.round(seconds / 60));
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60), rest = minutes % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
  };
  const renderEta = render => {
    const rendered = Number(render.rendered || 0), total = Number(render.totalRenders || 0);
    if (render.state !== "running" || !render.startedAt || total <= rendered) return "";
    if (!rendered) return "ETA after the first frame";
    const started = new Date(render.startedAt).getTime();
    if (!Number.isFinite(started)) return "";
    const elapsedSeconds = Math.max(1, (Date.now() - started) / 1000);
    return `ETA ≈ ${formatDuration(elapsedSeconds / rendered * (total - rendered))}`;
  };
  const armStop = { timer: null };
  const disarmStop = () => {
    const button = $("stopRender");
    button.dataset.confirm = ""; button.textContent = "Stop render";
    if (armStop.timer) { clearTimeout(armStop.timer); armStop.timer = null; }
  };
  // A mis-click here throws away hours of rendering, so the button asks twice.
  const stopRender = async () => {
    const button = $("stopRender");
    if (button.dataset.confirm !== "pending") {
      button.dataset.confirm = "pending"; button.textContent = "Confirm stop";
      armStop.timer = setTimeout(disarmStop, 5000);
      return;
    }
    disarmStop();
    try {
      updateRender(await api("/api/renders/stop", { method: "POST" }));
      toast("Render stopped; Unreal is being killed");
    } catch (error) { toast(error.message, true); }
  };
  const renderJobQueue = (queue = state.jobQueue) => {
    state.jobQueue = queue || { state: "idle", items: [], pendingCount: 0, failedCount: 0 };
    const items = state.jobQueue.items || [], panel = $("jobQueuePanel"), failed = items.some(item => ["failed", "paused"].includes(item.state));
    panel.hidden = !items.length;
    $("jobQueueSummary").textContent = items.length ? `${items.length} job${items.length === 1 ? "" : "s"} · ${state.jobQueue.state}` : "0 jobs";
    $("jobQueueList").innerHTML = items.map((item, index) => {
      const label = ({ active: "Rendering", queued: "Waiting", failed: "Failed", paused: "Paused" })[item.state] || item.state;
      return `<div data-state="${escapeHtml(item.state)}"><b>${String(index + 1).padStart(2, "0")}</b><span><strong>${escapeHtml(item.jobId)}</strong><small>${item.modelCount} model${item.modelCount === 1 ? "" : "s"} · ${item.expectedRenders} frames · ${escapeHtml(renderEnvironmentLabel(item.renderEnvironment))}${item.error ? ` · ${escapeHtml(item.error)}` : ""}</small></span><i>${escapeHtml(label)}</i>${item.state === "active" ? "" : `<button class="queue-remove" type="button" data-remove-queue="${escapeHtml(item.id)}" aria-label="Remove ${escapeHtml(item.jobId)} from queue">${CLOSE_ICON}</button>`}</div>`;
    }).join("");
    $("retryQueue").hidden = !failed; $("skipQueue").hidden = !failed;
    $("clearQueue").hidden = !items.some(item => item.state !== "active");
    syncLaunchAction(state.preflight?.ok === true);
  };
  const updateRender = (render) => {
    state.status ||= {}; state.status.render = render;
    if (render.jobQueue) renderJobQueue(render.jobQueue);
    document.querySelectorAll("button[data-render-environment]").forEach(button => { button.disabled = render.state === "running"; });
    const badge = $("renderBadge"), environmentBadge = $("activeEnvironmentBadge"), box = $("renderStatus"), log = $("renderLog"), progress = $("renderProgress");
    const activeEnvironment = render.environment?.id || state.renderEnvironment;
    environmentBadge.hidden = normalizeRenderEnvironment(activeEnvironment) !== "ue58" || (render.state === "idle" && !render.jobPath);
    badge.dataset.state = render.state; badge.textContent = render.state === "running" && render.phase ? render.phase : ({running:"Rendering",success:"Complete",failed:"Failed",stopped:"Stopped",idle:"Idle"})[render.state] || render.state;
    box.dataset.state = render.state;
    const phase = render.phase ? ` · ${render.phase}${render.phaseCount > 1 ? ` (${render.phaseIndex}/${render.phaseCount})` : ""}` : "";
    const title = render.state === "running" ? (render.phase === "Shadow processing" ? "Recovering visible Shadow alpha" : render.phase === "Post-processing" ? "Preparing delivery images" : `Unreal is rendering${phase}`) : render.state === "success" ? (render.postProcess?.state === "failed" ? "Render completed · post-process needs attention" : "Render completed") : render.state === "failed" ? "Render stopped with an error" : render.state === "stopped" ? "Render stopped by hand" : "No active render";
    const substrate = render.state === "running" && typeof render.substrate === "boolean" ? `Substrate ${render.substrate ? "ON" : "OFF"} · ` : "";
    const current = [render.currentTask, render.currentCamera].filter(Boolean).join(" · ");
    const runningEnvironment = render.environment?.label || renderEnvironmentLabel(state.renderEnvironment);
    box.querySelector("strong").textContent = title; box.querySelector("span").textContent = current || (render.jobPath ? `${runningEnvironment} · ${substrate}${render.jobPath}` : `Generate a job, then launch it in ${renderEnvironmentLabel(state.renderEnvironment)}.`);
    const total = Number(render.totalRenders || 0), rendered = Number(render.rendered || 0), postTotal = Number(render.postProcess?.total || 0), postCompleted = Number(render.postProcess?.completed || 0), shadowTotal = Number(render.shadowProcess?.total || 0), shadowCompleted = Number(render.shadowProcess?.completed || 0);
    const shadowRunning = render.shadowProcess?.state === "running" && shadowTotal;
    const percent = shadowRunning ? Math.min(100, shadowCompleted / shadowTotal * 100) : render.postProcess?.state === "running" && postTotal ? Math.min(100, postCompleted / postTotal * 100) : total ? Math.min(100, rendered / total * 100) : render.state === "success" ? 100 : 0;
    progress.hidden = render.state === "idle" && !render.jobPath;
    $("renderProgressLabel").textContent = shadowRunning ? `${shadowCompleted} / ${shadowTotal} shadows processed` : render.postProcess?.state === "running" ? `${render.postProcess.completed} / ${render.postProcess.total} processed` : total ? `${rendered} / ${total} frames` : `${rendered} frames`;
    $("renderProgressMeta").textContent = [`${substrate}${render.message || render.phase || "Waiting"}`, renderEta(render)].filter(Boolean).join(" · ");
    $("renderProgressBar").style.width = `${percent}%`;
    $("renderQueue").innerHTML = (render.queue || []).map((item, index) => {
      const itemState = render.state === "running" && item.name === render.currentTask ? "active" : item.state || "queued";
      const stateLabel = ({ active: "Rendering", complete: "Complete", partial: "Partial", pending: "Upcoming", queued: "Upcoming" })[itemState] || itemState;
      return `<span data-state="${escapeHtml(itemState)}" title="${escapeHtml(item.name)}"><b>${String(index + 1).padStart(2, "0")}</b><span class="render-queue-name">${escapeHtml(item.name)}</span><i>${escapeHtml(stateLabel)}</i><small>${Number(item.rendered || 0)}/${Number(item.expected || 0)}</small></span>`;
    }).join("");
    // With a long batch the running model is almost always outside the 300px window, so
    // bring it into view -- but only when it changes, otherwise every poll would yank the
    // list back while someone is reading another row.
    const running = $("renderQueue").querySelector('[data-state="active"]');
    if (running && state.queueFocus !== render.currentTask) {
      const list = $("renderQueue");
      // offsetTop counts from the nearest positioned ancestor, not from the list, so the
      // offset is measured against the list itself
      const offset = running.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
      list.scrollTop = Math.max(0, offset - (list.clientHeight - running.offsetHeight) / 2);
    }
    state.queueFocus = running ? render.currentTask : null;
    $("stopRender").hidden = render.state !== "running";
    if (render.state !== "running") disarmStop();
    $("retryRender").hidden = !["failed", "stopped"].includes(render.state) || !render.jobPath || Boolean(state.jobQueue.items?.length);
    $("retryRender").textContent = render.state === "stopped" ? "Resume stopped job" : "Retry failed job";
    log.hidden = false; log.textContent = render.log || "";
    if (render.state !== "running" && state.jobQueue.state !== "running" && state.poll) { clearInterval(state.poll); state.poll = null; loadHistory(); }
  };
  const startPolling = () => { if (state.poll) clearInterval(state.poll); state.poll = setInterval(async () => { try { updateRender(await api("/api/renders/status")); } catch {} }, 2000); };
  const formatDate = value => {
    const date = new Date(value); if (Number.isNaN(date.getTime())) return "Unknown time";
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
  };
  const historyStateLabel = value => ({ complete: "Complete", partial: "Partial", running: "Rendering", failed: "Failed", ready: "Job ready", invalid: "Invalid" })[value] || value;
  const TRASH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12M10.5 10.5v6M13.5 10.5v6"/></svg>';
  const CAROUSEL_PREVIOUS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5.5 8.5 12l6.5 6.5"/></svg>';
  const CAROUSEL_NEXT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5.5 6.5 6.5L9 18.5"/></svg>';
  // One popover for every delete on the page: the card only says what is being removed,
  // the confirmation lives here so no card has to carry a second state of its own.
  let pendingDelete = null;
  const askDelete = (trigger, { title, detail, run }) => {
    pendingDelete = run;
    $("deleteConfirmTitle").textContent = title;
    $("deleteConfirmBody").textContent = detail;
    const pop = $("deleteConfirm");
    pop.showPopover?.();
    // The trigger names itself as the anchor while its confirmation is up, and CSS keeps the
    // two together without a scroll handler.
    document.querySelectorAll('.card-delete[data-anchor="active"]').forEach(node => delete node.dataset.anchor);
    trigger.dataset.anchor = "active";
    trigger.setAttribute("aria-expanded", "true");
  };
  const closeDelete = () => {
    pendingDelete = null;
    document.querySelectorAll('.card-delete[data-anchor="active"]').forEach(node => delete node.dataset.anchor);
    $("deleteConfirm").hidePopover?.();
    document.querySelectorAll('.card-delete[aria-expanded="true"]').forEach(button => button.setAttribute("aria-expanded", "false"));
  };
  const renderJobSelection = () => {
    const selected = state.history.filter(batch => state.selectedJobs.has(batch.id)), count = selected.length;
    $("toggleJobSelection").setAttribute("aria-pressed", String(state.jobSelectionMode));
    $("toggleJobSelection").textContent = state.jobSelectionMode ? "Done selecting" : "Select jobs";
    $("jobSelectionBar").hidden = !state.jobSelectionMode;
    $("jobSelectionCount").textContent = `${count} job${count === 1 ? "" : "s"} selected`;
    const models = selected.reduce((sum, batch) => sum + Number(batch.modelCount || 0), 0), renders = selected.reduce((sum, batch) => sum + Number(batch.expectedRenders || 0), 0);
    const seconds = selected.reduce((sum, batch) => sum + Number(batch.timing?.seconds || batch.estimate?.seconds || 0), 0);
    $("jobSelectionMeta").textContent = count ? `${models} models · ${renders} frames${seconds ? ` · ≈ ${humanDuration(seconds)}` : ""}` : "Choose saved jobs to queue";
    $("addJobsToQueue").disabled = !count;
  };
  const renderHistoryList = () => {
    const query = $("historySearch").value.trim().toLowerCase(), filter = $("historyFilter").value;
    const batches = state.history.filter(batch => (filter === "all" || batch.state === filter) && (!query || batch.id.toLowerCase().includes(query) || (batch.models || []).some(model => model.name.toLowerCase().includes(query))));
    $("historyCount").textContent = batches.length === state.history.length ? `${state.history.length} job${state.history.length === 1 ? "" : "s"}` : `${batches.length} of ${state.history.length}`;
    $("historyList").innerHTML = batches.length ? batches.map(batch => `<div class="card-shell${state.selectedJobs.has(batch.id) ? " selected" : ""}">${state.jobSelectionMode ? `<button class="job-pick" type="button" data-select-job="${escapeHtml(batch.id)}" aria-pressed="${state.selectedJobs.has(batch.id)}" aria-label="${state.selectedJobs.has(batch.id) ? "Remove" : "Add"} ${escapeHtml(batch.id)} ${state.selectedJobs.has(batch.id) ? "from" : "to"} selection"><span></span></button>` : ""}<button class="history-card${state.historyBatch?.id === batch.id ? " active" : ""}" type="button" data-history-id="${escapeHtml(batch.id)}"><span class="history-card-top"><strong>${escapeHtml(batch.id)}</strong><span class="history-card-badges">${renderEnvironmentBadge(batch.renderEnvironment)}<i class="history-state" data-state="${escapeHtml(batch.state)}">${escapeHtml(historyStateLabel(batch.state))}</i></span></span><span class="history-card-meta"><b>${batch.modelCount} model${batch.modelCount === 1 ? "" : "s"} · ${escapeHtml(renderEnvironmentLabel(batch.renderEnvironment))}</b><b>${batch.renderCount}/${batch.expectedRenders} renders · ${batch.postProcessCount || 0} POST</b></span><small>${escapeHtml(formatDate(batch.updatedAt || batch.generatedAt))}</small></button><button class="card-delete" type="button" aria-expanded="false" aria-label="Delete this batch" title="Delete batch" data-delete-batch="${escapeHtml(batch.id)}">${TRASH_ICON}</button></div>`).join("") : '<div class="empty-state">No jobs match this filter.</div>';
    renderJobSelection();
  };
  const humanDuration = totalSeconds => {
    const value = Math.max(0, Math.round(Number(totalSeconds) || 0));
    const hours = Math.floor(value / 3600), minutes = Math.floor((value % 3600) / 60), rest = value % 60;
    if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
    if (minutes) return `${minutes}m ${String(rest).padStart(2, "0")}s`;
    return `${rest}s`;
  };
  // Per-frame costs read from whichever source knows them: a job that ran carries its own
  // phases, one that has not is priced from every run so far.
  const perFrameNote = batch => {
    const measured = (batch.timing?.phases || [])
      .filter(phase => !phase.calibration && phase.layer && phase.frames)
      .map(phase => `${phase.layer} ${humanDuration(phase.seconds / phase.frames)}/frame`);
    if (measured.length) return measured.join(" · ");
    const rates = Object.entries(state.timing?.perFrame || {})
      .map(([layer, rate]) => `${layer} ${humanDuration(rate.seconds)}/frame`);
    return rates.length ? `From ${state.timing.runs} run${state.timing.runs === 1 ? "" : "s"}: ${rates.join(" · ")}` : "";
  };
  const timingTile = batch => {
    if (batch.timing) return `<div title="${escapeHtml(perFrameNote(batch))}"><span>TOOK</span><strong>${escapeHtml(humanDuration(batch.timing.seconds))}</strong></div>`;
    if (batch.estimate) return `<div title="${escapeHtml(perFrameNote(batch))}"><span>ESTIMATE</span><strong>~${escapeHtml(humanDuration(batch.estimate.seconds))}</strong></div>`;
    return `<div title="No run has been timed yet"><span>TOOK</span><strong>—</strong></div>`;
  };
  const renderHistoryDetail = () => {
    const batch = state.historyBatch;
    if (!batch) { $("historyDetail").innerHTML = '<div class="empty-state">Choose a saved job to inspect its models, JSON, and render output.</div>'; return; }
    const models = batch.models?.length ? `<div class="history-model-list" aria-label="Models in ${escapeHtml(batch.id)}">${batch.models.map((model, index) => `<div class="history-model-row"><label><input type="checkbox" data-history-model-select="${escapeHtml(model.name)}"${state.historySelection.has(model.name) ? " checked" : ""}><span>${String(index + 1).padStart(2, "0")}</span><strong>${escapeHtml(model.name)}</strong><small>${escapeHtml(model.side || "UNKNOWN")} · ${model.dimensions ? `${model.dimensions.width} × ${model.dimensions.depth} × ${model.dimensions.height} cm` : "No dimensions"} · ${model.renders.length}/${model.expectedRenders}</small></label></div>`).join("")}</div>` : '<div class="empty-state history-model-empty">No models stored in this job.</div>';
    // The cameras and layers a job was built with, not a list written for sectionals and
    // shown for every product -- a sofa job was offering F, FH, TQ, and "Edit selection"
    // then restored those.
    const pick = (kind, values) => values.map(value =>
      `<label><input type="checkbox" data-select-${kind} value="${escapeHtml(value)}" checked><span>${escapeHtml(value)}</span></label>`).join("");
    const selective = `<div class="selective-controls"><div><span>SELECTIVE RENDER</span><button type="button" data-history-action="selectAll">All</button><button type="button" data-history-action="selectNone">None</button></div><div class="selective-options">${pick("camera", batch.cameras?.length ? batch.cameras : ["F", "FH", "TQ"])}<i></i>${pick("layer", batch.layers?.length ? batch.layers : ["Fabric", "Shadow"])}</div></div>`;
    const needsPost = batch.renderCount > 0 && (batch.postProcessCount < batch.renderCount || !batch.readyToUpload?.complete);
    const openOutput = batch.readyToUpload?.files ? `<button class="secondary-button" type="button" data-history-action="openReady">Open POST</button>` : `<button class="secondary-button" type="button" data-history-action="openRenders"${batch.renderCount ? "" : " disabled"}>Open renders</button>`;
    $("historyDetail").innerHTML = `<div class="history-detail-heading"><div><span>SAVED JOB · ${escapeHtml(renderEnvironmentLabel(batch.renderEnvironment))}</span><strong>${escapeHtml(batch.id)}</strong><small>${escapeHtml(formatDate(batch.generatedAt))}</small></div><div class="history-detail-badges">${renderEnvironmentBadge(batch.renderEnvironment)}<i class="history-state" data-state="${escapeHtml(batch.state)}">${escapeHtml(historyStateLabel(batch.state))}</i></div></div><div class="history-summary"><div><span>MODELS</span><strong>${batch.modelCount}</strong></div><div><span>RENDERS</span><strong>${batch.renderCount}/${batch.expectedRenders}</strong></div><div><span>POST</span><strong>${batch.postProcessCount || 0}/${batch.renderCount}</strong></div>${timingTile(batch)}</div>${selective}${models}${batch.error ? `<p class="inline-warning">${escapeHtml(batch.error)}</p>` : ""}<code class="history-path" title="${escapeHtml(batch.jobPath)}">${escapeHtml(batch.jobPath)}</code><div class="history-actions"><button class="primary-button" type="button" data-history-action="selective"${batch.modelCount ? "" : " disabled"}>Edit selection</button><button class="secondary-button" type="button" data-history-action="rerun"${batch.state === "invalid" ? " disabled" : ""}>${batch.renderCount ? "Run again" : "Run this job"}</button>${needsPost ? `<button class="secondary-button" type="button" data-history-action="postprocess">Build POST</button>` : ""}${openOutput}<button class="secondary-button" type="button" data-history-action="viewJob">View JSON</button></div>`;
  };
  const renderGalleryModels = () => {
    const batch = state.galleryBatch, group = $("galleryModelGroup");
    group.hidden = !batch?.models?.length;
    if (!batch?.models?.length) return;
    $("galleryModelCount").textContent = `${batch.models.length} model${batch.models.length === 1 ? "" : "s"}`;
    $("galleryModels").innerHTML = batch.models.map((model, index) => `<button type="button" class="gallery-model${state.historyModel === model ? " active" : ""}" data-state="${escapeHtml(model.state || "pending")}" data-gallery-model-index="${index}" title="${escapeHtml(model.name)}"><span>${String(index + 1).padStart(2, "0")}</span><strong>${escapeHtml(model.name)}</strong><small>${escapeHtml(model.state || "pending")} · ${model.renders.length}/${model.expectedRenders} renders</small></button>`).join("");
  };
  const renderGallery = () => {
    const model = state.historyModel, gallery = $("renderGallery");
    gallery.hidden = !model;
    if (!model) return;
    $("renderGalleryModel").textContent = model.name; $("renderGalleryCount").textContent = `${model.renders.length} file${model.renders.length === 1 ? "" : "s"}`;
    const cameraRank = { F: 0, FH: 1, TQ: 2 }, cameras = [...new Set(model.renders.map(render => render.camera || "Other"))].sort((left, right) => (cameraRank[left] ?? 9) - (cameraRank[right] ?? 9));
    const card = render => {
      const issues = render.issues || [];
      const diagnostics = [render.width && render.height ? `${render.width}×${render.height}` : "Unknown size", render.alpha === true ? "Alpha" : render.alpha === false ? "No alpha" : "Alpha unknown", ...(issues || [])];
      return `<div class="card-shell"><a class="render-preview-card${issues.length ? " render-warning" : ""}" data-layer="${escapeHtml(render.layer || "Fabric")}" href="${escapeHtml(render.url)}" target="_blank" rel="noreferrer"><div class="render-preview-media" style="--preview-aspect:${Number(render.width) || 1}/${Number(render.height) || 1}"><img src="${escapeHtml(render.previewUrl || render.url)}" alt="${escapeHtml(model.name)} ${escapeHtml(render.camera || "render")} ${escapeHtml(render.layer || "")}" loading="lazy"></div><span>${escapeHtml([render.camera, render.layer].filter(Boolean).join(" · ") || render.name)} · RAW${issues.length ? " · Check" : ""}</span><small>${escapeHtml(diagnostics.join(" · "))}</small></a><button class="card-delete" type="button" aria-expanded="false" aria-label="Delete this render" title="Delete render" data-delete-render="${escapeHtml(render.file || "")}" data-delete-label="${escapeHtml(`${render.camera || "render"} ${render.layer || ""}`.trim())}">${TRASH_ICON}</button></div>`;
    };
    const combinedCard = (fabric, shadow) => {
      if (!fabric || !shadow) return "";
      const fabricWidth = Math.min(100, Math.max(1, (Number(fabric.width) || 1) / (Number(shadow.width) || 1) * 100));
      const issues = [...(fabric.issues || []), ...(shadow.issues || [])];
      return `<div class="card-shell"><button type="button" class="render-preview-card render-combined${issues.length ? " render-warning" : ""}" data-layer="Combined" data-fabric-url="${escapeHtml(fabric.url)}" data-shadow-url="${escapeHtml(shadow.url)}" data-fabric-width="${fabricWidth}" data-combined-title="${escapeHtml(`${model.name} · ${fabric.camera || "render"} · Combined`)}"><div class="render-preview-media" style="--preview-aspect:${Number(shadow.width) || 1}/${Number(shadow.height) || 1};--fabric-width:${fabricWidth}%"><img class="render-composite-shadow" src="${escapeHtml(shadow.previewUrl || shadow.url)}" alt="" loading="lazy"><img class="render-composite-fabric" src="${escapeHtml(fabric.previewUrl || fabric.url)}" alt="${escapeHtml(model.name)} ${escapeHtml(fabric.camera || "render")} Fabric and Shadow combined" loading="lazy"></div><span>${escapeHtml(fabric.camera || "")} · Combined · RAW${issues.length ? " · Check" : ""}</span><small>Fabric over Shadow · click to open</small></button><button class="card-delete" type="button" aria-expanded="false" aria-label="Delete both layers" title="Delete both layers" data-delete-render="${escapeHtml([fabric.file, shadow.file].filter(Boolean).join("|"))}" data-delete-label="${escapeHtml(`${fabric.camera || "render"} Fabric and Shadow`)}">${TRASH_ICON}</button></div>`;
    };
    const materialLabel = render => {
      const selected = (render.materials || []).filter(Boolean);
      if (selected.length) return selected.join(" · ");
      if (render.material) return render.material;
      return render.name.match(/_Product_(.+?)(?:\.[^.]+)?$/i)?.[1]?.replaceAll("_", " ") || "Fabric";
    };
    const materialSets = new Map(), shadows = new Map();
    for (const render of model.renders) {
      if (render.layer === "Shadow") { shadows.set(render.camera || "Other", render); continue; }
      const label = materialLabel(render), key = JSON.stringify((render.materials || []).filter(Boolean).length ? render.materials : [label]);
      if (!materialSets.has(key)) materialSets.set(key, { label, renders: [] });
      materialSets.get(key).renders.push(render);
    }
    const sets = [...materialSets.values()];
    if (!sets.length && shadows.size) sets.push({ label: "Shadow", renders: [] });
    const currentSetIndex = Math.max(0, Math.min(state.galleryMaterialIndex, sets.length - 1));
    const slides = sets.map((set, index) => {
      const cameraSections = cameras.map(camera => {
        const fabric = set.renders.find(render => (render.camera || "Other") === camera), shadow = shadows.get(camera);
        const renders = [fabric, shadow].filter(Boolean);
        if (!renders.length) return "";
        return `<section class="render-camera-group"><div><strong>${escapeHtml(camera)}</strong><span>${fabric && shadow ? "Fabric · Shadow · Combined" : `${renders.length} layer${renders.length === 1 ? "" : "s"}`}</span></div><div>${renders.map(card).join("")}${combinedCard(fabric, shadow)}</div></section>`;
      }).join("");
      return `<article class="render-material-set" data-material-set="${index}" data-material-label="${escapeHtml(set.label)}" aria-label="Material set ${index + 1} of ${sets.length}">${cameraSections}</article>`;
    }).join("");
    const scrubberValue = sets.length <= 1 ? 0 : Math.round(currentSetIndex / (sets.length - 1) * 1000);
    $("renderGalleryImages").innerHTML = model.renders.length ? `<div class="render-material-carousel-shell" data-single="${sets.length <= 1}"><div class="render-material-carousel-heading"><span>${sets.length} material set${sets.length === 1 ? "" : "s"}</span><div class="render-material-navigation"><label class="render-material-select"><span>Material</span><select data-gallery-material-select aria-label="Choose material">${sets.map((set, index) => `<option value="${index}"${index === currentSetIndex ? " selected" : ""}>${escapeHtml(set.label)}</option>`).join("")}</select></label><button class="render-material-arrow previous" type="button" data-gallery-scroll="-1" aria-label="Previous material set">${CAROUSEL_PREVIOUS_ICON}</button><label class="render-material-scrubber" title="Drag to move through materials"><input type="range" min="0" max="1000" step="1" value="${scrubberValue}" data-gallery-scrubber aria-label="Material position"></label><button class="render-material-arrow next" type="button" data-gallery-scroll="1" aria-label="Next material set">${CAROUSEL_NEXT_ICON}</button><label class="render-material-page" style="--page-digits:${String(sets.length).length}"><input type="number" min="1" max="${sets.length}" value="${currentSetIndex + 1}" data-gallery-page aria-label="Material set page"><span>/ ${sets.length}</span></label></div></div><div class="render-material-viewport" data-at-start="true" data-at-end="${sets.length <= 1}"><div class="render-material-carousel" data-material-carousel tabindex="0" aria-label="Material render sets">${slides}</div></div></div>` : '<div class="empty-state">This model has no render files on disk yet.</div>';
    requestAnimationFrame(() => scrollGalleryMaterials(state.galleryMaterialIndex, false));
  };
  const updateGalleryMaterials = (carousel, index) => {
    const slides = [...carousel.querySelectorAll("[data-material-set]")];
    if (!slides.length) return;
    const current = Math.max(0, Math.min(index, slides.length - 1)), viewport = carousel.closest(".render-material-viewport"), shell = carousel.closest(".render-material-carousel-shell");
    state.galleryMaterialIndex = current;
    viewport.dataset.atStart = String(current === 0); viewport.dataset.atEnd = String(current === slides.length - 1);
    const page = shell.querySelector("[data-gallery-page]");
    if (page) { page.value = current + 1; page.setAttribute("aria-label", `Material set page ${current + 1} of ${slides.length}`); }
    const materialSelect = shell.querySelector("[data-gallery-material-select]");
    if (materialSelect) materialSelect.value = current;
    const scrubber = shell.querySelector("[data-gallery-scrubber]"), scrubberPosition = slides.length <= 1 ? 0 : current / (slides.length - 1);
    if (scrubber) {
      const scrubberIsMoving = scrubber.dataset.dragging === "true" || scrubber.dataset.animating === "true";
      if (!scrubberIsMoving) scrubber.value = Math.round(scrubberPosition * 1000);
      const progress = scrubberIsMoving ? Number(scrubber.value) / 10 : scrubberPosition * 100;
      scrubber.style.setProperty("--scrubber-progress", `${progress}%`);
    }
    shell.querySelector('[data-gallery-scroll="-1"]').disabled = current === 0; shell.querySelector('[data-gallery-scroll="1"]').disabled = current === slides.length - 1;
    slides.forEach((slide, slideIndex) => slide.toggleAttribute("data-active", slideIndex === current));
  };
  const galleryScrubberAnimations = new WeakMap();
  const galleryScrollSettleTimers = new WeakMap();
  const stopGalleryScrubberAnimation = scrubber => {
    const frame = galleryScrubberAnimations.get(scrubber);
    if (frame) cancelAnimationFrame(frame);
    galleryScrubberAnimations.delete(scrubber);
    delete scrubber.dataset.animating;
  };
  const setGalleryScrubberVisual = (scrubber, value) => {
    const next = Math.max(0, Math.min(1000, Math.round(value)));
    scrubber.value = next;
    scrubber.style.setProperty("--scrubber-progress", `${next / 10}%`);
  };
  const animateGalleryScrubber = (scrubber, targetValue) => {
    stopGalleryScrubberAnimation(scrubber);
    const startValue = Number(scrubber.value), target = Math.max(0, Math.min(1000, Math.round(targetValue))), distance = target - startValue;
    if (!distance) { setGalleryScrubberVisual(scrubber, target); return; }
    const startedAt = performance.now(), duration = 480;
    scrubber.dataset.animating = "true";
    const step = now => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 5);
      setGalleryScrubberVisual(scrubber, startValue + distance * eased);
      if (progress < 1) galleryScrubberAnimations.set(scrubber, requestAnimationFrame(step));
      else { galleryScrubberAnimations.delete(scrubber); delete scrubber.dataset.animating; setGalleryScrubberVisual(scrubber, target); }
    };
    galleryScrubberAnimations.set(scrubber, requestAnimationFrame(step));
  };
  const clearGalleryScrollTarget = carousel => {
    const timer = galleryScrollSettleTimers.get(carousel);
    if (timer) clearTimeout(timer);
    galleryScrollSettleTimers.delete(carousel);
    delete carousel.dataset.programmaticTarget;
  };
  const scheduleGalleryScrollSettle = (carousel, target, delay = 120) => {
    const previous = galleryScrollSettleTimers.get(carousel);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      galleryScrollSettleTimers.delete(carousel);
      delete carousel.dataset.programmaticTarget;
      updateGalleryMaterials(carousel, target);
    }, delay);
    galleryScrollSettleTimers.set(carousel, timer);
  };
  const scrollGalleryMaterials = (index, smooth = true, preserveScrubber = false) => {
    const carousel = $("renderGalleryImages").querySelector("[data-material-carousel]"), slides = carousel ? [...carousel.querySelectorAll("[data-material-set]")] : [];
    if (!slides.length) return;
    const current = Math.max(0, Math.min(index, slides.length - 1)), slide = slides[current];
    const scrubber = carousel.closest(".render-material-carousel-shell")?.querySelector("[data-gallery-scrubber]");
    const animated = smooth && !matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (scrubber && !preserveScrubber) {
      delete scrubber.dataset.dragging;
      const target = slides.length <= 1 ? 0 : current / (slides.length - 1) * 1000;
      if (animated) animateGalleryScrubber(scrubber, target);
      else { stopGalleryScrubberAnimation(scrubber); setGalleryScrubberVisual(scrubber, target); }
    }
    if (animated) {
      carousel.dataset.programmaticTarget = String(current);
      scheduleGalleryScrollSettle(carousel, current, 700);
    } else clearGalleryScrollTarget(carousel);
    const left = slide.getBoundingClientRect().left - carousel.getBoundingClientRect().left + carousel.scrollLeft;
    carousel.scrollTo({ left, behavior: animated ? "smooth" : "auto" }); updateGalleryMaterials(carousel, current);
  };
  const goToGalleryPage = value => {
    const carousel = $("renderGalleryImages").querySelector("[data-material-carousel]"), count = carousel?.querySelectorAll("[data-material-set]").length || 0;
    if (!count) return;
    const page = Math.max(1, Math.min(count, Math.round(Number(value) || 1)));
    scrollGalleryMaterials(page - 1, false);
  };
  const openCombinedPreview = card => {
    const popup = window.open("", "_blank");
    if (!popup) return toast("Allow pop-ups to open the combined preview", true);
    popup.opener = null;
    const title = card.dataset.combinedTitle || "Combined render", fabric = card.dataset.fabricUrl, shadow = card.dataset.shadowUrl, fabricWidth = Number(card.dataset.fabricWidth) || 33.333;
    popup.document.write(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>html,body{height:100%;margin:0;background:#121418;color:#e8e8e5;font:14px Inter,Segoe UI,sans-serif}body{display:grid;grid-template-rows:auto 1fr}.bar{padding:14px 18px;border-bottom:1px solid #343941}.stage{min-height:0;display:grid;place-items:center;padding:20px}.frame{position:relative;width:min(100%,calc((100vh - 84px)*3));aspect-ratio:3/1;overflow:hidden;background:#1a1e23}.frame img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}.frame .fabric{left:50%;width:${fabricWidth}%;transform:translateX(-50%)}</style></head><body><div class="bar">${escapeHtml(title)}</div><div class="stage"><div class="frame"><img src="${escapeHtml(shadow)}" alt=""><img class="fabric" src="${escapeHtml(fabric)}" alt="${escapeHtml(title)}"></div></div></body></html>`);
    popup.document.close();
  };
  const selectHistoryModel = model => {
    if (!model) return;
    if (state.historyModel?.name !== model.name) state.galleryMaterialIndex = 0;
    state.historyModel = model;
    renderGalleryModels(); renderGallery();
  };
  const selectHistoryBatch = batch => {
    state.galleryMaterialIndex = 0;
    state.historyBatch = batch; state.historySelection = new Set((batch.models || []).map(model => model.name));
    state.galleryBatch = batch; renderGalleryModels();
    renderHistoryList(); renderHistoryDetail();
    if (batch.models?.length) selectHistoryModel(batch.models[0]);
  };
  const viewHistoryJob = async batch => {
    const rawJsonTab = window.open(batch.jobUrl, "_blank");
    if (rawJsonTab) { rawJsonTab.opener = null; return; }
    const job = await api(batch.jobUrl); $("jobDialogTitle").textContent = batch.id; $("jobJson").textContent = JSON.stringify(job, null, 2); $("jobDialog").showModal();
  };
  // Jobs generated from now on record their product type. Older ones do not, but every
  // camera in them is shot in a scene that names it: Sofa_Indoor, Sectional_Indoor_<side>.
  const productTypeOfJob = (job, tasks) => {
    const recorded = job._rhLocal?.productType || (job._rhLocal?.models || [])[0]?.productType;
    if (recorded) return /sofa/i.test(recorded) ? "Sofas" : "Sectionals";
    const scene = [...tasks.flatMap(task => (task.sequence?.cameras || []).map(camera => camera.sequenceName)),
                   ...tasks.flatMap(task => (task.layers || []).flatMap(layer => layer.SubLevels || []))].find(Boolean) || "";
    return /^sofa/i.test(scene) ? "Sofas" : /^sectional/i.test(scene) ? "Sectionals" : "";
  };
  const editHistoryJob = async (batch, options = {}) => {
    const job = await api(batch.jobUrl), sourceTasks = job.tasks || [];
    await chooseRenderEnvironment(job._rhLocal?.renderEnvironment || job._rhLocal?.models?.[0]?.renderEnvironment || batch.renderEnvironment, true, true);
    const names = options.modelNames?.length ? new Set(options.modelNames) : null;
    const tasks = names ? sourceTasks.filter(task => names.has(task.taskId)) : sourceTasks;
    if (!tasks.length) throw new Error("This job has no models to edit");
    const metadataRows = job._rhLocal?.models || (job._rhLocal?.name ? [job._rhLocal] : []);
    const metadata = new Map(metadataRows.map(record => [record.name, record]));
    const archived = new Map((batch.models || []).map(model => [model.name, model]));
    const restored = [];
    for (const task of tasks) {
      const record = metadata.get(task.taskId) || archived.get(task.taskId) || {};
      const modelPath = record.modelPath || task.model?.objPath || "";
      const inspected = await inspectQuery(modelPath);
      restored.push({
        ...inspected, name: task.taskId || inspected.name, path: modelPath || inspected.path,
        dimensions: record.dimensions || inspected.dimensions, side: sectionalFormFactor(task.taskId, record.side || inspected.side),
        // Orientation fixes in current model metadata must supersede stale yaw
        // values embedded in an older saved job when it is loaded for editing.
        importYaw: Number.isFinite(+inspected.importYaw) ? +inspected.importYaw : (Number(record.importYaw) || 0),
      });
    }
    const materialValues = new Map(), multipliedIds = new Set();
    tasks.forEach(task => (task.materials || []).forEach(group => (group.list || []).forEach(material => (group.meshes || []).forEach(mesh => {
      const key = normalizedMaterialId(mesh).toLowerCase();
      if (!materialValues.has(key)) materialValues.set(key, new Set());
      materialValues.get(key).add(String(material.name || ""));
      if (group._rhLocalMultiply === true) multipliedIds.add(key);
    }))));
    const cameras = new Set(options.cameras?.length ? options.cameras : tasks.flatMap(task => (task.sequence?.cameras || []).map(camera => camera.name)));
    const recordedLayers = metadataRows.flatMap(record => record.selectedLayers || []);
    const layers = new Set(options.layers?.length ? options.layers : recordedLayers.length ? recordedLayers : tasks.flatMap(task => (task.layers || []).filter(layer => !layer.doNotRender && !layer._rhLocalPrefit).map(layer => layer.name)));
    state.batch = restored; state.jobPath = null; state.historyModel = null;
    $("materialsList").innerHTML = ""; renderMaterials(); selectModel(restored[0]);
    document.querySelectorAll("[data-material-group]").forEach(group => setMaterialValues(group.dataset.materialGroup, [...(materialValues.get(group.dataset.materialGroup) || [])], multipliedIds.has(group.dataset.materialGroup)));
    const jobProductType = productTypeOfJob(job, tasks);
    if (jobProductType && $("category").value !== jobProductType) { $("category").value = jobProductType; applyProductType(); }
    document.querySelectorAll('input[name="camera"]').forEach(input => input.checked = cameras.has(input.value));
    document.querySelectorAll('input[name="layer"]').forEach(input => input.checked = layers.has(input.value));
    const profile = String(job._rhLocal?.renderProfile || metadataRows[0]?.renderProfile || "").toLowerCase() || ((tasks[0]?.sequence?.cameras?.[0]?.LayerResolutions || []).some(layer => Number(layer.Resolution?.Y) <= 500) ? "low" : "high");
    document.querySelectorAll('input[name="renderProfile"]').forEach(input => input.checked = input.value === profile);
    document.querySelector('input[name="renderProfile"]:checked')?.dispatchEvent(new Event("change"));
    // After the profile, because switching it fills the fields from that profile.
    applyFrameSize(job._rhLocal?.baseFrame || metadataRows[0]?.baseFrame);
    const crop = String(job._rhLocal?.cropMode || metadataRows[0]?.cropMode || "full").toLowerCase();
    document.querySelectorAll('input[name="cropMode"]').forEach(input => input.checked = input.value === crop);
    const sides = new Set(restored.map(model => model.side).filter(side => ["R", "L", "U"].includes(side)));
    $("sceneSide").value = sides.size === 1 ? [...sides][0] : "auto";
    $("jobResult").hidden = true;
    validate(); document.querySelector(".workspace").scrollIntoView({ behavior: "smooth", block: "start" });
    const conflicts = [...materialValues.values()].filter(values => values.size > 1).length;
    toast(`Loaded ${restored.length} model${restored.length === 1 ? "" : "s"} for editing${conflicts ? ` · ${conflicts} material conflict${conflicts === 1 ? "" : "s"} need review` : ""}`);
  };
  const openLocal = (action, path) => api("/api/local/open", { method: "POST", body: JSON.stringify({ action, path }) });
  const loadHistory = async () => {
    try {
      const selectedId = state.historyBatch?.id, { batches, timing } = await api("/api/history");
      state.timing = timing || null;
      for (const batch of batches) {
        batch.jobUrl = apiUrl(batch.jobUrl);
        for (const item of batch.models || []) for (const render of item.renders || []) {
          render.url = apiUrl(render.url);
          if (render.previewUrl) render.previewUrl = apiUrl(render.previewUrl);
          if (render.processed?.url) render.processed.url = apiUrl(render.processed.url);
        }
      }
      state.history = batches;
      state.selectedJobs = new Set([...state.selectedJobs].filter(id => batches.some(batch => batch.id === id)));
      const selectedBatch = batches.find(batch => batch.id === selectedId) || batches[0] || null, changedBatch = state.historyBatch?.id !== selectedBatch?.id;
      state.historyBatch = selectedBatch;
      if (changedBatch || !state.historySelection.size) state.historySelection = new Set((selectedBatch?.models || []).map(model => model.name));
      renderHistoryList(); renderHistoryDetail();
      state.galleryBatch = selectedBatch; renderGalleryModels();
      if (state.historyModel && selectedBatch) {
        const updated = (selectedBatch.models || []).find(model => model.name === state.historyModel.name); if (updated) selectHistoryModel(updated);
      } else if (selectedBatch?.models?.length) selectHistoryModel(selectedBatch.models[0]);
    } catch (error) { $("historyList").innerHTML = `<div class="empty-state">History unavailable: ${escapeHtml(error.message)}</div>`; }
  };
  const refreshSheet = async () => {
    $("refreshSheet").disabled = true;
    try { const data = await api("/api/sheet/refresh", { method: "POST", body: "{}" }); $("sheetState").textContent = data.source === "live" ? "LIVE" : "CACHE"; toast(`Light data: ${data.rows} Sectionals / Indoor rows`); }
    catch (error) { toast(error.message, true); }
    finally { $("refreshSheet").disabled = false; }
  };
  const init = async () => {
    syncRenderEnvironment();
    applyProductType();
    fillFrameSize();
    try { await loadModelMetadata(); } catch (error) { console.warn(`Model metadata unavailable: ${error.message}`); }
    try { await loadMaterialAssets(); } catch (error) { console.warn(`Unreal materials unavailable: ${error.message}`); }
    if (!canReachLocalService) { setConnection(false); $("sheetState").textContent = "STATIC"; $("unrealState").textContent = "OFFLINE"; return; }
    try {
      const status = await api("/api/status"); state.status = status; state.models = status.models; state.renderEnvironments = status.renderEnvironments || [];
      syncRenderEnvironment();
      // Without the key the page is still fully readable, so it loads as usual and only
      // says that actions are out of reach.
      state.canAct = !status.access?.required || Boolean(status.access.authorized);
      setConnection(true);
      if (!state.canAct) $("connection").lastChild.textContent = " Read-only · key needed to act";
      $("modelCount").textContent = status.models.length; $("sheetState").textContent = status.sheet.source.toUpperCase();
      $("modelOptions").innerHTML = status.models.map(model => `<option value="${escapeHtml(model.path)}">${escapeHtml(model.name)}</option>`).join("");
      updateRender(status.render); loadHistory(); if (status.render.state === "running") startPolling();
    } catch { setConnection(false); $("sheetState").textContent = "OFFLINE"; $("unrealState").textContent = "OFFLINE"; }
  };
  // Both kinds of delete land here: the card names the target, the popover confirms it.
  document.addEventListener("click", event => {
    const trigger = event.target.closest(".card-delete");
    if (!trigger) return;
    event.preventDefault(); event.stopPropagation();
    const batchId = trigger.dataset.deleteBatch;
    if (batchId) {
      const batch = state.history.find(item => item.id === batchId);
      if (!batch) return;
      askDelete(trigger, {
        title: "Delete this batch?",
        detail: `${batch.id} — ${batch.modelCount} model${batch.modelCount === 1 ? "" : "s"}, ${batch.renderCount} render${batch.renderCount === 1 ? "" : "s"} and the job file. Cannot be undone.`,
        run: async () => {
          const result = await api("/api/renders/delete", { method: "POST", body: JSON.stringify({ jobPath: batch.jobPath }) });
          if (state.historyBatch?.id === batch.id) { state.historyBatch = null; state.galleryBatch = null; state.historyModel = null; }
          toast(`Deleted ${result.deleted.length} item${result.deleted.length === 1 ? "" : "s"}`);
          await loadHistory(); renderGalleryModels(); renderGallery();
        }
      });
      return;
    }
    const files = String(trigger.dataset.deleteRender || "").split("|").filter(Boolean);
    if (!files.length) return;
    askDelete(trigger, {
      title: files.length > 1 ? "Delete both layers?" : "Delete this render?",
      detail: `${trigger.dataset.deleteLabel || "render"} — ${files.length} file${files.length === 1 ? "" : "s"} plus its preview and POST copy. The batch and the job stay.`,
      run: async () => {
        for (const file of files) await api("/api/renders/delete", { method: "POST", body: JSON.stringify({ file }) });
        toast(`Deleted ${files.length} render${files.length === 1 ? "" : "s"}`);
        await loadHistory(); renderGalleryModels(); renderGallery();
      }
    });
  }, true);
  $("deleteConfirmCancel").addEventListener("click", closeDelete);
  $("deleteConfirmGo").addEventListener("click", async () => {
    const run = pendingDelete;
    closeDelete();
    if (!run) return;
    try { await run(); } catch (error) { toast(error.message, true); }
  });
  $("deleteConfirm").addEventListener("toggle", event => { if (event.newState === "closed") closeDelete(); });
  $("category").addEventListener("change", applyProductType);
  $("checkModels").addEventListener("click", checkModels);
  $("remeasureCrops").addEventListener("click", remeasureCrops);
  // Repeated clicks tour every model that needs attention, starting after the one in hand.
  $("checkJump").addEventListener("click", () => {
    const failing = needsAttention();
    if (!failing.length) return;
    const at = failing.findIndex(row => row.name === state.model?.name);
    const next = state.batch.find(model => model.name === failing[(at + 1) % failing.length].name);
    if (!next) return;
    selectModel(next);
    $("batchList").querySelector(`[data-model-path="${CSS.escape(next.path)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
  $("repairModels").addEventListener("click", repairModels);
  $("settingsToggle").addEventListener("click", () => {
    $("settingsAccessKey").value = ACCESS_KEY;
    $("settingsService").textContent = state.canAct === false ? "Read-only until the key is entered" : "Looking is open to everyone";
  });
  $("settingsSave").addEventListener("click", () => {
    ACCESS_KEY = $("settingsAccessKey").value.trim();
    settings.write("rhAccessKey", ACCESS_KEY);
    $("settingsPanel").hidePopover?.();
    toast(ACCESS_KEY ? "Access key saved" : "Access key cleared");
    init();
  });
  $("settingsClear").addEventListener("click", () => {
    ACCESS_KEY = ""; settings.write("rhAccessKey", ""); $("settingsAccessKey").value = "";
    $("settingsPanel").hidePopover?.(); toast("Access key cleared"); init();
  });
  $("inspectModel").addEventListener("click", inspect); $("modelPath").addEventListener("keydown", event => {
    // The shared suggestion handler owns Enter while an option is highlighted.
    // Otherwise Enter still inspects a manually typed model name or path.
    if (event.key === "Enter" && !event.target.hasAttribute("aria-activedescendant")) inspect();
  });
  $("chooseModel").addEventListener("click", () => $("modelFileInput").click());
  $("modelFileInput").addEventListener("change", event => { useDroppedModels(event.target.files); event.target.value = ""; });
  const dropTarget = $("modelDropTarget");
  ["dragenter", "dragover"].forEach(type => dropTarget.addEventListener(type, event => { event.preventDefault(); event.dataTransfer.dropEffect = "link"; dropTarget.dataset.dragging = "true"; }));
  dropTarget.addEventListener("dragleave", event => { if (!dropTarget.contains(event.relatedTarget)) delete dropTarget.dataset.dragging; });
  dropTarget.addEventListener("drop", event => { event.preventDefault(); delete dropTarget.dataset.dragging; useDroppedModels(event.dataTransfer.files, event.dataTransfer); });
  $("batchList").addEventListener("click", event => {
    const row = event.target.closest("[data-model-path]"); if (!row) return;
    const index = state.batch.findIndex(model => model.path === row.dataset.modelPath); if (index < 0) return;
    if (event.target.closest(".batch-model-remove")) {
      const [removed] = state.batch.splice(index, 1); state.jobPath = null;
      state.modelCheck = null; cachedChecksFor = null;
      if (state.model?.path === removed.path) state.model = state.batch[Math.min(index, state.batch.length - 1)] || null;
      renderMaterials(); renderBatch();
      if (state.model) selectModel(state.model); else { $("modelDetails").hidden = true; $("modelEmpty").hidden = false; $("modelPath").value = ""; }
      validate(); return;
    }
    if (event.target.closest(".batch-model-info")) {
      event.stopPropagation();
      selectModel(state.batch[index]);
      openFocusView($("batchList").children[index]?.querySelector(".batch-model-info"));
      return;
    }
    selectModel(state.batch[index]);
  });
  $("materialsList").addEventListener("click", event => {
    const group = event.target.closest("[data-material-group]"); if (!group) return;
    const multiply = event.target.closest("[data-material-multiply]");
    if (multiply) {
      multiply.setAttribute("aria-pressed", String(multiply.getAttribute("aria-pressed") !== "true"));
      state.jobPath = null; validate(); return;
    }
    if (event.target.closest("[data-add-material]")) {
      const container = group.querySelector("[data-material-variants]");
      container.insertAdjacentHTML("beforeend", materialVariantMarkup({ key: group.dataset.materialGroup }));
      const input = container.lastElementChild.querySelector("[data-material-key]"); bindMaterialInput(input); syncMaterialGroup(group);
      state.jobPath = null; validate(false); input.focus(); return;
    }
    const remove = event.target.closest("[data-remove-material]");
    if (remove && !remove.disabled) {
      remove.closest(".material-variant").remove(); syncMaterialGroup(group); state.jobPath = null; validate();
    }
  });
  [["width", "width"], ["depth", "depth"], ["height", "height"]].forEach(([id, key]) => $(id).addEventListener("input", () => { if (state.model && +$(id).value > 0) { state.model.dimensions[key] = +$(id).value; renderBatch(); validate(); } }));
  $("importYaw").addEventListener("input", () => { if (state.model) { state.model.importYaw = +$("importYaw").value || 0; validate(); } });
  $("generateJob").addEventListener("click", generate); $("launchRender").addEventListener("click", () => launch()); $("refreshSheet").addEventListener("click", refreshSheet); $("refreshMaterials").addEventListener("click", refreshMaterials);
  $("retryRender").addEventListener("click", () => launch(true)); $("stopRender").addEventListener("click", stopRender);
  document.querySelectorAll('input[name="renderProfile"]').forEach(input => input.addEventListener("change", () => {
    fillFrameSize();
    state.jobPath = null; $("jobResult").hidden = true; validate();
  }));
  $("resetFrameSize").addEventListener("click", () => { fillFrameSize(); state.jobPath = null; $("jobResult").hidden = true; validate(); toast("Frame size back to the profile"); });
  for (const ids of Object.values(FRAME_FIELDS)) for (const id of [...ids.res, ...ids.sensor]) {
    $(id).addEventListener("input", () => { describeFrameSize(); state.jobPath = null; $("jobResult").hidden = true; validate(false); });
  }
  // A popover lives in the top layer, so it does not scroll with the thing it belongs to and
  // looks like it is chasing the page. Anchoring means re-placing it while it is open — and
  // only once it is open, because a closed popover is display:none and measures as zero.
  $("copyJobPath").addEventListener("click", async () => { await navigator.clipboard.writeText(state.jobPath || ""); toast("Job path copied"); });
  $("refreshHistory").addEventListener("click", loadHistory);
  $("historySearch").addEventListener("input", renderHistoryList); $("historyFilter").addEventListener("change", renderHistoryList);
  $("historyList").addEventListener("click", event => {
    const picker = event.target.closest("[data-select-job]");
    if (picker) {
      const id = picker.dataset.selectJob;
      if (state.selectedJobs.has(id)) state.selectedJobs.delete(id); else state.selectedJobs.add(id);
      renderHistoryList(); return;
    }
    const card = event.target.closest("[data-history-id]"); if (!card) return;
    const batch = state.history.find(item => item.id === card.dataset.historyId); if (batch) selectHistoryBatch(batch);
  });
  $("toggleJobSelection").addEventListener("click", () => { state.jobSelectionMode = !state.jobSelectionMode; renderHistoryList(); });
  $("clearJobSelection").addEventListener("click", () => { state.selectedJobs.clear(); renderHistoryList(); });
  $("addJobsToQueue").addEventListener("click", async () => {
    const jobPaths = state.history.filter(batch => state.selectedJobs.has(batch.id)).map(batch => batch.jobPath);
    if (!jobPaths.length) return;
    try {
      const result = await api("/api/job-queue", { method: "POST", body: JSON.stringify({ action: "add", jobPaths }) });
      renderJobQueue(result); state.selectedJobs.clear(); state.jobSelectionMode = false; renderHistoryList();
      toast(result.added ? `${result.added} job${result.added === 1 ? "" : "s"} added to queue` : "Those jobs are already queued");
    } catch (error) { toast(error.message, true); }
  });
  const runQueueAction = async action => {
    try { renderJobQueue(await api("/api/job-queue", { method: "POST", body: JSON.stringify({ action }) })); if (["retry", "skip"].includes(action)) startPolling(); }
    catch (error) { toast(error.message, true); }
  };
  $("retryQueue").addEventListener("click", () => runQueueAction("retry"));
  $("skipQueue").addEventListener("click", () => runQueueAction("skip"));
  $("clearQueue").addEventListener("click", () => runQueueAction("clear"));
  $("jobQueueList").addEventListener("click", async event => {
    const button = event.target.closest("[data-remove-queue]"); if (!button) return;
    try { renderJobQueue(await api("/api/job-queue", { method: "POST", body: JSON.stringify({ action: "remove", itemId: button.dataset.removeQueue }) })); }
    catch (error) { toast(error.message, true); }
  });
  $("historyDetail").addEventListener("click", async event => {
    const button = event.target.closest("[data-history-action]"), batch = state.historyBatch; if (!button || !batch) return;
    event.preventDefault();
    const action = button.dataset.historyAction;
    try {
      if (action === "edit") await editHistoryJob(batch);
      else if (action === "selectAll") { state.historySelection = new Set((batch.models || []).map(model => model.name)); renderHistoryDetail(); }
      else if (action === "selectNone") { state.historySelection.clear(); renderHistoryDetail(); }
      else if (action === "selective") {
        const cameras = [...document.querySelectorAll("[data-select-camera]:checked")].map(input => input.value), layers = [...document.querySelectorAll("[data-select-layer]:checked")].map(input => input.value);
        if (!state.historySelection.size) throw new Error("Select at least one model");
        if (!cameras.length || !layers.length) throw new Error("Select at least one camera and layer");
        await editHistoryJob(batch, { modelNames: [...state.historySelection], cameras, layers });
      }
      else if (action === "rerun") { await chooseRenderEnvironment(batch.renderEnvironment, true, true); state.jobPath = batch.jobPath; $("jobResult").hidden = false; $("copyJobPath").textContent = batch.jobPath; await launch(); }
      else if (action === "postprocess") { const result = await api("/api/postprocess", { method: "POST", body: JSON.stringify({ jobPath: batch.jobPath }) }); toast("POST recovery started; RAW originals stay unchanged"); updateRender(result); startPolling(); }
      else if (action === "viewJob") await viewHistoryJob(batch);
      else if (action === "showJob") { await openLocal("showJob", batch.jobPath); toast("JSON selected in Explorer"); }

      else if (action === "openReady") { await openLocal("openRenders", batch.readyToUpload?.folder); toast("POST folder opened"); }
      else if (action === "openRenders") { await openLocal("openRenders", batch.outputFolder); toast("Render folder opened"); }
    } catch (error) { toast(error.message, true); }
  });
  $("historyDetail").addEventListener("change", event => {
    const input = event.target.closest("[data-history-model-select]"); if (!input) return;
    if (input.checked) state.historySelection.add(input.dataset.historyModelSelect); else state.historySelection.delete(input.dataset.historyModelSelect);
  });
  $("galleryModels").addEventListener("click", event => {
    const button = event.target.closest("[data-gallery-model-index]"); if (!button || !state.galleryBatch) return;
    selectHistoryModel(state.galleryBatch.models[+button.dataset.galleryModelIndex]);
  });
  $("renderGalleryImages").addEventListener("click", event => {
    const step = event.target.closest("[data-gallery-scroll]");
    if (step) { scrollGalleryMaterials(state.galleryMaterialIndex + Number(step.dataset.galleryScroll)); return; }
    const combined = event.target.closest("[data-fabric-url][data-shadow-url]");
    if (combined) openCombinedPreview(combined);
  });
  $("renderGalleryImages").addEventListener("change", event => {
    if (event.target.matches("[data-gallery-page]")) { goToGalleryPage(event.target.value); return; }
    if (event.target.matches("[data-gallery-material-select]")) scrollGalleryMaterials(Number(event.target.value), false);
    if (event.target.matches("[data-gallery-scrubber]")) {
      const carousel = $("renderGalleryImages").querySelector("[data-material-carousel]"), count = carousel?.querySelectorAll("[data-material-set]").length || 1;
      stopGalleryScrubberAnimation(event.target);
      delete event.target.dataset.dragging;
      scrollGalleryMaterials(Math.round(Number(event.target.value) / 1000 * (count - 1)), false);
    }
  });
  $("renderGalleryImages").addEventListener("input", event => {
    if (event.target.matches("[data-gallery-scrubber]")) {
      const carousel = $("renderGalleryImages").querySelector("[data-material-carousel]"), count = carousel?.querySelectorAll("[data-material-set]").length || 1;
      stopGalleryScrubberAnimation(event.target);
      event.target.dataset.dragging = "true";
      event.target.style.setProperty("--scrubber-progress", `${Number(event.target.value) / 10}%`);
      scrollGalleryMaterials(Math.round(Number(event.target.value) / 1000 * (count - 1)), false, true);
    }
  });
  let galleryScrollFrame = 0;
  $("renderGalleryImages").addEventListener("scroll", event => {
    const carousel = event.target.closest?.("[data-material-carousel]"); if (!carousel) return;
    cancelAnimationFrame(galleryScrollFrame); galleryScrollFrame = requestAnimationFrame(() => {
      const programmaticTarget = carousel.dataset.programmaticTarget;
      if (programmaticTarget !== undefined) {
        scheduleGalleryScrollSettle(carousel, Number(programmaticTarget));
        return;
      }
      const slides = [...carousel.querySelectorAll("[data-material-set]")], left = carousel.scrollLeft;
      const carouselLeft = carousel.getBoundingClientRect().left;
      const nearest = slides.reduce((best, slide, index) => { const distance = Math.abs(slide.getBoundingClientRect().left - carouselLeft); return distance < best.distance ? { index, distance } : best; }, { index: 0, distance: Infinity });
      updateGalleryMaterials(carousel, nearest.index);
    });
  }, true);
  $("renderGalleryImages").addEventListener("keydown", event => {
    if (event.target.matches("[data-gallery-page]") && event.key === "Enter") { event.preventDefault(); goToGalleryPage(event.target.value); return; }
    if (!event.target.matches("[data-material-carousel]") || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault(); scrollGalleryMaterials(state.galleryMaterialIndex + (event.key === "ArrowRight" ? 1 : -1));
  });
  $("closeJobDialog").addEventListener("click", () => $("jobDialog").close());
  $("jobDialog").addEventListener("click", event => { if (event.target === $("jobDialog")) $("jobDialog").close(); });
  const focusView = { source: null, placeholder: null, moved: [], trigger: null };
  const closeFocusView = () => {
    if (!focusView.source || !focusView.placeholder) return;
    if (focusView.moved.length === 1 && focusView.moved[0] === focusView.source) {
      focusView.placeholder.replaceWith(focusView.source);
    } else {
      focusView.moved.forEach(node => focusView.source.insertBefore(node, focusView.placeholder));
      focusView.placeholder.remove();
    }
    focusView.source = null; focusView.placeholder = null; focusView.moved = [];
    $("focusDialogBody").replaceChildren();
    delete $("focusDialog").dataset.focusKind;
  };
  const openFocusView = trigger => {
    const source = document.querySelector(trigger.dataset.focusSource);
    // `close` is queued by the browser. Keep a second dialog from opening in the
    // short gap after `.close()` clears `open` but before the live nodes are restored.
    if (!source || $("focusDialog").open || focusView.source) return;
    const moveSelf = trigger.dataset.focusMove === "self";
    const placeholder = document.createElement("div");
    placeholder.className = "focus-placeholder";
    placeholder.textContent = `${trigger.dataset.focusTitle} is open in focus view.`;
    const moved = moveSelf ? [source] : [...source.children].filter(node => !node.matches(".panel-heading,.model-batch-heading"));
    if (!moved.length) return;
    if (moveSelf) source.before(placeholder); else source.insertBefore(placeholder, moved[0]);
    moved.forEach(node => $("focusDialogBody").append(node));
    focusView.source = source; focusView.placeholder = placeholder; focusView.moved = moved; focusView.trigger = trigger;
    $("focusDialogTitle").textContent = trigger.dataset.focusTitle;
    $("focusDialog").dataset.focusKind = trigger.dataset.focusKind || "details";
    $("focusDialog").showModal();
    requestAnimationFrame(() => $("closeFocusDialog").focus({ preventScroll: true }));
  };
  document.addEventListener("click", event => {
    const trigger = event.target.closest("[data-focus-source]");
    if (trigger) openFocusView(trigger);
  });
  $("closeFocusDialog").addEventListener("click", () => $("focusDialog").close());
  $("focusDialog").addEventListener("click", event => { if (event.target === $("focusDialog")) $("focusDialog").close(); });
  $("focusDialog").addEventListener("close", () => {
    const trigger = focusView.trigger;
    closeFocusView();
    focusView.trigger = null;
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  });
  document.querySelectorAll("[data-theme-value]").forEach(button => button.addEventListener("click", () => applyTheme(button.dataset.themeValue, true)));
  document.querySelectorAll("button[data-render-environment]").forEach(button => button.addEventListener("click", () => chooseRenderEnvironment(button.dataset.renderEnvironment)));
  applyTheme(document.documentElement.dataset.theme);
  /* ── suggestion popups ────────────────────────────────────────────────────
     A native datalist popup cannot be styled, cannot be animated, and cuts long
     Unreal asset paths off, so inputs that carry a `list` are upgraded to their own
     listbox on first focus: the datalist stays as the data source, the popup is ours.
     It lives in the top layer as a popover, so a row inside a scrolling list can open
     it without being clipped. */
  const suggest = { input: null, items: [], index: -1, pop: null, anchored: null, committing: false };
  const suggestPop = () => {
    if (suggest.pop) return suggest.pop;
    const pop = document.createElement("div");
    pop.id = "suggestPop"; pop.className = "suggest-pop"; pop.setAttribute("popover", "manual"); pop.setAttribute("role", "listbox");
    pop.addEventListener("mousedown", event => {
      const item = event.target.closest("[data-suggest-value]");
      if (!item) return;
      event.preventDefault(); commitSuggestion(item.dataset.suggestValue);
    });
    pop.addEventListener("mousemove", event => {
      const item = event.target.closest("[data-suggest-value]");
      if (item) setSuggestIndex([...pop.children].indexOf(item), false);
    });
    document.body.append(pop); suggest.pop = pop; return pop;
  };
  // The datalist stays the data source either way; `list` would also make the browser
  // open its own popup over ours, so it is traded for data-suggest on sight.
  const adoptSuggestInput = target => {
    const input = target?.closest?.("input[list],input[data-suggest]");
    if (input?.hasAttribute("list")) { input.dataset.suggest = input.getAttribute("list"); input.removeAttribute("list"); }
    return input || null;
  };
  const suggestSource = input => {
    const list = input.dataset.suggest && $(input.dataset.suggest);
    return list ? [...list.options].map(option => ({ value: option.value, label: option.textContent })) : [];
  };
  const closeSuggestions = () => {
    const input = suggest.input;
    if (!input) return;
    suggest.input = null; suggest.items = []; suggest.index = -1;
    input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant");
    anchorSuggestions(null);
    if (suggest.pop?.matches(":popover-open")) suggest.pop.hidePopover();
  };
  const setSuggestIndex = (index, scroll = true) => {
    const options = [...(suggest.pop?.children || [])].filter(node => node.dataset.suggestValue !== undefined);
    if (!options.length) return;
    suggest.index = (index + options.length) % options.length;
    options.forEach((node, position) => {
      const active = position === suggest.index;
      node.classList.toggle("active", active); node.setAttribute("aria-selected", active ? "true" : "false");
      if (!active) return node.removeAttribute("id");
      node.id = "suggestActive"; suggest.input?.setAttribute("aria-activedescendant", "suggestActive");
      if (scroll) node.scrollIntoView({ block: "nearest" });
    });
  };
  // The list is anchored to the input in CSS, so all this has to do is say which input
  // is the anchor. Only one element may carry the name, or the browser has two to choose
  // between.
  const anchorSuggestions = input => {
    if (suggest.anchored && suggest.anchored !== input) suggest.anchored.style.anchorName = "";
    if (input) input.style.anchorName = "--suggest-anchor";
    suggest.anchored = input || null;
  };
  const renderSuggestions = input => {
    const query = input.value.trim().toLowerCase(), nameFirst = input.dataset.suggestPrimary === "label";
    const matches = suggestSource(input).filter(item => !query || item.value.toLowerCase().includes(query) || item.label.toLowerCase().includes(query));
    if (!matches.length) return closeSuggestions();
    const shown = matches.slice(0, 80), pop = suggestPop();
    pop.innerHTML = shown.map(item => {
      const title = nameFirst ? item.label : item.value, meta = nameFirst ? item.value : item.label;
      return `<div class="suggest-item" role="option" aria-selected="false" data-suggest-value="${escapeHtml(item.value)}"><b>${escapeHtml(title)}</b>${meta && meta !== title ? `<small>${escapeHtml(meta)}</small>` : ""}</div>`;
    }).join("") + (matches.length > shown.length ? `<p class="suggest-more">${matches.length - shown.length} more · keep typing to narrow</p>` : "");
    suggest.input = input; suggest.items = shown; suggest.index = -1;
    input.setAttribute("role", "combobox"); input.setAttribute("aria-controls", "suggestPop");
    input.setAttribute("aria-autocomplete", "list"); input.setAttribute("aria-expanded", "true");
    anchorSuggestions(input);
    if (!pop.matches(":popover-open")) pop.showPopover();
  };
  const commitSuggestion = value => {
    const input = suggest.input;
    if (!input) return;
    input.value = value; closeSuggestions();
    suggest.committing = true;
    input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true }));
    suggest.committing = false; input.focus();
    if (input.dataset.suggestAction === "inspect-model") inspect();
  };
  document.addEventListener("focusin", event => {
    adoptSuggestInput(event.target);
    if (suggest.input && event.target !== suggest.input && !event.target.closest?.(".suggest-pop")) closeSuggestions();
  });
  document.addEventListener("input", event => {
    if (suggest.committing) return;
    const input = event.target.closest?.("input[data-suggest]");
    if (input) renderSuggestions(input);
  });
  document.addEventListener("pointerdown", event => {
    const input = adoptSuggestInput(event.target);
    if (input) { if (suggest.input !== input) requestAnimationFrame(() => renderSuggestions(input)); return; }
    if (!event.target.closest?.(".suggest-pop")) closeSuggestions();
  });
  document.addEventListener("keydown", event => {
    const input = event.target.closest?.("input[data-suggest]");
    if (!input) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (suggest.input !== input) return renderSuggestions(input);
      const step = event.key === "ArrowDown" ? 1 : -1;
      setSuggestIndex(suggest.index < 0 ? (step === 1 ? 0 : -1) : suggest.index + step);
    } else if (event.key === "Enter" && suggest.input === input && suggest.index >= 0) {
      event.preventDefault(); commitSuggestion(suggest.items[suggest.index].value);
    } else if (event.key === "Escape" && suggest.input === input) { event.preventDefault(); closeSuggestions(); }
    else if (event.key === "Tab") closeSuggestions();
  });
  document.querySelectorAll("input,select").forEach(node => node.addEventListener("change", validate));
  init();
})();
