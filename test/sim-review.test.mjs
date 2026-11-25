import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { confirmPreview, run } from '../sim-review.mjs';
import { id, preview, simulatorFixture } from './simulator-fixture.mjs';

test('selects available iOS Simulator UUIDs and boots the chosen fixture', async () => {
  const { sim, calls } = simulatorFixture();
  assert.deepEqual(JSON.parse(await run(['list'], { sim })).map(device => device.udid), [id]);
  await assert.rejects(run(['status', 'booted'], { sim }), /UUID/);
  await assert.rejects(run(['status', 'E6B6F75C-D52C-4A30-8B25-8B3E85C09A2D'], { sim }), /outside/);
  assert.equal(JSON.parse(await run(['status', id.toLowerCase()], { sim })).state, 'Shutdown');
  assert.match(await run(['boot', id], { sim }), /Ready: Pocket Atlas QA/);
  assert.match(await run(['boot', id], { sim }), /Ready: Pocket Atlas QA/);
  assert.deepEqual(calls.filter(([operation]) => operation === 'boot'), [['boot', id]]);
  assert.equal(JSON.parse(await run(['status', id], { sim })).state, 'Booted');
});

test('captures named artifacts and preserves existing screenshots', async () => {
  const { sim } = simulatorFixture();
  const baseDirectory = mkdtempSync(join(tmpdir(), 'sim-review-test-'));
  try {
    await assert.rejects(run(['capture', id, 'before'], { sim, baseDirectory }), /Run boot/);
    await run(['boot', id], { sim });
    await assert.rejects(run(['capture', id, '../elsewhere'], { sim, baseDirectory }), /Use a label/);
    assert.equal(await run(['capture', id, 'before'], { sim, baseDirectory }), 'Saved artifacts/before.png');
    const artifact = join(baseDirectory, 'artifacts', 'before.png');
    assert.equal(readFileSync(artifact, 'utf8'), 'fixture screenshot bytes');
    writeFileSync(artifact, 'previous screenshot');
    await assert.rejects(run(['capture', id, 'before'], { sim, baseDirectory }), /already exists/);
    assert.equal(readFileSync(artifact, 'utf8'), 'previous screenshot');
    assert.deepEqual(readdirSync(join(baseDirectory, 'artifacts')), ['before.png']);
  } finally {
    rmSync(baseDirectory, { recursive: true, force: true });
  }
});

test('opens an allowlisted preview only after confirmation', async () => {
  const { sim, calls } = simulatorFixture();
  let prompts = 0;
  const decline = () => { prompts++; return false; };
  await run(['boot', id], { sim });
  await assert.rejects(run(['open', id, 'unknown-preview'], { sim, confirm: decline }), /Choose a preview/);
  assert.equal(prompts, 0);
  await assert.rejects(run(['open', id, 'juniper-loop'], { sim, confirm: decline }), /canceled/);
  assert.equal(prompts, 1);
  assert.deepEqual(calls.filter(([operation]) => operation === 'openurl'), []);
  assert.equal(await run(['open', id, 'juniper-loop'], {
    sim,
    confirm(device, url) {
      assert.equal(device.udid, id);
      assert.equal(url, preview);
      return true;
    },
  }), `Opened ${preview}`);
  assert.deepEqual(calls.at(-1), ['openurl', id, preview]);
});

test('interactive approval requires exact OPEN and fails closed without a terminal', async () => {
  assert.equal(await confirmPreview({ udid: id }, preview, {
    input: new PassThrough(), output: new PassThrough(),
  }), false);

  for (const [answer, approved] of [['OPEN\n', true], ['open\n', false], ['', false]]) {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = Object.assign(new PassThrough(), { isTTY: true });
    const asking = confirmPreview({ name: 'Pocket Atlas QA', udid: id }, preview, { input, output });
    input.end(answer);
    assert.equal(await asking, approved);
  }
});
