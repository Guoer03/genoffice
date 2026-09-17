import { join } from 'node:path'
import { genofficeUserDataDir } from './gui'

/**
 * The cloud commands (search / image / media) reuse the editors' BYOK provider
 * routing from the app's AI settings. That settings file lives in the shell's
 * Electron userData directory, which genoffice has to locate without Electron.
 * (Genspark cloud routing was removed; only the undici global proxy remains.)
 */
export function aiSettingsPath(env: NodeJS.ProcessEnv): string {
  return env.GENOFFICE_AI_SETTINGS || join(genofficeUserDataDir(env), 'ai-settings.json')
}

/** First http(s) proxy in the usual environment variables, as the app's main process reads them. */
export function proxyUrlFromEnv(env: NodeJS.ProcessEnv): string | null {
  return (
    [
      env.HTTPS_PROXY,
      env.https_proxy,
      env.HTTP_PROXY,
      env.http_proxy,
      env.ALL_PROXY,
      env.all_proxy,
    ].find((v) => v && /^https?:\/\//.test(v)) ?? null
  )
}

let prepared = false

/** Once per process: apply the environment proxy to fetch (undici global dispatcher). */
export async function prepareCloud(env: NodeJS.ProcessEnv): Promise<void> {
  if (prepared) return
  prepared = true
  const proxy = proxyUrlFromEnv(env)
  if (proxy) {
    const { ProxyAgent, setGlobalDispatcher } = await import('undici')
    setGlobalDispatcher(new ProxyAgent(proxy))
  }
}
