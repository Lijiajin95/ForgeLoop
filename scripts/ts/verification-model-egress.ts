import { createServer } from 'node:http'
import { connect } from 'node:net'
import { QWEN_TOKEN_PLAN_CN_HOSTS } from './verification-container.ts'

export function modelHostFor(
  authority: string | undefined,
  hosts: readonly string[],
): string | undefined {
  return hosts.find((host) => authority?.toLowerCase() === `${host}:443`)
}

export function egressLine(
  verdict: 'allow' | 'reject',
  target: string | undefined,
  reason: 'host' | 'auth' | '',
  authPresent: boolean,
): string {
  const auth = authPresent ? 'present' : 'absent'
  return reason
    ? `[egress] ${verdict} target=${target ?? ''} reason=${reason} auth=${auth}`
    : `[egress] ${verdict} target=${target ?? ''} auth=${auth}`
}

function start(): void {
  const hosts = (process.env.FORGELOOP_MODEL_HOSTS ?? '').split(',').filter(Boolean)
  const password = process.env.FORGELOOP_MODEL_PROXY_PASSWORD
  const approved = new Set(['api.deepseek.com', ...QWEN_TOKEN_PLAN_CN_HOSTS])
  if (!password || hosts.length === 0 || hosts.some((host) => !approved.has(host))) {
    throw new Error('模型代理需要本轮授权令牌和已登记的模型域名')
  }
  const authorization = `Basic ${Buffer.from(`forge:${password}`).toString('base64')}`
  const server = createServer((_request, response) => {
    response.writeHead(403).end()
  })
  server.on('connect', (request, client, head) => {
    const host = modelHostFor(request.url, hosts)
    const authPresent = request.headers['proxy-authorization'] !== undefined
    if (!host || request.headers['proxy-authorization'] !== authorization) {
      const reason = host ? 'auth' : 'host'
      process.stdout.write(`${egressLine('reject', request.url, reason, authPresent)}\n`)
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    process.stdout.write(`${egressLine('allow', request.url, '', authPresent)}\n`)
    const upstream = connect({ host, port: 443 })
    const deadline = setTimeout(() => upstream.destroy(), 30_000)
    upstream.once('close', () => {
      clearTimeout(deadline)
      client.destroy()
    })
    upstream.on('error', () => client.destroy())
    client.on('error', () => upstream.destroy())
    client.once('close', () => upstream.destroy())
    upstream.once('connect', () => {
      clearTimeout(deadline)
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(client).pipe(upstream)
    })
  })
  server.listen(8123, '0.0.0.0')
}

if (import.meta.main) start()
