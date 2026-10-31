import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class StoreConfigTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "source"
        (self.root / "deploy").mkdir(parents=True)
        shutil.copyfile(Path(__file__).with_name("apply-store-config.py"), self.root / "deploy/apply-store-config.py")
        (self.root / "pindou-miniapp/src").mkdir(parents=True)
        (self.root / "pindou-miniapp/src/title.ts").write_text("export const title = 'Example'")
        self.config = self.base / "private"
        (self.config / "files/layout").mkdir(parents=True)
        (self.config / "files/layout/store-layout.json").write_text('{"fixture": true}')
        (self.config / "branding.json").write_text(json.dumps({"Example": "Production fixture"}))
        (self.config / "build-env.json").write_text(json.dumps({"TARO_APP_ID": "test-fixture-app"}))

    def run_config(self):
        return subprocess.run(
            ["python3", str(self.root / "deploy/apply-store-config.py"), str(self.config)],
            env={**os.environ, "GITHUB_ENV": str(self.base / "github-env")},
            capture_output=True,
            text=True,
        )

    def test_applies_brand_layout_and_environment_without_logging_values(self):
        result = self.run_config()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Production fixture", (self.root / "pindou-miniapp/src/title.ts").read_text())
        self.assertEqual((self.root / "layout/store-layout.json").read_text(), '{"fixture": true}')
        self.assertEqual((self.base / "github-env").read_text(), "TARO_APP_ID=test-fixture-app\n")
        self.assertEqual((self.root / "pindou-miniapp/.env.production.local").read_text(), "TARO_APP_ID=test-fixture-app\n")
        self.assertNotIn("test-fixture-app", result.stdout + result.stderr)

    def test_rejects_multiline_environment_values(self):
        (self.config / "build-env.json").write_text(json.dumps({"TARO_APP_ID": "first\nOTHER=value"}))
        result = self.run_config()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("invalid environment entry TARO_APP_ID", result.stderr)
        self.assertFalse((self.base / "github-env").exists())

    def test_rejects_overlay_destination_outside_the_build_workspace(self):
        (self.root / "layout").symlink_to(self.base, target_is_directory=True)
        result = self.run_config()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("forbidden destination layout/store-layout.json", result.stderr)
        self.assertFalse((self.base / "store-layout.json").exists())


if __name__ == "__main__":
    unittest.main()
