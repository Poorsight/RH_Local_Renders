"""Tool-owned startup adapter for stock BatchRender 5.6; no plugin/asset saves.

The editor loads this script after its asset registry is ready. Native TestJob
defers the import to an editor tick and disables background server-job fetching.
Only public reflected functions of the upstream plugin are used.
"""
import json
import math
import os
import traceback
import urllib.request


def run(unreal, manifest):
    with open(manifest["jobFile"], encoding="utf-8") as source:
        job = json.load(source)
    library = unreal.BatchRenderLibrary
    subsystem = unreal.get_editor_subsystem(unreal.BatchRenderEditorSubsystem)
    if subsystem is None:
        raise RuntimeError("BatchRender editor subsystem is unavailable")
    # Keep loaded/modified sequences alive until process exit. Never save them.
    sequences = {}
    validate_resources = manifest.get("validateResources", True)
    inherited_names = {item["sequenceName"] for item in manifest.get("inherited", [])}
    for task in job.get("tasks", []):
        # A stock-plugin experiment must let the plugin itself handle bad inputs.
        # Only load sequences required to transport the explicitly allowed focal.
        for group in task.get("materials", []) if validate_resources else []:
            if not group.get("list"):
                raise RuntimeError("Empty material variant list for " + str(task.get("taskId")))
            for material in group["list"]:
                name = material.get("name", "")
                if not name or library.find_material_by_name(name) is None:
                    raise RuntimeError("Required material not found: " + name + "; task=" + str(task.get("taskId")))
        for layer in task.get("layers", []) if validate_resources else []:
            if library.find_movie_pipeline_config_by_name(layer.get("config", "")) is None:
                raise RuntimeError("MRQ preset not found: " + str(layer.get("config")))
        for camera in task.get("sequence", {}).get("cameras", []):
            name = camera.get("sequenceName", "")
            if not validate_resources and name not in inherited_names:
                continue
            if not name:
                raise RuntimeError("Camera sequenceName is required")
            if name not in sequences:
                found = library.find_level_sequence_by_name(name)
                # Reflected return value + output bool form a tuple in Python.
                if not isinstance(found, tuple) or len(found) != 2 or not found[1]:
                    raise RuntimeError("Sequence not found: " + name)
                sequence = library.get_level_sequence_from_path(found[0])
                if sequence is None:
                    raise RuntimeError("Sequence cannot be loaded: " + name)
                sequences[name] = sequence
    for inherited in manifest.get("inherited", []):
        name, focal = inherited["sequenceName"], float(inherited["focalLength"])
        if not math.isfinite(focal) or focal <= 0:
            raise RuntimeError("Invalid inherited focal length for " + name)
        sequence = sequences[name]
        if not library.add_focal_length_key_to_arch_cine_camera_in_sequence(sequence, 0.0, focal, True):
            raise RuntimeError("Cannot set inherited focal length for " + name)
        actual = library.get_focal_length_key_from_cine_camera_in_sequence(sequence, 0.0)
        # A bool-return function with one output float yields float or None.
        if actual is None or not math.isclose(float(actual), focal, rel_tol=1e-5, abs_tol=1e-3):
            raise RuntimeError("Inherited focal verification failed for " + name + ": " + str(actual))
    # UE exports UEditorPythonScriptingLibrary as "EditorPythonScripting".
    unreal.EditorPythonScripting.set_keep_python_script_alive(True)
    subsystem.test_job(manifest["jobFile"])
    # TestJob is void: an invalid manager reports only to the UE log and clears
    # its manual-job flag synchronously. Do not announce readiness in that case.
    if not subsystem.is_manual_test_job():
        raise RuntimeError("Native BatchRender rejected TestJob; inspect its initialization log")
    return sequences


def send_event(manifest, event, **extra):
    data = {"jobId": manifest["jobId"], "attemptId": manifest["attemptId"], **extra}
    request = urllib.request.Request(manifest["apiUrl"], data=json.dumps({"event": event, "data": data}).encode("utf-8"),
                                     headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=10) as response:
        if response.status != 200:
            raise RuntimeError("Local adapter event was rejected")


def main():
    import unreal
    with open(os.environ["RH_BATCHRENDER_ADAPTER_MANIFEST"], encoding="utf-8") as source:
        manifest = json.load(source)
    try:
        global _retained_sequences
        _retained_sequences = run(unreal, manifest)
        send_event(manifest, "rh_adapter_ready", inheritedCameras=len(manifest.get("inherited", [])))
    except Exception:
        message = traceback.format_exc()
        unreal.log_error("RH local adapter: " + message)
        try:
            send_event(manifest, "rh_adapter_error", error=message)
        finally:
            unreal.EditorPythonScripting.set_keep_python_script_alive(False)


if __name__ == "__main__":
    main()
