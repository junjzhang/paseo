"""Exercise deployment boundaries with a temporary checkout and build adapter."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("deploy", Path(__file__).with_name("deploy.py"))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class DeploymentTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="magpie-deployment-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "checkout"
        self.home = Path(self.temp.name) / "user"
        self.source = self.root / "third_party/magpie"
        self.source.mkdir(parents=True)
        self.home.mkdir()
        self.git("init", "-q")
        (self.source / "source.txt").write_text("pinned source\n")
        self.git("add", "source.txt")
        self.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture")
        self.revision = self.git("rev-parse", "HEAD").stdout.strip()
        self.lock = {"revision": self.revision, "version": "0.1.0-test", "go": "1.26.8"}
        (self.root / "third_party/magpie.lock.json").write_text(json.dumps(self.lock))
        self.binary = self.home / ".local/bin/magpie"
        self.binary.parent.mkdir(parents=True)
        self.binary.write_text("old binary")
        self.config = self.home / ".config/magpie/accounts.json"
        self.config.parent.mkdir(parents=True)
        self.config.write_text("private fixture must remain unchanged")

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.source), *args], check=True, text=True, capture_output=True)

    def invoke(self, *args, fail_build=False):
        real_run = deploy.run

        def run(*command, **kwargs):
            if command[0] != "go":
                return real_run(*command, **kwargs)
            if fail_build:
                raise subprocess.CalledProcessError(1, command)
            output = Path(command[command.index("-o") + 1])
            output.write_text("#!/bin/sh\necho 'magpie 0.1.0-test'\n")
            output.chmod(0o755)

        with patch.object(deploy.Path, "home", return_value=self.home), \
             patch.object(deploy.shutil, "which", return_value="/fixture/go"), \
             patch.object(deploy, "run", side_effect=run), \
             patch("sys.argv", ["deploy.py", "--repo", str(self.root), *args]), \
             contextlib.redirect_stdout(io.StringIO()):
            deploy.main()

    def test_install_preserves_config_and_previous_binary_even_on_same_pin(self):
        self.invoke("--install")
        self.assertTrue(self.binary.is_symlink())
        self.assertEqual(self.config.read_text(), "private fixture must remain unchanged")
        backups = self.home / ".local/lib/magpie/backups"
        self.assertEqual([p.read_text() for p in backups.iterdir()], ["old binary"])
        self.binary.resolve().write_text("previous build at same pin")
        self.invoke("--install")
        self.assertIn("previous build at same pin", [p.read_text() for p in backups.iterdir()])
        self.assertEqual(self.config.read_text(), "private fixture must remain unchanged")

    def test_failed_build_keeps_installed_binary(self):
        with self.assertRaises(subprocess.CalledProcessError):
            self.invoke("--install", fail_build=True)
        self.assertFalse(self.binary.is_symlink())
        self.assertEqual(self.binary.read_text(), "old binary")

    def test_dry_run_and_dirty_source_do_not_mutate_install(self):
        before = sorted(str(p.relative_to(self.home)) for p in self.home.rglob("*"))
        self.invoke("--dry-run")
        self.assertEqual(sorted(str(p.relative_to(self.home)) for p in self.home.rglob("*")), before)
        (self.source / "source.txt").write_text("unreviewed change")
        with self.assertRaises(SystemExit):
            self.invoke("--install")
        self.assertEqual(self.binary.read_text(), "old binary")


if __name__ == "__main__":
    unittest.main()
