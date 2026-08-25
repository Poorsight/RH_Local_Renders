(() => {
  const $ = (id) => document.getElementById(id);
  const state = { status: null, models: [], metadata: null, materialAssets: [], preflight: null, preflightTimer: null, batch: [], model: null, jobPath: null, poll: null, history: [], historyBatch: null, historySelection: new Set(), historyModel: null, queueFocus: null };
  const canReachLocalService = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  const LOCAL_MODELS_ROOT = "D:\\GitHub\\RH_Local_Renders\\local\\models";
  const THEME_KEY = "rh-local-renders-theme";
  const applyTheme = theme => {
    const allowed = ["light", "system", "dark"], value = allowed.includes(theme) ? theme : "system";
    document.documentElement.dataset.theme = value;
    document.querySelectorAll("[data-theme-value]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.themeValue === value)));
    try { localStorage.setItem(THEME_KEY, value); } catch {}
  };
  const api = async (path, options = {}) => {
    const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
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
    environment: $("environment").value,
    side: $("sceneSide").value, sourceMode: $("sourceMode").value, renderProfile: selected("renderProfile")[0] || "high", cropMode: selected("cropMode")[0] || "full",
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
  const renderBatch = () => {
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
    const value = String(query || "").trim(), needle = value.split(/[\\/]/).pop().replace(/\.fbx$/i, "").toLowerCase();
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
    if (/^[a-z]:[\\/].+\.fbx$/i.test(directPath)) return directPath.replace(/\//g, "\\");
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
    const selectedFiles = [...(files || [])], fbxFiles = selectedFiles.filter(file => /\.fbx$/i.test(file.name || ""));
    if (!fbxFiles.length) { status.dataset.state = "error"; status.textContent = "Choose one or more FBX model files."; return toast(status.textContent, true); }
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
  const updateRender = (render) => {
    state.status ||= {}; state.status.render = render;
    const badge = $("renderBadge"), box = $("renderStatus"), log = $("renderLog"), progress = $("renderProgress");
    badge.dataset.state = render.state; badge.textContent = render.state === "running" && render.phase ? render.phase : ({running:"Rendering",success:"Complete",failed:"Failed",idle:"Idle"})[render.state] || render.state;
    box.dataset.state = render.state;
    const phase = render.phase ? ` · ${render.phase}${render.phaseCount > 1 ? ` (${render.phaseIndex}/${render.phaseCount})` : ""}` : "";
    const title = render.state === "running" ? (render.phase === "Post-processing" ? "Preparing delivery images" : `Unreal is rendering${phase}`) : render.state === "success" ? (render.postProcess?.state === "failed" ? "Render completed · post-process needs attention" : "Render completed") : render.state === "failed" ? "Render stopped with an error" : "No active render";
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
    $("retryRender").hidden = render.state !== "failed" || !render.jobPath;
    log.hidden = false; log.textContent = render.log || "";
    if (render.state !== "running" && state.poll) { clearInterval(state.poll); state.poll = null; loadHistory(); }
  };
  const startPolling = () => { if (state.poll) clearInterval(state.poll); state.poll = setInterval(async () => { try { updateRender(await api("/api/renders/status")); } catch {} }, 2000); };
  const formatDate = value => {
    const date = new Date(value); if (Number.isNaN(date.getTime())) return "Unknown time";
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
  };
  const historyStateLabel = value => ({ complete: "Complete", partial: "Partial", running: "Rendering", failed: "Failed", ready: "Job ready", invalid: "Invalid" })[value] || value;
  const renderHistoryList = () => {
    const query = $("historySearch").value.trim().toLowerCase(), filter = $("historyFilter").value;
    const batches = state.history.filter(batch => (filter === "all" || batch.state === filter) && (!query || batch.id.toLowerCase().includes(query) || (batch.models || []).some(model => model.name.toLowerCase().includes(query))));
    $("historyCount").textContent = batches.length === state.history.length ? `${state.history.length} job${state.history.length === 1 ? "" : "s"}` : `${batches.length} of ${state.history.length}`;
    $("historyList").innerHTML = batches.length ? batches.map(batch => `<button class="history-card${state.historyBatch?.id === batch.id ? " active" : ""}" type="button" data-history-id="${escapeHtml(batch.id)}"><span class="history-card-top"><strong>${escapeHtml(batch.id)}</strong><i class="history-state" data-state="${escapeHtml(batch.state)}">${escapeHtml(historyStateLabel(batch.state))}</i></span><span class="history-card-meta"><b>${batch.modelCount} model${batch.modelCount === 1 ? "" : "s"}</b><b>${batch.renderCount}/${batch.expectedRenders} renders · ${batch.postProcessCount || 0} POST</b></span><small>${escapeHtml(formatDate(batch.updatedAt || batch.generatedAt))}</small></button>`).join("") : '<div class="empty-state">No jobs match this filter.</div>';
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
  const selectHistoryModel = model => {
    if (!model) return;
    state.historyModel = model;
  };
  const selectHistoryBatch = batch => {
    state.historyBatch = batch; state.historySelection = new Set((batch.models || []).map(model => model.name));
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
        sourceMode: record.sourceMode || inspected.sourceMode || "B"
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
    $("sourceMode").value = restored[0].sourceMode || "B"; $("jobResult").hidden = true;
    validate(); document.querySelector(".workspace").scrollIntoView({ behavior: "smooth", block: "start" });
    const conflicts = [...materialValues.values()].filter(values => values.size > 1).length;
    toast(`Loaded ${restored.length} model${restored.length === 1 ? "" : "s"} for editing${conflicts ? ` · ${conflicts} material conflict${conflicts === 1 ? "" : "s"} need review` : ""}`);
  };
  const openLocal = (action, path) => api("/api/local/open", { method: "POST", body: JSON.stringify({ action, path }) });
  const loadHistory = async () => {
    try {
      const selectedId = state.historyBatch?.id, { batches } = await api("/api/history"); state.history = batches;
      const selectedBatch = batches.find(batch => batch.id === selectedId) || batches[0] || null, changedBatch = state.historyBatch?.id !== selectedBatch?.id;
      state.historyBatch = selectedBatch;
      if (changedBatch || !state.historySelection.size) state.historySelection = new Set((selectedBatch?.models || []).map(model => model.name));
      renderHistoryList(); renderHistoryDetail();
    } catch (error) { $("historyList").innerHTML = `<div class="empty-state">History unavailable: ${escapeHtml(error.message)}</div>`; }
  };
  const refreshSheet = async () => {
    $("refreshSheet").disabled = true;
    try { const data = await api("/api/sheet/refresh", { method: "POST", body: "{}" }); $("sheetState").textContent = data.source === "live" ? "LIVE" : "CACHE"; toast(`Light data: ${data.rows} Sectionals / Indoor rows`); }
    catch (error) { toast(error.message, true); }
    finally { $("refreshSheet").disabled = false; }
  };
  const init = async () => {
    try { await loadModelMetadata(); } catch (error) { console.warn(`Model metadata unavailable: ${error.message}`); }
    try { await loadMaterialAssets(); } catch (error) { console.warn(`Unreal materials unavailable: ${error.message}`); }
    if (!canReachLocalService) { setConnection(false); $("sheetState").textContent = "STATIC"; $("unrealState").textContent = "OFFLINE"; return; }
    try {
      const status = await api("/api/status"); state.status = status; state.models = status.models; setConnection(true);
      $("modelCount").textContent = status.models.length; $("sheetState").textContent = status.sheet.source.toUpperCase(); $("unrealState").textContent = status.unreal.available ? "READY" : "MISSING";
      $("modelOptions").innerHTML = status.models.map(model => `<option value="${escapeHtml(model.path)}">${escapeHtml(model.name)}</option>`).join("");
      updateRender(status.render); loadHistory(); if (status.render.state === "running") startPolling();
    } catch { setConnection(false); $("sheetState").textContent = "OFFLINE"; $("unrealState").textContent = "OFFLINE"; }
  };
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
      if (state.model) selectModel(state.model); else { $("modelDetails").hidden = true; $("modelEmpty").hidden = false; $("rigUseModel").disabled = true; $("modelPath").value = ""; }
      validate(); return;
    }
    selectModel(state.batch[index]);
  });
  [["width", "width"], ["depth", "depth"], ["height", "height"]].forEach(([id, key]) => $(id).addEventListener("input", () => { if (state.model && +$(id).value > 0) { state.model.dimensions[key] = +$(id).value; renderBatch(); validate(); } }));
  $("importYaw").addEventListener("input", () => { if (state.model) { state.model.importYaw = +$("importYaw").value || 0; validate(); } });
  $("generateJob").addEventListener("click", generate); $("launchRender").addEventListener("click", launch); $("refreshSheet").addEventListener("click", refreshSheet);
  $("retryRender").addEventListener("click", () => launch(true));
  document.querySelectorAll('input[name="renderProfile"]').forEach(input => input.addEventListener("change", () => {
    const low = input.checked && input.value === "low";
    $("fabricResolutionLabel").textContent = low ? "Path Trace · 500" : "Path Trace · 5K";
    $("shadowResolutionLabel").textContent = low ? "Lumen · 1.5K×500" : "Lumen · 15K×5K";
    state.jobPath = null; $("jobResult").hidden = true; validate();
  }));
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
  $("closeJobDialog").addEventListener("click", () => $("jobDialog").close());
  $("jobDialog").addEventListener("click", event => { if (event.target === $("jobDialog")) $("jobDialog").close(); });
  document.querySelectorAll("[data-theme-value]").forEach(button => button.addEventListener("click", () => applyTheme(button.dataset.themeValue)));
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
