import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'assets/blue_pet_assets_v0_2');
const output = path.join(root, 'apps/web/public/assets/derived/blue_pet_512');
const manifest = JSON.parse(await fs.readFile(path.join(source, 'manifest.json'), 'utf8'));
const check = process.argv.includes('--check');
const records = [];
for (const relative of Object.values({ ...manifest.expressions, ...manifest.mouths })) {
  const input = await fs.readFile(path.join(source, relative));
  const meta = await sharp(input).metadata();
  if (meta.width !== 1254 || meta.height !== 1254 || !meta.hasAlpha)
    throw Error(`Invalid source: ${relative}`);
  const target = path.join(output, relative);
  if (!check) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await sharp(input).resize(512, 512, { kernel: 'lanczos3' }).png().toFile(target);
  }
  const derived = await fs.readFile(target);
  const outMeta = await sharp(derived).metadata();
  if (outMeta.width !== 512 || outMeta.height !== 512 || !outMeta.hasAlpha)
    throw Error(`Invalid derived: ${relative}`);
  records.push({
    file: relative,
    sourceSha256: crypto.createHash('sha256').update(input).digest('hex'),
    derivedSha256: crypto.createHash('sha256').update(derived).digest('hex'),
    sourceBytes: input.length,
    derivedBytes: derived.length,
  });
}
const result = {
  ...manifest,
  version: '0.2.0-derived-512',
  canvas: { width: 512, height: 512 },
  derivation: {
    source: 'assets/blue_pet_assets_v0_2',
    transform:
      'uniform Lanczos3 512/1254; full transparent canvas; no crop; offsets (0,0); no alignment correction',
    records,
  },
};
if (!check)
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(result, null, 2) + '\n');
else {
  const saved = JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8'));
  if (JSON.stringify(saved.derivation.records) !== JSON.stringify(records))
    throw Error('Asset hashes changed; regenerate explicitly');
}
console.log(
  `${check ? 'Validated' : 'Prepared'} 9 assets: ${records.reduce((n, r) => n + r.sourceBytes, 0)} → ${records.reduce((n, r) => n + r.derivedBytes, 0)} bytes. Sources untouched.`,
);
