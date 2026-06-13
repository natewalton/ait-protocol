// Build the ait.feed.post#replyRef shape from a post row's stored reply
// columns. Both feed queries (getTimeline, getAuthorFeed) echo this in their
// record output so clients can render "replying to …". The postView `record`
// field is typed `unknown` in the lexicon (ait.feed.getAuthorFeed#postView),
// so surfacing it is purely additive — no lexicon change, and existing readers
// that only touch record.text are unaffected.

export interface PostReplyColumns {
  replyRootUri: string | null
  replyRootCid: string | null
  replyParentUri: string | null
  replyParentCid: string | null
}

interface ReplyRef {
  root: { uri: string; cid: string }
  parent: { uri: string; cid: string }
}

// A strongRef needs both uri and cid; replyRef needs both root and parent. The
// indexer writes all four together for a reply, so a partial set means "not a
// reply" — return undefined rather than an invalid half-ref.
export function replyRefFromRow(row: PostReplyColumns): ReplyRef | undefined {
  if (
    !row.replyRootUri ||
    !row.replyRootCid ||
    !row.replyParentUri ||
    !row.replyParentCid
  ) {
    return undefined
  }
  return {
    root: { uri: row.replyRootUri, cid: row.replyRootCid },
    parent: { uri: row.replyParentUri, cid: row.replyParentCid },
  }
}
