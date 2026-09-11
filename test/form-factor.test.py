"""Geometry regression tests; run with Python + NumPy or Blender's Python."""
import ast
from pathlib import Path
import unittest
import numpy as np

tree = ast.parse((Path(__file__).parents[1] / 'scripts/inspect_fbx.py').read_text(encoding='utf-8'))
# Test the actual pure functions without importing bpy or running the CLI.
tree.body = [node for node in tree.body if isinstance(node, ast.FunctionDef)]
import re
engine = {'np': np, 're': re}
exec(compile(tree, 'inspect_fbx.py', 'exec'), engine)


def footprint(kind):
    x, y = np.meshgrid(np.linspace(-2, 2, 181), np.linspace(-1, 1, 121))
    if kind == 'straight': keep = np.ones(x.shape, dtype=bool)
    elif kind == 'right': keep = (y >= 0.25) | (x >= 0.95)
    elif kind == 'left': keep = (y >= 0.25) | (x <= -0.95)
    elif kind == 'u': keep = (y >= 0.25) | (np.abs(x) >= 0.95)
    elif kind == 'curved':
        outer = 1.0 - 0.5 * x**2
        keep = (y <= outer) & (y >= outer - 0.65)
    elif kind == 'diamond': keep = np.abs(x) / 2 + np.abs(y) <= 1
    return np.column_stack([x[keep], y[keep], np.zeros(keep.sum())])


class FormFactorTests(unittest.TestCase):
    def test_geometry_rotates_and_scales_without_changing_shape(self):
        for kind, expected in [('straight', 'STRAIGHT'), ('right', 'R'), ('left', 'L'), ('u', 'U')]:
            for turn, back in enumerate(['+Y', '-X', '-Y', '+X']):
                angle = turn * np.pi / 2
                rotation = np.array([[np.cos(angle), -np.sin(angle)], [np.sin(angle), np.cos(angle)]])
                for scale in [0.01, 1, 100]:
                    points = footprint(kind) * scale
                    points[:, :2] = points[:, :2] @ rotation.T + [37, -42]
                    self.assertEqual(engine['geometric_form_factor'](points, back), expected, (kind, back, scale))

    def test_curved_back_inference_rotates_with_opening(self):
        for turn, expected in enumerate(['+Y', '-X', '-Y', '+X']):
            points = footprint('curved')
            angle = turn * np.pi / 2
            points[:, :2] = points[:, :2] @ np.array([[np.cos(angle), -np.sin(angle)], [np.sin(angle), np.cos(angle)]]).T
            back, _, method = engine['resolve_back'](points)
            self.assertEqual((back, method), (expected, 'curved-footprint'))
            self.assertEqual(engine['geometric_form_factor'](points, back), 'U')

    def test_unknown_is_not_a_default_u_or_straight(self):
        self.assertEqual(engine['geometric_form_factor'](footprint('straight'), None), 'UNKNOWN')
        self.assertEqual(engine['geometric_form_factor'](footprint('diamond'), '+Y'), 'UNKNOWN')
        self.assertIsNone(engine['resolve_back'](footprint('diamond'))[0])
        line = np.column_stack([np.linspace(-2, 2, 181), np.zeros(181), np.zeros(181)])
        self.assertEqual(engine['geometric_form_factor'](line, '+Y'), 'UNKNOWN')

    def test_small_padding_variation_is_not_a_chaise(self):
        points = footprint('straight')
        points[:, 1] += points[:, 0] * 0.015
        self.assertEqual(engine['geometric_form_factor'](points, '+Y'), 'STRAIGHT')

    def test_l_sectional_is_not_left_and_sofa_is_not_automatically_straight(self):
        for name in ['ISOLA_L_SECTIONAL_CLASSIC_9x9_prod32820190', 'ANY_SOFA_prod1']:
            self.assertEqual(engine['named_form_factor'](name), 'UNKNOWN')
        self.assertEqual(engine['named_form_factor']('ANY_RIGHT_ARM_L_SECTIONAL'), 'R')


if __name__ == '__main__': unittest.main()
