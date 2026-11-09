import { T } from '@start9labs/start-sdk'
import { readdir, readFile, stat } from 'fs/promises'
import { storeJson } from '../fileModels/store.json'
import { manifest } from '../manifest'
import { current } from '../versions/current'
import { Lists, sat, walletTotals } from './node'
import { State } from './report'
import { finalPath, readLists, recoveryPath, snapshotDirs } from './snapshot'
import { Tools } from './tools'

/**
 * Recovery: Export Diagnostics builds one text file to send to whoever is helping with a recovery. It holds
 * what a developer needs to see why a recovery went wrong, and never a secret:
 * no hsm_secret, seed, rune, password, commando or VPN credential, and none of
 * store.json beyond the recovery keys. Peer node ids are cut to a prefix.
 * Without `detail`, transaction ids, addresses, short channel ids and amounts
 * are replaced by placeholders as well.
 */

/** The main volume as the action's own process sees it. */
const volume = '/media/startos/volumes/main'

/** How much of each log goes into the file. */
const actionsLogLines = 300
const crashLogLines = 200

const peerId = /\b0[23][0-9a-f]{64}\b/gi
// Block hashes start with zeros on mainnet and testnet (or end with them, in
// the byte order older Core Lightning databases keep); they identify a chain,
// not a person, and stay in. Any other 64-digit hex is a transaction id.
const txid = /\b(?!0{8})(?![0-9a-f]{56}0{8}\b)[0-9a-f]{64}\b/gi
// The Status report's short form, "d4867a59…e377": with a height next to it,
// enough to find the transaction.
const shortTxid = /\b[0-9a-f]{8}…[0-9a-f]{4}\b/gi
const address =
  /\b(?:bc1|tb1|bcrt1)[02-9ac-hj-np-z]{8,87}\b|\b[13mn2][1-9A-HJ-NP-Za-km-z]{25,34}\b/g
const scid = /\b\d+x\d+x\d+\b/g
const amount = /\b\d[\d,]*(?:\.\d+)? ?(m?sat)\b/g
// "ours 558251 of 558251 sat": the first number has no unit of its own.
const amountOf = /\b\d[\d,]* of (?=\d[\d,]* ?m?sat\b)/g

const secretWords = /preimage|secret|rune|password|passphrase|privkey|private/i
// Raw plugin and RPC traffic ("plugin-bcliIO_IN: <hex>"): whole blocks as
// hex, 100+ kB a line. No \b: the tag runs straight on from the subsystem.
const ioLine = /IO_(IN|OUT):/
const maxLineLength = 1000
/** How many crash log files are listed by name; the rest are only counted. */
const crashFilesListed = 10

/** The store.json keys the file may show; the rest holds VPN and watchtower settings. */
const recoveryKeys = [
  'bitcoinBackend',
  'blake2bActivationHeight',
  'offline',
  'rescan',
  'recovery',
  'developer',
  'wipeGossip',
]

const prefix = (id: string) => `${id.slice(0, 10)}…`

/** Free text as it may go into the file. */
function clean(text: string, detail: boolean) {
  const t = text.replace(peerId, (id) => prefix(id))
  return detail
    ? t
    : t
        .replace(txid, '<txid>')
        .replace(shortTxid, '<txid>')
        .replace(address, '<address>')
        .replace(scid, '<scid>')
        .replace(amountOf, '<amount> of ')
        .replace(amount, '<amount> $1')
}

/** An ActionResult as indented text, the way the Status page shows it. */
export function resultText(result: T.ActionResult & { version: '1' }): string {
  const lines = [result.title, '', result.message ?? '', '']
  const walk = (m: T.ActionResultMember, depth: number) => {
    const pad = '  '.repeat(depth)
    if (m.type === 'group') {
      lines.push(`${pad}[${m.name}]`)
      m.value.forEach((v) => walk(v, depth + 1))
    } else {
      lines.push(`${pad}${m.name}: ${m.value}`)
    }
  }
  const r = result.result
  if (r?.type === 'group') r.value.forEach((v) => walk(v, 0))
  else if (r?.type === 'single') lines.push(r.value)
  return lines.join('\n')
}

