import { FileHelper } from '@start9labs/start-sdk'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import {
  parseTowerUri,
  towerKey,
  towerNetAddr,
} from './actions/watchtower/towerUri'
import { errorMessage, literal } from './actions/payments'
import { watchtowerClientPlugin } from './actions/watchtower/watchtower'
import { ListTowers } from './actions/watchtower/watchtowerClientInfo'
import { clnConfig } from './fileModels/config'
import { storeJson } from './fileModels/store.json'
import { vpnConfFile } from './fileModels/vpn.conf'
import { i18n } from './i18n'
import { finishIfRequested } from './recovery/finish'
import { createBlake2bInstance } from './recovery/instance'
import { blake2bInstance, primaryInstance } from './recovery/tools'
import { sdk } from './sdk'
import {
  bitcoinBackend,
  bitcoindRpcBridge,
  blake2bLightningDir,
  blake2bPrefix,
  blake2bRpcBridge,
  clnrestPort,
  grpcPort,
  mainMounts,
  mountsWithBitcoin,
  rootDir,
  sha256dPrefix,
  uiPort,
  wsPort,
} from './utils'
import {
  handshakeStaleMs,
  parseWireguardConfig,
  renderWgQuick,
  vpnDownScript,
  vpnIface,
  vpnUpScript,
} from './vpn'

