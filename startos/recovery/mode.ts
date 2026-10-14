import { T } from '@start9labs/start-sdk'
import { clnConfig } from '../fileModels/config'
import { storeJson } from '../fileModels/store.json'
import { heightsFor, recoveryRescan } from './heights'

/**
 * Puts the node in recovery mode: no peers (offline), the dev- commands the
 * repair needs (developer), and one rescan from below the split. Used by the
 * migrations that arrive from a build of the other chain, and by Recovery:
 * Enter Recovery Mode. Recovery: Finish undoes it.
 */
export async function enterRecoveryMode(effects: T.Effects) {
  const conf = await clnConfig.read().once()
  const heights = heightsFor(
    conf?.raw?.network ?? 'bitcoin',
    conf?.raw?.['dev-blake2b-activation-height'],
  )
  const rescan = recoveryRescan(heights)
  await storeJson.merge(effects, {
    recovery: true,
    offline: true,
    developer: true,
    ...(rescan === null ? {} : { rescan }),
  })
  return { heights, rescan }
}
