import { T } from '@start9labs/start-sdk'
import { depBitcoindDescription } from './manifest/i18n'
import { storeJson } from './fileModels/store.json'
import { sdk } from './sdk'
import { bitcoinBackend, blake2bBackend } from './utils'

/** During a recovery the BLAKE2b instance follows `bitcoind` whatever the primary follows. */
const recovering = async (effects: T.Effects) =>
  !!(await storeJson.read((s) => s.recovery).const(effects))

const base = {
  description: depBitcoindDescription,
  metadata: {
    title: 'Bitcoin',
    icon: 'https://raw.githubusercontent.com/Start9Labs/bitcoin-core-startos/feec0b1dae42961a257948fe39b40caf8672fce1/dep-icon.svg',
  },
  kind: 'running',
  healthChecks: ['bitcoind', 'sync-progress'],
} as const

// A dependency is identified by package id, so each Bitcoin service this node
// can follow is its own entry; the Bitcoin Backend setting enables one of
// them, and a recovery enables the BLAKE2b service as well.
const bitcoind = sdk.Dependency.optional('bitcoind', {
  ...base,
  healthChecks: [...base.healthChecks],
  versionRange:
    '(>=28.4:29 && <29) || (>=29.4:16 && <30) || (>=30.3:16 && <31) || >=31.1:16 || >=#knotsprerdts:29.3:29',
  enabled: async ({ effects }) =>
    (await bitcoinBackend(effects)) === blake2bBackend ||
    (await recovering(effects)),
})

const knotsPrerdts = sdk.Dependency.optional('knots-prerdts', {
  ...base,
  healthChecks: [...base.healthChecks],
  versionRange: '>=#knotsprerdts:29.3:29',
  enabled: async ({ effects }) =>
    (await bitcoinBackend(effects)) === 'knots-prerdts',
})

export const dependencies = sdk.Dependencies.of()
  .addDependency(bitcoind)
  .addDependency(knotsPrerdts)
