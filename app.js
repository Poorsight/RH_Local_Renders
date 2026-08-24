(() => {
  const $ = (id) => document.getElementById(id);
  const state = { status: null, models: [], model: null, jobPath: null, poll: null };
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
    const refHash = location.hash || "#v=F&W=343&D=307&H=79&m=A&cb=role"; $("referenceFrame").src = `light-rig-reference.html${refHash}`;
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
  document.querySelectorAll("input,select").forEach(node => node.addEventListener("change", validate));
  init();
})();
