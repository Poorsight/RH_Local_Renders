#!/usr/bin/env python3
"""Reference implementation of the sectional light-rig scaler (port target for automation).

Byte-for-byte equivalent to the browser tool (light-rig-scaler/index.html): given a sofa's
Width x Depth x Height and a camera shot, it scales the 5-light rig and emits paste-ready
Unreal T3D. See HANDOFF_FORMULA.md for the formula and the field-by-field contract.

Data lives next to this file and is generated from index.html:
    light_rig.json           constants (reference sofa, per-light base, per-shot rigs, presets)
    rig_template.t3d         the T3D skeleton whose numeric fields get rewritten
    acceptance_vectors.json  golden cases for --selftest

CLI
    python light_rig.py --preset 39250480 --view TQL -o rig.t3d
    python light_rig.py -W 384 -D 305 -H 82 --view TQL --mode A
    python light_rig.py --preset "Koper · U (39250483)" --view auto --emit json
    python light_rig.py --list-presets
    python light_rig.py --selftest

API
    res  = compute_all(384, 305, 82, mode="A", swap=False, view="TQL")
    t3d  = generate_t3d(res)                  # == scale_rig(384, 305, 82, view="TQL")

Python 3.8+, standard library only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
from decimal import Decimal, ROUND_HALF_UP

DATA_DIR = os.path.dirname(os.path.abspath(__file__))

# ─────────────────────────────────────────────────────────────────────────────
# Data
# ─────────────────────────────────────────────────────────────────────────────

_CACHE: dict = {}


def _read_text(path: str) -> str:
    """Read UTF-8 and normalise to LF (git may check the files out with CRLF)."""
    with open(path, "r", encoding="utf-8", newline="") as fh:
        return fh.read().replace("\r\n", "\n")


def data(name: str = "constants"):
    """Lazily load one of: 'constants', 'template', 'vectors'."""
    if name not in _CACHE:
        if name == "constants":
            _CACHE[name] = json.loads(_read_text(os.path.join(DATA_DIR, "light_rig.json")))
        elif name == "template":
            _CACHE[name] = _read_text(os.path.join(DATA_DIR, "rig_template.t3d"))
        elif name == "vectors":
            _CACHE[name] = json.loads(_read_text(os.path.join(DATA_DIR, "acceptance_vectors.json")))
        else:
            raise KeyError(name)
    return _CACHE[name]


def reference() -> dict:
    """The sofa the rig was tuned for: {'W': 453, 'D': 279, 'H': 79}."""
    return dict(data()["reference"])


def presets() -> list:
    """Built-in RH sectional presets (name, sku, W/D/H, render_prefix, tq_view)."""
    return list(data()["presets"])


def find_preset(query: str):
    """Resolve a preset by full name, SKU digits, or render prefix (case-insensitive)."""
    q = str(query).strip().lower()
    for p in presets():
        if q in (str(p["name"]).lower(), str(p["sku"] or "").lower(), str(p["render_prefix"] or "").lower()):
            return p
    hits = [p for p in presets() if q and q in str(p["name"]).lower()]
    if len(hits) == 1:
        return hits[0]
    if len(hits) > 1:
        raise ValueError("ambiguous preset %r -> %s" % (query, ", ".join(p["name"] for p in hits)))
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Formatting — must match JS Number.prototype.toFixed(6) exactly
# ─────────────────────────────────────────────────────────────────────────────

_Q6 = Decimal("0.000001")


def fmt(x) -> str:
    """6-decimal fixed notation, ties away from zero (JS toFixed), '-0' normalised to '0'.

    Python's own f'{x:.6f}' rounds ties to even, so it disagrees with JS on exact
    ties such as 0.0078125 -> JS '0.007813' vs f-string '0.007812'. Decimal(x) is the
    exact binary value of the float, so ROUND_HALF_UP reproduces the JS result.
    """
    x = float(x)
    if x == 0:                     # collapses -0.0, which JS toFixed prints as "0.000000"
        x = 0.0
    return str(Decimal(x).quantize(_Q6, rounding=ROUND_HALF_UP))


def _hyp3(a: float, b: float, c: float) -> float:
    return math.sqrt(a * a + b * b + c * c)


def rig_scale(W, D, H, ref=None) -> float:
    """The single factor the whole rig is scaled by: cbrt(sX * sY * sZ).

    The rig is a studio setup around the subject, not geometry glued to its bounding box,
    so it moves as a rigid body. Every light gets the same factor, which keeps the balance
    between the five sources intact and means pitch/yaw never have to be recomputed.
    The factor is also invariant to swapping W and D, because sX*sY = W*D/(refW*refD)
    either way, so a mesh authored rotated 90 deg produces the same rig.
    """
    ref = reference() if ref is None else ref
    return ((float(W) / float(ref["W"])) *
            (float(D) / float(ref["D"])) *
            (float(H) / float(ref["H"]))) ** (1.0 / 3.0)


# ─────────────────────────────────────────────────────────────────────────────
# Formula
# ─────────────────────────────────────────────────────────────────────────────

def view_lights(view: str) -> dict:
    """LIGHT_BASE merged with the per-shot overrides (pos / I / pitch / yaw)."""
    C = data()
    v = C["views"].get(view) or C["views"]["F"]
    out = {}
    for name in C["light_order"]:
        merged = dict(C["lights"][name])
        merged.update(v["lights"][name])
        out[name] = merged
    return out


def compute_all(W, D, H, mode="A", swap=False, ref=None, view="F") -> dict:
    """Scale the rig for a sofa of W x D x H cm.

    mode  "B" = keep source sizes, intensity x (k^2*d0^2 + R^2)/(d0^2 + R^2)   (default in the UI)
          "A" = scale source sizes too, intensity x k^2 (an exact similarity transform)
    swap  accepted for API compatibility; it has no effect (see rig_scale)
    ref   rig reference sofa, defaults to {'W': 453, 'D': 279, 'H': 79}
    view  "F" | "FH" | "TQR" | "TQL"

    Returns {light_name: {...}} with the values the T3D fields are written from.
    """
    W, D, H = float(W), float(D), float(H)
    ref = reference() if ref is None else ref
    if view not in data()["views"]:
        view = "F"

    k = rig_scale(W, D, H, ref)                 # one factor for the whole rig

    res = {}
    for name, L in view_lights(view).items():
        x, y, z = (float(c) for c in L["pos"])
        npos = [x * k, y * k, z * k]
        d0 = _hyp3(x, y, z)                                  # distance to origin, source rig
        R = (float(L["radius"]) if L["type"] == "spot"
             else math.sqrt(float(L["w"]) * float(L["h"]) / math.pi))   # effective source radius
        p = 2.0 * d0 * d0 / (d0 * d0 + R * R)                # effective falloff exponent (info)

        I0 = float(L["I"])
        if mode == "A":
            intensity, size_k = I0 * k * k, k
        else:
            intensity = I0 * (k * k * d0 * d0 + R * R) / (d0 * d0 + R * R)
            size_k = 1.0

        r = {
            "type": L["type"],
            "pos": npos,
            "intensity": intensity,
            "k": k,
            "p": p,
            "I0": I0,
            "pitch": float(L["pitch"]),                      # never recomputed
            "yaw": float(L["yaw"]),
            "sourcePitch": float(L["pitch"]),                # kept for API compatibility
            "sourceYaw": float(L["yaw"]),                    # (always equal to pitch / yaw now)
            "roll": float(L.get("roll") or 0.0),             # roll is never scaled
            "cone": L.get("cone"),                           # static (template) — for reference only
            "temp": L.get("temp"),                           # static (template) — for reference only
            "label": L.get("label"),
        }
        if L["type"] == "rect":
            r["w"] = float(L["w"]) * size_k
            r["h"] = float(L["h"]) * size_k
            r["barn"] = float(L.get("barn") or 0.0) * size_k
        else:
            r["radius"] = float(L["radius"]) * size_k
            r["soft"] = float(L["soft"]) * size_k if L.get("soft") is not None else None
        res[name] = r
    return res


# ─────────────────────────────────────────────────────────────────────────────
# T3D output
# ─────────────────────────────────────────────────────────────────────────────

_ACTOR = re.compile(r"Begin Actor[\s\S]*?End Actor")
_LABEL = re.compile(r'ActorLabel="([^"]+)"')
_FIELD_CACHE: dict = {}


def _field_re(field: str):
    if field not in _FIELD_CACHE:
        tail = r"\([^)]*\)" if field.startswith("Relative") else r".*$"
        _FIELD_CACHE[field] = re.compile(r"^([ \t]*)" + field + "=" + tail, re.M)
    return _FIELD_CACHE[field]


def _set_field(block: str, field: str, value: str) -> str:
    """Rewrite the first `<indent><field>=…` line in this actor block; no-op if absent."""
    return _field_re(field).sub(lambda m: m.group(1) + field + "=" + value, block, count=1)


def generate_t3d(res: dict, template: str = None) -> str:
    """Rewrite only the numeric fields of the skeleton; structure stays byte-identical."""
    tmpl = data("template") if template is None else template

    def actor(m):
        block = m.group(0)
        label = _LABEL.search(block)
        if not label or label.group(1) not in res:
            return block
        r = res[label.group(1)]
        block = _set_field(block, "RelativeLocation",
                           "(X=%s,Y=%s,Z=%s)" % (fmt(r["pos"][0]), fmt(r["pos"][1]), fmt(r["pos"][2])))
        block = _set_field(block, "RelativeRotation",
                           "(Pitch=%s,Yaw=%s,Roll=%s)" % (fmt(r["pitch"]), fmt(r["yaw"]), fmt(r["roll"])))
        block = _set_field(block, "Intensity", fmt(r["intensity"]))
        if r["type"] == "rect":
            block = _set_field(block, "SourceWidth", fmt(r["w"]))
            block = _set_field(block, "SourceHeight", fmt(r["h"]))
            block = _set_field(block, "BarnDoorLength", fmt(r["barn"]))
        else:
            block = _set_field(block, "SourceRadius", fmt(r["radius"]))
            if r.get("soft") is not None:
                block = _set_field(block, "SoftSourceRadius", fmt(r["soft"]))
        # AttenuationRadius is deliberately not written: the path tracer ignores it, so the
        # template's authored value passes through untouched.
        return block

    return _ACTOR.sub(actor, tmpl)


def scale_rig(W, D, H, view="F", mode="A", swap=False, ref=None) -> str:
    """compute_all + generate_t3d in one call."""
    return generate_t3d(compute_all(W, D, H, mode=mode, swap=swap, ref=ref, view=view))


def as_dict(res: dict, W, D, H, view: str, mode: str, swap: bool, ref: dict) -> dict:
    """Machine-readable rig (for pipelines that spawn/patch lights instead of pasting T3D).

    Authoritative for the *scaled* fields only. Everything static (cone angles, temperature,
    IntensityUnits, shadow/sample settings, folder) comes from rig_template.t3d.
    """
    lights = {}
    for name, r in res.items():
        o = {
            "unreal_class": "RectLight" if r["type"] == "rect" else "SpotLight",
            "location": [round(c, 6) for c in r["pos"]],
            "rotation": {"pitch": round(r["pitch"], 6), "yaw": round(r["yaw"], 6), "roll": round(r["roll"], 6)},
            "source_rotation": {"pitch": r["sourcePitch"], "yaw": r["sourceYaw"], "roll": round(r["roll"], 6)},
            "intensity": round(r["intensity"], 6),
            "k": round(r["k"], 9),
            "p": round(r["p"], 9),
            "static": {"temperature": r["temp"], "outer_cone_angle": r["cone"], "intensity_units": "Candelas"},
        }
        if r["type"] == "rect":
            o["source_width"] = round(r["w"], 6)
            o["source_height"] = round(r["h"], 6)
            o["barn_door_length"] = round(r["barn"], 6)
        else:
            o["source_radius"] = round(r["radius"], 6)
            o["soft_source_radius"] = None if r["soft"] is None else round(r["soft"], 6)
        lights[name] = o

    C = data()
    return {
        "input": {"W": W, "D": D, "H": H},
        "ref": dict(ref),
        "view": view,
        "mode": mode,
        "swap": bool(swap),
        "sofa_yaw": C["views"][view]["sofa_yaw"],
        "folder": "Lights",
        "lights": lights,
        "warnings": warnings(W, D, H, mode, swap, ref, res),
    }


def warnings(W, D, H, mode, swap, ref, res) -> list:
    """Same three sanity checks the web tool shows."""
    sX = (D if swap else W) / float(ref["W"])
    sY = (W if swap else D) / float(ref["D"])
    sZ = H / float(ref["H"])
    out = []
    s_max = max(abs(sX - 1), abs(sY - 1), abs(sZ - 1))
    if s_max > 0.5:
        out.append("rig scaled to ~%d%% of the reference - verify the look%s"
                   % (round((1 + s_max) * 100), " (mode B drifts more)" if mode == "B" else ""))
    in_asp = (D if swap else W) / float(W if swap else D)
    ref_asp = float(ref["W"]) / float(ref["D"])
    if abs(in_asp / ref_asp - 1) > 0.25:
        out.append("footprint aspect %.2f:1 differs from the reference %.2f:1 - check framing"
                   % (in_asp, ref_asp))
    peak = max(r["intensity"] for r in res.values())
    if peak > 250:
        out.append("peak intensity ~%d cd - re-check camera exposure" % round(peak))
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Self-test — proves this file (or your port) matches the web tool
# ─────────────────────────────────────────────────────────────────────────────

_FMT_VECTORS = [
    (0.0, "0.000000"), (-0.0, "0.000000"), (696.0, "696.000000"), (-90.0, "-90.000000"),
    (242.441086, "242.441086"), (0.38283, "0.382830"), (157.21875, "157.218750"),
    (1e-7, "0.000000"), (-1e-7, "-0.000000"),
    (0.0078125, "0.007813"), (-0.0078125, "-0.007813"),   # exact ties: JS rounds away from zero
    (2.5, "2.500000"), (1.0000005, "1.000001"), (1234.5678905, "1234.567890"),
]


def selftest(verbose=True) -> int:
    failed = 0

    def check(name, ok):
        nonlocal failed
        if not ok:
            failed += 1
        if verbose or not ok:
            print("  %s  %s" % ("PASS" if ok else "FAIL", name))

    V = data("vectors")
    tmpl = data("template")
    sha = lambda s: hashlib.sha256(s.encode("utf-8")).hexdigest()

    check("rig_template.t3d matches acceptance_vectors.template_sha256",
          sha(tmpl) == V["template_sha256"])

    for value, want in _FMT_VECTORS:
        check("fmt(%r) == %r" % (value, want), fmt(value) == want)

    # rigid-rig invariants (same vectors as test/sanity.cjs in the repo)
    r0 = reference()
    check("rig_scale: geometric mean of the three axis ratios",
          abs(rig_scale(r0["W"] * 2, r0["D"] * 2, r0["H"] * 2, r0) - 2) < 1e-12 and
          abs(rig_scale(r0["W"] * 2, r0["D"], r0["H"], r0) - 2 ** (1.0 / 3.0)) < 1e-12 and
          rig_scale(r0["W"], r0["D"], r0["H"], r0) == 1.0)
    check("rig_scale: invariant to swapping W and D",
          abs(rig_scale(274.583, 355.499, 86.860, r0) -
              rig_scale(355.499 * r0["W"] / r0["D"], 274.583 * r0["D"] / r0["W"], 86.860, r0)) < 1e-12)
    for v in data()["views"]:
        rr = compute_all(274.583, 355.499, 86.860, mode="B", ref=r0, view=v)
        src = view_lights(v)
        check("%s: pitch/yaw are never recomputed" % v,
              all(rr[n]["pitch"] == float(src[n]["pitch"]) and rr[n]["yaw"] == float(src[n]["yaw"])
                  for n in rr))
        ks = [rr[n]["k"] for n in rr]
        check("%s: k is identical for all five lights" % v, max(ks) - min(ks) == 0.0)
    check("the legacy `swap` argument is a no-op",
          scale_rig(274.583, 355.499, 86.860, view="TQR", mode="B", swap=False) ==
          scale_rig(274.583, 355.499, 86.860, view="TQR", mode="B", swap=True))

    ref = reference()
    for mode in ("A", "B"):
        got = scale_rig(ref["W"], ref["D"], ref["H"], view="F", mode=mode, ref=ref)
        check("identity: F @ reference / mode %s reproduces the skeleton" % mode, got == tmpl)

    for c in V["cases"]:
        res = compute_all(c["input"]["W"], c["input"]["D"], c["input"]["H"],
                          mode=c["mode"], swap=c["swap"], ref=c["ref"], view=c["view"])
        t3d = generate_t3d(res)
        check("%s: t3d sha256" % c["id"], sha(t3d) == c["t3d_sha256"])

        bad = []
        for name, want in c["lights"].items():
            r = res[name]
            got = {
                "location": [fmt(v) for v in r["pos"]],
                "rotation": [fmt(r["pitch"]), fmt(r["yaw"]), fmt(r["roll"])],
                "source_rotation": [fmt(r["sourcePitch"]), fmt(r["sourceYaw"]), fmt(r["roll"])],
                "intensity": fmt(r["intensity"]),
                "k": "%.9f" % r["k"],
            }
            if r["type"] == "rect":
                got.update(source_width=fmt(r["w"]), source_height=fmt(r["h"]),
                           barn_door_length=fmt(r["barn"]))
            else:
                got["source_radius"] = fmt(r["radius"])
                if r["soft"] is not None:
                    got["soft_source_radius"] = fmt(r["soft"])
            for field, expected in want.items():
                if got.get(field) != expected:
                    bad.append("%s.%s: got %r want %r" % (name, field, got.get(field), expected))
        check("%s: per-light values" % c["id"], not bad)
        for b in bad:
            print("        " + b)

    print("\n%s" % ("%d check(s) FAILED" % failed if failed else "All checks passed."))
    return 1 if failed else 0


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

def _cli(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Scale the sectional light rig and emit Unreal T3D.",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-W", type=float, help="sofa width, cm (world X)")
    ap.add_argument("-D", type=float, help="sofa depth, cm (world Y)")
    ap.add_argument("-H", type=float, help="sofa height, cm (world Z)")
    ap.add_argument("--preset", help="built-in preset: full name, SKU digits, or render prefix")
    ap.add_argument("--view", default="F", choices=["F", "FH", "TQR", "TQL", "auto"],
                    help="camera shot; 'auto' = the preset's arm-side TQ shot, else F")
    ap.add_argument("--mode", default="A", choices=["A", "B"], help="intensity model (default A)")
    ap.add_argument("--swap", action="store_true", help="sofa stands rotated 90 deg (swap X/Y inputs)")
    ap.add_argument("--ref", nargs=3, type=float, metavar=("W", "D", "H"),
                    help="override the rig reference sofa (default 453 279 79)")
    ap.add_argument("--emit", default="t3d", choices=["t3d", "json"], help="output format")
    ap.add_argument("-o", "--out", help="write to this file instead of stdout")
    ap.add_argument("--list-presets", action="store_true", help="print the built-in presets and exit")
    ap.add_argument("--selftest", action="store_true", help="verify against the golden vectors and exit")
    a = ap.parse_args(argv)

    try:                                   # preset names contain "·"; Windows consoles default to cp125x
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    if a.selftest:
        return selftest()

    if a.list_presets:
        print("%-52s %-9s %-16s %s" % ("preset", "sku", "W x D x H", "tq shot"))
        for p in presets():
            print("%-52s %-9s %-16s %s" % (p["name"], p["sku"] or "-",
                                           "%g x %g x %g" % (p["W"], p["D"], p["H"]),
                                           p["tq_view"] or "-"))
        return 0

    preset = None
    if a.preset:
        preset = find_preset(a.preset)
        if not preset:
            print("unknown preset: %s (try --list-presets)" % a.preset, file=sys.stderr)
            return 2

    W = a.W if a.W is not None else (preset or {}).get("W")
    D = a.D if a.D is not None else (preset or {}).get("D")
    H = a.H if a.H is not None else (preset or {}).get("H")
    if W is None or D is None or H is None:
        print("need -W -D -H (or --preset)", file=sys.stderr)
        return 2
    if min(W, D, H) <= 0:
        print("dimensions must be > 0", file=sys.stderr)
        return 2

    ref = reference() if not a.ref else {"W": a.ref[0], "D": a.ref[1], "H": a.ref[2]}
    view = a.view
    if view == "auto":
        view = (preset or {}).get("tq_view") or "F"

    res = compute_all(W, D, H, mode=a.mode, swap=a.swap, ref=ref, view=view)
    if a.emit == "json":
        text = json.dumps(as_dict(res, W, D, H, view, a.mode, a.swap, ref), indent=2, ensure_ascii=False) + "\n"
    else:
        text = generate_t3d(res)

    for w in warnings(W, D, H, a.mode, a.swap, ref, res):
        print("warning: " + w, file=sys.stderr)

    if a.out:
        with open(a.out, "w", encoding="utf-8", newline="") as fh:   # newline="" keeps LF on Windows
            fh.write(text)
        print("wrote %s (%s, view %s, mode %s, %g x %g x %g)"
              % (a.out, a.emit, view, a.mode, W, D, H), file=sys.stderr)
    else:
        sys.stdout.write(text if text.endswith("\n") else text + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
