import { T } from '@start9labs/start-sdk'
import { mkdir, readdir, rename, rm } from 'fs/promises'
import { clnConfig } from '../fileModels/config'
import { storeJson } from '../fileModels/store.json'
import { i18n } from '../i18n'
import { blake2bBackend, blake2bRpcBridge } from '../utils'
import { doNotRestoreText, preRecoveryPath } from './instance'
import { literal } from './report'
import {
  audit,
  host,
  recoveryPath,
  snapshotDirs,
  writePrivate,
} from './snapshot'
import { Chains, withChains } from './tools'

/** Where the SHA256d instance's data goes. */
export const archivePath = `${recoveryPath}/sha256d`

/** Why the last Finish requested with the service up did not happen; Status shows it. */
export const finishRefusedPath = `${recoveryPath}/finish-refused.txt`

/** A precondition of Finish does not hold: nothing was changed. */
export class Refusal extends Error {}

export type FinishOptions = { force: boolean; keepCopies: boolean }
export type FinishOutcome = {
  archive: string
  deleted: string[]
  /** An earlier attempt had already moved a directory. */
  resumed: boolean
}

const exists = (path: string) =>
  readdir(path).then(
    () => true,
    () => false,
  )

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Waits until no lightningd of either instance exists. A condition, not a
 * delay: a shutdown takes as long as the machine and the database need.
 */
export async function lightningdGone(
  chains: Chains,
  maxMs: number,
): Promise<boolean> {
  const deadline = Date.now() + maxMs
  for (;;) {
    const alive =
      (await chains.sha256d.lightningdAlive()) ||
      (!!chains.blake2b && (await chains.blake2b.lightningdAlive()))
    if (!alive) return true
    if (Date.now() >= deadline) return false
    await sleep(2000)
  }
}

/** The directories Finish moves, and how far an earlier attempt got. */
async function layout(chains: Chains) {
  const network = chains.sha256d.network
  const live = host(network)
  const archive = `${archivePath}/${network}`
  const copy = host(`${recoveryPath}/blake2b/${network}`)
  return {
    network,
    live,
    archive,
    copy,
    hasLive: await exists(live),
    hasArchive: await exists(host(archive)),
    hasCopy: await exists(copy),
  }
}

/**
 * What must hold before the SHA256d data is given up. Reads only, so it runs
 * with lightningd up (the action, before it asks for the restart) and again
 * with it down, right before the move. With lightningd known to be gone the
 * database is opened writable, so that the journal of a lightningd that was
 * killed is replayed instead of failing the check.
 */
export async function finishPrecheck(
  chains: Chains,
  lightningdIsGone = false,
): Promise<void> {
  const l = await layout(chains)
  // An earlier attempt already archived the SHA256d data, after this check.
  if (l.hasArchive && !(l.hasLive && l.hasCopy)) return
  if (l.hasArchive) {
    throw new Refusal(
      i18n(
        'Refused: recovery/sha256d already holds data from an earlier Finish. Move it away by hand before running this again.',
      ),
    )
  }
  if (!l.hasCopy) {
    throw new Refusal(
      i18n('Refused: the BLAKE2b instance has no data under recovery/blake2b.'),
    )
  }
  // The one check that cannot be skipped: coins left in the archived
  // database would be out of reach. 0 available, 1 reserved, 2 spent.
  const [{ n }] = await chains.sha256d.sqlite<{ n: number }>(
    'SELECT count(*) AS n FROM outputs WHERE status IN (0, 1)',
    { recover: lightningdIsGone },
  )
  if (n > 0) {
    throw new Refusal(
      i18n(
        'Refused: the SHA256d wallet still has ${count} unspent output(s). Withdraw them first.',
        { count: String(n) },
      ),
    )
  }
}

/**
 * The move itself. Only with no lightningd alive. Every step can be repeated:
 * an attempt cut off anywhere (power loss, a full disk) is completed by the
 * next one instead of being refused.
 */
