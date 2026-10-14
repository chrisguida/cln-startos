import { IMPOSSIBLE, T, VersionInfo } from '@start9labs/start-sdk'
import { readFile } from 'fs/promises'
import { clnConfig, dropClboss } from '../fileModels/config'
import { enterRecoveryMode } from '../recovery/mode'

//CLBOSS is no longer shipped, so a config that loaded it names a binary that is not
//there and lightningd exits at startup. Every edge into this version runs this.
const removeClboss = async ({ effects }: { effects: T.Effects }) => {
  const form = await clnConfig.read().once()
  const plugins = (form?.raw?.plugin ?? []).filter(
    (p): p is string => typeof p === 'string',
  )
  await clnConfig.merge(effects, {
    raw: { ...(form?.raw ?? {}), ...dropClboss(plugins) },
  })
}

// Arriving from the stock build or its recovery flavor: the database may have followed the SHA256d
// chain past the split, and lightningd does not notice that on its own. Never
// start on such data without recovery mode: no peers (offline), the dev-
// commands the repair needs (developer), and one rescan from below the split.
// Recovery: Finish clears all of it.
const enterRecovery = async ({ effects }: { effects: T.Effects }) => {
  await removeClboss({ effects })

  // The stock build keeps the regtest test activation height in store.json,
  // which this build's model would drop: read the file as it is.
  const stockHeight: unknown = await readFile(
    '/media/startos/volumes/main/store.json',
    'utf-8',
  ).then(
    (s) => JSON.parse(s).blake2bActivationHeight,
    () => undefined,
  )
  const conf = await clnConfig.read().once()
  const network = conf?.raw?.network ?? 'bitcoin'
  const activation = conf?.raw?.['dev-blake2b-activation-height']
  if (network === 'regtest' && !activation && typeof stockHeight === 'number') {
    await clnConfig.merge(effects, {
      network: {
        selection: 'regtest',
        value: { 'blake2b-activation-height': stockHeight },
      },
    })
  }

  await enterRecoveryMode(effects)
}

export const current = VersionInfo.of({
  version: '#blake:26.6.9:1',
  releaseNotes: {
    en_US: `Core Lightning v26.06.9-blake2b.7, based on upstream v26.06.9. We strongly recommend updating.

## Notes for operators

- Updating from the previous version changes nothing else, and the two versions peer normally.
- If the node stops with "80-byte header", its Bitcoin service is not following BLAKE2b. Point it at one that is.
- Channels opened with \`v26.06.7-blake2b.1\` to \`.3\` do not use unified signatures. Close them and open new ones.

This release brings upstream's security and stability fixes, including protection against peers crashing the node and against forwarded funds being lost to a late fulfill while a channel shuts down.

Your node's configuration does not change.`,
  },
  migrations: {
    up: removeClboss,
    //Refuse every downgrade. Channels opened here negotiate unified signing, and a build without it
    //computes a different signature hash, so it cannot close them. lightning-downgrade refuses for
    //the same reason.
    down: IMPOSSIBLE,
    other: {
      //Arriving from the unflavored build, or from the header-only flavor. Both are Core Lightning
      //v26.06.7; lightningd upgrades the wallet database on its first start.
      ['^26']: {
        up: enterRecovery,
      },
      //Arriving from the recovery flavor of the stock build, which exists to be left for this one.
      ['>=#recovery:26.6.9:0 <#recovery:26.6.10:0']: {
        up: enterRecovery,
      },
      //Arriving from the first blake flavor, whose web interface used commando.
      ['#blake:26.6.7:1']: {
        up: removeClboss,
      },
      //Arriving from the flavor that shipped CLBOSS and linked to a SHA256d chain explorer.
      ['#blake:26.6.7:2']: {
        up: removeClboss,
      },
      //Arriving from Core Lightning v26.06.7-blake2b.4.
      ['#blake:26.6.7:3']: {
        up: removeClboss,
      },
      //Arriving from Core Lightning v26.06.8-blake2b.5.
      ['#blake:26.6.8:0']: {
        up: removeClboss,
      },
      //Arriving from Core Lightning v26.06.8-blake2b.6.
      ['#blake:26.6.8:1']: {
        up: removeClboss,
      },
    },
  },
})
