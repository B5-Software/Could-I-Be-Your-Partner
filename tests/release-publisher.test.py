# SPDX-License-Identifier: GPL-3.0-or-later
"""Exercise the real publisher and Node generators with an in-memory GitHub API."""
import base64
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
REPO = 'fixture/app'
VERSION = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
PLATFORMS = ['win-x64', 'win-arm64', 'mac-x64', 'mac-arm64', 'linux-x64', 'linux-arm64']


class PublisherTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='cibyp-publisher-test-')
        self.cwd = Path(self.temporary.name)
        self.original_cwd = Path.cwd()
        os.chdir(self.cwd)
        self.addCleanup(self.temporary.cleanup)
        self.addCleanup(os.chdir, self.original_cwd)
        self.real_run = subprocess.run
        self.git('init', '-b', 'main')
        self.git('config', 'user.name', 'Release test')
        self.git('config', 'user.email', 'release@example.invalid')
        self.git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'old version')
        self.git('tag', 'v0.0.1')
        self.git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fix: direct change',
                 '-m', '完整提交正文。\nSecond paragraph.')
        self.sha = self.git('rev-parse', 'HEAD').strip()
        self.git('tag', 'v' + VERSION)
        self.release = None
        self.bodies = []
        self.uploads = []
        self.artifacts = []
        self.archives = {}
        self.release_pages = []
        for i, platform in enumerate(PLATFORMS):
            system, arch = platform.split('-')
            system = {'win': 'win32', 'mac': 'darwin'}.get(system, system)
            name = f'cibyp-runtime-{VERSION}-{system}-{arch}.tar.gz'
            binary = ('fixture payload ' + platform).encode()
            metadata = {
                'version': VERSION, 'platform': system, 'arch': arch, 'file': name,
                'size': len(binary), 'sha256': hashlib.sha256(binary).hexdigest(),
                'node': 'node/bin/node', 'entry': 'app/entry.cjs',
                'executable': 'app/cibyp', 'resources': 'app/resources',
            }
            self.add_artifact(i * 2 + 1, 'npm-' + platform, {
                name: binary, name.replace('.tar.gz', '.json'): json.dumps(metadata).encode(),
            })
            self.add_artifact(i * 2 + 2, 'dist-' + platform, {platform + '.exe': b'installer'})

    def git(self, *args):
        result = self.real_run(['git', *args], check=True, capture_output=True, text=True)
        return result.stdout

    def add_artifact(self, number, name, files):
        self.artifacts.append({'id': number, 'name': name, 'expired': False})
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w') as bundle:
            for filename, data in files.items():
                bundle.writestr(filename, data)
        self.archives[number] = stream.getvalue()

    def api(self, args, **kwargs):
        self.assertEqual(args[:2], ['gh', 'api'])
        endpoint = args[2].removeprefix('repos/' + REPO + '/')
        if endpoint == 'actions/runs/123':
            data = {'head_branch': 'main', 'path': '.github/workflows/release.yml',
                    'event': 'push', 'head_sha': self.sha}
        elif endpoint.startswith('actions/runs/123/jobs'):
            data = {'jobs': [{'name': 'build (' + p + ')', 'conclusion': 'success'} for p in PLATFORMS]}
        elif endpoint == 'contents/package.json?ref=' + self.sha:
            data = {'content': base64.b64encode(json.dumps({'version': VERSION}).encode()).decode()}
        elif endpoint.startswith('releases?'):
            page = int(endpoint.rsplit('=', 1)[1])
            self.release_pages.append(page)
            # Force pagination; drafts cannot become changelog baselines.
            data = ([{'tag_name': 'v0.0.0', 'draft': True}] * 100 if page == 1
                    else [{'tag_name': 'v0.0.1', 'draft': False}])
        elif endpoint == 'releases/tags/v' + VERSION:
            if self.release is None:
                raise subprocess.CalledProcessError(1, args)
            data = copy.deepcopy(self.release)
        elif endpoint.startswith('actions/runs/123/artifacts'):
            data = {'artifacts': self.artifacts}
        else:
            raise AssertionError('Unexpected API request: ' + endpoint)
        return json.dumps(data).encode()

    def run_command(self, args, **kwargs):
        if args[0] == 'node':
            # Run the production generators in this fixture's Git repository.
            return self.real_run(['node', str(ROOT / args[1]), *args[2:]], **kwargs)
        self.assertEqual(args[0], 'gh')
        if args[1] == 'api':
            number = int(args[2].split('/')[-2])
            kwargs['stdout'].write(self.archives[number])
        elif args[1:3] == ['release', 'create']:
            self.assertIn('--verify-tag', args)
            if '-' in VERSION:
                self.assertIn('--prerelease', args)
            body = Path(args[args.index('--notes-file') + 1]).read_text(encoding='utf-8')
            self.release = {'draft': False, 'body': body, 'assets': []}
            self.bodies.append(body)
        elif args[1:3] == ['release', 'edit']:
            body = Path(args[args.index('--notes-file') + 1]).read_text(encoding='utf-8')
            self.release['body'] = body
            self.bodies.append(body)
        elif args[1:3] == ['release', 'upload']:
            file = Path(args[4])
            self.uploads.append(file.name)
            self.release['assets'].append({'name': file.name, 'size': file.stat().st_size,
                                          'digest': 'sha256:' + hashlib.sha256(file.read_bytes()).hexdigest()})
        else:
            raise AssertionError('Unexpected command: ' + repr(args))
        return subprocess.CompletedProcess(args, 0)

    def publish(self, runtime_only=False):
        # The publisher expects a fresh output directory for every CI run.
        output = self.cwd / 'runtime-assets'
        if output.exists():
            # Checked workspace path, native Python deletion throughout.
            self.assertEqual(output.resolve().parent, self.cwd.resolve())
            import shutil
            shutil.rmtree(output)
        with patch.dict(os.environ, {'GITHUB_REPOSITORY': REPO, 'BUILD_RUN_ID': '123'}), \
             patch.object(sys, 'argv', ['publish-runtime-assets.py'] + (['--runtime-only'] if runtime_only else [])), \
             patch('subprocess.check_output', side_effect=self.api), \
             patch('subprocess.run', side_effect=self.run_command):
            runpy.run_path(str(ROOT / 'scripts/publish-runtime-assets.py'), run_name='__main__')

    def test_new_release_and_idempotent_rerun(self):
        self.publish()
        self.assertEqual(self.release_pages, [1, 2])
        self.assertIn('fix: direct change', self.release['body'])
        self.assertIn('完整提交正文。', self.release['body'])
        self.assertIn('v0.0.1', self.release['body'])
        self.assertEqual(self.uploads[-2:], ['CHANGELOG.md', 'cibyp-runtime.json'])
        first_uploads = self.uploads.copy()
        self.release['body'] += '\nManual installation instructions.\n'
        self.publish()
        self.assertEqual(self.uploads, first_uploads)
        self.assertIn('Manual installation instructions.', self.release['body'])
        self.assertEqual(len(self.bodies), 1)

    def test_existing_release_preserves_manual_notes(self):
        self.release = {'draft': False, 'body': 'Manual release notes.', 'assets': []}
        self.publish()
        self.assertIn('Manual release notes.', self.release['body'])
        self.assertIn('fix: direct change', self.release['body'])
        self.assertEqual(len(self.bodies), 1)

    def test_runtime_only_leaves_body_and_changelog_alone(self):
        self.release = {'draft': False, 'body': 'Original release notes.', 'assets': []}
        self.publish(runtime_only=True)
        self.assertEqual(self.release['body'], 'Original release notes.')
        self.assertEqual(self.release_pages, [])
        self.assertEqual(self.bodies, [])
        self.assertNotIn('CHANGELOG.md', self.uploads)
        self.assertEqual(self.uploads[-1], 'cibyp-runtime.json')


if __name__ == '__main__':
    unittest.main()
