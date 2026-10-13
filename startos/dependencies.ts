import { depBitcoindDescription } from './manifest/i18n'
import { sdk } from './sdk'
import { bitcoinBackend } from './utils'

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
// can follow is its own entry; the Bitcoin Backend setting enables one of them.
const bitcoind = sdk.Dependency.optional('bitcoind', {
  ...base,
  healthChecks: [...base.healthChecks],
  versionRange:
    '(>=28.4:29 && <29) || (>=29.4:16 && <30) || (>=30.3:16 && <31) || >=31.1:16 || >=#knotsprerdts:29.3:29',
  enabled: async ({ effects }) =>
    (await bitcoinBackend(effects)) === 'bitcoind',
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
