import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export type DeliveryOwner = {
  epoch: number;
  born: number;
  pid: number;
  runtime: string;
  dir: string;
  file: string;
};

export type Checkpoint =
  | { kind: 'cursor' | 'since'; value: string }
  | { kind: 'none'; value: null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLAIM = /^(0|[1-9][0-9]*)-([1-9][0-9]*)-([1-9][0-9]*)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.claim$/;

function failure(location: string, detail: string, cause?: unknown): Error {
  return new Error(`Claude delivery state at ${location}: ${detail}. Inspect the delivery state before retrying.`, { cause });
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function assertDirectory(dir: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch (error) {
    if (isMissing(error)) return false;
    throw failure(dir, 'cannot inspect the owner directory', error);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw failure(dir, 'the owner directory must be a real directory, not a symbolic link');
  }
  return true;
}

function parseOwner(dir: string, name: string): DeliveryOwner {
  const match = CLAIM.exec(name);
  if (!match) throw failure(path.join(dir, name), 'invalid claim filename');
  const [, epochText, bornText, pidText, runtime] = match;
  const epoch = Number(epochText);
  const born = Number(bornText);
  const pid = Number(pidText);
  if (![epoch, born, pid].every(Number.isSafeInteger) || born <= 0 || pid <= 0 || epoch < born) {
    throw failure(path.join(dir, name), 'claim timestamps and PID must be safe integers, with epoch at least born');
  }
  return { epoch, born, pid, runtime, dir, file: path.join(dir, name) };
}

function validateOwner(owner: DeliveryOwner): void {
  const parsed = parseOwner(owner.dir, path.basename(owner.file));
  if (owner.file !== parsed.file || owner.epoch !== parsed.epoch || owner.born !== parsed.born || owner.pid !== parsed.pid || owner.runtime !== parsed.runtime) {
    throw failure(owner.file, 'owner metadata does not match its immutable claim filename');
  }
}

function readClaims(dir: string): DeliveryOwner[] {
  if (!assertDirectory(dir)) return [];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    throw failure(dir, 'cannot read the owner directory', error);
  }
  return names.filter(name => name.endsWith('.claim')).map(name => {
    const owner = parseOwner(dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(owner.file);
    } catch (error) {
      throw failure(owner.file, 'cannot inspect a published claim', error);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw failure(owner.file, 'a published claim must be a regular file, not a symbolic link');
    }
    return owner;
  });
}

function validCheckpoint(value: unknown): value is Checkpoint {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const checkpoint = value as Record<string, unknown>;
  return (checkpoint.kind === 'none' && checkpoint.value === null)
    || ((checkpoint.kind === 'cursor' || checkpoint.kind === 'since') && typeof checkpoint.value === 'string');
}

function readBody(owner: DeliveryOwner): Checkpoint {
  let fd: number | undefined;
  try {
    fd = fs.openSync(owner.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (!fs.fstatSync(fd).isFile()) throw new Error('claim is not a regular file');
    const document: unknown = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (typeof document !== 'object' || document === null || Array.isArray(document)) {
      throw new Error('expected a checkpoint document');
    }
    const body = document as Record<string, unknown>;
    if (body.version !== 1 || !validCheckpoint(body.checkpoint)) {
      throw new Error('expected version 1 and a valid checkpoint');
    }
    return { ...body.checkpoint };
  } catch (error) {
    throw failure(owner.file, 'cannot read a valid checkpoint document', error);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function greatestClaims(claims: DeliveryOwner[]): DeliveryOwner[] {
  const epoch = claims.reduce((maximum, claim) => Math.max(maximum, claim.epoch), -1);
  return claims.filter(claim => claim.epoch === epoch);
}

function eligible(owner: DeliveryOwner, claims: DeliveryOwner[]): boolean {
  const greatest = greatestClaims(claims);
  // Validate the published predecessor even when the candidate is newer. A new
  // activation must never conceal an unavailable persisted checkpoint.
  for (const claim of greatest) readBody(claim);
  if (greatest.length === 0 || owner.epoch > greatest[0].epoch) return true;
  return greatest.length === 1 && greatest[0].file === owner.file;
}

export function ownerDirectory(base: string, did: string): string {
  return path.join(base, 'claude-delivery-' + createHash('sha256').update(did).digest('hex'));
}

export function describeOwner(dir: string, runtime: string, born: number, pid: number, activation: number): DeliveryOwner {
  if (!UUID.test(runtime)) throw failure(dir, 'runtime must be a lowercase UUID');
  if (![born, pid, activation].every(Number.isSafeInteger) || born <= 0 || pid <= 0 || activation < born) {
    throw failure(dir, 'born, PID, and activation must be safe integers, with activation at least born');
  }
  const existing = readClaims(dir).filter(claim => claim.runtime === runtime && claim.born === born && claim.pid === pid);
  if (existing.length > 1) throw failure(dir, 'multiple claims identify the same runtime, birth time, and PID');
  return existing[0] ?? parseOwner(dir, `${activation}-${born}-${pid}-${runtime}.claim`);
}

export function ownerEligible(owner: DeliveryOwner): boolean {
  validateOwner(owner);
  return eligible(owner, readClaims(owner.dir));
}

export function readCheckpoint(dir: string): Checkpoint | null {
  const greatest = greatestClaims(readClaims(dir));
  const checkpoints = greatest.map(readBody);
  if (greatest.length === 0) return null;
  // Equal epochs have no winner. Explicit none preserves the directory's
  // authority and asks the caller to replay, never to use legacy credentials.
  return greatest.length > 1 ? { kind: 'none', value: null } : checkpoints[0];
}

function writeTemporary(owner: DeliveryOwner, checkpoint: Checkpoint): string {
  if (!validCheckpoint(checkpoint)) throw failure(owner.file, 'invalid checkpoint to persist');
  const temporary = path.join(owner.dir, `.${owner.pid}-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify({ version: 1, checkpoint })}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    return temporary;
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch { /* Preserve the original failure. */ }
    throw failure(owner.file, 'cannot prepare an atomic checkpoint write', error);
  }
}

function cleanup(temporary: string): void {
  try {
    fs.unlinkSync(temporary);
  } catch (error) {
    if (!isMissing(error)) throw failure(temporary, 'cannot remove the temporary checkpoint file', error);
  }
}

export function publishOwner(owner: DeliveryOwner, initialCheckpoint: Checkpoint): void {
  validateOwner(owner);
  if (!validCheckpoint(initialCheckpoint)) throw failure(owner.file, 'invalid initial checkpoint');
  if (!assertDirectory(owner.dir)) {
    try {
      fs.mkdirSync(owner.dir, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw failure(owner.dir, 'cannot create the owner directory', error);
    }
  }
  const claims = readClaims(owner.dir);
  if (claims.some(claim => claim.file === owner.file)) {
    readBody(owner);
    return;
  }
  const temporary = writeTemporary(owner, initialCheckpoint);
  try {
    try {
      // A hard link creates the final name exclusively, without replacing any
      // existing claim. Only that claim's owner may subsequently replace its body.
      fs.linkSync(temporary, owner.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      readClaims(owner.dir);
      readBody(owner);
    }
  } catch (error) {
    throw failure(owner.file, 'cannot publish the owner claim', error);
  } finally {
    cleanup(temporary);
  }
}

export function commitCheckpoint(owner: DeliveryOwner, expected: string | null | undefined, cursor: string): boolean {
  validateOwner(owner);
  if (typeof cursor !== 'string') throw failure(owner.file, 'cursor must be a string');
  const claims = readClaims(owner.dir);
  if (!eligible(owner, claims) || !claims.some(claim => claim.file === owner.file)) return false;
  const current = readBody(owner);
  if (expected !== undefined && current.value !== expected) return false;
  const temporary = writeTemporary(owner, { kind: 'cursor', value: cursor });
  try {
    // Recheck after preparing the temporary file so a superseded owner does
    // not write merely because it was eligible before disk I/O.
    const latest = readClaims(owner.dir);
    if (!eligible(owner, latest) || !latest.some(claim => claim.file === owner.file)) return false;
    if (expected !== undefined && readBody(owner).value !== expected) return false;
    fs.renameSync(temporary, owner.file);
    return ownerEligible(owner);
  } catch (error) {
    throw failure(owner.file, 'cannot commit the checkpoint', error);
  } finally {
    cleanup(temporary);
  }
}