const tail = async (path: string, n: number) => {
  const text = await readFile(path, 'utf-8')
  return text.split('\n').filter(Boolean).slice(-n)
}

/** Every wallet transaction spending an outpoint, with its height (0 = unconfirmed). */
const spendsOf = (lists: Lists, txidOf: string, vout: number) =>
  lists.listtransactions.transactions
    .filter((t) => t.inputs.some((i) => i.txid === txidOf && i.index === vout))
    .map((t) => ({ txid: t.hash, height: t.blockheight }))

/** The channel and wallet part of the file, as plain data. */
function nodeDetail(lists: Lists, detail: boolean) {
  const id = (v: string | undefined) => (v ? (detail ? v : '<txid>') : null)
  const sats = (msat: number | undefined) =>
    msat === undefined ? null : detail ? sat(msat) : '<amount>'
  const outpoint = (t: string, n: number) =>
    detail ? `${t}:${n}` : '<outpoint>'
  const spends = (t: string, n: number) =>
    spendsOf(lists, t, n).map((s) => ({ txid: id(s.txid), height: s.height }))

  // lightningd returns these in no fixed order; sorted, two exports diff cleanly.
  const byFunding = <
    C extends { funding_txid: string; funding_outnum: number },
  >(
    cs: C[],
  ) =>
    [...cs].sort(
      (a, b) =>
        a.funding_txid.localeCompare(b.funding_txid) ||
        a.funding_outnum - b.funding_outnum,
    )
  const outputs = [...lists.listfunds.outputs].sort(
    (a, b) => a.txid.localeCompare(b.txid) || a.output - b.output,
  )

  const totals = walletTotals(lists.listfunds.outputs)
  return {
    open: byFunding(lists.listpeerchannels.channels).map((c) => ({
      scid: c.short_channel_id
        ? detail
          ? c.short_channel_id
          : '<scid>'
        : null,
      peer: prefix(c.peer_id),
      state: c.state,
      status: (c.status ?? []).map((s) => clean(s, detail)),
      opener: c.opener ?? null,
      ours_sat: sats(c.to_us_msat),
      total_sat: sats(c.total_msat),
      htlcs: c.htlcs?.length ?? 0,
      channel_type: c.channel_type?.names ?? null,
      funding: outpoint(c.funding_txid, c.funding_outnum),
      funding_spends: spends(c.funding_txid, c.funding_outnum),
    })),
    closed: byFunding(lists.listclosedchannels.closedchannels).map((c) => ({
      scid: c.short_channel_id
        ? detail
          ? c.short_channel_id
          : '<scid>'
        : null,
      peer: c.peer_id ? prefix(c.peer_id) : null,
      opener: c.opener ?? null,
      close_cause: c.close_cause ?? null,
      ours_sat: sats(c.final_to_us_msat),
      total_sat: sats(c.total_msat),
      funding: outpoint(c.funding_txid, c.funding_outnum),
      last_commitment: id(c.last_commitment_txid),
      funding_spends: spends(c.funding_txid, c.funding_outnum),
    })),
    wallet: {
      totals: detail
        ? totals
        : Object.fromEntries(
            Object.entries(totals).map(([k, v]) => [
              k,
              k === 'count' ? v : '<amount>',
            ]),
          ),
      outputs: outputs.map((o) => ({
        outpoint: outpoint(o.txid, o.output),
        sat: sats(o.amount_msat),
        status: o.status,
        height: o.blockheight ?? null,
        reserved: o.reserved,
      })),
      transactions: lists.listtransactions.transactions.length,
    },
  }
}

/**
 * The whole diagnostics file. `status` is the Status action's result for the
 * same moment; `extra` carries build-specific sections. A section that fails
 * is recorded under `errors` instead of failing the file.
 */
