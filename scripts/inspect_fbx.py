"""Inspect one FBX inside Blender and print RH model metadata as JSON.

Usage:
  blender -b --factory-startup --python scripts/inspect_fbx.py -- model.fbx
"""

import json
import os
import re
import sys

import bpy
import numpy as np


MAX_POINTS = 300_000
UNIT_CANDIDATES = [
    (1.0, "metres"),
    (0.01, "centimetres"),
    (0.001, "millimetres"),
    (0.0254, "inches"),
    (2.54, "inches exported as cm"),
    (0.3048, "feet"),
    (25.4, "inches exported as mm"),
]


def arguments():
    marker = sys.argv.index("--") if "--" in sys.argv else -1
    values = sys.argv[marker + 1:]
    if len(values) != 1:
        raise RuntimeError("Expected exactly one FBX path after --")
    return os.path.abspath(values[0])


def guess_unit(height, width, depth):
    span = max(width, depth)
    fits = [item for item in UNIT_CANDIDATES
            if 0.60 <= height * item[0] <= 1.15 and 1.2 <= span * item[0] <= 6.0]
    if not fits:
        raise RuntimeError(
            f"Could not infer FBX units from {width:.3f} x {depth:.3f} x {height:.3f}")
    return fits[0], len(fits)


def occupancy(points, low, high, cells=180):
    span = np.maximum(high - low, 1e-9)
    resolution = np.maximum((span / span.max() * cells).astype(int), 1) + 1
    indices = np.clip(((points - low) / span * (resolution - 1)).astype(int), 0, resolution - 1)
    grid = np.zeros(resolution, np.int32)
    np.add.at(grid, (indices[:, 0], indices[:, 1]), 1)
    return grid >= 1


def side_coverage(grid, depth=0.14, segments=32):
    nx, ny = grid.shape
    dx, dy = max(int(nx * depth), 1), max(int(ny * depth), 1)
    result = {}
    for name, band, axis in (
        ("-X", grid[:dx, :], 0), ("+X", grid[nx - dx:, :], 0),
        ("-Y", grid[:, :dy], 1), ("+Y", grid[:, ny - dy:], 1),
    ):
        along = band.any(axis=axis)
        edges = np.linspace(0, len(along) - 1, segments + 1).astype(int)
        result[name] = float(np.mean([
            along[edges[index]:edges[index + 1] + 1].any()
            for index in range(segments)
        ]))
    return result


def detect_back(points):
    z = points[:, 2]
    height = float(z.max() - z.min())
    normalized = (z - z.min()) / max(height, 1e-9)
    xy = points[:, :2]
    low, high = xy.min(0), xy.max(0)
    size = high - low
    best_score, best_coverage = -1.0, None
    bands = [(0.90, 1.01), (0.84, 1.01), (0.78, 0.97), (0.72, 0.91), (0.66, 0.85)]
    for index, (bottom, top) in enumerate(bands):
        selected = points[(normalized >= bottom) & (normalized < top)]
        if len(selected) < 50:
            continue
        coverage = side_coverage(occupancy(selected[:, :2], low, high))
        score = max(coverage.values()) + 0.02 * (len(bands) - index)
        if score > best_score:
            best_score, best_coverage = score, coverage
    if not best_coverage:
        return None, {}
    walls = [side for side, coverage in best_coverage.items() if coverage >= 0.55]
    opposite = {"-X": "+X", "+X": "-X", "-Y": "+Y", "+Y": "-Y"}
    side_length = {"-X": size[1], "+X": size[1], "-Y": size[0], "+Y": size[0]}
    if not walls:
        detected = None
    elif len(walls) >= 3:
        detected = opposite[min(best_coverage, key=best_coverage.get)]
    elif len(walls) == 2 and opposite[walls[0]] == walls[1]:
        detected = max(walls, key=lambda side: best_coverage[side])
    else:
        detected = max(walls, key=lambda side: side_length[side])
    return detected, best_coverage


def named_form_factor(stem):
    upper = stem.upper()
    if "U_SECTIONAL" in upper or "U_CHAISE" in upper or re.search(r"(?:^|_)U(?:_|$)", upper):
        return "U"
    if re.search(r"(?:^|_)RIGHT_ARM(?:_|$)", upper):
        return "R"
    if re.search(r"(?:^|_)LEFT_ARM(?:_|$)", upper):
        return "L"
    return "UNKNOWN"


