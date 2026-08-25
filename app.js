(() => {
  const $ = (id) => document.getElementById(id);
  const state = { status: null, models: [], metadata: null, materialAssets: [], preflight: null, preflightTimer: null, batch: [], model: null, jobPath: null, poll: null, rig: null, history: [], historyBatch: null, historySelection: new Set(), rigBatch: null, historyModel: null };
  const canReachLocalService = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  const LOCAL_MODELS_ROOT = "D:\\GitHub\\RH_Local_Renders\\local\\models";
  const RIG_REFERENCE = { width: 453, depth: 279, height: 79 };
  const RIG_GEOMETRY = {
    front_fill_lgt: { type: "rect", width: 500, height: 500, radius: 282.094791774 },
    left_rim_lgt: { type: "spot", radius: 256, soft: 25 },
    main_key_lgt: { type: "spot", radius: 52.479965 },
    right_bounce_lgt: { type: "rect", width: 256, height: 256, radius: 144.432533388 },
    right_rim_lgt: { type: "rect", width: 91.440002, height: 60.900002, radius: 42.101913103 }
  };
  const RIG_META = {
    front_fill_lgt: { label: "Front fill", role: "fill", color: "#7f9fb9", kelvin: 6500 },
    left_rim_lgt: { label: "Left rim", role: "rim", color: "#a08eae", kelvin: 6500 },
    main_key_lgt: { label: "Main key", role: "key", color: "#d1b477", kelvin: 6500 },
    right_bounce_lgt: { label: "Bounce", role: "bounce", color: "#88a98c", kelvin: 6000 },
    right_rim_lgt: { label: "Right rim", role: "rim", color: "#74a5a2", kelvin: 6500 }
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
    side: $("sceneSide").value, sourceMode: $("sourceMode").value, renderProfile: selected("renderProfile")[0] || "high",
    dimensions: { width: +$("width").value, depth: +$("depth").value, height: +$("height").value },
    importYaw: +$("importYaw").value || 0,
    cameras: selected("camera"), layers: selected("layer"), materials: materialRows()
  });
  const updatePipelineSummary = () => {
    const cameras = selected("camera").length, layers = selected("layer"), models = state.batch.length;
    const expected = models * cameras * layers.length;
    $("pipelineSummary").textContent = models ? `${models} model${models === 1 ? "" : "s"} · ${expected} render${expected === 1 ? "" : "s"}` : "No models selected";
    $("pipelineDetail").textContent = models ? `${selected("renderProfile")[0] === "low" ? "Low" : "High"} · ${layers.join(" → ") || "No layers"} · ${state.preflight?.ok ? "Ready" : "Preflight required"}` : "Add FBX models to prepare a render job.";
  };
  const syncActionButtons = basicReady => {
    const ready = basicReady && state.preflight?.ok === true;
    $("generateJob").disabled = !ready; $("stickyGenerate").disabled = !ready;
    $("launchRender").disabled = !state.jobPath; $("stickyLaunch").disabled = !state.jobPath;
    updatePipelineSummary();
  };
  const renderPreflight = result => {
    const panel = $("preflight"), checks = result?.checks || [];
    panel.dataset.state = result?.waiting ? "idle" : !result ? "checking" : result.ok ? "ready" : checks.some(check => check.level === "error") ? "error" : "warning";
    $("preflightState").textContent = result?.waiting ? "Waiting for setup" : !result ? "Checking…" : result.ok ? `${result.counts.expectedRenders} renders ready` : `${checks.filter(check => check.level === "error").length} issue${checks.filter(check => check.level === "error").length === 1 ? "" : "s"}`;
    $("preflightChecks").innerHTML = checks.length ? checks.map(check => `<span data-level="${escapeHtml(check.level)}"><b>${escapeHtml(check.label)}</b><small>${escapeHtml(check.detail)}</small></span>`).join("") : `<span>${result?.waiting ? "Add models and material assignments to validate the job." : "Checking models, materials, lights, output, and Unreal…"}</span>`;
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
    $("rigUseModel").disabled = false; syncRigFromModel();
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
  const parseCsv = (text) => {
    const rows = []; let row = [], cell = "", quoted = false;
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (char === '"') {
        if (quoted && text[index + 1] === '"') { cell += '"'; index++; } else quoted = !quoted;
      } else if (char === "," && !quoted) { row.push(cell); cell = ""; }
      else if ((char === "\n" || char === "\r") && !quoted) {
        if (char === "\r" && text[index + 1] === "\n") index++;
        row.push(cell); if (row.some(value => value !== "")) rows.push(row); row = []; cell = "";
      } else cell += char;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    const headers = rows.shift() || [];
    return rows.map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] || ""])));
  };
  const listValues = (value) => String(value || "").split(",").map(part => part.trim()).filter(Boolean);
  const buildClientRig = (rows) => {
    const rig = {};
    rows.filter(row => row.active === "TRUE" && row.airtable_categories === "Sectionals" && row.environment === "Indoor").forEach(row => {
      const light = {
        name: row.light_name,
        position: [+row.default_x, +row.default_y, +row.default_z],
        rotation: { pitch: +row.default_pitch, yaw: +row.default_yaw, roll: +row.default_roll },
        intensity: +row.default_intensity,
        innerCone: row.default_InnerConeAngle === "" ? -1 : +row.default_InnerConeAngle,
        outerCone: row.default_OuterConeAngle === "" ? -1 : +row.default_OuterConeAngle,
        shadow: {
          position: row.shadow_x === "" ? null : [+row.shadow_x, +row.shadow_y, +row.shadow_z],
          rotation: row.shadow_pitch === "" ? null : { pitch: +row.shadow_pitch, yaw: +row.shadow_yaw, roll: +row.shadow_roll },
          intensity: row.shadow_intensity === "" ? null : +row.shadow_intensity,
          innerCone: row.shadow_InnerConeAngle === "" ? null : +row.shadow_InnerConeAngle,
          outerCone: row.shadow_OuterConeAngle === "" ? null : +row.shadow_OuterConeAngle
        }
      };
      listValues(row.sequence_prefix).forEach(scene => listValues(row.camera).forEach(camera => {
        if (!["F", "FH", "TQ"].includes(camera)) return;
        rig[scene] ||= {}; rig[scene][camera] ||= {}; rig[scene][camera][light.name] = light;
      }));
    });
    return rig;
  };
  const kelvinColor = (kelvin) => {
    const temperature = kelvin / 100; let red, green, blue;
    if (temperature <= 66) { red = 255; green = 99.4708025861 * Math.log(temperature) - 161.1195681661; blue = temperature <= 19 ? 0 : 138.5177312231 * Math.log(temperature - 10) - 305.0447927307; }
    else { red = 329.698727446 * Math.pow(temperature - 60, -0.1332047592); green = 288.1221695283 * Math.pow(temperature - 60, -0.0755148492); blue = 255; }
    const hex = value => Math.max(0, Math.min(255, Math.round(value || 0))).toString(16).padStart(2, "0");
    return `#${hex(red)}${hex(green)}${hex(blue)}`;
  };
  const currentRigShot = () => document.querySelector('input[name="rigShot"]:checked')?.value || "F";
  const rigDimensions = () => ({
    width: Math.max(1, +$("rigWidth").value || RIG_REFERENCE.width),
    depth: Math.max(1, +$("rigDepth").value || RIG_REFERENCE.depth),
    height: Math.max(1, +$("rigHeight").value || RIG_REFERENCE.height)
  });
  const currentRig = () => {
    const shot = currentRigShot(), dimensions = rigDimensions(), mode = $("rigMode").value, layer = selected("rigLayer")[0] || "Fabric";
    const side = shot === "TQR" ? "R" : shot === "TQL" ? "L" : sideFromModel();
    const camera = shot.startsWith("TQ") ? "TQ" : shot;
    const scene = `Sectional_Indoor_${side}`;
    const source = state.rig?.[scene]?.[camera];
    if (!source) return null;
    const raw = Math.cbrt((dimensions.width / RIG_REFERENCE.width) * (dimensions.depth / RIG_REFERENCE.depth) * (dimensions.height / RIG_REFERENCE.height));
    const scale = Math.max(1, raw);
    const lights = Object.entries(source).map(([name, light]) => {
      const shadow = layer === "Shadow" ? light.shadow || {} : {}, basePosition = shadow.position || light.position, baseRotation = shadow.rotation || light.rotation;
      const baseIntensity = shadow.intensity ?? light.intensity, innerCone = shadow.innerCone ?? light.innerCone, outerCone = shadow.outerCone ?? light.outerCone;
      const geometry = RIG_GEOMETRY[name] || {}, [x, y, z] = basePosition;
      const distance2 = x * x + y * y + z * z, radius2 = (geometry.radius || 0) ** 2;
      const intensity = mode === "A" ? baseIntensity * scale * scale : baseIntensity * ((scale * scale * distance2 + radius2) / (distance2 + radius2));
      return { ...light, name, rotation: baseRotation, position: [x * scale, y * scale, z], intensity, innerCone, outerCone, changedForShadow: layer === "Shadow" && (shadow.intensity != null || shadow.innerCone != null || shadow.outerCone != null || shadow.position || shadow.rotation), geometry, meta: RIG_META[name] };
    });
    return { shot, side, camera, dimensions, mode, layer, raw, scale, lights, sofaYaw: shot === "TQR" ? -36 : shot === "TQL" ? 36 : 0 };
  };
  const svgGrid = (minX, maxX, minY, maxY, step = 100) => {
    let markup = "";
    for (let x = Math.ceil(minX / step) * step; x <= maxX; x += step) markup += `<line x1="${x}" y1="${minY}" x2="${x}" y2="${maxY}"/>`;
    for (let y = Math.ceil(minY / step) * step; y <= maxY; y += step) markup += `<line x1="${minX}" y1="${y}" x2="${maxX}" y2="${y}"/>`;
    return `<g class="rig-svg-grid">${markup}</g><g class="rig-svg-axes"><line x1="${minX}" y1="0" x2="${maxX}" y2="0"/><line x1="0" y1="${minY}" x2="0" y2="${maxY}"/></g>`;
  };
  const sofaPlanPoints = ({ width, depth }, yaw) => {
    const radians = yaw * Math.PI / 180, cosine = Math.cos(radians), sine = Math.sin(radians);
    return [[-width / 2, -depth / 2], [width / 2, -depth / 2], [width / 2, depth / 2], [-width / 2, depth / 2]].map(([x, y]) => [x * cosine - y * sine, -(x * sine + y * cosine)]);
  };
  const rigColor = (light) => document.querySelector('input[name="rigColor"]:checked')?.value === "kelvin" ? kelvinColor(light.meta.kelvin) : light.meta.color;
  const renderRigPlan = (preview) => {
    const svg = $("rigPlan"), sofa = sofaPlanPoints(preview.dimensions, preview.sofaYaw);
    const points = [...sofa, ...preview.lights.map(light => [light.position[0], -light.position[1]])];
    const pad = 150 * preview.scale, minX = Math.min(...points.map(point => point[0])) - pad, maxX = Math.max(...points.map(point => point[0])) + pad;
    const minY = Math.min(...points.map(point => point[1])) - pad, maxY = Math.max(...points.map(point => point[1])) + pad;
    svg.setAttribute("viewBox", `${minX} ${minY} ${maxX - minX} ${maxY - minY}`);
    const lights = preview.lights.map(light => {
      const [x, worldY] = light.position, y = -worldY, radians = light.rotation.yaw * Math.PI / 180, length = 120 * preview.scale;
      const endX = x + Math.cos(radians) * length, endY = y - Math.sin(radians) * length, color = rigColor(light);
      return `<g class="rig-svg-light" style="--light:${color}"><line x1="${x}" y1="${y}" x2="${endX}" y2="${endY}" marker-end="url(#rig-plan-arrow)"/><circle cx="${x}" cy="${y}" r="10"/><text x="${x + 16}" y="${y - 14}">${escapeHtml(light.meta.label)}</text></g>`;
    }).join("");
    svg.innerHTML = `<defs><marker id="rig-plan-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z"/></marker></defs>${svgGrid(minX, maxX, minY, maxY)}<polygon class="rig-svg-sofa" points="${sofa.map(point => point.join(",")).join(" ")}"/><text class="rig-svg-sofa-label" x="0" y="5">SECTIONAL · ${preview.dimensions.width} × ${preview.dimensions.depth}</text>${lights}`;
  };
  const renderRigElevation = (preview) => {
    const points = preview.lights.map(light => [light.position[0], -light.position[2]]), pad = 120 * preview.scale;
    const minX = Math.min(-preview.dimensions.width / 2, ...points.map(point => point[0])) - pad, maxX = Math.max(preview.dimensions.width / 2, ...points.map(point => point[0])) + pad;
    const minY = Math.min(-preview.dimensions.height, ...points.map(point => point[1])) - pad, maxY = pad;
    const svg = $("rigElevation"); svg.setAttribute("viewBox", `${minX} ${minY} ${maxX - minX} ${maxY - minY}`);
    const lights = preview.lights.map(light => {
      const x = light.position[0], y = -light.position[2], pitch = light.rotation.pitch * Math.PI / 180, yaw = light.rotation.yaw * Math.PI / 180, length = 120 * preview.scale;
      const endX = x + Math.cos(pitch) * Math.cos(yaw) * length, endY = y - Math.sin(pitch) * length, color = rigColor(light);
      return `<g class="rig-svg-light" style="--light:${color}"><line x1="${x}" y1="${y}" x2="${endX}" y2="${endY}" marker-end="url(#rig-elevation-arrow)"/><circle cx="${x}" cy="${y}" r="10"/><text x="${x + 16}" y="${y - 14}">${escapeHtml(light.meta.label)}</text></g>`;
    }).join("");
    svg.innerHTML = `<defs><marker id="rig-elevation-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z"/></marker></defs>${svgGrid(minX, maxX, minY, maxY)}<rect class="rig-svg-sofa" x="${-preview.dimensions.width / 2}" y="${-preview.dimensions.height}" width="${preview.dimensions.width}" height="${preview.dimensions.height}" rx="12"/><text class="rig-svg-sofa-label" x="0" y="${-preview.dimensions.height / 2}">H ${preview.dimensions.height}</text>${lights}`;
  };
  const renderRig = () => {
    const preview = currentRig(); if (!preview) return;
    $("rigLoading").hidden = true; $("rigViews").hidden = false;
    $("rigScale").textContent = `${preview.scale.toFixed(3)}×`;
    $("rigScaleNote").textContent = `${preview.layer} · ${preview.scale === 1 ? "Reference footprint" : `Raw ${preview.raw.toFixed(3)}×`}`;
    $("rigShotHint").textContent = ({ F: "Front", FH: "Front high", TQR: "Three-quarter · right", TQL: "Three-quarter · left" })[preview.shot];
    renderRigPlan(preview); renderRigElevation(preview);
    $("rigLights").innerHTML = preview.lights.map(light => {
      const color = rigColor(light), size = light.geometry.type === "rect" ? `${Math.round(light.geometry.width * (preview.mode === "A" ? preview.scale : 1))} × ${Math.round(light.geometry.height * (preview.mode === "A" ? preview.scale : 1))}` : `r ${Math.round(light.geometry.radius * (preview.mode === "A" ? preview.scale : 1))}`;
      const cones = light.innerCone >= 0 || light.outerCone >= 0 ? ` · cones ${light.innerCone}/${light.outerCone}` : "";
      return `<article class="rig-light-card${light.changedForShadow ? " changed" : ""}"><div class="rig-light-name"><i class="rig-light-dot" style="color:${color};background:${color}"></i><strong>${escapeHtml(light.meta.label)}</strong>${light.changedForShadow ? "<em>Shadow override</em>" : ""}</div><div class="rig-light-values"><span>${light.intensity.toFixed(light.intensity < 10 ? 2 : 1)} cd · ${size} cm${escapeHtml(cones)}</span><span>${light.position.map(value => Math.round(value)).join(" · ")} cm</span></div></article>`;
    }).join("");
  };
  const updateRigRange = range => {
    const progress = ((+range.value - +range.min) / (+range.max - +range.min)) * 100;
    range.style.setProperty("--range-progress", `${progress}%`);
  };
  const setRigDimensions = dimensions => {
    if (!dimensions) return;
    [["rigWidth", "rigWidthRange", "width"], ["rigDepth", "rigDepthRange", "depth"], ["rigHeight", "rigHeightRange", "height"]].forEach(([numberId, rangeId, dimension]) => {
      const number = $(numberId), range = $(rangeId), value = Math.max(+number.min, +dimensions[dimension] || +number.value);
      if (value > +range.max) range.max = value;
      number.value = value; range.value = value; updateRigRange(range);
    });
    renderRig();
  };
  const syncRigFromModel = () => {
    if (!state.model) return;
    setRigDimensions(state.model.dimensions);
  };
  const loadRig = async () => {
    try {
      const response = await fetch("data/sectionals-indoor.csv", { cache: "no-cache" }); if (!response.ok) throw new Error(`Light data ${response.status}`);
      state.rig = buildClientRig(parseCsv(await response.text()));
      if (Object.keys(state.rig.Sectional_Indoor_R?.F || {}).length !== 5) throw new Error("Incomplete Sectionals / Indoor rig");
      renderRig();
    } catch (error) { $("rigLoading").dataset.state = "error"; $("rigLoading").textContent = `Light rig unavailable: ${error.message}`; }
  };
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
  const updateRender = (render) => {
    state.status ||= {}; state.status.render = render;
    const badge = $("renderBadge"), box = $("renderStatus"), log = $("renderLog"), progress = $("renderProgress");
    badge.dataset.state = render.state; badge.textContent = render.state === "running" && render.phase ? render.phase : ({running:"Rendering",success:"Complete",failed:"Failed",idle:"Idle"})[render.state] || render.state;
    box.dataset.state = render.state;
    const phase = render.phase ? ` · ${render.phase}${render.phaseCount > 1 ? ` (${render.phaseIndex}/${render.phaseCount})` : ""}` : "";
    const title = render.state === "running" ? `Unreal is rendering${phase}` : render.state === "success" ? "Render completed" : render.state === "failed" ? "Render stopped with an error" : "No active render";
    const substrate = render.state === "running" && typeof render.substrate === "boolean" ? `Substrate ${render.substrate ? "ON" : "OFF"} · ` : "";
    const current = [render.currentTask, render.currentCamera].filter(Boolean).join(" · ");
    box.querySelector("strong").textContent = title; box.querySelector("span").textContent = current || (render.jobPath ? `${substrate}${render.jobPath}` : "Generate a job, then launch it in Unreal Engine 5.6.");
    const total = Number(render.totalRenders || 0), rendered = Number(render.rendered || 0), percent = total ? Math.min(100, rendered / total * 100) : render.state === "success" ? 100 : 0;
    progress.hidden = render.state === "idle" && !render.jobPath;
    $("renderProgressLabel").textContent = total ? `${rendered} / ${total} frames` : `${rendered} frames`;
    $("renderProgressMeta").textContent = `${substrate}${render.message || render.phase || "Waiting"}`;
    $("renderProgressBar").style.width = `${percent}%`;
    $("renderQueue").innerHTML = (render.queue || []).map((item, index) => `<span data-state="${escapeHtml(item.state || "queued")}"><b>${String(index + 1).padStart(2, "0")}</b>${escapeHtml(item.name)}</span>`).join("");
    $("retryRender").hidden = render.state !== "failed" || !render.jobPath;
    log.hidden = !render.log; log.textContent = render.log || "";
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
    $("historyList").innerHTML = batches.length ? batches.map(batch => `<button class="history-card${state.historyBatch?.id === batch.id ? " active" : ""}" type="button" data-history-id="${escapeHtml(batch.id)}"><span class="history-card-top"><strong>${escapeHtml(batch.id)}</strong><i class="history-state" data-state="${escapeHtml(batch.state)}">${escapeHtml(historyStateLabel(batch.state))}</i></span><span class="history-card-meta"><b>${batch.modelCount} model${batch.modelCount === 1 ? "" : "s"}</b><b>${batch.renderCount}/${batch.expectedRenders} renders</b></span><small>${escapeHtml(formatDate(batch.updatedAt || batch.generatedAt))}</small></button>`).join("") : '<div class="empty-state">No jobs match this filter.</div>';
  };
  const renderHistoryDetail = () => {
    const batch = state.historyBatch;
    if (!batch) { $("historyDetail").innerHTML = '<div class="empty-state">Choose a saved job to inspect its models, JSON, and render output.</div>'; return; }
    const models = batch.models?.length ? `<div class="history-model-list" aria-label="Models in ${escapeHtml(batch.id)}">${batch.models.map((model, index) => `<div class="history-model-row"><label><input type="checkbox" data-history-model-select="${escapeHtml(model.name)}"${state.historySelection.has(model.name) ? " checked" : ""}><span>${String(index + 1).padStart(2, "0")}</span><strong>${escapeHtml(model.name)}</strong><small>${escapeHtml(model.side || "UNKNOWN")} · ${model.dimensions ? `${model.dimensions.width} × ${model.dimensions.depth} × ${model.dimensions.height} cm` : "No dimensions"} · ${model.renders.length}/${model.expectedRenders}</small></label><button type="button" data-history-action="review" data-model-index="${index}" title="Review in light rig">Rig</button></div>`).join("")}</div>` : '<div class="empty-state history-model-empty">No models stored in this job.</div>';
    const selective = `<div class="selective-controls"><div><span>SELECTIVE RENDER</span><button type="button" data-history-action="selectAll">All</button><button type="button" data-history-action="selectNone">None</button></div><div class="selective-options"><label><input type="checkbox" data-select-camera value="F" checked><span>F</span></label><label><input type="checkbox" data-select-camera value="FH" checked><span>FH</span></label><label><input type="checkbox" data-select-camera value="TQ" checked><span>TQ</span></label><i></i><label><input type="checkbox" data-select-layer value="Fabric" checked><span>Fabric</span></label><label><input type="checkbox" data-select-layer value="Shadow" checked><span>Shadow</span></label></div></div>`;
    $("historyDetail").innerHTML = `<div class="history-detail-heading"><div><span>SAVED JOB</span><strong>${escapeHtml(batch.id)}</strong><small>${escapeHtml(formatDate(batch.generatedAt))}</small></div><i class="history-state" data-state="${escapeHtml(batch.state)}">${escapeHtml(historyStateLabel(batch.state))}</i></div><div class="history-summary"><div><span>MODELS</span><strong>${batch.modelCount}</strong></div><div><span>RENDERS</span><strong>${batch.renderCount}/${batch.expectedRenders}</strong></div><div><span>OUTPUT</span><strong>${batch.renderCount ? "On disk" : "Empty"}</strong></div></div>${selective}${models}${batch.error ? `<p class="inline-warning">${escapeHtml(batch.error)}</p>` : ""}<code class="history-path" title="${escapeHtml(batch.jobPath)}">${escapeHtml(batch.jobPath)}</code><div class="history-actions"><button class="primary-button" type="button" data-history-action="selective"${batch.modelCount ? "" : " disabled"}>Load selection</button><button class="secondary-button" type="button" data-history-action="edit"${batch.modelCount ? "" : " disabled"}>Load all & edit</button><button class="secondary-button" type="button" data-history-action="review"${batch.modelCount ? "" : " disabled"}>Review rig</button><button class="secondary-button" type="button" data-history-action="rerun"${batch.state === "invalid" ? " disabled" : ""}>Run again</button><button class="quiet-button" type="button" data-history-action="viewJob">View JSON</button><button class="quiet-button" type="button" data-history-action="showJob">Show JSON</button><button class="quiet-button" type="button" data-history-action="openRenders"${batch.renderCount ? "" : " disabled"}>Open renders</button></div>`;
  };
  const renderRigHistoryModels = () => {
    const batch = state.rigBatch, group = $("rigBatchGroup");
    group.hidden = !batch?.models?.length;
    if (!batch?.models?.length) return;
    $("rigBatchCount").textContent = `${batch.models.length} models`;
    $("rigBatchModels").innerHTML = batch.models.map((model, index) => `<button type="button" class="rig-batch-model${state.historyModel === model ? " active" : ""}" data-state="${escapeHtml(model.state || "pending")}" data-history-model-index="${index}" title="${escapeHtml(model.name)}"><span>${String(index + 1).padStart(2, "0")}</span><strong>${escapeHtml(model.name)}</strong><small>${escapeHtml(model.state || "pending")} · ${model.dimensions ? `${model.dimensions.width} × ${model.dimensions.depth} × ${model.dimensions.height} cm` : "No dimensions"} · ${model.renders.length}/${model.expectedRenders}</small></button>`).join("");
  };
  const renderRigGallery = () => {
    const model = state.historyModel, gallery = $("rigRenderGallery");
    gallery.hidden = !model;
    if (!model) return;
    $("rigRenderModel").textContent = model.name; $("rigRenderCount").textContent = `${model.renders.length} file${model.renders.length === 1 ? "" : "s"}`;
    const cameraRank = { F: 0, FH: 1, TQ: 2 }, cameras = [...new Set(model.renders.map(render => render.camera || "Other"))].sort((left, right) => (cameraRank[left] ?? 9) - (cameraRank[right] ?? 9));
    const card = render => {
      const diagnostics = [render.width && render.height ? `${render.width}×${render.height}` : "Unknown size", render.alpha === true ? "Alpha" : render.alpha === false ? "No alpha" : "Alpha unknown", ...(render.issues || [])];
      return `<a class="render-preview-card${render.issues?.length ? " render-warning" : ""}" data-layer="${escapeHtml(render.layer || "Fabric")}" href="${escapeHtml(render.url)}" target="_blank" rel="noreferrer"><div class="render-preview-media" style="--preview-aspect:${Number(render.width) || 1}/${Number(render.height) || 1}"><img src="${escapeHtml(render.url)}" alt="${escapeHtml(model.name)} ${escapeHtml(render.camera || "render")} ${escapeHtml(render.layer || "")}" loading="lazy"></div><span>${escapeHtml(render.layer || render.camera || render.name)}${render.issues?.length ? " · Check" : ""}</span><small>${escapeHtml(diagnostics.join(" · "))}</small></a>`;
    };
    const combinedCard = (fabric, shadow) => {
      if (!fabric || !shadow) return "";
      const fabricWidth = Math.min(100, Math.max(1, (Number(fabric.width) || 1) / (Number(shadow.width) || 1) * 100));
      const issues = [...(fabric.issues || []), ...(shadow.issues || [])];
      return `<div class="render-preview-card render-combined${issues.length ? " render-warning" : ""}" data-layer="Combined"><div class="render-preview-media" style="--preview-aspect:${Number(shadow.width) || 1}/${Number(shadow.height) || 1};--fabric-width:${fabricWidth}%"><img class="render-composite-shadow" src="${escapeHtml(shadow.url)}" alt="" loading="lazy"><img class="render-composite-fabric" src="${escapeHtml(fabric.url)}" alt="${escapeHtml(model.name)} ${escapeHtml(fabric.camera || "render")} Fabric and Shadow combined" loading="lazy"></div><span>Combined${issues.length ? " · Check" : ""}</span><small>Fabric over Shadow · alpha preview</small></div>`;
    };
    $("rigRenderImages").innerHTML = model.renders.length ? cameras.map(camera => {
      const renders = model.renders.filter(render => (render.camera || "Other") === camera).sort((left, right) => (left.layer === "Shadow" ? 1 : 0) - (right.layer === "Shadow" ? 1 : 0) || left.name.localeCompare(right.name));
      const fabric = renders.find(render => render.layer === "Fabric"), shadow = renders.find(render => render.layer === "Shadow");
      return `<section class="render-camera-group"><div><strong>${escapeHtml(camera)}</strong><span>${fabric && shadow ? "Fabric · Shadow · Combined" : `${renders.length} layer${renders.length === 1 ? "" : "s"}`}</span></div><div>${renders.map(card).join("")}${combinedCard(fabric, shadow)}</div></section>`;
    }).join("") : '<div class="empty-state">This model has no render files on disk yet.</div>';
  };
  const selectHistoryModel = model => {
    if (!model) return;
    state.historyModel = model; $("rigMode").value = model.sourceMode || "B";
    if (currentRigShot().startsWith("TQ")) {
      const shot = document.querySelector(`input[name="rigShot"][value="${model.side === "R" ? "TQR" : "TQL"}"]`); if (shot) shot.checked = true;
    }
    setRigDimensions(model.dimensions); renderRigHistoryModels(); renderRigGallery();
  };
  const reviewHistoryBatch = (batch, modelIndex = 0) => {
    if (!batch?.models?.length) return;
    state.historyBatch = batch; state.rigBatch = batch; renderHistoryList(); renderHistoryDetail(); renderRigHistoryModels();
    selectHistoryModel(batch.models[Math.max(0, Math.min(modelIndex, batch.models.length - 1))]);
    document.querySelector(".rig-section").scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const selectHistoryBatch = batch => {
    state.historyBatch = batch; state.historySelection = new Set((batch.models || []).map(model => model.name));
    state.rigBatch = batch; renderHistoryList(); renderHistoryDetail(); renderRigHistoryModels();
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
      if (!state.rigBatch && selectedBatch?.models?.length) { state.rigBatch = selectedBatch; renderRigHistoryModels(); selectHistoryModel(selectedBatch.models[0]); }
      if (state.rigBatch) state.rigBatch = batches.find(batch => batch.id === state.rigBatch.id) || null;
      if (state.historyModel && state.rigBatch) {
        const updated = state.rigBatch.models.find(model => model.name === state.historyModel.name); if (updated) selectHistoryModel(updated);
      }
    } catch (error) { $("historyList").innerHTML = `<div class="empty-state">History unavailable: ${escapeHtml(error.message)}</div>`; }
  };
  const refreshSheet = async () => {
    $("refreshSheet").disabled = true;
    try { const data = await api("/api/sheet/refresh", { method: "POST", body: "{}" }); $("sheetState").textContent = data.source === "live" ? "LIVE" : "CACHE"; toast(`Light data: ${data.rows} Sectionals / Indoor rows`); }
    catch (error) { toast(error.message, true); }
    finally { $("refreshSheet").disabled = false; }
  };
  const init = async () => {
    loadRig();
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
  $("generateJob").addEventListener("click", generate); $("launchRender").addEventListener("click", launch); $("stickyGenerate").addEventListener("click", generate); $("stickyLaunch").addEventListener("click", launch); $("refreshSheet").addEventListener("click", refreshSheet);
  $("retryRender").addEventListener("click", () => launch(true));
  document.querySelectorAll('input[name="renderProfile"]').forEach(input => input.addEventListener("change", () => {
    const low = input.checked && input.value === "low";
    $("fabricResolutionLabel").textContent = low ? "Path Trace · 500" : "Path Trace · 5K";
    $("shadowResolutionLabel").textContent = low ? "Lumen · 1.5K×500" : "Lumen · 15K×5K";
    state.jobPath = null; $("jobResult").hidden = true; validate();
  }));
  $("copyJobPath").addEventListener("click", async () => { await navigator.clipboard.writeText(state.jobPath || ""); toast("Job path copied"); });
  $("rigUseModel").addEventListener("click", syncRigFromModel);
  [["rigWidth", "rigWidthRange"], ["rigDepth", "rigDepthRange"], ["rigHeight", "rigHeightRange"]].forEach(([numberId, rangeId]) => {
    const number = $(numberId), range = $(rangeId);
    number.addEventListener("input", () => { if (+number.value > +range.max) range.max = number.value; range.value = number.value; updateRigRange(range); renderRig(); });
    number.addEventListener("change", () => {
      const value = Math.max(+number.min, +number.value || +number.min);
      if (value > +range.max) range.max = value;
      number.value = value; range.value = value; updateRigRange(range); renderRig();
    });
    range.addEventListener("input", () => { number.value = range.value; updateRigRange(range); renderRig(); });
    updateRigRange(range);
  });
  $("rigMode").addEventListener("change", renderRig);
  document.querySelectorAll('input[name="rigShot"], input[name="rigColor"], input[name="rigLayer"]').forEach(node => node.addEventListener("change", renderRig));
  document.querySelectorAll('input[name="rigLayout"]').forEach(node => node.addEventListener("change", () => { $("rigViews").dataset.layout = node.value; requestAnimationFrame(renderRig); }));
  $("sceneSide").addEventListener("change", renderRig);
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
      else if (action === "review") reviewHistoryBatch(batch, +(button.dataset.modelIndex || 0));
      else if (action === "selectAll") { state.historySelection = new Set((batch.models || []).map(model => model.name)); renderHistoryDetail(); }
      else if (action === "selectNone") { state.historySelection.clear(); renderHistoryDetail(); }
      else if (action === "selective") {
        const cameras = [...document.querySelectorAll("[data-select-camera]:checked")].map(input => input.value), layers = [...document.querySelectorAll("[data-select-layer]:checked")].map(input => input.value);
        if (!state.historySelection.size) throw new Error("Select at least one model");
        if (!cameras.length || !layers.length) throw new Error("Select at least one camera and layer");
        await editHistoryJob(batch, { modelNames: [...state.historySelection], cameras, layers });
      }
      else if (action === "rerun") { state.jobPath = batch.jobPath; $("jobResult").hidden = false; $("copyJobPath").textContent = batch.jobPath; await launch(); }
      else if (action === "viewJob") await viewHistoryJob(batch);
      else if (action === "showJob") { await openLocal("showJob", batch.jobPath); toast("JSON selected in Explorer"); }
      else if (action === "openRenders") { await openLocal("openRenders", batch.outputFolder); toast("Render folder opened"); }
    } catch (error) { toast(error.message, true); }
  });
  $("historyDetail").addEventListener("change", event => {
    const input = event.target.closest("[data-history-model-select]"); if (!input) return;
    if (input.checked) state.historySelection.add(input.dataset.historyModelSelect); else state.historySelection.delete(input.dataset.historyModelSelect);
  });
  $("rigBatchModels").addEventListener("click", event => {
    const button = event.target.closest("[data-history-model-index]"); if (!button || !state.rigBatch) return;
    selectHistoryModel(state.rigBatch.models[+button.dataset.historyModelIndex]);
  });
  $("closeJobDialog").addEventListener("click", () => $("jobDialog").close());
  $("jobDialog").addEventListener("click", event => { if (event.target === $("jobDialog")) $("jobDialog").close(); });
  document.querySelectorAll("input,select").forEach(node => node.addEventListener("change", validate));
  init();
})();
