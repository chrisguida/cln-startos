import { IMPOSSIBLE, T, VersionInfo } from '@start9labs/start-sdk'
import { clnConfig } from '../fileModels/config'

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

// The recovery flavor is the stock build plus the Bitcoin Backend setting and
// the Recovery actions. It is its own flavor so that the unflavored package is
// left as it is for everybody else: nobody receives it as an update, it is
// installed over the stock build on purpose and left again for the BLAKE2b
// flavor, whose migration accepts arrivals from here.
export const current = VersionInfo.of({
  version: '#recovery:26.6.9:0',
  releaseNotes: {
    en_US: `Core Lightning 26.06.9 with the Recovery actions, for moving a node that has channels or coins from before the chains parted to the BLAKE2b chain.

- General Settings has a Bitcoin Backend choice, so that the node can keep following the SHA256d chain on the Knots (pre-RDTS) service.
- Recovery actions: Status, Snapshot, Offline Mode, Close All Channels, Withdraw to SHA256d Wallet.
- CLBOSS is turned off when this build is installed, so that it cannot move coins during the recovery.

Install it over Core Lightning 26.6.9 or older. When you are done here, install the BLAKE2b build of Core Lightning over it. You cannot go back to the stock build from this one.`,
    es_ES: `Core Lightning 26.06.9 con las acciones de Recuperación, para trasladar a la cadena BLAKE2b un nodo que tiene canales o monedas anteriores a la separación de las cadenas.

- Configuración general incluye la opción Backend de Bitcoin, para que el nodo pueda seguir la cadena SHA256d en el servicio Knots (pre-RDTS).
- Acciones de Recuperación: Estado, Instantánea, Modo sin conexión, Cerrar todos los canales, Retirar a un monedero SHA256d.
- CLBOSS se desactiva al instalar esta versión, para que no pueda mover monedas durante la recuperación.

Instálelo sobre Core Lightning 26.6.9. Cuando termine aquí, instale encima la versión BLAKE2b de Core Lightning. Desde esta versión no se puede volver a la versión original.`,
    de_DE: `Core Lightning 26.06.9 mit den Wiederherstellungsaktionen, um einen Knoten mit Kanälen oder Coins aus der Zeit vor der Trennung der Ketten auf die BLAKE2b-Kette zu bringen.

- Die Allgemeinen Einstellungen enthalten die Auswahl Bitcoin-Backend, damit der Knoten der SHA256d-Kette auf dem Dienst Knots (pre-RDTS) weiter folgen kann.
- Wiederherstellungsaktionen: Status, Snapshot, Offline-Modus, Alle Kanäle schließen, Auf SHA256d-Wallet auszahlen.
- CLBOSS wird bei der Installation dieses Builds ausgeschaltet, damit es während der Wiederherstellung keine Coins bewegen kann.

Installieren Sie es über Core Lightning 26.6.9. Wenn Sie hier fertig sind, installieren Sie den BLAKE2b-Build von Core Lightning darüber. Von diesem Build aus ist kein Weg zurück zum ursprünglichen Build möglich.`,
    pl_PL: `Core Lightning 26.06.9 z akcjami odzyskiwania, służącymi do przeniesienia na łańcuch BLAKE2b węzła, który ma kanały lub monety sprzed rozdzielenia łańcuchów.

- Ustawienia ogólne zawierają wybór Backend Bitcoin, dzięki czemu węzeł może nadal podążać za łańcuchem SHA256d w usłudze Knots (pre-RDTS).
- Akcje odzyskiwania: Status, Migawka, Tryb offline, Zamknij wszystkie kanały, Wypłać do portfela SHA256d.
- CLBOSS jest wyłączany przy instalacji tej wersji, aby nie mógł przenosić monet podczas odzyskiwania.

Zainstaluj tę wersję na Core Lightning 26.6.9. Po zakończeniu pracy tutaj zainstaluj na niej wersję BLAKE2b Core Lightning. Z tej wersji nie można wrócić do wersji standardowej.`,
    fr_FR: `Core Lightning 26.06.9 avec les actions de récupération, pour amener sur la chaîne BLAKE2b un nœud qui possède des canaux ou des pièces antérieurs à la séparation des chaînes.

- Les Paramètres généraux proposent le choix Backend Bitcoin, afin que le nœud puisse continuer à suivre la chaîne SHA256d sur le service Knots (pre-RDTS).
- Actions de récupération : État, Instantané, Mode hors ligne, Fermer tous les canaux, Retirer vers un portefeuille SHA256d.
- CLBOSS est désactivé à l'installation de cette version, afin qu'il ne puisse pas déplacer de pièces pendant la récupération.

Installez-la par-dessus Core Lightning 26.6.9. Une fois terminé ici, installez par-dessus la version BLAKE2b de Core Lightning. Il n'est pas possible de revenir à la version standard depuis celle-ci.`,
  },
  migrations: {
    // No earlier version of this flavor exists.
    up: async () => {},
    down: IMPOSSIBLE,
    other: {
      // Arriving from the stock build: 26.6.9:2, or a later packaging revision
      // of the same Core Lightning release. Older stock versions get here
      // through the unflavored chain (26.6.2:0, 26.6.8:3, 26.6.9:2) first. A
      // newer Core Lightning release may have upgraded the database beyond
      // what this lightningd reads, so it is not accepted.
      '>=26.6.9:2 <26.6.10:0': {
        up: removeClboss,
      },
    },
  },
})