export async function diagnosticsText(
  tools: Tools,
  state: State,
  status: T.ActionResult & { version: '1' },
  detail: boolean,
  extra: Record<string, () => Promise<unknown>> = {},
): Promise<string> {
  const errors: string[] = []
  const section = async <R>(name: string, fn: () => Promise<R>) => {
    try {
      return await fn()
    } catch (e) {
      errors.push(`${name}: ${clean(String(e), detail)}`)
      return null
    }
  }

  const store = await section('store', () => storeJson.read().once())
  const saved =
    state.lists === null
      ? await section('saved lists', () => readLists(finalPath))
      : null
  const lists = state.lists ?? saved

  const data: Record<string, unknown> = {
    generated: new Date().toISOString(),
    package: {
      id: manifest.id,
      version: current.options.version,
    },
    core_lightning: state.node
      ? {
          version: state.node.version,
          blockheight: state.node.blockheight,
          id: prefix(state.node.id),
        }
      : 'not answering',
    network: tools.network,
    backend: tools.backend,
    heights: state.heights,
    recovery_settings:
      store &&
      Object.fromEntries(
        recoveryKeys.map((k) => [
          k,
          (store as Record<string, unknown>)[k] ?? null,
        ]),
      ),
    // Block hashes only: they identify the chain, not the user.
    chain: state.chain,
    node: lists
      ? {
          source: state.lists ? 'lightningd' : `saved in ${finalPath}`,
          ...nodeDetail(lists, detail),
        }
      : 'lightningd not answering and no saved lists',
    snapshots: await section('snapshots', snapshotDirs),
  }
  for (const [name, fn] of Object.entries(extra)) {
    data[name] = await section(name, fn)
  }

  const actionsLog = await section('actions.log', () =>
    tail(`${volume}/${recoveryPath}/actions.log`, actionsLogLines),
  )
  const crash = await section('crash logs', async () => {
    const dir = `${volume}/${tools.network}`
    const names = (await readdir(dir))
      .filter((n) => n.startsWith('crash.log'))
      .sort()
    const files = await Promise.all(
      names.slice(-crashFilesListed).map(async (n) => ({
        name: n,
        bytes: (await stat(`${dir}/${n}`)).size,
      })),
    )
    // Debug lines can name payment preimages and peer addresses: the tail
    // goes in only with detail, and never a line that names a secret.
    const newest = names.at(-1)
    return {
      count: names.length,
      files,
      newestTail:
        detail && newest
          ? (await tail(`${dir}/${newest}`, crashLogLines * 5))
              .filter((l) => !secretWords.test(l) && !ioLine.test(l))
              .slice(-crashLogLines)
              .map((l) =>
                l.length > maxLineLength
                  ? `${l.slice(0, maxLineLength)}… (${l.length} characters)`
                  : l,
              )
          : [],
    }
  })

  return [
    '# Core Lightning recovery diagnostics',
    `# ${detail ? 'Includes transaction ids, addresses and amounts.' : 'Transaction ids, addresses, short channel ids and amounts replaced by placeholders.'}`,
    '# Never contains the seed, hsm_secret, runes, passwords or VPN keys.',
    '',
    '## Status',
    '',
    clean(resultText(status), detail),
    '',
    '## Detail',
    '',
    clean(JSON.stringify(data, null, 2), detail),
    '',
    `## recovery/actions.log (last ${actionsLogLines} lines)`,
    '',
    ...(actionsLog ?? []).map((l) => clean(l, detail)),
    '',
    `## Crash logs${detail ? ` (last ${crashLogLines} lines of the newest)` : ''}`,
    '',
    `${crash?.count ?? 0} file(s)${(crash?.count ?? 0) > crashFilesListed ? `, the newest ${crashFilesListed} listed` : ''}:`,
    clean(JSON.stringify(crash?.files ?? [], null, 2), detail),
    '',
    ...(crash?.newestTail ?? []).map((l) => clean(l, detail)),
    '',
    '## Errors while collecting',
    '',
    ...(errors.length ? errors : ['none']),
    '',
  ].join('\n')
}
