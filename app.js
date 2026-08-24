(() => {
  const $ = (id) => document.getElementById(id);
  const state = { status: null, models: [], metadata: null, batch: [], model: null, jobPath: null, poll: null, rig: null };
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
  const normalizedMaterialId = id => {
    const value = String(id || ""), last = value.split(/[:_]/).filter(Boolean).pop() || value;
    return last.replace(/\d/g, "") || last;
  };
  const sideFromModel = () => {
    const value = $("sceneSide").value;
    if (value !== "auto") return value;
    const label = state.model?.side || "";
    return label.includes("RIGHT") ? "R" : label.includes("LEFT") ? "L" : label.includes("U") ? "U" : "R";
  };
  const payload = () => ({
    modelPath: state.model.path,
    models: state.batch.map(model => ({ modelPath: model.path, dimensions: model.dimensions, importYaw: model.importYaw })),
    category: $("category").value,
    environment: $("environment").value,
    side: $("sceneSide").value, sourceMode: $("sourceMode").value,
    dimensions: { width: +$("width").value, depth: +$("depth").value, height: +$("height").value },
    importYaw: +$("importYaw").value || 0,
    cameras: selected("camera"), layers: selected("layer"), materials: materialRows()
  });
  const validate = () => {
    const ready = canReachLocalService && state.batch.length > 0 && materialRows().length > 0 && materialRows().every(row => row.material) && selected("camera").length && selected("layer").length;
    $("generateJob").disabled = !ready;
    if (!ready) state.jobPath = null;
    $("launchRender").disabled = !state.jobPath;
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
      return `<label class="material-row"><span class="material-id"><b>${escapeHtml(item.label)}</b><small>${modelCount} model${modelCount === 1 ? "" : "s"} · ${sourceIds.length} component ID${sourceIds.length === 1 ? "" : "s"}</small></span><input data-material-key="${escapeHtml(item.key)}" data-material-ids="${escapeHtml(JSON.stringify(sourceIds))}" value="${escapeHtml(previous.get(item.key) || "")}" placeholder="Replace with RH material name" autocomplete="off"></label>`;
    }).join("");
    document.querySelectorAll("[data-material-key]").forEach(input => input.addEventListener("input", validate));
  };
  const renderBatch = () => {
    $("modelBatch").hidden = !state.batch.length; $("batchCount").textContent = `${state.batch.length} model${state.batch.length === 1 ? "" : "s"}`;
    $("batchList").innerHTML = state.batch.map(model => `<div class="batch-model${state.model?.path === model.path ? " active" : ""}" data-model-path="${escapeHtml(model.path)}"><button class="batch-model-select" type="button" title="Open ${escapeHtml(model.name)}"><span>${escapeHtml(model.name)}</span><small>${model.dimensions.width} × ${model.dimensions.depth} × ${model.dimensions.height} cm · ${escapeHtml(model.materialIds.length)} IDs</small></button><button class="batch-model-remove" type="button" title="Remove ${escapeHtml(model.name)}" aria-label="Remove ${escapeHtml(model.name)}">×</button></div>`).join("");
  };
  const selectModel = model => {
    state.model = model;
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
    return { name, path: `${LOCAL_MODELS_ROOT}\\${name}.fbx`, side: record.side, materialIds: [...materialIds], dimensions: { width, depth, height }, importYaw: record.yaw, offsetUniformScale: record.scale, warning: record.warning || "" };
  };
  const loadModelMetadata = async () => {
    const response = await fetch("data/models.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`Model metadata returned ${response.status}`);
    state.metadata = await response.json();
    state.models = Object.keys(state.metadata.models || {}).map(name => ({ name, path: `${LOCAL_MODELS_ROOT}\\${name}.fbx` }));
    $("modelCount").textContent = state.models.length;
    $("modelOptions").innerHTML = state.models.map(model => `<option value="${escapeHtml(model.path)}">${escapeHtml(model.name)}</option>`).join("");
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
        intensity: +row.default_intensity
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
    const shot = currentRigShot(), dimensions = rigDimensions(), mode = $("rigMode").value;
    const side = shot === "TQR" ? "R" : shot === "TQL" ? "L" : sideFromModel();
    const camera = shot.startsWith("TQ") ? "TQ" : shot;
    const scene = `Sectional_Indoor_${side}`;
    const source = state.rig?.[scene]?.[camera];
    if (!source) return null;
    const raw = Math.cbrt((dimensions.width / RIG_REFERENCE.width) * (dimensions.depth / RIG_REFERENCE.depth) * (dimensions.height / RIG_REFERENCE.height));
    const scale = Math.max(1, raw);
    const lights = Object.entries(source).map(([name, light]) => {
      const geometry = RIG_GEOMETRY[name] || {}, [x, y, z] = light.position;
      const distance2 = x * x + y * y + z * z, radius2 = (geometry.radius || 0) ** 2;
      const intensity = mode === "A" ? light.intensity * scale * scale : light.intensity * ((scale * scale * distance2 + radius2) / (distance2 + radius2));
      return { ...light, name, position: [x * scale, y * scale, z], intensity, geometry, meta: RIG_META[name] };
    });
    return { shot, side, camera, dimensions, mode, raw, scale, lights, sofaYaw: shot === "TQR" ? -36 : shot === "TQL" ? 36 : 0 };
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
    $("rigScaleNote").textContent = preview.scale === 1 ? "Reference footprint" : `Raw ${preview.raw.toFixed(3)}×`;
    $("rigShotHint").textContent = ({ F: "Front", FH: "Front high", TQR: "Three-quarter · right", TQL: "Three-quarter · left" })[preview.shot];
    renderRigPlan(preview); renderRigElevation(preview);
    $("rigLights").innerHTML = preview.lights.map(light => {
      const color = rigColor(light), size = light.geometry.type === "rect" ? `${Math.round(light.geometry.width * (preview.mode === "A" ? preview.scale : 1))} × ${Math.round(light.geometry.height * (preview.mode === "A" ? preview.scale : 1))}` : `r ${Math.round(light.geometry.radius * (preview.mode === "A" ? preview.scale : 1))}`;
      return `<article class="rig-light-card"><div class="rig-light-name"><i class="rig-light-dot" style="color:${color};background:${color}"></i><strong>${escapeHtml(light.meta.label)}</strong></div><div class="rig-light-values"><span>${light.intensity.toFixed(light.intensity < 10 ? 2 : 1)} cd · ${size} cm</span><span>${light.position.map(value => Math.round(value)).join(" · ")} cm</span></div></article>`;
    }).join("");
  };
  const updateRigRange = range => {
    const progress = ((+range.value - +range.min) / (+range.max - +range.min)) * 100;
    range.style.setProperty("--range-progress", `${progress}%`);
  };
  const syncRigFromModel = () => {
    if (!state.model) return;
    [["rigWidth", "rigWidthRange", "width"], ["rigDepth", "rigDepthRange", "depth"], ["rigHeight", "rigHeightRange", "height"]].forEach(([numberId, rangeId, modelId]) => {
      const number = $(numberId), range = $(rangeId), value = Math.max(+number.min, +$(modelId).value || +number.value);
      if (value > +range.max) range.max = value;
      number.value = value; range.value = value; updateRigRange(range);
    });
    renderRig();
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
    $("generateJob").disabled = true; $("generateJob").textContent = "Generating…";
    try {
      const result = await api("/api/jobs", { method: "POST", body: JSON.stringify(payload()) });
      state.jobPath = result.jobPath; $("jobResult").hidden = false; $("copyJobPath").textContent = result.jobPath;
      $("launchRender").disabled = false; toast(`Job ready: ${result.modelCount || 1} model${result.modelCount === 1 ? "" : "s"} · ${result.cameraCount} views · ${result.lightSource}`);
    } catch (error) { toast(error.message, true); }
    finally { $("generateJob").disabled = false; $("generateJob").textContent = "Generate job"; validate(); }
  };
  const launch = async () => {
    try {
      const result = await api("/api/renders", { method: "POST", body: JSON.stringify({ jobPath: state.jobPath }) });
      toast(`Unreal started (PID ${result.pid})`); updateRender(result); startPolling();
    } catch (error) { toast(error.message, true); }
  };
  const updateRender = (render) => {
    const badge = $("renderBadge"), box = $("renderStatus"), log = $("renderLog");
    badge.dataset.state = render.state; badge.textContent = ({running:"Rendering",success:"Complete",failed:"Failed",idle:"Idle"})[render.state] || render.state;
    box.dataset.state = render.state;
    const title = render.state === "running" ? "Unreal is rendering" : render.state === "success" ? "Render completed" : render.state === "failed" ? "Render stopped with an error" : "No active render";
    box.querySelector("strong").textContent = title; box.querySelector("span").textContent = render.jobPath || "Generate a job, then launch it in Unreal Engine 5.6.";
    log.hidden = !render.log; log.textContent = render.log || "";
    if (render.state !== "running" && state.poll) { clearInterval(state.poll); state.poll = null; loadCatalog(); }
  };
  const startPolling = () => { if (state.poll) clearInterval(state.poll); state.poll = setInterval(async () => { try { updateRender(await api("/api/renders/status")); } catch {} }, 2000); };
  const loadCatalog = async () => {
    try {
      const { models } = await api("/api/catalog"); $("catalogCount").textContent = `${models.length} model${models.length === 1 ? "" : "s"}`;
      $("catalog").innerHTML = models.length ? models.map(model => `<article class="catalog-card"><div class="catalog-image">${model.previewUrl ? `<img src="${escapeHtml(model.previewUrl)}" alt="${escapeHtml(model.name)} render">` : "<span>No render preview</span>"}</div><div class="catalog-body"><strong title="${escapeHtml(model.name)}">${escapeHtml(model.name)}</strong><div class="catalog-meta"><span>${model.dimensions.width} × ${model.dimensions.depth} × ${model.dimensions.height} cm</span><span>${model.renders.length} renders</span></div></div></article>`).join("") : '<div class="empty-state">A model appears here after its first successful render, with measured dimensions and render examples.</div>';
    } catch {}
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
    if (!canReachLocalService) { setConnection(false); $("sheetState").textContent = "STATIC"; $("unrealState").textContent = "OFFLINE"; return; }
    try {
      const status = await api("/api/status"); state.status = status; state.models = status.models; setConnection(true);
      $("modelCount").textContent = status.models.length; $("sheetState").textContent = status.sheet.source.toUpperCase(); $("unrealState").textContent = status.unreal.available ? "READY" : "MISSING";
      $("modelOptions").innerHTML = status.models.map(model => `<option value="${escapeHtml(model.path)}">${escapeHtml(model.name)}</option>`).join("");
      updateRender(status.render); loadCatalog(); if (status.render.state === "running") startPolling();
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
  document.querySelectorAll('input[name="rigShot"], input[name="rigColor"]').forEach(node => node.addEventListener("change", renderRig));
  document.querySelectorAll('input[name="rigLayout"]').forEach(node => node.addEventListener("change", () => { $("rigViews").dataset.layout = node.value; requestAnimationFrame(renderRig); }));
  $("sceneSide").addEventListener("change", renderRig);
  document.querySelectorAll("input,select").forEach(node => node.addEventListener("change", validate));
  init();
})();
