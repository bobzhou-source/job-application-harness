import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { rm, readFile, stat, writeFile } from 'node:fs/promises'

// Advisory lock: `<path>.lock` created with O_EXCL. Lock files older than STALE_MS
// are left by a crashed holder and are taken over; ACQUIRE_MS bounds the wait.
const STALE_MS = 30_000
const ACQUIRE_MS = 20_000
const RETRY_MS = 50

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

const ours = async lockPath => (await readFile(lockPath, 'utf8').catch(() => '')) === `${process.pid}\n`

export async function withFileLock(path, fn) {
  const lockPath = `${path}.lock`
  const deadline = Date.now() + ACQUIRE_MS

  for (;;) {
    try {
      await writeFile(lockPath, `${process.pid}\n`, { flag: 'wx' })
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const info = await stat(lockPath).catch(() => null)
      if (info && Date.now() - info.mtimeMs > STALE_MS) {
        await rm(lockPath, { force: true })
        continue
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for lock ${lockPath}`)
      await sleep(RETRY_MS)
    }
  }

  try {
    return await fn()
  } finally {
    if (await ours(lockPath)) await rm(lockPath, { force: true })
  }
}

// Same protocol for callers that cannot await (remember() in accounts.mjs), so they
// serialise against async holders on the same `<path>.lock` file.
export function withFileLockSync(path, fn) {
  const lockPath = `${path}.lock`
  const deadline = Date.now() + ACQUIRE_MS

  for (;;) {
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx' })
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const info = (() => { try { return statSync(lockPath) } catch { return null } })()
      if (info && Date.now() - info.mtimeMs > STALE_MS) {
        rmSync(lockPath, { force: true })
        continue
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for lock ${lockPath}`)
      sleepSync(RETRY_MS)
    }
  }

  try {
    return fn()
  } finally {
    const holder = (() => { try { return readFileSync(lockPath, 'utf8') } catch { return '' } })()
    if (holder === `${process.pid}\n`) rmSync(lockPath, { force: true })
  }
}
