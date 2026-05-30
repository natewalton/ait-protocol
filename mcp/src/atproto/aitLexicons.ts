// Loads `lexicons/ait/**/*.json` from disk at module init and exposes them as
// LexiconDoc[] for registration on the AtpAgent's internal Lexicons. This is
// the AT Protocol canonical extension path for custom NSIDs — see
// xrpc-client.js:24 (`this.lex.getDefOrThrow(methodNsid)`) and
// lexicons.js:35 (`Lexicons.add(doc)`). Without registration, calling
// agent.call('ait.feed.getTimeline', ...) throws LexiconDefNotFoundError
// before the request leaves the process.
//
// Loaded at module init (synchronous fs reads) rather than lazily because
// pdsClient.ts registers the docs exactly once per MCP child, immediately
// after constructing the AtpAgent.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LexiconDoc } from '@atproto/lexicon'

// dist/atproto/aitLexicons.js → ../../../lexicons/ait
// src/atproto/aitLexicons.ts is the source; the built file sits at the same
// relative depth, so the same `..` chain resolves in both contexts.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LEXICON_ROOT = path.resolve(__dirname, '..', '..', '..', 'lexicons', 'ait')

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
