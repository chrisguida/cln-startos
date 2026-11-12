import { IMPOSSIBLE, T, VersionInfo } from '@start9labs/start-sdk'
import { clnConfig, lightningNetwork } from '../fileModels/config'
import { storeJson } from '../fileModels/store.json'
import { preRecoveryBackup } from '../recovery/instance'
import { audit } from '../recovery/snapshot'

// Same path as clbossPlugin in actions/config/plugins.ts, kept here to avoid importing actions.
const clbossPlugin = '/usr/local/libexec/c-lightning/plugins/clboss'

// CLBOSS manages the on-chain wallet: once Close All Channels returns the
// coins to it, it may open new channels or swap them before Withdraw runs.
// Recovery moves every coin by hand, so CLBOSS is turned off on arrival (its
// options too: lightningd refuses options of a plugin it has not loaded).
const removeClboss = async ({ effects }: { effects: T.Effects }) => {
  const form = await clnConfig.read().once()
  const plugins = (form?.raw?.plugin ?? []).filter(
    (p): p is string => typeof p === 'string',
  )
  if (!plugins.includes(clbossPlugin)) return
  await clnConfig.merge(effects, {
    raw: {
      ...(form?.raw ?? {}),
      plugin: plugins.filter((p) => p !== clbossPlugin),
      'clboss-min-onchain': undefined,
      'clboss-auto-close': undefined,
      'clboss-zerobasefee': undefined,
      'clboss-min-channel': undefined,
      'clboss-max-channel': undefined,
    },
  })
}

// Every arrival runs with the node stopped (StartOS quiesces and uninstalls
// the old container before this build's init): the safety backup is a plain
// file copy, and recovery mode is set before the first start, so the node's
// own data is only ever opened by the SHA256d build until Recovery: Finish.
const enterRecovery = async ({ effects }: { effects: T.Effects }) => {
  const backup = await preRecoveryBackup(await lightningNetwork())
  await storeJson.merge(effects, { recovery: true })
  await audit('enter-recovery', backup)
}

const arriveFromStock = async (arg: { effects: T.Effects }) => {
  await removeClboss(arg)
  await enterRecovery(arg)
}

