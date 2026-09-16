"""Offline adapter tests. Mocks do NOT validate Unreal reflection or rendering."""
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

script = Path(__file__).resolve().parents[1] / "integration/batchrender/upstream-bootstrap.py"
spec = importlib.util.spec_from_file_location("upstream_bootstrap", script)
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="rh-bootstrap-test-")
        self.addCleanup(self.tmp.cleanup)
        self.calls = []
        self.focal = 35.0
        self.valid_material = True
        self.readback_offset = 0.0
        self.accepts_job = True
        self.sequence = object()
        library = types.SimpleNamespace(
            find_material_by_name=lambda name: object() if self.valid_material else None,
            find_movie_pipeline_config_by_name=lambda name: object(),
            find_level_sequence_by_name=lambda name: ("/Game/F", True),
            get_level_sequence_from_path=lambda path: self.sequence,
            add_focal_length_key_to_arch_cine_camera_in_sequence=self.set_focal,
            get_focal_length_key_from_cine_camera_in_sequence=lambda seq, time: self.focal + self.readback_offset,
        )
        self.unreal = types.SimpleNamespace(
            BatchRenderLibrary=library,
            BatchRenderEditorSubsystem=object,
            get_editor_subsystem=lambda cls: types.SimpleNamespace(
                test_job=lambda file: self.calls.append(("test_job", file)),
                is_manual_test_job=lambda: self.accepts_job),
            EditorPythonScripting=types.SimpleNamespace(set_keep_python_script_alive=lambda value: self.calls.append(("keep_alive", value))),
        )
        self.job = {"jobId": "test", "tasks": [{"taskId": "model", "materials": [{"meshes": ["uph"], "list": [{"name": "linen"}]}],
            "layers": [{"config": "preset"}], "sequence": {"cameras": [{"sequenceName": "F"}]}}]}
        self.file = Path(self.tmp.name) / "phase.json"
        self.file.write_text(json.dumps(self.job), encoding="utf-8")
        self.manifest = {"jobFile": str(self.file), "inherited": [{"sequenceName": "F", "focalLength": 164.25}]}

    def set_focal(self, sequence, time, focal, reset):
        self.calls.append(("focal", focal))
        self.focal = focal
        return True

    def test_sets_focal_before_native_job_and_retains_sequence(self):
        retained = bootstrap.run(self.unreal, self.manifest)
        self.assertIs(retained["F"], self.sequence)
        self.assertEqual(self.calls, [("focal", 164.25), ("keep_alive", True), ("test_job", str(self.file))])

    def test_missing_material_never_changes_camera_or_starts_job(self):
        self.valid_material = False
        with self.assertRaisesRegex(RuntimeError, "Required material not found"):
            bootstrap.run(self.unreal, self.manifest)
        self.assertEqual(self.calls, [])

    def test_missing_preset_does_not_start_job(self):
        self.unreal.BatchRenderLibrary.find_movie_pipeline_config_by_name = lambda name: None
        with self.assertRaisesRegex(RuntimeError, "MRQ preset not found"):
            bootstrap.run(self.unreal, self.manifest)
        self.assertEqual(self.calls, [])

    def test_missing_sequence_does_not_start_job(self):
        self.unreal.BatchRenderLibrary.find_level_sequence_by_name = lambda name: ("", False)
        with self.assertRaisesRegex(RuntimeError, "Sequence not found"):
            bootstrap.run(self.unreal, self.manifest)
        self.assertEqual(self.calls, [])

    def test_readback_mismatch_does_not_start_job(self):
        self.readback_offset = 1.0
        with self.assertRaisesRegex(RuntimeError, "verification failed"):
            bootstrap.run(self.unreal, self.manifest)
        self.assertEqual(self.calls, [("focal", 164.25)])

    def test_fabric_fit_starts_without_changing_authored_focal(self):
        self.manifest["inherited"] = []
        bootstrap.run(self.unreal, self.manifest)
        self.assertEqual(self.focal, 35.0)
        self.assertEqual(self.calls[0], ("keep_alive", True))

    def test_invalid_native_manager_does_not_report_readiness(self):
        self.accepts_job = False
        with self.assertRaisesRegex(RuntimeError, "rejected TestJob"):
            bootstrap.run(self.unreal, self.manifest)

    def test_stock_experiment_leaves_material_and_preset_failures_to_plugin(self):
        self.manifest["validateResources"] = False
        self.valid_material = False
        self.unreal.BatchRenderLibrary.find_movie_pipeline_config_by_name = lambda name: None
        bootstrap.run(self.unreal, self.manifest)
        self.assertIn(("focal", 164.25), self.calls)
        self.assertIn(("test_job", str(self.file)), self.calls)

    def test_stock_fabric_does_not_preload_or_repair_camera(self):
        self.manifest.update(validateResources=False, inherited=[])
        self.unreal.BatchRenderLibrary.find_level_sequence_by_name = lambda name: self.fail("Fabric must use the native sequence path")
        retained = bootstrap.run(self.unreal, self.manifest)
        self.assertEqual(retained, {})
        self.assertEqual(self.focal, 35.0)

    def test_startup_failure_reports_error_and_releases_editor_keep_alive(self):
        self.unreal.log_error = lambda message: self.calls.append(("log_error", message))
        manifest_file = Path(self.tmp.name) / "adapter.json"
        manifest_file.write_text(json.dumps(self.manifest), encoding="utf-8")
        with patch.dict("sys.modules", {"unreal": self.unreal}), \
                patch.dict("os.environ", {"RH_BATCHRENDER_ADAPTER_MANIFEST": str(manifest_file)}), \
                patch.object(bootstrap, "run", side_effect=RuntimeError("startup failed")), \
                patch.object(bootstrap, "send_event") as send_event:
            bootstrap.main()
        self.assertEqual(send_event.call_args.args[1], "rh_adapter_error")
        self.assertIn("startup failed", send_event.call_args.kwargs["error"])
        self.assertEqual(self.calls[-1], ("keep_alive", False))


if __name__ == "__main__":
    unittest.main()
