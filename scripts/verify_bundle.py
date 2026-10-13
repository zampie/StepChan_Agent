"""Verify the delivered snapshot with Python 3 standard library only."""
from pathlib import Path
import hashlib
import json
import sys

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / 'DELIVERY_MANIFEST.json').read_text(encoding='utf-8'))
errors = []
for item in manifest['files']:
    path = root / item['path']
    if not path.is_file():
        errors.append('Missing: ' + item['path'])
        continue
    data = path.read_bytes()
    if len(data) != item['bytes'] or hashlib.sha256(data).hexdigest() != item['sha256']:
        errors.append('Changed: ' + item['path'])
asset_root = root / 'assets' / 'blue_pet_assets_v0_2'
try:
    asset_manifest = json.loads((asset_root / 'manifest.json').read_text(encoding='utf-8'))
    for group in ('expressions', 'mouths'):
        for relative in asset_manifest[group].values():
            path = (asset_root / relative).resolve()
            if not path.is_relative_to(asset_root.resolve()) or not path.is_file():
                errors.append('Invalid asset reference: ' + relative)
except Exception as exc:
    errors.append('Asset manifest: ' + str(exc))
if errors:
    print('FAIL\n' + '\n'.join(errors))
    sys.exit(1)
print('PASS: ' + str(len(manifest['files'])) + ' delivered files; hashes and asset paths match.')
print('This verifies the delivery snapshot, not runtime or visual acceptance.')
