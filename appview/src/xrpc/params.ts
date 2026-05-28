export class InvalidRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidRequestError'
  }
}

export function parseLimit(raw: string | null): number | undefined {
  if (raw === null) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new InvalidRequestError(
      `limit must be an integer in [1, 100]; got ${raw}`,
    )
  }
  return n
}
