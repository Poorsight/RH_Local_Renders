(() => {
  const $ = (id) => document.getElementById(id);
  const state = { status: null, models: [], metadata: null, materialAssets: [], preflight: null, preflightTimer: null, batch: [], model: null, jobPath: null, poll: null, history: [], historyBatch: null, historySelection: new Set(), historyModel: null, galleryBatch: null, queueFocus: null };
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
  const materialRows = () => [...document.querySelectorAll("[data-material-ids]")].map(node => ({ meshes: JSON.parse(node.dataset.materialIds), material: node.value.trim() }));
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
  const syncActionButtons = basicReady => {
    const ready = basicReady && state.preflight?.ok === true;
    $("generateJob").disabled = !ready;
    $("launchRender").disabled = !state.jobPath;
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
    const basicReady = canReachLocalService && state.batch.length > 0 && materialRows().length > 0 && materialRows().every(row => row.material) && selected("camera").length && selected("layer").length;
    if (!basicReady) return false;
    renderPreflight(null);
    try { state.preflight = await api("/api/preflight", { method: "POST", body: JSON.stringify(payload()) }); }
    catch (error) { state.preflight = { ok: false, checks: [{ level: "error", label: "Local service", detail: error.message }], counts: { expectedRenders: 0 } }; }
    renderPreflight(state.preflight); syncActionButtons(basicReady); return state.preflight.ok;
  };
  const validate = (runCheck = true) => {
    const ready = canReachLocalService && state.batch.length > 0 && materialRows().length > 0 && materialRows().every(row => row.material) && selected("camera").length && selected("layer").length;
    if (!ready) { state.preflight = null; renderPreflight({ waiting: true, ok: false, checks: [], counts: { expectedRenders: 0 } }); }
    else if (runCheck) {
      state.preflight = null; renderPreflight(null); clearTimeout(state.preflightTimer);
      state.preflightTimer = setTimeout(refreshPreflight, 260);
    }
    if (!ready) state.jobPath = null;
    syncActionButtons(ready);
  };
  const updateMaterialStatus = input => {
    const asset = materialAsset(input.value), status = input.closest(".material-row")?.querySelector("[data-material-status]");
    input.dataset.assetState = !input.value.trim() ? "empty" : asset ? "found" : "missing";
    if (status) { status.dataset.state = input.dataset.assetState; status.textContent = !input.value.trim() ? "Enter material" : asset ? "Found" : "Missing"; status.title = asset?.path || "No matching .uasset in the Unreal project"; }
  };
  const renderMaterials = () => {
    const previous = new Map([...document.querySelectorAll("[data-material-key]")].map(node => [node.dataset.materialKey, node.value]));
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
      return `<label class="material-row"><span class="material-id"><b>${escapeHtml(item.label)}</b><small>${modelCount} model${modelCount === 1 ? "" : "s"} · ${sourceIds.length} component ID${sourceIds.length === 1 ? "" : "s"}</small></span><span class="material-input-wrap"><input list="materialOptions" data-material-key="${escapeHtml(item.key)}" data-material-ids="${escapeHtml(JSON.stringify(sourceIds))}" value="${escapeHtml(previous.get(item.key) || "")}" placeholder="Search Unreal materials" autocomplete="off"><em data-material-status>Enter material</em></span></label>`;
    }).join("");
    document.querySelectorAll("[data-material-key]").forEach(input => { updateMaterialStatus(input); input.addEventListener("input", () => { updateMaterialStatus(input); validate(); }); });
  };
  // Checks the models about to be rendered, not the whole library: what matters is whether
  // this batch will come out right.
  const LEVEL_ORDER = { error: 0, warning: 1, info: 2, ok: 3 };
  const renderModelCheck = report => {
    const panel = $("modelCheck");
    panel.hidden = !report;
    if (!report) return;
    const rows = (report.models || []).slice().sort((a, b) => (b.errors - a.errors) || (b.warnings - a.warnings) || a.name.localeCompare(b.name));
    $("modelCheckSummary").textContent = report.failing
      ? `${report.failing} of ${report.checked} need attention`
      : report.warning ? `${report.checked} checked · ${report.warning} with warnings` : `${report.checked} checked · all sound`;
    const repairable = rows.some(row => (row.findings || []).some(finding => finding.repairable));
    $("repairModels").hidden = !repairable;
    $("modelCheckList").innerHTML = rows.map(row => {
      const findings = (row.findings || []).slice().sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
      const worst = findings[0]?.level || "ok";
      return `<div class="model-check-row" data-worst="${escapeHtml(worst)}"><strong>${escapeHtml(row.name)}${row.format ? `<small>${escapeHtml(row.format)}${row.group ? ` · ${escapeHtml(row.group)}` : ""}</small>` : ""}</strong>${findings.map(finding => `<div class="model-check-finding" data-level="${escapeHtml(finding.level)}"><i>${escapeHtml(finding.level)}</i><span>${escapeHtml(finding.label)}: ${escapeHtml(finding.detail)}</span></div>`).join("")}</div>`;
    }).join("");
  };
  const checkModels = async () => {
    const names = state.batch.map(model => model.name);
    if (!names.length) { toast("Add models to the batch first", true); return; }
    const button = $("checkModels");
    button.disabled = true; button.textContent = "Checking…";
    try {
      const report = await api("/api/models/check", { method: "POST", body: JSON.stringify({ models: names }) });
      state.modelCheck = report; renderModelCheck(report);
      toast(report.failing ? `${report.failing} model${report.failing === 1 ? "" : "s"} need attention` : "All models look sound");
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
    const summary = $("frameSizeSummary"), toggle = $("frameSizeToggle");
    summary.textContent = custom.length ? custom.join("   ") : `${currentProfile() === "low" ? "500" : "5000"} px at a 36 mm sensor, from the profile`;
    summary.dataset.state = custom.length ? "custom" : "profile";
    toggle.dataset.state = custom.length ? "custom" : "profile";
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
  const renderBatch = () => {
    if (state.modelCheck) { state.modelCheck = null; renderModelCheck(null); }
    $("modelBatch").hidden = !state.batch.length; $("batchCount").textContent = `${state.batch.length} model${state.batch.length === 1 ? "" : "s"}`;
    $("batchList").innerHTML = state.batch.map(model => `<div class="batch-model${state.model?.path === model.path ? " active" : ""}" data-model-path="${escapeHtml(model.path)}"><button class="batch-model-select" type="button" title="Open ${escapeHtml(model.name)}"><span>${escapeHtml(model.name)}</span><small>${model.dimensions.width} × ${model.dimensions.depth} × ${model.dimensions.height} cm · ${escapeHtml(model.materialIds.length)} IDs</small></button><button class="batch-model-remove" type="button" title="Remove ${escapeHtml(model.name)}" aria-label="Remove ${escapeHtml(model.name)}">×</button></div>`).join("");
  };
  const selectModel = model => {
    state.model = model; state.historyModel = null;
    $("modelEmpty").hidden = true; $("modelDetails").hidden = false;
    $("inspectedName").textContent = model.name; $("modelSide").textContent = model.side || "Unknown side";
    $("width").value = model.dimensions.width; $("depth").value = model.dimensions.depth; $("height").value = model.dimensions.height; $("importYaw").value = model.importYaw;
    $("modelPath").value = model.path;
    $("modelWarning").hidden = !model.warning; $("modelWarning").textContent = model.warning || "";
    
    renderBatch(); validate();
  };
  const applyModel = (model, quiet = false) => {
    state.jobPath = null;
    const index = state.batch.findIndex(item => item.path.toLowerCase() === model.path.toLowerCase());
    if (index >= 0) state.batch[index] = model; else state.batch.push(model);
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
  const loadMaterialAssets = async () => {
    if (!canReachLocalService) return;
    const result = await api("/api/materials"); state.materialAssets = result.materials || [];
    $("materialOptions").innerHTML = state.materialAssets.map(asset => `<option value="${escapeHtml(asset.name)}">${escapeHtml(asset.path)}</option>`).join("");
    document.querySelectorAll("[data-material-key]").forEach(updateMaterialStatus);
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
    try {
      const result = await api("/api/renders", { method: "POST", body: JSON.stringify({ jobPath: state.jobPath, resume }) });
      toast(resume ? "Resuming incomplete models in Unreal" : `Unreal started (PID ${result.pid})`); updateRender(result); startPolling();
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
  const updateRender = (render) => {
    state.status ||= {}; state.status.render = render;
    const badge = $("renderBadge"), box = $("renderStatus"), log = $("renderLog"), progress = $("renderProgress");
    badge.dataset.state = render.state; badge.textContent = render.state === "running" && render.phase ? render.phase : ({running:"Rendering",success:"Complete",failed:"Failed",stopped:"Stopped",idle:"Idle"})[render.state] || render.state;
    box.dataset.state = render.state;
    const phase = render.phase ? ` · ${render.phase}${render.phaseCount > 1 ? ` (${render.phaseIndex}/${render.phaseCount})` : ""}` : "";
    const title = render.state === "running" ? (render.phase === "Post-processing" ? "Preparing delivery images" : `Unreal is rendering${phase}`) : render.state === "success" ? (render.postProcess?.state === "failed" ? "Render completed · post-process needs attention" : "Render completed") : render.state === "failed" ? "Render stopped with an error" : render.state === "stopped" ? "Render stopped by hand" : "No active render";
    const substrate = render.state === "running" && typeof render.substrate === "boolean" ? `Substrate ${render.substrate ? "ON" : "OFF"} · ` : "";
    const current = [render.currentTask, render.currentCamera].filter(Boolean).join(" · ");
    box.querySelector("strong").textContent = title; box.querySelector("span").textContent = current || (render.jobPath ? `${substrate}${render.jobPath}` : "Generate a job, then launch it in Unreal Engine 5.6.");
    const total = Number(render.totalRenders || 0), rendered = Number(render.rendered || 0), postTotal = Number(render.postProcess?.total || 0), postCompleted = Number(render.postProcess?.completed || 0);
    const percent = render.postProcess?.state === "running" && postTotal ? Math.min(100, postCompleted / postTotal * 100) : total ? Math.min(100, rendered / total * 100) : render.state === "success" ? 100 : 0;
    progress.hidden = render.state === "idle" && !render.jobPath;
    $("renderProgressLabel").textContent = render.postProcess?.state === "running" ? `${render.postProcess.completed} / ${render.postProcess.total} processed` : total ? `${rendered} / ${total} frames` : `${rendered} frames`;
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
    $("retryRender").hidden = !["failed", "stopped"].includes(render.state) || !render.jobPath;
    $("retryRender").textContent = render.state === "stopped" ? "Resume stopped job" : "Retry failed job";
    log.hidden = false; log.textContent = render.log || "";
    if (render.state !== "running" && state.poll) { clearInterval(state.poll); state.poll = null; loadHistory(); }
  };
  const startPolling = () => { if (state.poll) clearInterval(state.poll); state.poll = setInterval(async () => { try { updateRender(await api("/api/renders/status")); } catch {} }, 2000); };
  const formatDate = value => {
    const date = new Date(value); if (Number.isNaN(date.getTime())) return "Unknown time";
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
  };
  const historyStateLabel = value => ({ complete: "Complete", partial: "Partial", running: "Rendering", failed: "Failed", ready: "Job ready", invalid: "Invalid" })[value] || value;
  const TRASH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12M10.5 10.5v6M13.5 10.5v6"/></svg>';
  // One popover for every delete on the page: the card only says what is being removed,
  // the confirmation lives here so no card has to carry a second state of its own.
  let pendingDelete = null, pendingAnchor = null;
  const askDelete = (trigger, { title, detail, run }) => {
    pendingDelete = run;
    $("deleteConfirmTitle").textContent = title;
    $("deleteConfirmBody").textContent = detail;
    const pop = $("deleteConfirm");
    pop.showPopover?.();
    const side = anchorPopover(pop, trigger, "right");
    pendingAnchor = () => anchorPopover(pop, trigger, "right", side);
    window.addEventListener("scroll", pendingAnchor, { passive: true, capture: true });
    window.addEventListener("resize", pendingAnchor);
    trigger.setAttribute("aria-expanded", "true");
  };
  const closeDelete = () => {
    pendingDelete = null;
    if (pendingAnchor) {
      window.removeEventListener("scroll", pendingAnchor, { capture: true });
      window.removeEventListener("resize", pendingAnchor);
      pendingAnchor = null;
    }
    $("deleteConfirm").hidePopover?.();
    document.querySelectorAll('.card-delete[aria-expanded="true"]').forEach(button => button.setAttribute("aria-expanded", "false"));
  };
  const renderHistoryList = () => {
    const query = $("historySearch").value.trim().toLowerCase(), filter = $("historyFilter").value;
    const batches = state.history.filter(batch => (filter === "all" || batch.state === filter) && (!query || batch.id.toLowerCase().includes(query) || (batch.models || []).some(model => model.name.toLowerCase().includes(query))));
    $("historyCount").textContent = batches.length === state.history.length ? `${state.history.length} job${state.history.length === 1 ? "" : "s"}` : `${batches.length} of ${state.history.length}`;
    $("historyList").innerHTML = batches.length ? batches.map(batch => `<div class="card-shell"><button class="history-card${state.historyBatch?.id === batch.id ? " active" : ""}" type="button" data-history-id="${escapeHtml(batch.id)}"><span class="history-card-top"><strong>${escapeHtml(batch.id)}</strong><i class="history-state" data-state="${escapeHtml(batch.state)}">${escapeHtml(historyStateLabel(batch.state))}</i></span><span class="history-card-meta"><b>${batch.modelCount} model${batch.modelCount === 1 ? "" : "s"}</b><b>${batch.renderCount}/${batch.expectedRenders} renders · ${batch.postProcessCount || 0} POST</b></span><small>${escapeHtml(formatDate(batch.updatedAt || batch.generatedAt))}</small></button><button class="card-delete" type="button" aria-expanded="false" aria-label="Delete this batch" title="Delete batch" data-delete-batch="${escapeHtml(batch.id)}">${TRASH_ICON}</button></div>`).join("") : '<div class="empty-state">No jobs match this filter.</div>';
  };
  const renderHistoryDetail = () => {
    const batch = state.historyBatch;
    if (!batch) { $("historyDetail").innerHTML = '<div class="empty-state">Choose a saved job to inspect its models, JSON, and render output.</div>'; return; }
    const models = batch.models?.length ? `<div class="history-model-list" aria-label="Models in ${escapeHtml(batch.id)}">${batch.models.map((model, index) => `<div class="history-model-row"><label><input type="checkbox" data-history-model-select="${escapeHtml(model.name)}"${state.historySelection.has(model.name) ? " checked" : ""}><span>${String(index + 1).padStart(2, "0")}</span><strong>${escapeHtml(model.name)}</strong><small>${escapeHtml(model.side || "UNKNOWN")} · ${model.dimensions ? `${model.dimensions.width} × ${model.dimensions.depth} × ${model.dimensions.height} cm` : "No dimensions"} · ${model.renders.length}/${model.expectedRenders}</small></label></div>`).join("")}</div>` : '<div class="empty-state history-model-empty">No models stored in this job.</div>';
    const selective = `<div class="selective-controls"><div><span>SELECTIVE RENDER</span><button type="button" data-history-action="selectAll">All</button><button type="button" data-history-action="selectNone">None</button></div><div class="selective-options"><label><input type="checkbox" data-select-camera value="F" checked><span>F</span></label><label><input type="checkbox" data-select-camera value="FH" checked><span>FH</span></label><label><input type="checkbox" data-select-camera value="TQ" checked><span>TQ</span></label><i></i><label><input type="checkbox" data-select-layer value="Fabric" checked><span>Fabric</span></label><label><input type="checkbox" data-select-layer value="Shadow" checked><span>Shadow</span></label></div></div>`;
    const needsPost = batch.renderCount > 0 && (batch.postProcessCount < batch.renderCount || !batch.readyToUpload?.complete);
    const openOutput = batch.readyToUpload?.files ? `<button class="secondary-button" type="button" data-history-action="openReady">Open POST</button>` : `<button class="secondary-button" type="button" data-history-action="openRenders"${batch.renderCount ? "" : " disabled"}>Open renders</button>`;
    $("historyDetail").innerHTML = `<div class="history-detail-heading"><div><span>SAVED JOB</span><strong>${escapeHtml(batch.id)}</strong><small>${escapeHtml(formatDate(batch.generatedAt))}</small></div><i class="history-state" data-state="${escapeHtml(batch.state)}">${escapeHtml(historyStateLabel(batch.state))}</i></div><div class="history-summary"><div><span>MODELS</span><strong>${batch.modelCount}</strong></div><div><span>RENDERS</span><strong>${batch.renderCount}/${batch.expectedRenders}</strong></div><div><span>POST</span><strong>${batch.postProcessCount || 0}/${batch.renderCount}</strong></div></div>${selective}${models}${batch.error ? `<p class="inline-warning">${escapeHtml(batch.error)}</p>` : ""}<code class="history-path" title="${escapeHtml(batch.jobPath)}">${escapeHtml(batch.jobPath)}</code><div class="history-actions"><button class="primary-button" type="button" data-history-action="selective"${batch.modelCount ? "" : " disabled"}>Edit selection</button><button class="secondary-button" type="button" data-history-action="rerun"${batch.state === "invalid" ? " disabled" : ""}>Run again</button>${needsPost ? `<button class="secondary-button" type="button" data-history-action="postprocess">Build POST</button>` : ""}${openOutput}<button class="quiet-button" type="button" data-history-action="viewJob">View JSON</button></div>`;
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
    $("renderGalleryImages").innerHTML = model.renders.length ? cameras.map(camera => {
      const renders = model.renders.filter(render => (render.camera || "Other") === camera).sort((left, right) => (left.layer === "Shadow" ? 1 : 0) - (right.layer === "Shadow" ? 1 : 0) || left.name.localeCompare(right.name));
      const fabric = renders.find(render => render.layer === "Fabric"), shadow = renders.find(render => render.layer === "Shadow");
      return `<section class="render-camera-group"><div><strong>${escapeHtml(camera)}</strong><span>${fabric && shadow ? "Fabric · Shadow · Combined" : `${renders.length} layer${renders.length === 1 ? "" : "s"}`}</span></div><div>${renders.map(card).join("")}${combinedCard(fabric, shadow)}</div></section>`;
    }).join("") : '<div class="empty-state">This model has no render files on disk yet.</div>';
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
    state.historyModel = model;
    renderGalleryModels(); renderGallery();
  };
  const selectHistoryBatch = batch => {
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
  const editHistoryJob = async (batch, options = {}) => {
    const job = await api(batch.jobUrl), sourceTasks = job.tasks || [];
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
    const materialValues = new Map();
    tasks.forEach(task => (task.materials || []).forEach(group => (group.list || []).forEach(material => (group.meshes || []).forEach(mesh => {
      const key = normalizedMaterialId(mesh).toLowerCase();
      if (!materialValues.has(key)) materialValues.set(key, new Set());
      materialValues.get(key).add(String(material.name || ""));
    }))));
    const cameras = new Set(options.cameras?.length ? options.cameras : tasks.flatMap(task => (task.sequence?.cameras || []).map(camera => camera.name)));
    const recordedLayers = metadataRows.flatMap(record => record.selectedLayers || []);
    const layers = new Set(options.layers?.length ? options.layers : recordedLayers.length ? recordedLayers : tasks.flatMap(task => (task.layers || []).filter(layer => !layer.doNotRender && !layer._rhLocalPrefit).map(layer => layer.name)));
    state.batch = restored; state.jobPath = null; state.historyModel = null;
    $("materialsList").innerHTML = ""; renderMaterials(); selectModel(restored[0]);
    document.querySelectorAll("[data-material-key]").forEach(input => {
      const values = materialValues.get(input.dataset.materialKey); input.value = values?.size === 1 ? [...values][0] : ""; updateMaterialStatus(input);
    });
    document.querySelectorAll('input[name="camera"]').forEach(input => input.checked = cameras.has(input.value));
    document.querySelectorAll('input[name="layer"]').forEach(input => input.checked = layers.has(input.value));
    const profile = String(job._rhLocal?.renderProfile || metadataRows[0]?.renderProfile || "").toLowerCase() || ((tasks[0]?.sequence?.cameras?.[0]?.LayerResolutions || []).some(layer => Number(layer.Resolution?.Y) <= 500) ? "low" : "high");
    document.querySelectorAll('input[name="renderProfile"]').forEach(input => input.checked = input.value === profile);
    document.querySelector('input[name="renderProfile"]:checked')?.dispatchEvent(new Event("change"));
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
      const selectedId = state.historyBatch?.id, { batches } = await api("/api/history");
      for (const batch of batches) {
        batch.jobUrl = apiUrl(batch.jobUrl);
        for (const item of batch.models || []) for (const render of item.renders || []) {
          render.url = apiUrl(render.url);
          if (render.previewUrl) render.previewUrl = apiUrl(render.previewUrl);
          if (render.processed?.url) render.processed.url = apiUrl(render.processed.url);
        }
      }
      state.history = batches;
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
    applyProductType();
    fillFrameSize();
    try { await loadModelMetadata(); } catch (error) { console.warn(`Model metadata unavailable: ${error.message}`); }
    try { await loadMaterialAssets(); } catch (error) { console.warn(`Unreal materials unavailable: ${error.message}`); }
    if (!canReachLocalService) { setConnection(false); $("sheetState").textContent = "STATIC"; $("unrealState").textContent = "OFFLINE"; return; }
    try {
      const status = await api("/api/status"); state.status = status; state.models = status.models;
      // Without the key the page is still fully readable, so it loads as usual and only
      // says that actions are out of reach.
      state.canAct = !status.access?.required || Boolean(status.access.authorized);
      setConnection(true);
      if (!state.canAct) $("connection").lastChild.textContent = " Read-only · key needed to act";
      $("modelCount").textContent = status.models.length; $("sheetState").textContent = status.sheet.source.toUpperCase(); $("unrealState").textContent = status.unreal.available ? "READY" : "MISSING";
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
  $("closeModelCheck").addEventListener("click", () => { state.modelCheck = null; renderModelCheck(null); });
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
  $("inspectModel").addEventListener("click", inspect); $("modelPath").addEventListener("keydown", event => { if (event.key === "Enter") inspect(); });
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
      if (state.model?.path === removed.path) state.model = state.batch[Math.min(index, state.batch.length - 1)] || null;
      renderMaterials(); renderBatch();
      if (state.model) selectModel(state.model); else { $("modelDetails").hidden = true; $("modelEmpty").hidden = false; $("modelPath").value = ""; }
      validate(); return;
    }
    selectModel(state.batch[index]);
  });
  [["width", "width"], ["depth", "depth"], ["height", "height"]].forEach(([id, key]) => $(id).addEventListener("input", () => { if (state.model && +$(id).value > 0) { state.model.dimensions[key] = +$(id).value; renderBatch(); validate(); } }));
  $("importYaw").addEventListener("input", () => { if (state.model) { state.model.importYaw = +$("importYaw").value || 0; validate(); } });
  $("generateJob").addEventListener("click", generate); $("launchRender").addEventListener("click", launch); $("refreshSheet").addEventListener("click", refreshSheet);
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
  // The side is decided once, when it opens. Re-deciding on every scroll makes the panel hop
  // from under the button to above it and back as room appears.
  const anchorPopover = (pop, trigger, align = "left", side = null) => {
    const box = trigger.getBoundingClientRect(), { width, height } = pop.getBoundingClientRect();
    const clamp = (value, max) => Math.max(12, Math.min(Math.max(12, max - 12), value));
    const above = side ? side === "above" : box.bottom + height + 12 > window.innerHeight;
    const left = align === "right" ? box.right - width : box.left;
    pop.style.left = `${clamp(left, window.innerWidth - width)}px`;
    pop.style.top = `${clamp(above ? box.top - height - 8 : box.bottom + 8, window.innerHeight - height)}px`;
    return above ? "above" : "below";
  };
  const pinPopover = (popId, triggerId, align) => {
    const pop = $(popId);
    let follow = null;
    pop.addEventListener("toggle", event => {
      if (event.newState === "open") {
        const side = anchorPopover(pop, $(triggerId), align);
        follow = () => anchorPopover(pop, $(triggerId), align, side);
        window.addEventListener("scroll", follow, { passive: true, capture: true });
        window.addEventListener("resize", follow);
      } else if (follow) {
        window.removeEventListener("scroll", follow, { capture: true });
        window.removeEventListener("resize", follow);
        follow = null;
      }
    });
  };
  pinPopover("frameSizePanel", "frameSizeToggle");
  $("copyJobPath").addEventListener("click", async () => { await navigator.clipboard.writeText(state.jobPath || ""); toast("Job path copied"); });
  $("refreshHistory").addEventListener("click", loadHistory);
  $("historySearch").addEventListener("input", renderHistoryList); $("historyFilter").addEventListener("change", renderHistoryList);
  $("historyList").addEventListener("click", event => {
    const card = event.target.closest("[data-history-id]"); if (!card) return;
    const batch = state.history.find(item => item.id === card.dataset.historyId); if (batch) selectHistoryBatch(batch);
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
      else if (action === "rerun") { state.jobPath = batch.jobPath; $("jobResult").hidden = false; $("copyJobPath").textContent = batch.jobPath; await launch(); }
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
    const combined = event.target.closest("[data-fabric-url][data-shadow-url]");
    if (combined) openCombinedPreview(combined);
  });
  $("closeJobDialog").addEventListener("click", () => $("jobDialog").close());
  $("jobDialog").addEventListener("click", event => { if (event.target === $("jobDialog")) $("jobDialog").close(); });
  document.querySelectorAll("[data-theme-value]").forEach(button => button.addEventListener("click", () => applyTheme(button.dataset.themeValue, true)));
  applyTheme(document.documentElement.dataset.theme);
  /* ── suggestion popups ────────────────────────────────────────────────────
     A native datalist popup cannot be styled, cannot be animated, and cuts long
     Unreal asset paths off, so inputs that carry a `list` are upgraded to their own
     listbox on first focus: the datalist stays as the data source, the popup is ours.
     It lives in the top layer as a popover, so a row inside a scrolling list can open
     it without being clipped. */
  const suggest = { input: null, items: [], index: -1, pop: null, committing: false };
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
  const suggestSource = input => {
    const list = input.dataset.suggest && $(input.dataset.suggest);
    return list ? [...list.options].map(option => ({ value: option.value, label: option.textContent })) : [];
  };
  const closeSuggestions = () => {
    const input = suggest.input;
    if (!input) return;
    suggest.input = null; suggest.items = []; suggest.index = -1;
    input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant");
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
  const placeSuggestions = () => {
    const input = suggest.input, pop = suggest.pop;
    if (!input || !pop) return;
    const rect = input.getBoundingClientRect(), width = Math.min(Math.max(rect.width, 300), window.innerWidth - 24);
    const below = window.innerHeight - rect.bottom - 16, above = rect.top - 16, up = below < 190 && above > below;
    pop.style.width = `${Math.round(width)}px`;
    pop.style.left = `${Math.round(Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)))}px`;
    pop.style.maxHeight = `${Math.round(Math.max(150, Math.min(326, up ? above : below)))}px`;
    pop.dataset.flip = up ? "up" : "down";
    if (up) { pop.style.top = "auto"; pop.style.bottom = `${Math.round(window.innerHeight - rect.top + 7)}px`; }
    else { pop.style.bottom = "auto"; pop.style.top = `${Math.round(rect.bottom + 7)}px`; }
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
    if (!pop.matches(":popover-open")) pop.showPopover();
    placeSuggestions();
  };
  const commitSuggestion = value => {
    const input = suggest.input;
    if (!input) return;
    input.value = value; closeSuggestions();
    suggest.committing = true;
    input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true }));
    suggest.committing = false; input.focus();
  };
  document.addEventListener("focusin", event => {
    const input = event.target.closest?.("input[list]");
    if (input) { input.dataset.suggest = input.getAttribute("list"); input.removeAttribute("list"); }
    if (suggest.input && event.target !== suggest.input && !event.target.closest?.(".suggest-pop")) closeSuggestions();
  });
  document.addEventListener("input", event => {
    if (suggest.committing) return;
    const input = event.target.closest?.("input[data-suggest]");
    if (input) renderSuggestions(input);
  });
  document.addEventListener("pointerdown", event => {
    const input = event.target.closest?.("input[data-suggest]");
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
  window.addEventListener("resize", () => placeSuggestions());
  document.addEventListener("scroll", () => placeSuggestions(), true);
  document.querySelectorAll("input,select").forEach(node => node.addEventListener("change", validate));
  init();
})();
