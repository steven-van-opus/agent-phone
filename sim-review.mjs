#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

const usage = `sim-review
  list
  status <simulator-uuid>
  boot <simulator-uuid>
  capture <simulator-uuid> <label>
  open <simulator-uuid> <preview-alias>`;

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const LABEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SCHEME = /^[a-z][a-z0-9]*(?:\.[a-z0-9]+)+$/;
const IOS_RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-';

function simctl(args) {
  const result = spawnSync('/usr/bin/xcrun', ['simctl', ...args], {
    encoding: 'utf8',
    timeout: 180_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `simctl ${args[0]} failed.`);
  }
  return result.stdout;
}

function devices(sim) {
  const { devices: byRuntime } = JSON.parse(sim(['list', 'devices', 'available', '--json']));
  return Object.entries(byRuntime)
    .filter(([runtime]) => runtime.startsWith(IOS_RUNTIME))
    .flatMap(([runtime, list]) => list
      .filter(device => device.isAvailable && UUID.test(device.udid))
      .map(({ udid, name, state }) => ({ udid, name, state, runtime })));
}

function findDevice(sim, requestedId) {
  if (!UUID.test(requestedId ?? '')) {
    throw new Error('Pass an iOS Simulator UUID from the list command.');
  }
  const device = devices(sim).find(({ udid }) => udid.toLowerCase() === requestedId.toLowerCase());
  if (!device) throw new Error('That UUID is outside the available iOS Simulator list.');
  return device;
}

function requireBooted(device) {
  if (device.state !== 'Booted') throw new Error('Run boot for this simulator first.');
}

function capture(sim, device, label, baseDirectory) {
  if (!LABEL.test(label) || label.length > 60) {
    throw new Error('Use a label of up to 60 lowercase letters, numbers, and single hyphens.');
  }
  requireBooted(device);

  const directory = join(baseDirectory, 'artifacts');
  mkdirSync(directory, { recursive: true });
  const staging = mkdtempSync(join(directory, '.capture-'));
  const image = join(staging, 'screen.png');
  const name = `${label}.png`;
  try {
    sim(['io', device.udid, 'screenshot', image]);
    linkSync(image, join(directory, name));
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`artifacts/${name} already exists. Choose a new label.`);
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return `Saved artifacts/${name}`;
}

function previewUrl(alias, configSource) {
  const { scheme, previews } = JSON.parse(readFileSync(configSource, 'utf8'));
  if (typeof scheme !== 'string' || !SCHEME.test(scheme) || !Array.isArray(previews)) {
    throw new Error('Use a reverse-DNS scheme and a list of preview aliases in previews.json.');
  }
  if (!LABEL.test(alias) || !previews.includes(alias)) {
    throw new Error('Choose a preview alias from previews.json.');
  }
  return `${scheme}://preview/${alias}`;
}

export async function confirmPreview(device, url, {
  input = process.stdin,
  output = process.stderr,
} = {}) {
  if (!input.isTTY || !output.isTTY) return false;
  const prompt = createInterface({ input, output });
  const controller = new AbortController();
  prompt.once('close', () => controller.abort());
  prompt.once('SIGINT', () => controller.abort());

  try {
    const answer = await prompt.question(
      `Open ${url}\non ${device.name} (${device.udid})? Type OPEN to continue: `,
      { signal: controller.signal },
    );
    return answer === 'OPEN';
  } catch (error) {
    if (error.name === 'AbortError') return false;
    throw error;
  } finally {
    prompt.close();
  }
}

export async function run(args, {
  sim = simctl,
  confirm = confirmPreview,
  baseDirectory = process.cwd(),
  configSource = new URL('./previews.json', import.meta.url),
} = {}) {
  const [command, id, argument] = args;
  if (args.length === 0 || (args.length === 1 && command === '--help')) return usage;
  if (args.length === 1 && command === 'list') return JSON.stringify(devices(sim), null, 2);

  if (args.length === 2 && (command === 'status' || command === 'boot')) {
    const device = findDevice(sim, id);
    if (command === 'status') return JSON.stringify(device, null, 2);
    if (device.state === 'Shutdown') sim(['boot', device.udid]);
    sim(['bootstatus', device.udid]);
    return `Ready: ${device.name} (${device.udid})`;
  }

  if (args.length === 3 && (command === 'capture' || command === 'open')) {
    const device = findDevice(sim, id);
    if (command === 'capture') return capture(sim, device, argument, baseDirectory);

    requireBooted(device);
    const url = previewUrl(argument, configSource);
    if (!await confirm(device, url)) throw new Error('Preview canceled.');
    sim(['openurl', device.udid, url]);
    return `Opened ${url}`;
  }

  throw new Error(usage);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    console.log(await run(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
