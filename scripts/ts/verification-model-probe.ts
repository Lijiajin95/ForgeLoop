/**
 * 模型代理就绪探针。Windows 上探针经 `cmd.exe` 启动，参数里的 `>` 会被当成重定向，
 * 所以这里只用函数表达式与 `http.get`，不使用箭头函数或任何 shell 元字符。
 */
export const MODEL_PROXY_PROBE =
  "require('http').get('http://127.0.0.1:8123/',function(r){if(r.statusCode===403)console.log('ready')}).on('error',function(){})"

export function modelProxyProbe(proxy: string): string[] {
  return ['exec', proxy, 'node', '-e', MODEL_PROXY_PROBE]
}