export async function finishMove(
  effects: T.Effects,
  chains: Chains,
  options: FinishOptions,
): Promise<FinishOutcome> {
  await finishPrecheck(chains, true)
  const l = await layout(chains)
  const resumed = l.hasArchive
  await audit('finish', {
    forced: options.force,
    keepCopies: options.keepCopies,
    resumed,
  })
  await mkdir(host(archivePath), { recursive: true, mode: 0o700 })
  // Two renames inside one volume: each is atomic. Between them the node's
  // directory is absent, and the next attempt goes on from there.
  if (!l.hasArchive) await rename(l.live, host(l.archive))
  if (l.hasCopy) await rename(l.copy, l.live)
  await rename(
    host(`${recoveryPath}/blake2b/config`),
    host(`${archivePath}/blake2b-instance-config`),
  ).catch(() => {})
  await rm(host(`${recoveryPath}/blake2b`), {
    recursive: true,
    force: true,
  })
  await writePrivate(
    `${archivePath}/DO-NOT-RESTORE.txt`,
    doNotRestoreText(
      'The SHA256d data of this node at the end of its recovery: every channel closed and every coin withdrawn',
      new Date().toISOString(),
    ),
  )

  const deleted: string[] = []
  if (!options.keepCopies) {
    const databases = [
      `${l.archive}/lightningd.sqlite3`,
      `${l.archive}/lightningd.sqlite3-wal`,
      `${l.archive}/lightningd.sqlite3-shm`,
      `${l.archive}/gossip_store`,
      `${preRecoveryPath}/lightningd.sqlite3`,
      `${preRecoveryPath}/lightningd.sqlite3-wal`,
      `${preRecoveryPath}/lightningd.sqlite3-shm`,
      ...(await snapshotDirs()).flatMap((d) => [
        `${d}/lightningd.sqlite3`,
        `${d}/blake2b-lightningd.sqlite3`,
      ]),
    ]
    for (const path of databases) {
      const gone = await rm(host(path), { force: false }).then(
        () => true,
        () => false,
      )
      if (gone) deleted.push(path)
    }
  }

  // The node's config names its backend's RPC address. init/watchHosts.ts
  // rewrites it when the backend setting changes, but only some time after
  // the store is written: a lightningd started before that would be pointed
  // at the SHA256d service with the BLAKE2b service's cookie.
  const bridge = await blake2bRpcBridge(effects, false)
  if (bridge) {
    await clnConfig.merge(
      effects,
      {
        raw: {
          'bitcoin-rpcconnect': bridge.host,
          'bitcoin-rpcport': bridge.port,
        },
      },
      { allowWriteAfterConst: true },
    )
  }

  await rm(host(finishRefusedPath), { force: true })
  await storeJson.merge(effects, {
    recovery: false,
    blake2b: false,
    blake2bRescan: undefined,
    offline: false,
    rescan: undefined,
    bitcoinBackend: blake2bBackend,
    wipeGossip: true,
    finish: undefined,
  })
  await audit('finish-result', { archive: l.archive, deleted, resumed })
  return { archive: l.archive, deleted, resumed }
}

/** How long main waits for a lightningd of the previous run to be gone. */
const goneAtStartMs = 15 * 60_000

/**
 * First thing main does: a Finish requested with the service up happens here,
 * where no lightningd of this run exists yet and nothing limits the time. A
 * refusal leaves the recovery as it was and is shown by Status; any other
 * failure stops the start, and the next start goes on with the move.
 */
export async function finishIfRequested(effects: T.Effects): Promise<void> {
  const store = await storeJson.read().once()
  const request = store?.finish
  if (!request) return
  if (!store.recovery || !store.blake2b) {
    await storeJson.merge(effects, { finish: undefined })
    return
  }
  try {
    await withChains(effects, 'recovery-finish', async (chains) => {
      // An earlier attempt already moved a directory: the node cannot run
      // until the move is complete, so a failure here stops the start and the
      // next start tries again.
      const resuming = (await layout(chains)).hasArchive
      let gone: boolean
      try {
        gone = await lightningdGone(chains, goneAtStartMs)
        await finishPrecheck(chains, gone)
      } catch (e) {
        if (resuming || e instanceof Refusal) throw e
        // Nothing was moved and a check could not even be run: the node goes
        // on as before rather than failing to start over and over.
        throw new Refusal(
          i18n(
            'Refused: a check could not be run, so nothing was moved: ${error}',
            { error: literal(e instanceof Error ? e.message : String(e)) },
          ),
        )
      }
      if (!gone) {
        if (resuming) {
          throw new Error(
            'a lightningd process is still alive; not completing the move',
          )
        }
        throw new Refusal(
          i18n(
            'Refused: a lightningd process of the previous run is still alive, so its data was not moved.',
          ),
        )
      }
      return finishMove(effects, chains, request)
    })
  } catch (e) {
    if (!(e instanceof Refusal)) throw e
    await audit('finish-refused', { reason: e.message })
    await writePrivate(finishRefusedPath, e.message)
    await storeJson.merge(effects, { finish: undefined })
  }
}

/** The line Status puts before NEXT when the last requested Finish was refused. */
export const refusedLine = (reason: string) =>
  i18n(
    'The last Recovery: Finish did not happen when Core Lightning restarted. ${reason}',
    { reason: literal(reason) },
  )
