import { readFileSync, writeFileSync } from 'node:fs';

export const id = '8B6592A2-FD5A-4E98-B587-BF499C63E1D3';
export const runtime = 'com.apple.CoreSimulator.SimRuntime.iOS-26-1';
export const preview = 'com.creatorstoolbox.pocketatlas://preview/juniper-loop';

export function simulatorFixture({ screenshot } = {}) {
  const calls = [];
  let state = 'Shutdown';

  return {
    calls,
    sim(args) {
      calls.push(args);
      switch (args[0]) {
        case 'list':
          return JSON.stringify({
            devices: {
              [runtime]: [{ udid: id, name: 'Pocket Atlas QA', state, isAvailable: true }],
              'com.apple.CoreSimulator.SimRuntime.watchOS-26-1': [
                { udid: 'E6B6F75C-D52C-4A30-8B25-8B3E85C09A2D', isAvailable: true },
              ],
            },
          });
        case 'boot':
          state = 'Booted';
          return '';
        case 'bootstatus':
        case 'openurl':
          return '';
        case 'io':
          writeFileSync(args[3], screenshot ? readFileSync(screenshot) : 'fixture screenshot bytes');
          return '';
        default:
          throw new Error(`Unexpected fixture command: ${args.join(' ')}`);
      }
    },
  };
}
