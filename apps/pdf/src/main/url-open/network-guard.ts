/**
 * Network policy for "Open from URL". A downloaded PDF or a captured webpage
 * runs in its own throwaway Chromium session that gets a private, TCP-only
 * SOCKS proxy: Chromium keeps its normal HTTP, TLS/SNI and certificate checks,
 * while we open the actual connection to an address we validated ourselves.
 * There is no second DNS lookup between "check" and "connect", so DNS
 * rebinding cannot slip a page onto this computer or the local network.
 * Local destinations are refused unless the user approved that exact origin
 * and address set.
 *
 * Ported from Folio's electron/network.cjs (https://github.com/Forward-Future/folio,
 * MIT, © Matthew Berman / Forward Future) — see NOTICE.
 */
import { once } from 'node:events'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import type { App, Session } from 'electron'

const LOCAL = new net.BlockList()
for (const [ip, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const) {
  LOCAL.addSubnet(ip, prefix, 'ipv4')
}
// Permit global unicast IPv6, excluding transition/documentation ranges which can embed IPv4.
const GLOBAL6 = new net.BlockList()
GLOBAL6.addSubnet('2000::', 3, 'ipv6')
for (const [ip, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const) {
  LOCAL.addSubnet(ip, prefix, 'ipv6')
}

export const bareHost = (host: string): string =>
  host
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase()
const localName = (host: string) =>
  host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')

export function isLocalAddress(address: string): boolean {
  const ip = bareHost(address)
  if (net.isIPv4(ip)) return LOCAL.check(ip, 'ipv4')
  return !net.isIPv6(ip) || !GLOBAL6.check(ip, 'ipv6') || LOCAL.check(ip, 'ipv6')
}

function connectedNetworks(): net.BlockList {
  const networks = new net.BlockList()
  for (const iface of Object.values(os.networkInterfaces()).flat()) {
    if (!iface?.cidr) continue
    const [ip, bits] = iface.cidr.split('/')
    try {
      networks.addSubnet(
        ip!.split('%')[0]!,
        Number(bits),
        iface.family.toLowerCase() as 'ipv4' | 'ipv6',
      )
    } catch {
      /* an interface Node cannot describe is simply not "nearby" */
    }
  }
  return networks
}

export interface Destination {
  origin: string
  addresses: string[]
  /** At least one address is on this computer or the local network: the user must be asked */
  local: boolean
  /** Every address is local */
  allLocal: boolean
}

type HostResolver = Pick<Session, 'resolveHost'>

export async function resolveDestination(url: URL, resolver: HostResolver): Promise<Destination> {
  const host = bareHost(url.hostname)
  const addresses = net.isIP(host)
    ? [host]
    : (await resolver.resolveHost(host)).endpoints.map((e) => e.address)
  if (addresses.length === 0 || addresses.some((ip) => !net.isIP(ip))) {
    throw new Error("Couldn't resolve that address.")
  }
  const networks = connectedNetworks()
  const nearby = (ip: string) =>
    isLocalAddress(ip) || networks.check(ip, net.isIPv4(ip) ? 'ipv4' : 'ipv6')
  return {
    origin: url.origin,
    addresses,
    local: localName(host) || addresses.some(nearby),
    allLocal: addresses.every(nearby),
  }
}

// Read exactly one SOCKS field. Leave any pipelined application bytes in the socket.
async function readField(socket: net.Socket, length: number, signal: AbortSignal): Promise<Buffer> {
  while (!socket.destroyed) {
    const bytes = socket.read(length) as Buffer | null
    if (bytes) return bytes
    await once(socket, 'readable', { signal })
  }
  throw new Error('Connection closed')
}

async function readTarget(socket: net.Socket, signal: AbortSignal): Promise<string> {
  const read = (length: number) => readField(socket, length, signal)
  const [version, methods] = await read(2)
  if (version !== 5 || !methods || !(await read(methods)).includes(0)) {
    throw new Error('Invalid greeting')
  }
  socket.write(Buffer.from([5, 0]))
  const [v, command, reserved, type] = await read(4)
  if (v !== 5 || command !== 1 || reserved !== 0) {
    throw new Error('Only TCP connections are supported')
  }
  let host: string
  if (type === 3) {
    const [length] = await read(1)
    if (!length) throw new Error('Missing hostname')
    host = (await read(length)).toString('ascii')
  } else if (type === 1) {
    host = Array.from(await read(4)).join('.')
  } else if (type === 4) {
    const words = (await read(16)).toString('hex').match(/.{4}/g)!
    host = new URL(`http://[${words.join(':')}]`).hostname
  } else throw new Error('Invalid address')
  const port = (await read(2)).readUInt16BE()
  return `${bareHost(host)}:${port}`
}

interface Grant extends Destination {
  route: string
  port: number
}

// Honor the system route. An HTTP(S) proxy gets a numeric CONNECT authority as well. An
// unsupported proxy or failed tunnel must never silently become a direct connection.
async function connectPinned(
  { addresses, route, port }: Grant,
  signal: AbortSignal,
): Promise<net.Socket> {
  const first = route.split(';')[0]!.trim()
  if (first === 'DIRECT') {
    // Node can try both families, but its lookup can return only the addresses approved above.
    const endpoints = addresses.map((address) => ({ address, family: net.isIP(address) }))
    const socket = net.connect({
      host: 'pinned.invalid',
      port,
      signal,
      autoSelectFamily: true,
      lookup: ((_host: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) =>
        options.all
          ? cb(null, endpoints)
          : cb(null, endpoints[0]!.address, endpoints[0]!.family)) as unknown as net.LookupFunction,
    })
    await once(socket, 'connect')
    return socket
  }
  const proxy = /^(PROXY|HTTPS) (\S+)$/i.exec(first)
  if (!proxy) throw new Error('This system proxy cannot open a verified IP tunnel.')
  const secure = proxy[1]!.toUpperCase() === 'HTTPS'
  const via = new URL(`${secure ? 'https://' : 'http://'}${proxy[2]}`)
  const address = addresses[0]!
  const authority = `${net.isIPv6(address) ? `[${address}]` : address}:${port}`
  return new Promise((resolve, reject) => {
    const req = (secure ? https : http).request(via, {
      method: 'CONNECT',
      path: authority,
      agent: false,
      headers: { host: authority },
      signal,
    })
    req.once('error', reject)
    req.once('connect', (res, socket, head) => {
      if (res.statusCode !== 200 || signal.aborted) {
        socket.destroy()
        reject(new Error('System proxy refused the IP tunnel.'))
        return
      }
      if (head.length) socket.unshift(head)
      resolve(socket)
    })
    req.end()
  })
}

export interface SessionGuard {
  close(): void
  /** A request was refused because it led to an unapproved local address */
  refusedLocal(): boolean
}

/**
 * Route every request of `ses` through the pinned proxy. `approvedLocal` is the
 * one local destination the user agreed to (or null).
 */
export async function guardSession(
  ses: Session,
  system: Session,
  approvedLocal: Destination | null,
  app: App,
): Promise<SessionGuard> {
  const grants = new Map<string, Grant>()
  const sockets = new Set<net.Socket>()
  let denied = false
  let closed = false
  const server = net.createServer({ pauseOnConnect: true }, (client) => {
    void (async () => {
      sockets.add(client)
      const stop = new AbortController()
      let upstream: net.Socket | undefined
      client.on('error', () => client.destroy())
      client.on('close', () => {
        stop.abort()
        upstream?.destroy()
        sockets.delete(client)
      })
      client.setTimeout(15_000, () => client.destroy())
      try {
        const key = await readTarget(client, stop.signal)
        const grant = grants.get(key)
        if (!grant || closed) throw new Error('Unrequested destination')
        upstream = await connectPinned(grant, stop.signal)
        upstream.on('error', () => client.destroy())
        upstream.on('close', () => client.destroy())
        if (client.destroyed || closed) {
          upstream.destroy()
          return
        }
        client.setTimeout(0)
        client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
        client.pipe(upstream).pipe(client)
      } catch {
        client.destroy()
      }
    })()
  })
  // Never hand a client certificate (smart card, corporate cert) to a page we fetch for the user.
  const declineCertificate = (
    event: Electron.Event,
    contents: Electron.WebContents | null,
    authority: string,
    _certificates: Electron.Certificate[],
    choose: (certificate?: Electron.Certificate) => void,
  ) => {
    if (contents) {
      if (contents.session !== ses) return
    } else {
      // Electron supplies no Session for net.request challenges. Only destinations
      // granted by this guard can reach TLS through its SOCKS proxy.
      const peer = new URL(`https://${authority}`)
      if (!grants.has(`${bareHost(peer.hostname)}:${peer.port || 443}`)) return
    }
    event.preventDefault()
    choose()
  }
  const close = () => {
    closed = true
    ses.webRequest.onBeforeRequest((_request, callback) => callback({ cancel: true }))
    server.close()
    for (const socket of sockets) socket.destroy()
    grants.clear()
    app.removeListener('select-client-certificate', declineCertificate as never)
  }
  try {
    app.on('select-client-certificate', declineCertificate as never)
    server.maxConnections = 128
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const { port } = server.address() as net.AddressInfo
    await ses.setProxy({
      mode: 'fixed_servers',
      proxyRules: `socks5://127.0.0.1:${port}`,
      proxyBypassRules: '<-loopback>',
    })
    ses.webRequest.onBeforeRequest((details, callback) => {
      void (async () => {
        try {
          const url = new URL(details.url)
          if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            callback({ cancel: !['data:', 'blob:'].includes(url.protocol) })
            return
          }
          const [dest, route] = await Promise.all([
            resolveDestination(url, ses),
            system.resolveProxy(url.href),
          ])
          const allowedLocal =
            approvedLocal?.origin === dest.origin &&
            dest.addresses.every((ip) => approvedLocal.addresses.includes(ip))
          if ((dest.local && !allowedLocal) || closed) {
            denied ||= dest.local
            callback({ cancel: true })
            return
          }
          const destPort = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
          const key = `${bareHost(url.hostname)}:${destPort}`
          // SOCKS identifies a connection only by host and port. Never let a concurrent request
          // replace the addresses, scope or route that an already-authorized connection will use.
          const existing = grants.get(key)
          if (existing) {
            if (
              existing.origin !== dest.origin ||
              existing.local !== dest.local ||
              existing.route !== route
            ) {
              denied ||= existing.local || dest.local
              callback({ cancel: true })
              return
            }
          } else {
            if (grants.size >= 1024) {
              callback({ cancel: true })
              return
            }
            grants.set(key, { ...dest, route, port: destPort })
          }
          callback({})
        } catch {
          callback({ cancel: true })
        }
      })()
    })
    return { close, refusedLocal: () => denied }
  } catch (error) {
    close()
    throw error
  }
}
