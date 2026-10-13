import { T } from '@start9labs/start-sdk'
import { manifest as bitcoinManifest } from 'bitcoin-core-startos/startos/manifest'
import {
  rpcHostId as btcRpcHostId,
  rpcPort as btcRpcPort,
} from 'bitcoin-core-startos/startos/utils'
import { BitcoinBackend, storeJson } from './fileModels/store.json'
import { sdk } from './sdk'

export const uiPort = 4500
export const wsPort = 4269
export const rpcPort = 8080
export const peerPort = 9735
export const clnrestPort = 3010
export const watchtowerPort = 9814
export const websocketPort = 7272
export const grpcPort = 2106

export const rootDir = '/root/.lightning'
export const bitcoinDataDir = '/mnt/bitcoin'

/** Host path of the rune the CLN Application UI authenticates with. */
export const commandoEnv = '/media/startos/volumes/main/.commando-env'

export const mainMounts = sdk.Mounts.of().mountVolume({
  volumeId: 'main',
  subpath: null,
  mountpoint: rootDir,
  readonly: false,
})

/**
 * The package id of the Bitcoin service this node follows, chosen in General
 * Settings. Pass `effects` to subscribe reactively; omit it for a one-shot read.
 */
export const bitcoinBackend = async (
  effects?: T.Effects,
): Promise<BitcoinBackend> => {
  const backend = storeJson.read((s) => s.bitcoinBackend)
  return (
    (await (effects ? backend.const(effects) : backend.once())) ?? 'bitcoind'
  )
}

// knots-prerdts is a build of the bitcoind package under another id: same
// volumes, same layout, same interface ids.
type KnotsPrerdtsManifest = Omit<typeof bitcoinManifest, 'id'> & {
  id: 'knots-prerdts'
}

/** The main volume plus the chosen Bitcoin service's data directory (for its RPC cookie). */
export const mountsWithBitcoin = (backend: BitcoinBackend) => {
  const mount = {
    mountpoint: bitcoinDataDir,
    subpath: null,
    readonly: true,
    volumeId: 'main',
  } as const
  return backend === 'knots-prerdts'
    ? mainMounts.mountDependency<KnotsPrerdtsManifest>({
        dependencyId: 'knots-prerdts',
        ...mount,
      })
    : mainMounts.mountDependency<typeof bitcoinManifest>({
        dependencyId: 'bitcoind',
        ...mount,
      })
}

/**
 * The Bitcoin service's RPC bridge address, resolved through
 * `sdk.host.getBridgeAddress` and split into the `{ host, port }` pair
 * lightningd's config, teos.toml, and the sync health check consume. `.const()`
 * stays churn-free: the assigned RPC port persists across the service's
 * updates/restarts, so CLN restarts only if it is (re)installed on a new port
 * or another Bitcoin service is chosen. `null` while the binding is absent, so
 * callers omit the address rather than writing a placeholder. Pass
 * `watch: false` from an action, which reads once.
 */
export const bitcoindRpcBridge = async (effects: T.Effects, watch = true) => {
  const bridge = sdk.host.getBridgeAddress(effects, {
    packageId: await bitcoinBackend(watch ? effects : undefined),
    hostId: btcRpcHostId,
    internalPort: btcRpcPort,
    ssl: false,
  })
  const addr = await (watch ? bridge.const() : bridge.once())
  if (!addr) return null
  const [host, port] = addr.split(':')
  return { host, port: Number(port) }
}
