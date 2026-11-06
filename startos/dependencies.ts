import { depBitcoindDescription } from './manifest/i18n'
import { sdk } from './sdk'

const bitcoind = sdk.Dependency.required('bitcoind', {
  description: depBitcoindDescription,
  metadata: {
    title: 'Bitcoin',
    icon: 'https://raw.githubusercontent.com/Start9Labs/bitcoin-core-startos/feec0b1dae42961a257948fe39b40caf8672fce1/dep-icon.svg',
  },
  kind: 'running',
  healthChecks: ['bitcoind', 'sync-progress'],
  versionRange: '>=28.4:14',
})

export const dependencies = sdk.Dependencies.of().addDependency(bitcoind)
