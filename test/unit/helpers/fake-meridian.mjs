import { createServer } from "node:net"

export async function startProxyServer({ port, host }) {
  globalThis.fakeMeridianStarts++
  const server = createServer()
  server.listen(port, host)
  return {
    server,
    config: { port },
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}
