// pi's entry for hud (root package.json): pi.mjs with pi-tui's own OSC 8 detection. pi aliases its packages for a
// static import only (a dynamic import does not resolve), and node cannot load this file, so the tests take pi.mjs.
import { getCapabilities } from '@earendil-works/pi-tui'
import hudExtension from './pi.mjs'

export default (pi) => hudExtension(pi, { hyperlinks: () => getCapabilities().hyperlinks })