def geometric_form_factor(points, back):
    if back not in {"-X", "+X", "-Y", "+Y"}:
        return "UNKNOWN"
    xy = points[:, :2]
    low, high = xy.min(0), xy.max(0)
    grid = occupancy(xy, low, high)
    ix, iy = np.nonzero(grid)
    size = high - low
    centers = np.stack([
        low[0] + (ix + 0.5) / grid.shape[0] * size[0],
        low[1] + (iy + 0.5) / grid.shape[1] * size[1],
    ], axis=1) - (low + high) / 2
    back_vector = {"-X": (-1.0, 0.0), "+X": (1.0, 0.0), "-Y": (0.0, -1.0), "+Y": (0.0, 1.0)}[back]
    front = np.array([-back_vector[0], -back_vector[1]])
    viewer_right = np.array([-front[1], front[0]])
    lateral, forward = centers @ viewer_right, centers @ front
    bins = 64
    edges = np.linspace(lateral.min(), lateral.max(), bins + 1)
    indices = np.clip(np.digitize(lateral, edges) - 1, 0, bins - 1)
    profile = np.full(bins, np.nan)
    for index in range(bins):
        selected = indices == index
        if selected.any():
            profile[index] = forward[selected].max()
    floor = np.nanmin(profile)
    span = np.nanmax(profile) - floor
    normalized = np.where(np.isnan(profile), floor, profile)
    normalized = (normalized - floor) / (span if span > 1e-9 else 1.0)
    half = bins // 2
    asymmetry = float(normalized[half:].mean() - normalized[:half].mean())
    center = normalized[int(bins * 0.30):int(bins * 0.70)].mean()
    ends = np.concatenate([normalized[:int(bins * 0.18)], normalized[bins - int(bins * 0.18):]]).mean()
    notch = float(ends - center)
    if abs(asymmetry) >= 0.13:
        return "R" if asymmetry > 0 else "L"
    if notch >= 0.22:
        return "U"
    return "UNKNOWN"


def material_id(name):
    value = name.rsplit(":", 1)[-1] if ":" in name else name
    return re.sub(r"\.\d{3}$", "", value)


def material_sort_key(identifier):
    suffix = identifier.upper().rstrip("0123456789")
    rank = 0 if suffix.endswith("UPH") else 1 if suffix.endswith("STITCHES") else 2 if suffix.endswith("FEET") else 3
    return rank, identifier.casefold()


def inspect(source):
    if not os.path.isfile(source) or not source.lower().endswith(".fbx"):
        raise RuntimeError(f"FBX not found: {source}")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    try:
        bpy.ops.wm.fbx_import(filepath=source, use_anim=False, validate_meshes=False)
    except Exception:
        bpy.ops.import_scene.fbx(filepath=source, use_anim=False)

    chunks, ids, mesh_count = [], [], 0
    bounds_low, bounds_high = None, None
    for obj in bpy.data.objects:
        if obj.type != "MESH" or obj.data is None or not len(obj.data.vertices):
            continue
        mesh_count += 1
        identifier = material_id(obj.name)
        if identifier and identifier.casefold() not in {item.casefold() for item in ids}:
            ids.append(identifier)
        coordinates = np.empty(len(obj.data.vertices) * 3, dtype=np.float64)
        obj.data.vertices.foreach_get("co", coordinates)
        coordinates = coordinates.reshape(-1, 3)
        matrix = np.array(obj.matrix_world)
        coordinates = coordinates @ matrix[:3, :3].T + matrix[:3, 3]
        low, high = coordinates.min(0), coordinates.max(0)
        bounds_low = low if bounds_low is None else np.minimum(bounds_low, low)
        bounds_high = high if bounds_high is None else np.maximum(bounds_high, high)
        chunks.append(coordinates.astype(np.float32))

    if not chunks:
        raise RuntimeError("The FBX contains no mesh objects")
    points = np.concatenate(chunks, axis=0)
    if len(points) > MAX_POINTS:
        indices = np.linspace(0, len(points) - 1, MAX_POINTS).astype(np.int64)
        points = points[indices]

    raw = bounds_high - bounds_low
    (unit_factor, unit_name), ambiguous_units = guess_unit(float(raw[2]), float(raw[0]), float(raw[1]))
    back, coverage = detect_back(points)
    yaw_by_back = {"+Y": 0, "-X": -90, "+X": 90, "-Y": 180}
    import_yaw = yaw_by_back.get(back, 0)
    x_cm, y_cm, z_cm = [float(value * unit_factor * 100) for value in raw]
    width, depth = (y_cm, x_cm) if abs(import_yaw) == 90 else (x_cm, y_cm)
    warnings = []
    if back is None:
        warnings.append("ORIENTATION: no backrest wall found; import yaw defaults to 0°")
    elif back != "+Y":
        warnings.append(f"ORIENTATION: backrest points {back}; import yaw {import_yaw}° applied")
    if ambiguous_units > 1:
        warnings.append(f"UNIT: ambiguous; using {unit_name}")

    stem = os.path.splitext(os.path.basename(source))[0]
    form_factor = named_form_factor(stem)
    if form_factor == "UNKNOWN":
        form_factor = geometric_form_factor(points, back)
    return {
        "side": form_factor,
        "dimensions": [round(width, 1), round(depth, 1), round(z_cm, 1)],
        "yaw": import_yaw,
        "scale": unit_factor,
        "materialIds": sorted(ids, key=material_sort_key),
        "meshObjects": mesh_count,
        "warning": " | ".join(warnings),
        "analysis": {
            "detectedBack": back,
            "unit": unit_name,
            "coverage": {key: round(value, 2) for key, value in coverage.items()},
        },
    }


try:
    result = inspect(arguments())
    print("RH_MODEL_JSON " + json.dumps(result, ensure_ascii=False))
except Exception as error:
    print("RH_MODEL_ERROR " + str(error))
    raise
