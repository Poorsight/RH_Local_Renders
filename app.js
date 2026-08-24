(() => {
  const $ = (id) => document.getElementById(id);
  const state = { status: null, models: [], model: null, jobPath: null, poll: null, rig: null };
  const canReachLocalService = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
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
  const materialRows = () => [...document.querySelectorAll("[data-material-id]")].map(node => ({ meshes: [node.dataset.materialId], material: node.value.trim() }));
  const sideFromModel = () => {
    const value = $("sceneSide").value;
    if (value !== "auto") return value;
    const label = state.model?.side || "";
    return label.includes("RIGHT") ? "R" : label.includes("LEFT") ? "L" : label.includes("U") ? "U" : "R";
  };
  const payload = () => ({
    modelPath: state.model.path,
    category: $("category").value,
    environment: $("environment").value,
    side: sideFromModel(), sourceMode: $("sourceMode").value,
    dimensions: { width: +$("width").value, depth: +$("depth").value, height: +$("height").value },
    importYaw: +$("importYaw").value || 0,
    cameras: selected("camera"), layers: selected("layer"), materials: materialRows()
  });
  const validate = () => {
    const ready = !!state.model && materialRows().length > 0 && materialRows().every(row => row.material) && selected("camera").length && selected("layer").length;
    $("generateJob").disabled = !ready;
    if (!ready) state.jobPath = null;
    $("launchRender").disabled = !state.jobPath;
  };
  const renderMaterials = (ids) => {
    $("materialsEmpty").hidden = !!ids.length;
    $("materialsList").innerHTML = ids.map(id => `<label class="material-row"><span class="material-id">${escapeHtml(id)}</span><input data-material-id="${escapeHtml(id)}" placeholder="RH material name" autocomplete="off"></label>`).join("");
    document.querySelectorAll("[data-material-id]").forEach(input => input.addEventListener("input", validate));
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
      return { ...light, name, position: [x * scale, y * scale, z * scale], intensity, geometry, meta: RIG_META[name] };
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
  const syncRigFromModel = () => {
    if (!state.model) return;
    $("rigWidth").value = $("width").value; $("rigDepth").value = $("depth").value; $("rigHeight").value = $("height").value; renderRig();
  };
  const loadRig = async () => {
    try {
      const response = await fetch("data/sectionals-indoor.csv", { cache: "no-cache" }); if (!response.ok) throw new Error(`Light data ${response.status}`);
      state.rig = buildClientRig(parseCsv(await response.text()));
      if (Object.keys(state.rig.Sectional_Indoor_R?.F || {}).length !== 5) throw new Error("Incomplete Sectionals / Indoor rig");
      renderRig();
    } catch (error) { $("rigLoading").dataset.state = "error"; $("rigLoading").textContent = `Light rig unavailable: ${error.message}`; }
  };
  const inspect = async () => {
    const query = $("modelPath").value.trim(); if (!query) return toast("Enter a model name or path", true);
    $("inspectModel").disabled = true; $("inspectModel").textContent = "Inspecting…";
    try {
      const model = await api("/api/models/inspect", { method: "POST", body: JSON.stringify({ modelPath: query }) });
      state.model = model; state.jobPath = null;
      $("modelEmpty").hidden = true; $("modelDetails").hidden = false;
      $("inspectedName").textContent = model.name; $("modelSide").textContent = model.side || "Unknown side";
      $("width").value = model.dimensions.width; $("depth").value = model.dimensions.depth; $("height").value = model.dimensions.height; $("importYaw").value = model.importYaw;
      $("modelWarning").hidden = !model.warning; $("modelWarning").textContent = model.warning || "";
      renderMaterials(model.materialIds);
      $("rigUseModel").disabled = false; syncRigFromModel();
      const uph = document.querySelector('[data-material-id="UPH"], [data-material-id="uph"]'); if (uph) uph.focus();
      validate(); toast(`Read ${model.materialIds.length} Material IDs from ${model.name}`);
    } catch (error) { toast(error.message, true); }
    finally { $("inspectModel").disabled = false; $("inspectModel").textContent = "Inspect model"; }
  };
  const generate = async () => {
    $("generateJob").disabled = true; $("generateJob").textContent = "Generating…";
    try {
      const result = await api("/api/jobs", { method: "POST", body: JSON.stringify(payload()) });
      state.jobPath = result.jobPath; $("jobResult").hidden = false; $("copyJobPath").textContent = result.jobPath;
      $("launchRender").disabled = false; toast(`Job ready: ${result.cameraCount} views · ${result.lightSource}`);
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
    if (!canReachLocalService) { setConnection(false); $("sheetState").textContent = "STATIC"; $("unrealState").textContent = "OFFLINE"; return; }
    try {
      const status = await api("/api/status"); state.status = status; state.models = status.models; setConnection(true);
      $("modelCount").textContent = status.models.length; $("sheetState").textContent = status.sheet.source.toUpperCase(); $("unrealState").textContent = status.unreal.available ? "READY" : "MISSING";
      $("modelOptions").innerHTML = status.models.map(model => `<option value="${escapeHtml(model.path)}">${escapeHtml(model.name)}</option>`).join("");
      updateRender(status.render); loadCatalog(); if (status.render.state === "running") startPolling();
    } catch { setConnection(false); $("sheetState").textContent = "OFFLINE"; $("unrealState").textContent = "OFFLINE"; }
  };
  $("inspectModel").addEventListener("click", inspect); $("modelPath").addEventListener("keydown", event => { if (event.key === "Enter") inspect(); });
  $("generateJob").addEventListener("click", generate); $("launchRender").addEventListener("click", launch); $("refreshSheet").addEventListener("click", refreshSheet);
  $("copyJobPath").addEventListener("click", async () => { await navigator.clipboard.writeText(state.jobPath || ""); toast("Job path copied"); });
  $("rigUseModel").addEventListener("click", syncRigFromModel);
  ["rigWidth", "rigDepth", "rigHeight"].forEach(id => $(id).addEventListener("input", renderRig));
  $("rigMode").addEventListener("change", renderRig);
  document.querySelectorAll('input[name="rigShot"], input[name="rigColor"]').forEach(node => node.addEventListener("change", renderRig));
  document.querySelectorAll('input[name="rigLayout"]').forEach(node => node.addEventListener("change", () => { $("rigViews").dataset.layout = node.value; requestAnimationFrame(renderRig); }));
  $("sceneSide").addEventListener("change", renderRig);
  document.querySelectorAll("input,select").forEach(node => node.addEventListener("change", validate));
  init();
})();