// The recovery flavor is its own flavor so that the unflavored package is
// left as it is for everybody else: nobody receives it as an update, it is
// installed over the stock build on purpose and left again for the BLAKE2b
// flavor, whose migration accepts arrivals from here.
export const current = VersionInfo.of({
  version: '#recovery:26.6.10:0',
  releaseNotes: {
    en_US: `Requires StartOS 0.4.1 or later.

One package for the whole recovery. It carries two Core Lightning builds: upstream 26.06.9, which keeps running the node on the SHA256d chain, and privkeyio 26.06.10-blake2b.1, which runs a copy of the node on the BLAKE2b chain from the moment the channels are closed. Both Bitcoin services are needed: Knots (pre-RDTS) for SHA256d and Knots for BLAKE2b.

- Recovery actions, in order: Status, Snapshot, Close All Channels (starts the BLAKE2b instance), Replay Closes, Repair Wallet, Split Coins, Withdraw to SHA256d Wallet, Finish. Status says which comes next.
- Withdraw refuses any coin that is still unspent on the BLAKE2b chain, so a withdrawal can never be copied there: Split first.
- Installing takes a safety backup under recovery/pre-recovery. Never restore it, or any other copy of the database, once a channel has been closed.
- CLBOSS is turned off when this build is installed, so that it cannot move coins during the recovery.

Install it over Core Lightning 26.6.9 or over the earlier recovery build. After Finish the node runs on BLAKE2b alone and the BLAKE2b build of Core Lightning can be installed over it. You cannot go back to the stock build from this one.`,
    es_ES: `Requiere StartOS 0.4.1 o posterior.

Un solo paquete para toda la recuperación. Incluye dos versiones de Core Lightning: la oficial 26.06.9, que sigue ejecutando el nodo en la cadena SHA256d, y privkeyio 26.06.10-blake2b.1, que ejecuta una copia del nodo en la cadena BLAKE2b desde el momento en que se cierran los canales. Hacen falta los dos servicios de Bitcoin: Knots (pre-RDTS) para SHA256d y Knots para BLAKE2b.

- Acciones de Recuperación, en orden: Estado, Instantánea, Cerrar todos los canales (arranca la instancia BLAKE2b), Reproducir cierres, Reparar monedero, Separar monedas, Retirar a un monedero SHA256d, Finalizar. Estado indica cuál sigue.
- Retirar rechaza toda moneda que siga sin gastar en la cadena BLAKE2b, de modo que una retirada nunca puede copiarse allí: primero Separar.
- La instalación toma una copia de seguridad en recovery/pre-recovery. No la restaure nunca, ni ninguna otra copia de la base de datos, una vez cerrado un canal.
- CLBOSS se desactiva al instalar esta versión, para que no pueda mover monedas durante la recuperación.

Instálelo sobre Core Lightning 26.6.9 o sobre la versión de recuperación anterior. Tras Finalizar, el nodo funciona solo en BLAKE2b y puede instalarse encima la versión BLAKE2b de Core Lightning. Desde esta versión no se puede volver a la versión original.`,
    de_DE: `Erfordert StartOS 0.4.1 oder neuer.

Ein Paket für die ganze Wiederherstellung. Es enthält zwei Core-Lightning-Builds: das offizielle 26.06.9, das den Knoten weiter auf der SHA256d-Kette betreibt, und privkeyio 26.06.10-blake2b.1, das ab dem Schließen der Kanäle eine Kopie des Knotens auf der BLAKE2b-Kette betreibt. Beide Bitcoin-Dienste werden gebraucht: Knots (pre-RDTS) für SHA256d und Knots für BLAKE2b.

- Wiederherstellungsaktionen, der Reihe nach: Status, Snapshot, Alle Kanäle schließen (startet die BLAKE2b-Instanz), Schließungen wiederholen, Wallet reparieren, Coins trennen, Auf SHA256d-Wallet auszahlen, Abschließen. Status nennt den nächsten Schritt.
- Auszahlen lehnt jeden Coin ab, der auf der BLAKE2b-Kette noch unausgegeben ist, damit eine Auszahlung dort nie kopiert werden kann: erst Trennen.
- Die Installation legt eine Sicherung unter recovery/pre-recovery an. Stellen Sie sie, wie jede andere Kopie der Datenbank, nie wieder her, sobald ein Kanal geschlossen wurde.
- CLBOSS wird bei der Installation dieses Builds ausgeschaltet, damit es während der Wiederherstellung keine Coins bewegen kann.

Installieren Sie es über Core Lightning 26.6.9 oder über den früheren Wiederherstellungs-Build. Nach Abschließen läuft der Knoten allein auf BLAKE2b, und der BLAKE2b-Build von Core Lightning kann darüber installiert werden. Von diesem Build aus ist kein Weg zurück zum ursprünglichen Build möglich.`,
    pl_PL: `Wymaga StartOS 0.4.1 lub nowszego.

Jeden pakiet na całe odzyskiwanie. Zawiera dwie wersje Core Lightning: oficjalną 26.06.9, która nadal prowadzi węzeł na łańcuchu SHA256d, oraz privkeyio 26.06.10-blake2b.1, która od chwili zamknięcia kanałów prowadzi kopię węzła na łańcuchu BLAKE2b. Potrzebne są obie usługi Bitcoin: Knots (pre-RDTS) dla SHA256d i Knots dla BLAKE2b.

- Akcje odzyskiwania, po kolei: Status, Migawka, Zamknij wszystkie kanały (uruchamia instancję BLAKE2b), Odtwórz zamknięcia, Napraw portfel, Rozdziel monety, Wypłać do portfela SHA256d, Zakończ. Status mówi, która jest następna.
- Wypłata odrzuca każdą monetę, która na łańcuchu BLAKE2b jest wciąż niewydana, więc wypłaty nie da się tam skopiować: najpierw Rozdziel.
- Instalacja tworzy kopię zapasową w recovery/pre-recovery. Nigdy jej nie przywracaj, ani żadnej innej kopii bazy danych, gdy jakiś kanał został już zamknięty.
- CLBOSS jest wyłączany przy instalacji tej wersji, aby nie mógł przenosić monet podczas odzyskiwania.

Zainstaluj tę wersję na Core Lightning 26.6.9 lub na wcześniejszej wersji odzyskiwania. Po Zakończ węzeł działa tylko na BLAKE2b i można na nim zainstalować wersję BLAKE2b Core Lightning. Z tej wersji nie można wrócić do wersji standardowej.`,
    fr_FR: `Nécessite StartOS 0.4.1 ou une version ultérieure.

Un seul paquet pour toute la récupération. Il contient deux versions de Core Lightning : la version officielle 26.06.9, qui continue de faire tourner le nœud sur la chaîne SHA256d, et privkeyio 26.06.10-blake2b.1, qui fait tourner une copie du nœud sur la chaîne BLAKE2b dès la fermeture des canaux. Les deux services Bitcoin sont nécessaires : Knots (pre-RDTS) pour SHA256d et Knots pour BLAKE2b.

- Actions de récupération, dans l'ordre : État, Instantané, Fermer tous les canaux (démarre l'instance BLAKE2b), Rejouer les fermetures, Réparer le portefeuille, Séparer les pièces, Retirer vers un portefeuille SHA256d, Terminer. État indique la suivante.
- Retirer refuse toute pièce encore non dépensée sur la chaîne BLAKE2b, de sorte qu'un retrait ne peut jamais y être copié : Séparer d'abord.
- L'installation prend une sauvegarde de sécurité sous recovery/pre-recovery. Ne la restaurez jamais, ni aucune autre copie de la base de données, une fois un canal fermé.
- CLBOSS est désactivé à l'installation de cette version, afin qu'il ne puisse pas déplacer de pièces pendant la récupération.

Installez-la par-dessus Core Lightning 26.6.9 ou par-dessus la version de récupération précédente. Après Terminer, le nœud tourne sur BLAKE2b seul et la version BLAKE2b de Core Lightning peut être installée par-dessus. Il n'est pas possible de revenir à la version standard depuis celle-ci.`,
  },
  migrations: {
    // Earlier revisions of this flavor (26.6.9:0 to :4, one SHA256d build,
    // the BLAKE2b build as a second package): the same data, now to be run by
    // both instances. bespoke-employer arrives this way.
    up: enterRecovery,
    down: IMPOSSIBLE,
    other: {
      // Arriving from the stock build: 26.6.9:2, or a later packaging revision
      // of the same Core Lightning release. Older stock versions get here
      // through the unflavored chain (26.6.2:0, 26.6.8:3, 26.6.9:2) first. A
      // newer Core Lightning release may have upgraded the database beyond
      // what the SHA256d build reads, so it is not accepted.
      '>=26.6.9:2 <26.6.10:0': {
        up: arriveFromStock,
      },
    },
  },
})
