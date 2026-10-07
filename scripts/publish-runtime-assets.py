# SPDX-License-Identifier: GPL-3.0-or-later
"""Publish six verified GitHub runtimes; never publish payloads to npm."""
import base64
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import zipfile

repo = os.environ['GITHUB_REPOSITORY']
run_id = os.environ['BUILD_RUN_ID']
runtime_only = '--runtime-only' in sys.argv
if not run_id.isdigit():
    raise RuntimeError('Invalid build run ID')

def api(endpoint):
    return json.loads(subprocess.check_output(['gh', 'api', f'repos/{repo}/{endpoint}']))

run = api(f'actions/runs/{run_id}')
if run['head_branch'] != 'main' or run['path'] != '.github/workflows/release.yml' or run['event'] not in ('push', 'workflow_dispatch'):
    raise RuntimeError('Runtimes must originate from the main release workflow')
jobs = api(f'actions/runs/{run_id}/jobs?per_page=100')['jobs']
platforms = ['win-x64', 'win-arm64', 'mac-x64', 'mac-arm64', 'linux-x64', 'linux-arm64']
for platform in platforms:
    if not any((job['name'] == f'build ({platform})' or job['name'].startswith(f'build ({platform},')) and job['conclusion'] == 'success' for job in jobs):
        raise RuntimeError('Missing successful platform build: ' + platform)
source = api('contents/package.json?ref=' + run['head_sha'])
version = json.loads(base64.b64decode(source['content']))['version']
tag = 'v' + version
destination = pathlib.Path('runtime-assets')
destination.mkdir(exist_ok=False)
notes_file = destination / 'CHANGELOG.md'
notes_args = ['node', 'scripts/generate-release-notes.cjs', '--repo', repo,
              '--version', version, '--to', run['head_sha']]
if not runtime_only:
    published_tags = []
    page = 1
    while True:
        batch = api(f'releases?per_page=100&page={page}')
        published_tags.extend(item['tag_name'] for item in batch if not item['draft'])
        if len(batch) < 100:
            break
        page += 1
    tags_file = destination / 'published-tags.txt'
    tags_file.write_text(json.dumps(published_tags), encoding='utf-8')
    notes_args.extend(['--published-tags', str(tags_file)])
    subprocess.run(notes_args + ['--output', str(notes_file)], check=True)
try:
    release = api('releases/tags/' + tag)
except subprocess.CalledProcessError:
    if runtime_only:
        raise RuntimeError('Runtime-only publication requires an existing GitHub Release')
    args = ['gh', 'release', 'create', tag, '--verify-tag', '--title', tag,
            '--notes-file', str(notes_file)]
    if '-' in version:
        args.append('--prerelease')
    subprocess.run(args, check=True)
    release = api('releases/tags/' + tag)
if release['draft']:
    raise RuntimeError('Cannot use a draft release')
if not runtime_only:
    body_file = destination / 'existing-body.txt'
    body_file.write_text(release.get('body') or '', encoding='utf-8')
    merged_file = destination / 'release-body.md'
    subprocess.run(notes_args + ['--existing-body', str(body_file), '--output', str(merged_file)], check=True)
    if merged_file.read_text(encoding='utf-8').strip() != (release.get('body') or '').strip():
        subprocess.run(['gh', 'release', 'edit', tag, '--notes-file', str(merged_file)], check=True)

def digest(file):
    h = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return 'sha256:' + h.hexdigest()

existing = {asset['name']: asset for asset in release['assets']}
def upload(file):
    previous = existing.get(file.name)
    if previous:
        if previous.get('digest') != digest(file) or previous['size'] != file.stat().st_size:
            raise RuntimeError('Refusing to overwrite an existing release asset: ' + file.name)
        print('Already verified: ' + file.name, flush=True)
        return
    subprocess.run(['gh', 'release', 'upload', tag, str(file)], check=True)

artifacts = api(f'actions/runs/{run_id}/artifacts?per_page=100')['artifacts']
for platform in platforms:
    selected = [a for a in artifacts if a['name'] == 'npm-' + platform]
    legacy = not selected
    if legacy:
        selected = [a for a in artifacts if a['name'] == 'dist-' + platform]
    if len(selected) != 1 or selected[0]['expired']:
        raise RuntimeError('Expected a complete runtime artifact: ' + platform)
    artifact = selected[0]
    print('Downloading verified build: ' + artifact['name'], flush=True)
    with tempfile.TemporaryFile() as archive:
        subprocess.run(['gh', 'api', f"repos/{repo}/actions/artifacts/{artifact['id']}/zip"], stdout=archive, check=True)
        archive.seek(0)
        with zipfile.ZipFile(archive) as bundle:
            copied = []
            for entry in bundle.infolist():
                name = pathlib.PurePosixPath(entry.filename).name
                if not name.startswith('cibyp-runtime-') or not name.endswith(('.tar.gz', '.json')):
                    continue
                if '\\' in name or entry.is_dir():
                    raise RuntimeError('Invalid runtime archive entry')
                file = destination / name
                with bundle.open(entry) as stream, file.open('xb') as output:
                    shutil.copyfileobj(stream, output, 1024 * 1024)
                copied.append(file)
            if len(copied) != 2:
                raise RuntimeError('Incomplete runtime artifact')
            metadata_file = next(file for file in copied if file.suffix == '.json')
            metadata = json.loads(metadata_file.read_text())
            binary = destination / metadata['file']
            if binary not in copied or metadata['version'] != version or digest(binary) != 'sha256:' + metadata['sha256'] or binary.stat().st_size != metadata['size']:
                raise RuntimeError('Runtime checksum verification failed')
            upload(binary)
            if not runtime_only and legacy:
                for entry in bundle.infolist():
                    name = pathlib.PurePosixPath(entry.filename).name
                    if entry.is_dir() or not name.endswith(('.exe', '.dmg', '.pkg', '-mac.zip', '.AppImage', '.deb')):
                        continue
                    with tempfile.TemporaryDirectory() as temporary:
                        file = pathlib.Path(temporary) / name
                        with bundle.open(entry) as stream, file.open('xb') as output:
                            shutil.copyfileobj(stream, output, 1024 * 1024)
                        upload(file)
    if not runtime_only and not legacy:
        installers = [a for a in artifacts if a['name'] == 'dist-' + platform and not a['expired']]
        if len(installers) != 1:
            raise RuntimeError('Missing installer artifact')
        with tempfile.TemporaryFile() as archive:
            subprocess.run(['gh', 'api', f"repos/{repo}/actions/artifacts/{installers[0]['id']}/zip"], stdout=archive, check=True)
            archive.seek(0)
            with zipfile.ZipFile(archive) as bundle:
                for entry in bundle.infolist():
                    name = pathlib.PurePosixPath(entry.filename).name
                    if entry.is_dir() or not name.endswith(('.exe', '.dmg', '.pkg', '-mac.zip', '.AppImage', '.deb')):
                        raise RuntimeError('Unexpected installer artifact entry')
                    with tempfile.TemporaryDirectory() as temporary:
                        file = pathlib.Path(temporary) / name
                        with bundle.open(entry) as stream, file.open('xb') as output:
                            shutil.copyfileobj(stream, output, 1024 * 1024)
                        upload(file)

subprocess.run(['node', 'scripts/prepare-npm.cjs', '--manifest', '--assets', str(destination), '--revision', run['head_sha']], check=True)
if not runtime_only:
    upload(notes_file)
# The manifest is uploaded last: launchers cannot select a partially uploaded release.
upload(destination / 'cibyp-runtime.json')
print('Published six verified GitHub runtimes for ' + tag, flush=True)