export const main = sdk.setupMain(async ({ effects }) => {
  /**
   * ======================== Setup (optional) ========================
   *
   * In this section, we fetch any resources or run any desired preliminary commands.
   */
  console.info(i18n('Starting Core Lightning!'))

  // A Recovery: Finish requested while the service was up: the data is moved
  // here, before anything below reads the store or starts a daemon.
  await finishIfRequested(effects)

  // watch cln config for changes
  const conf = await clnConfig.read().const(effects)

  // bitcoind's RPC over the bridge, for the sync-progress bitcoin-cli below.
  const bitcoind = await bitcoindRpcBridge(effects)

  // get store.json but don't watch for changes
  const store = await storeJson.read().once()
  if (!store) {
    throw new Error('no store.json')
  }

  const watchtowerClientLoaded = !!conf?.raw?.plugin?.includes(
    watchtowerClientPlugin,
  )

  // During a recovery the node's own data is run by the SHA256d build, and a
  // second lightningd, the fork, runs a copy of it against the BLAKE2b service
  // (see recovery/instance.ts). Afterwards the fork runs the node's data.
  const prefix = store.recovery ? sha256dPrefix : blake2bPrefix
  const blake2bBridge = store.recovery ? await blake2bRpcBridge(effects) : null

  // One-shot from Recovery: Finish: the gossip store gathered on the SHA256d
  // chain is useless on BLAKE2b. The file is gone once this returns, so the
  // flag is cleared here; the store watch below ignores this key.
  if (store.wipeGossip) {
    await rm(
      `/media/startos/volumes/main/${conf?.raw?.network ?? 'bitcoin'}/gossip_store`,
      { force: true },
    )
    await storeJson.merge(effects, { wipeGossip: undefined })
  }

  const lightningdArgs: string[] = ['--database-upgrade=true']

  const vpn =
    store.clearnetVpn && parseWireguardConfig(store.clearnetVpn.config)
  if (vpn && 'error' in vpn) {
    throw new Error(`invalid clearnet VPN configuration: ${vpn.error}`)
  }
  if (vpn) {
    await mkdir(sdk.volumes.main.subpath('./vpn'), { recursive: true })
    await vpnConfFile.write(effects, renderWgQuick(vpn.config))
  } else {
    await rm(sdk.volumes.main.subpath(`./vpn/${vpnIface}.conf`), {
      force: true,
    })
  }

  if (store.rescan) {
    lightningdArgs.push(`--rescan=${store.rescan}`)
  }

  // Unlike rescan this is a standing setting, toggled by Recovery: Offline Mode.
  if (store.offline) {
    lightningdArgs.push('--offline')
  }

  // Regtest after a recovery: the fork needs the test activation height, which
  // the SHA256d build has no option for, so it lives in the store and goes on
  // the command line here (dev- options need --developer).
  if (
    !store.recovery &&
    conf?.raw?.network === 'regtest' &&
    store.blake2bActivationHeight
  ) {
    lightningdArgs.push(
      '--developer',
      `--dev-blake2b-activation-height=${store.blake2bActivationHeight}`,
    )
  }

  // `rescan` and `restore` are one-shot request flags (rescan set by the
  // Rescan Blockchain action, restore by the post-restore hook in backups.ts).
  // They are deliberately NOT cleared here: a session where lightningd never
  // comes up must not consume them, or the user's request silently vanishes
  // (a rescan requested during a crash loop used to be lost this way). The
  // consume-flags oneshot at the end of the chain clears both once lightningd
  // answers RPC — which happens early in a rescan, so a mid-scan crash still
  // resumes from where it got to rather than re-running the whole scan. The
  // store watch below ignores flag *clears*, so that write doesn't bounce
  // main.

  /**
   * ======================== Daemons ========================
   *
   * In this section, we create one or more daemons that define the service runtime.
   *
   * Each daemon defines its own health check, which can optionally be exposed to the user.
   */

  const lightningSub = sdk.SubContainer.of(
    effects,
    { imageId: 'lightning' },
    mountsWithBitcoin(await bitcoinBackend(effects), store.recovery),
    'lightning-sub',
  )

  const lightningGetinfo = async () => {
    for (let attempt = 1; ; attempt++) {
      const res = await lightningSub.exec([
        `${prefix}/bin/lightning-cli`,
        `--lightning-dir=${rootDir}`,
        'getinfo',
      ])
      if (
        (res.exitCode === 0 && res.stdout.length > 0) ||
        res.timedOutAfter !== null ||
        attempt === 3
      )
        return res
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  }

  // Restart only when bitcoind writes a replacement cookie — an absent cookie
  // means bitcoind is down, and stopping lightningd then hangs its shutdown.
  await FileHelper.string(`${await lightningSub.rootfs}/mnt/bitcoin/.cookie`)
    .read(
      (cookie) => cookie,
      (prev, next) => next === null || prev === next,
    )
    .const(effects)

  let vpnHealthConfig = store.clearnetVpn?.config ?? null
  let vpnNoHandshakeSince = Date.now()
  const vpnConfigHash = createHash('sha256')
    .update(vpnHealthConfig ?? '')
    .digest('hex')

  const baseDaemons = sdk.Daemons.of(effects)
    .addOneshot('vpn', {
      subcontainer: lightningSub,
      exec: {
        command: ['sh', '-c', vpn ? vpnUpScript : vpnDownScript],
        env: { STARTOS_VPN_CONFIG_HASH: vpnConfigHash },
      },
      requires: [],
    })
    .addDaemon('lightningd', {
      subcontainer: lightningSub,
      exec: {
        command: [
          `${prefix}/bin/lightningd`,
          `--lightning-dir=${rootDir}`,
          `--conf=${rootDir}/config`,
          ...lightningdArgs,
        ],
        // watchtower-client keeps its identity key and registered towers in
        // watchtowers_db.sql3 under $TOWERS_DATA_DIR, defaulting to
        // $HOME/.watchtower — outside the only persistent mount. Without this
        // it re-keys and forgets every tower on each container rebuild.
        env: { TOWERS_DATA_DIR: `${rootDir}/.watchtower` },
      },
      ready: {
        display: i18n('RPC Interface'),
        fn: async () => {
          const res = await lightningGetinfo()
          if (res.exitCode === 0) {
            return {
              message: i18n('The RPC interface is ready'),
              result: 'success',
            }
          }
          return {
            message: i18n('The RPC interface is not ready'),
            result: 'loading',
          }
        },
      },
      requires: ['vpn'],
    })
    .addOneshot('commando-config', {
      subcontainer: lightningSub,
      exec: {
        fn: async (subcontainer) => {
          const commandoEnv = `${await lightningSub.rootfs}${rootDir}/.commando-env`
          const cliBase = ['lightning-cli', `--lightning-dir=${rootDir}`]

          // Get current pubkey
          const getinfoRes = await subcontainer.exec([...cliBase, 'getinfo'])
          if (getinfoRes.exitCode !== 0) {
            throw new Error(`getinfo failed: ${String(getinfoRes.stderr)}`)
          }
          const { id: pubkey } = JSON.parse(getinfoRes.stdout as string)

          // Check existing config
          const existing = await readFile(commandoEnv, 'utf-8').catch(() => '')
          const existingPubkey = existing.match(
            /^LIGHTNING_PUBKEY="(.+)"$/m,
          )?.[1]
          const existingRune = existing.match(/^LIGHTNING_RUNE="(.+)"$/m)?.[1]

          if (existingPubkey === pubkey && existingRune) {
            console.log('Commando config: pubkey matches, rune exists')
            return null
          }

          // Generate new rune
          console.log('Commando config: generating new rune')
          const runeRes = await subcontainer.exec([
            ...cliBase,
            'createrune',
            'null',
            '[["For Application#"]]',
          ])
          if (runeRes.exitCode !== 0) {
            throw new Error(`createrune failed: ${String(runeRes.stderr)}`)
          }
          const { rune } = JSON.parse(runeRes.stdout as string)

          await writeFile(
            commandoEnv,
            `LIGHTNING_PUBKEY="${pubkey}"\nLIGHTNING_RUNE="${rune}"\n`,
          )

          return null
        },
      },
      requires: ['lightningd'],
    })
    .addDaemon('cln-application', {
      subcontainer: sdk.SubContainer.of(
        effects,
        {
          imageId: 'ui',
        },
        mainMounts,
        'cln-application-sub',
      ),
      exec: {
        command: ['node', '/app/apps/backend/dist/server.js'],
        env: {
          BITCOIN_NETWORK: conf?.raw?.network ?? 'bitcoin',
          LIGHTNING_DATA_DIR: rootDir,
          APP_PROTOCOL: 'https',
          APP_HOST: '0.0.0.0',
          APP_PORT: String(uiPort),
          APP_CONFIG_FILE: `${rootDir}/data/app/config.json`,
          APP_LOG_FILE: `${rootDir}/data/app/application-cln.log`,
          LIGHTNING_VARS_FILE: `${rootDir}/.commando-env`,
          LIGHTNING_WS_PORT: String(wsPort),
          LIGHTNING_REST_PORT: String(clnrestPort),
          // clnrest runs plaintext (clnrest-protocol=http); the app defaults
          // this to https and would otherwise look for TLS certs.
          LIGHTNING_REST_PROTOCOL: 'http',
          LIGHTNING_GRPC_PORT: String(grpcPort),
        },
      },
      ready: {
        display: i18n('Web Interface'),
        fn: () =>
          sdk.healthCheck.checkPortListening(effects, uiPort, {
            successMessage: i18n('The Web Interface is ready'),
            errorMessage: i18n('The Web Interface is not ready'),
          }),
      },
      requires: ['lightningd', 'commando-config'],
    })
    .addHealthCheck('check-synced', {
      ready: {
        display: i18n('Synced'),
        fn: async () => {
          const getinfoRes = await lightningGetinfo()

          // Check the exit code before parsing: when lightningd's RPC is not
          // answering, lightning-cli exits non-zero with empty stdout, and
          // JSON.parse('') would fail the check with the unhelpful
          // "Unexpected end of JSON input" instead of the real error.
          if (getinfoRes.exitCode !== 0) {
            return {
              result: 'failure',
              message: `Error calling 'lightning-cli getinfo': ${String(getinfoRes.stderr)}`,
            }
          }

          let getinfo: {
            warning_lightningd_sync?: string
            warning_bitcoind_sync?: string
            blockheight: number
          }
          try {
            getinfo = JSON.parse(getinfoRes.stdout as string)
          } catch {
            return {
              result: 'failure',
              message: `'lightning-cli getinfo' returned unparseable output: ${String(getinfoRes.stdout)}`,
            }
          }
          const {
            warning_lightningd_sync,
            warning_bitcoind_sync,
            blockheight,
          } = getinfo

          if (warning_bitcoind_sync) {
            return {
              message: i18n('Bitcoind is not up-to-date with network.'),
              result: 'loading',
            }
          } else if (warning_lightningd_sync) {
            if (!bitcoind) {
              return {
                message:
                  'Lightningd is still loading latest blocks, but bitcoind is not yet reachable over the bridge',
                result: 'loading',
              }
            }
            const bitcoinGetblockcount = await lightningSub.exec([
              'bitcoin-cli',
              `--rpcconnect=${bitcoind.host}`,
              `--rpcport=${bitcoind.port}`,
              '--rpccookiefile=/mnt/bitcoin/.cookie',
              'getblockcount',
            ])
            if (bitcoinGetblockcount.exitCode !== 0) {
              return {
                message: i18n(
                  'Lightningd is still loading latest blocks from bitcoind, but bitcoin-cli failed to getblockcount from bitcoind',
                ),
                result: 'failure',
              }
            }
            return {
              message: `Catching up to blocks from bitcoind. This may take several hours. Progress: ${blockheight} of ${String(bitcoinGetblockcount.stdout)}`,
              result: 'loading',
            }
          }

          return {
            result: 'success',
            message: i18n(
              'Synced to chain and ready to perform on-chain operations',
            ),
          }
        },
      },
      requires: ['lightningd'],
    })

  // Restart on store changes that reconfigure the daemon chain (watchtower
  // server/clients, custom external hosts) or on a NEW rescan/restore request
  // — setting a flag is what restarts a running service so main can consume
  // it. A rescan/restore transition back to undefined is the consume-flags
  // oneshot clearing an already-consumed request, treated as equal so the
  // clear doesn't restart the service. When main starts consuming another
  // store field, add it to this comparison.
  await storeJson
    .read(
      (s) => s,
      (prev, next) =>
        prev?.watchtowerServer === next?.watchtowerServer &&
        JSON.stringify(prev?.watchtowerClients) ===
          JSON.stringify(next?.watchtowerClients) &&
        JSON.stringify(prev?.customExternalHosts) ===
          JSON.stringify(next?.customExternalHosts) &&
        JSON.stringify(prev?.clearnetVpn) ===
          JSON.stringify(next?.clearnetVpn) &&
        prev?.offline === next?.offline &&
        prev?.recovery === next?.recovery &&
        prev?.blake2b === next?.blake2b &&
        (next?.rescan === undefined || prev?.rescan === next?.rescan) &&
        (next?.blake2bRescan === undefined ||
          prev?.blake2bRescan === next?.blake2bRescan) &&
        (next?.restore === undefined || prev?.restore === next?.restore),
    )
    .const(effects)

  // The BLAKE2b instance of a recovery, once Close All has asked for it: the
  // copy is made here rather than in the action, which StartOS stops after
  // 120 s, and the daemon waits for it. Both run whenever the flag is set, so
  // a copy that an earlier start did not finish is completed first.
  const blake2bOn = store.recovery && store.blake2b
  const blake2bCli = [
    `${blake2bPrefix}/bin/lightning-cli`,
    `--lightning-dir=${blake2bLightningDir}`,
  ]
  const blake2bGetinfo = () =>
    lightningSub.exec([...blake2bCli, 'getinfo'], { timeout: 20_000 })

  // emergency-recover and watchtower-server are added conditionally via thunks so
  // both can coexist in a single chain. (Previously each `if` rebuilt from
  // `baseDaemons`, so enabling the watchtower server silently dropped the
  // emergency-recover oneshot after a restore.)
  return baseDaemons
    .addOneshot('blake2b-copy', () =>
      blake2bOn
        ? {
            subcontainer: lightningSub,
            exec: {
              fn: async (subcontainer) => {
                const primary = await primaryInstance(effects)
                const secondary = await blake2bInstance(effects)
                if (!secondary) return null
                const made = await createBlake2bInstance(
                  subcontainer,
                  primary,
                  secondary,
                  {
                    network: secondary.network,
                    bridge: blake2bBridge,
                    cookieDir: secondary.cookieDir,
                    activationHeight: store.blake2bActivationHeight,
                  },
                )
                console.log(
                  made.copied
                    ? `BLAKE2b instance: database copied to ${made.database}`
                    : `BLAKE2b instance: database already at ${made.database}`,
                )
                return null
              },
            },
            requires: [],
          }
        : null,
    )
    .addDaemon('lightningd-blake2b', () =>
      blake2bOn
        ? {
            subcontainer: lightningSub,
            exec: {
              command: [
                `${blake2bPrefix}/bin/lightningd`,
                `--lightning-dir=${blake2bLightningDir}`,
                `--conf=${blake2bLightningDir}/config`,
                '--database-upgrade=true',
                ...(store.blake2bRescan
                  ? [`--rescan=${store.blake2bRescan}`]
                  : []),
              ],
            },
            ready: {
              display: i18n('BLAKE2b Instance'),
              fn: async () => {
                const res = await blake2bGetinfo()
                return res.exitCode === 0
                  ? {
                      result: 'success',
                      message: i18n('The BLAKE2b instance answers RPC'),
                    }
                  : {
                      result: 'loading',
                      message: i18n('The BLAKE2b instance is starting'),
                    }
              },
            },
            requires: ['blake2b-copy'],
          }
        : null,
    )
    .addHealthCheck('blake2b-synced', () =>
      blake2bOn
        ? {
            ready: {
              display: i18n('BLAKE2b Chain'),
              fn: async () => {
                const res = await blake2bGetinfo()
                if (res.exitCode !== 0) {
                  return {
                    result: 'loading',
                    message: i18n('The BLAKE2b instance is not answering yet'),
                  }
                }
                let height = 0
                let warning = false
                let backendBehind = false
                try {
                  const info = JSON.parse(res.stdout as string)
                  height = info.blockheight
                  warning = !!info.warning_lightningd_sync
                  backendBehind = !!info.warning_bitcoind_sync
                } catch {
                  return {
                    result: 'failure',
                    message: `'lightning-cli getinfo' returned unparseable output: ${String(res.stdout)}`,
                  }
                }
                if (backendBehind) {
                  return {
                    result: 'loading',
                    message: i18n(
                      'The BLAKE2b service (bitcoind) is not up to date with its network; the BLAKE2b instance is at height ${height} and waits for it.',
                      { height: String(height) },
                    ),
                  }
                }
                if (!warning) {
                  return {
                    result: 'success',
                    message: i18n(
                      'The BLAKE2b instance is at the tip of the BLAKE2b chain, height ${height}',
                      { height: String(height) },
                    ),
                  }
                }
                const tip = blake2bBridge
                  ? await lightningSub.exec([
                      'bitcoin-cli',
                      `--rpcconnect=${blake2bBridge.host}`,
                      `--rpcport=${blake2bBridge.port}`,
                      `--rpccookiefile=${(await blake2bInstance(effects))?.cookieDir}/.cookie`,
                      'getblockcount',
                    ])
                  : null
                return {
                  result: 'loading',
                  message: i18n(
                    'The BLAKE2b instance is reading the BLAKE2b chain: block ${height} of ${tip}. This takes a while after the first start.',
                    {
                      height: String(height),
                      tip:
                        tip?.exitCode === 0 ? String(tip.stdout).trim() : '?',
                    },
                  ),
                }
              },
            },
            requires: ['lightningd-blake2b'],
          }
        : null,
    )
    .addOneshot('blake2b-consume-rescan', () =>
      blake2bOn && store.blake2bRescan
        ? {
            subcontainer: lightningSub,
            exec: {
              fn: async () => {
                // The instance is up: its rescan can no longer be lost to a
                // failed start. The store watch ignores this clear.
                await storeJson.merge(effects, { blake2bRescan: undefined })
                return null
              },
            },
            requires: ['lightningd-blake2b'],
          }
        : null,
    )
    .addOneshot('emergency-recover', () =>
      store.restore
        ? {
            subcontainer: lightningSub,
            exec: {
              fn: async () => {
                await sdk.setHealth(effects, {
                  id: 'restored',
                  name: i18n('Backup Restoration Detected'),
                  message: i18n(
                    'It is not recommended to continue using a Core Lightning node after emergency recovery. All channels will be force-closed and funds swept to the on-chain wallet. Please wait for all channels to resolve, then sweep remaining funds to another wallet. Afterwards, Core Lightning should be uninstalled and re-installed fresh if you would like to continue using it.',
                  ),
                  result: 'failure',
                })
                return {
                  command: [
                    'lightning-cli',
                    `--lightning-dir=${rootDir}`,
                    'emergencyrecover',
                  ],
                }
              },
            },
            requires: ['lightningd'],
          }
        : null,
    )
    .addOneshot('address-pregen', () =>
      store.restore
        ? {
            subcontainer: lightningSub,
            exec: {
              // A restored database restarts the wallet's address counter at
              // zero, and CLN only recognizes addresses up to 50 past the
              // highest known-used index (keyscan_gap, hardcoded upstream).
              // The node's previous life burned indexes far faster than
              // on-chain hits advance that window — the web UIs issue a fresh
              // address per Receive view, observed in the field at ~140/day
              // (index 4,838 within five weeks of node birth) — so without
              // this a post-restore rescan silently misses wallet outputs
              // beyond the first >50-index gap. newaddr persists
              // bip32_max_index, so pre-registering 10,000 addresses widens
              // the window for every later rescan. (1,000 was field-tested
              // and proven too shallow.)
              command: [
                'sh',
                '-c',
                `i=0; while [ $i -lt 10000 ]; do lightning-cli --lightning-dir=${rootDir} newaddr all > /dev/null || exit 1; i=$((i+1)); done`,
              ],
            },
            requires: ['lightningd'],
          }
        : null,
    )
    .addOneshot('consume-flags', () =>
      store.rescan || store.restore
        ? {
            subcontainer: lightningSub,
            exec: {
              fn: async () => {
                // lightningd is up (and the restore oneshots above are done),
                // so the request can no longer be lost to a failed start. The
                // store watch in main ignores these clears, so this write
                // doesn't restart the service.
                await storeJson.merge(effects, {
                  rescan: undefined,
                  restore: undefined,
                })
                return null
              },
            },
            requires: store.restore
              ? ['lightningd', 'emergency-recover', 'address-pregen']
              : ['lightningd'],
          }
        : null,
    )
    .addDaemon('watchtower-server', () =>
      store.watchtowerServer
        ? {
            subcontainer: lightningSub,
            exec: {
              command: ['teosd', '--datadir=/root/.lightning/.teos'],
            },
            ready: {
              display: i18n('TEOS Watchtower Server'),
              fn: async () => {
                const gettowerinfoRes = await lightningSub.exec([
                  'teos-cli',
                  '--datadir=/root/.lightning/.teos',
                  'gettowerinfo',
                ])
                if (gettowerinfoRes.exitCode === 0) {
                  return {
                    result: 'success',
                    message: i18n('The Watchtower Server is online'),
                  }
                }

                return {
                  result: 'starting',
                  message: i18n('TEOSd is starting...'),
                }
              },
            },
            requires: ['lightningd'],
          }
        : null,
    )
    .addOneshot('watchtower-client', {
      subcontainer: lightningSub,
      exec: {
        fn: async (subcontainer, abort) => {
          if (!watchtowerClientLoaded) return null

          const listtowersRes = await subcontainer.exec(
            ['lightning-cli', 'listtowers'],
            { cwd: rootDir },
          )

          if (listtowersRes.exitCode === 0) {
            const parsedTowers: ListTowers = JSON.parse(
              listtowersRes.stdout as string,
            )
            const registered = new Set(
              Object.entries(parsedTowers).map(([id, t]) =>
                towerKey(id, t.net_addr),
              ),
            )
            for (const entry of store.watchtowerClients || []) {
              if (abort.aborted) break
              const tower = parseTowerUri(entry)
              if (!tower) {
                console.log(
                  `Watchtower client cannot read ${entry} as <tower id>@<host>:<port>`,
                )
                continue
              }
              if (registered.has(towerKey(tower.id, towerNetAddr(tower)))) {
                continue
              }

              console.log(`Watchtower client adding ${entry}`)
              // The host goes over as a JSON string literal because
              // lightning-cli leaves an argument that reads as a number
              // unquoted, which would send an IPv4 host as malformed JSON.
              const res = await subcontainer.exec(
                [
                  'lightning-cli',
                  'registertower',
                  tower.id,
                  JSON.stringify(tower.host),
                  String(tower.port),
                ],
                {
                  cwd: rootDir,
                  abort: { abort: abort.reason, signal: abort },
                },
              )

              if (
                res.exitCode === 0 &&
                res.stdout !== '' &&
                typeof res.stdout === 'string'
              ) {
                console.log(`Result adding tower ${entry}: ${res.stdout}`)
              } else {
                console.log(
                  `Error adding tower ${entry}: ${String(res.stderr)}`,
                )
              }
            }
          } else {
            console.log("failed to run 'listtowers':", listtowersRes)
          }
          return null
        },
      },
      requires: ['lightningd'],
    })
    .addOneshot('abandontowers', {
      subcontainer: lightningSub,
      exec: {
        fn: async (subcontainer, abort) => {
          if (!watchtowerClientLoaded) return null

          const listtowersRes = await subcontainer.exec(
            ['lightning-cli', 'listtowers'],
            { cwd: rootDir },
          )

          if (listtowersRes.exitCode === 0) {
            const parsedTowers: ListTowers = JSON.parse(
              listtowersRes.stdout as string,
            )
            const configured = new Set(
              (store.watchtowerClients || []).flatMap((entry) => {
                const tower = parseTowerUri(entry)
                return tower ? [towerKey(tower.id, towerNetAddr(tower))] : []
              }),
            )
            for (const [id, t] of Object.entries(parsedTowers)) {
              if (abort.aborted) break
              if (configured.has(towerKey(id, t.net_addr))) continue

              const tower = `${id}@${t.net_addr}`
              console.log(`Watchtower client removing ${tower}`)
              const res = await subcontainer.exec(
                ['lightning-cli', 'abandontower', id],
                {
                  cwd: rootDir,
                  abort: { abort: abort.reason, signal: abort },
                },
              )

              if (
                res.exitCode === 0 &&
                res.stdout !== '' &&
                typeof res.stdout === 'string'
              ) {
                console.log(`Result removing tower ${tower}: ${res.stdout}`)
              } else {
                console.log(
                  `Error removing tower ${tower}: ${String(res.stderr)}`,
                )
              }
            }
          } else {
            console.log(
              'Failed to run listtowers while checking for abandoned towers',
              listtowersRes,
            )
          }
          return null
        },
      },
      // Client-side tower cleanup: runs after watchtower-client to remove towers
      // no longer in the store, down to and including an empty list. Both are
      // always registered and skip their work internally, so this ordering
      // holds. Does NOT need the conditional
      // watchtower *server* (teosd) — requiring it broke the chain when the
      // server was disabled (SDK 2.0's Daemons.build enforces requires-ordering).
      requires: ['lightningd', 'watchtower-client'],
    })
    .addHealthCheck('watchtowers', () =>
      watchtowerClientLoaded && store.watchtowerClients.length
        ? {
            ready: {
              display: i18n('Watchtowers'),
              trigger: sdk.trigger.statusTrigger(60_000, { starting: 5_000 }),
              fn: async () => {
                const res = await lightningSub.exec(
                  ['lightning-cli', 'listtowers'],
                  { cwd: rootDir },
                )
                if (res.exitCode !== 0) {
                  return {
                    result: 'failure',
                    message: i18n('Could not list watchtowers: ${error}', {
                      error: literal(errorMessage(res)),
                    }),
                  }
                }
                const registered: ListTowers = JSON.parse(res.stdout as string)
                const labels =
                  (await storeJson.read((s) => s.watchtowerLabels).once()) ?? []
                const statuses = store.watchtowerClients.map((entry) => {
                  const id = parseTowerUri(entry)?.id
                  return {
                    name: labels.find((l) => l.id === id)?.label ?? id ?? entry,
                    status: (id && registered[id]?.status) || 'unregistered',
                  }
                })
                const down = statuses.filter(
                  (t) =>
                    t.status !== 'reachable' &&
                    t.status !== 'temporary_unreachable',
                )
                if (down.length) {
                  return {
                    result: 'failure',
                    message: i18n(
                      '${count} of ${total} watchtowers are unreachable or not registered: ${towers}',
                      {
                        count: String(down.length),
                        total: String(statuses.length),
                        towers: literal(down.map((t) => t.name).join(', ')),
                      },
                    ),
                  }
                }
                const retrying = statuses.filter(
                  (t) => t.status === 'temporary_unreachable',
                )
                if (retrying.length) {
                  return {
                    result: 'loading',
                    message: i18n(
                      'Retrying ${count} of ${total} watchtowers: ${towers}',
                      {
                        count: String(retrying.length),
                        total: String(statuses.length),
                        towers: literal(retrying.map((t) => t.name).join(', ')),
                      },
                    ),
                  }
                }
                return {
                  result: 'success',
                  message: i18n('All ${total} watchtowers are reachable', {
                    total: String(statuses.length),
                  }),
                }
              },
            },
            requires: ['abandontowers'],
          }
        : null,
    )
    .addHealthCheck('vpn-tunnel', () =>
      vpn
        ? {
            ready: {
              display: i18n('Clearnet VPN'),
              trigger: sdk.trigger.statusTrigger(30_000, {
                starting: 5_000,
                failure: 30_000,
              }),
              fn: async () => {
                const currentConfig =
                  (await storeJson
                    .read((s) => s.clearnetVpn?.config ?? null)
                    .once()) ?? null
                if (currentConfig !== vpnHealthConfig) {
                  vpnHealthConfig = currentConfig
                  vpnNoHandshakeSince = Date.now()
                }
                const noHandshake = () => {
                  const ageMs = Date.now() - vpnNoHandshakeSince
                  return ageMs > handshakeStaleMs
                    ? {
                        result: 'failure' as const,
                        message: i18n(
                          'No WireGuard handshake for ${minutes} minutes. Clearnet traffic is held until the tunnel returns, not sent over your ISP connection.',
                          { minutes: String(Math.floor(ageMs / 60_000)) },
                        ),
                      }
                    : {
                        result: 'starting' as const,
                        message: i18n(
                          'Waiting for the first WireGuard handshake.',
                        ),
                      }
                }
                let res
                try {
                  res = await lightningSub.exec(
                    ['wg', 'show', vpnIface, 'latest-handshakes'],
                    { timeout: 10_000 },
                  )
                } catch {
                  return noHandshake()
                }
                if (res.exitCode !== 0) return noHandshake()
                const epoch = Number(
                  String(res.stdout).trim().split(/\s+/)[1] ?? 0,
                )
                if (!epoch) return noHandshake()
                const ageMs = Date.now() - epoch * 1000
                if (ageMs > handshakeStaleMs) {
                  return {
                    result: 'failure',
                    message: i18n(
                      'No WireGuard handshake for ${minutes} minutes. Clearnet traffic is held until the tunnel returns, not sent over your ISP connection.',
                      { minutes: String(Math.floor(ageMs / 60_000)) },
                    ),
                  }
                }
                return {
                  result: 'success',
                  message: i18n('Tunnel up; last handshake ${seconds}s ago.', {
                    seconds: String(Math.floor(ageMs / 1000)),
                  }),
                }
              },
            },
            requires: ['vpn'],
          }
        : null,
    )
    .addHealthCheck('custom-external-host', () =>
      conf?.['tor-only'] === true && store.customExternalHosts.length
        ? {
            ready: {
              display: i18n('Custom External Host'),
              // Nothing here initializes, so the default grace period would
              // only show this as "starting" for its first 10 seconds.
              gracePeriod: 0,
              trigger: sdk.trigger.cooldownTrigger(60_000),
              fn: async () => ({
                result: 'failure' as const,
                message: i18n(
                  'Your custom external host is not being announced, because Core Lightning cannot resolve a hostname while Tor Only is enabled. In General Settings, either turn off Tor Only or clear the custom external host.',
                ),
              }),
            },
            requires: [],
          }
        : null,
    )
})
