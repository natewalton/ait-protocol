// Loads `lexicons/ait/**/*.json` from disk at module init and exposes them as
// LexiconDoc[] for registration on the xrpc-server Server's internal Lexicons.
// Without registration, calling Server.method('ait.feed.getTimeline', ...)
// fails because `this.lex.getDef(nsid)` returns undefined (server.js:150) and
// the route never registers.
//
// Mirror of mcp/src/atproto/aitLexicons.ts — the spec (section 1) deliberately
// duplicates the ~30-line loader rather than wiring a shared module across
// the two packages.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LexiconDoc } from '@atproto/lexicon'

// dist/aitLexicons.js → ../../lexicons/ait
// src/aitLexicons.ts is the source; the built file sits one level deeper than
// the source's `appview/src/`, so the `..` chain resolves in both contexts.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LEXICON_ROOT = path.resolve(__dirname, '..', '..', 'lexicons', 'ait')

function loadAll(root: string): LexiconDoc[] {
  const out: LexiconDoc[] = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      out.push(...loadAll(full))
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      const raw = fs.readFileSync(full, 'utf8')
      out.push(JSON.parse(raw) as LexiconDoc)
    }
  }
  return out
}

export const AIT_LEXICONS: readonly LexiconDoc[] = Object.freeze(
  loadAll(LEXICON_ROOT),
)
