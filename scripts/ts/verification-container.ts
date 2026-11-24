import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

interface VerificationSuite {
  readonly scripts: readonly string[]
  readonly model: 'none' | 'deepseek' | 'either'
  readonly candidate?: boolean
  readonly options?: readonly string[]
  readonly enable?: string
  readonly hostPathOption?: string
}

export const QWEN_TOKEN_PLAN_CN_HOSTS: readonly string[] = [
  'token-plan.cn-beijing.maas.aliyuncs.com',
  'token-plan.maas.qianwenaiapi.com',
]

export const VERIFICATION_TARGETS = {
  e2e: { scripts: ['e2e', 'e2e-board'], model: 'none', candidate: true },
  'e2e-board': { scripts: ['e2e-board'], model: 'none', candidate: true },
  'verify-plugin': { scripts: ['verify-plugin'], model: 'deepseek', candidate: true },
  'verify-e2e': {
    scripts: ['verify-e2e'],
    model: 'deepseek',
    candidate: true,
    options: ['FORGELOOP_E2E_TIMEOUT_MS'],
  },
  'm0-loop-e2e': { scripts: ['m0-loop-e2e'], model: 'none' },
  'm1-seed': { scripts: ['m1-seed'], model: 'none' },
  'real-deploy-interrupt': { scripts: ['real-deploy-interrupt'], model: 'none' },
  'real-model-e2e': {
    scripts: ['real-model-e2e'],
    model: 'either',
    enable: 'FORGELOOP_REAL_MODEL',
    hostPathOption: 'FORGELOOP_REAL_MODEL_PROJECT_DIR',
    options: [
      'FORGELOOP_REAL_MODEL_DEPLOY',
      'FORGELOOP_REAL_MODEL_ID',
      'FORGELOOP_REAL_MODEL_REQUIREMENT',
      'FORGELOOP_REAL_MODEL_TIMEOUT_MS',
      'FORGELOOP_REAL_MODEL_SUBMIT_TIMEOUT_MS',
      'FORGELOOP_REAL_MODEL_BLOCKED_GRACE_MS',
      'FORGELOOP_REAL_MODEL_TURN_TIMEOUT_SECONDS',
      'FORGELOOP_REAL_MODEL_MAX_TASK_ATTEMPTS',
      'FORGELOOP_REAL_MODEL_MAX_FAILURE_ROUNDS',
    ],
  },
  'real-ops-e2e': {
    scripts: ['real-ops-e2e'],
    model: 'either',
    enable: 'FORGELOOP_REAL_OPS',
    hostPathOption: 'FORGELOOP_REAL_OPS_ROOT',
    options: ['FORGELOOP_REAL_OPS_INTERRUPT', 'FORGELOOP_REAL_OPS_TIMEOUT_MS'],
  },
  'real-self-e2e': {
    scripts: ['real-self-e2e'],
    model: 'either',
    enable: 'FORGELOOP_REAL_SELF',
    hostPathOption: 'FORGELOOP_REAL_SELF_ROOT',
    options: [
      'FORGELOOP_REAL_SELF_INTERRUPT',
      'FORGELOOP_REAL_SELF_TIMEOUT_MS',
      'FORGELOOP_REAL_SELF_SUBMIT_TIMEOUT_MS',
      'FORGELOOP_REAL_SELF_BLOCKED_GRACE_MS',
      'FORGELOOP_REAL_SELF_TURN_TIMEOUT_SECONDS',
      'FORGELOOP_REAL_SELF_MAX_TASK_ATTEMPTS',
      'FORGELOOP_REAL_SELF_MAX_FAILURE_ROUNDS',
    ],
  },
} satisfies Record<string, VerificationSuite>

export type VerificationTarget = keyof typeof VERIFICATION_TARGETS

export function isVerificationTarget(value: string): value is VerificationTarget {
  return Object.hasOwn(VERIFICATION_TARGETS, value)
}

export interface VerificationSettings {
  readonly env: Record<string, string>
  readonly modelHosts: readonly string[]
  readonly candidate?: string
  readonly modelPatch?: string
}

export function verificationSettings(
  target: VerificationTarget,
  shell: NodeJS.ProcessEnv,
): VerificationSettings {
  if (target === 'm0-loop-e2e' && shell.FORGELOOP_M0_REAL_ARTIFACT === '1') {
    throw new Error('M0 容器验收只使用合成数据，禁止读取生产记录和制品')
  }
  const suite: VerificationSuite = VERIFICATION_TARGETS[target]
  if (suite.hostPathOption && shell[suite.hostPathOption]?.trim()) {
    throw new Error(`Docker 验收拒绝宿主路径覆盖 ${suite.hostPathOption}`)
  }
  const env: Record<string, string> = {}
  const modelHosts: string[] = []
  const candidate = suite.candidate ? shell.FORGELOOP_CANDIDATE_TARBALL?.trim() : undefined
  const modelPatch = suite.model === 'either' ? shell.FORGELOOP_TEST_MODEL_PATCH?.trim() : undefined
  if (suite.enable) env[suite.enable] = '1'
  for (const name of suite.options ?? []) {
    const value = shell[name]
    if (value !== undefined) env[name] = value
  }
  if (suite.model !== 'none') {
    const deepseek = shell.FORGELOOP_TEST_DEEPSEEK_API_KEY?.trim()
    const qwen =
      suite.model === 'either' ? shell.FORGELOOP_TEST_QWEN_TOKEN_PLAN_CN_API_KEY?.trim() : undefined
    if (!deepseek && !qwen) {
      throw new Error(
        '真实模型验收需要 FORGELOOP_TEST_DEEPSEEK_API_KEY 或本场景支持的专用 Qwen 测试凭据',
      )
    }
    if (!deepseek && !modelPatch && target !== 'real-model-e2e') {
      throw new Error('此场景使用 Qwen 测试凭据时需要 FORGELOOP_TEST_MODEL_PATCH')
    }
    if (deepseek) {
      env.DEEPSEEK_API_KEY = deepseek
      modelHosts.push('api.deepseek.com')
    }
    if (qwen) {
      env.QWEN_TOKEN_PLAN_CN_API_KEY = qwen
      modelHosts.push(...QWEN_TOKEN_PLAN_CN_HOSTS)
    }
  }
  return {
    env,
    modelHosts,
    ...(candidate ? { candidate } : {}),
    ...(modelPatch ? { modelPatch } : {}),
  }
}

export function assertLocalDockerHost(endpoint: string): void {
  if (!/^unix:\/\/\/[^\s]+$/.test(endpoint) && !/^npipe:\/\/\/\/\.\/pipe\/[^\s]+$/.test(endpoint)) {
    throw new Error('验证需要本地 Docker 引擎（unix socket 或本机 named pipe）')
  }
}

export function requireVerificationContainer(): void {
  if (
    process.platform !== 'linux' ||
    process.getuid?.() === 0 ||
    process.env.FORGELOOP_VERIFICATION_CONTAINER !== '1' ||
    !existsSync('/.dockerenv')
  ) {
    throw new Error(
      '真实环境验收只能在 ForgeLoop Docker 验证容器内执行，请使用 make 或 make.cmd 的验收入口',
    )
  }
}

export function verificationCandidate(root: string): { path: string; sha256: string } {
  const input = process.env.FORGELOOP_CANDIDATE_TARBALL?.trim()
  const dist = join(root, 'packages', 'forgeloop', 'dist')
  const packed = existsSync(dist)
    ? readdirSync(dist)
        .filter((name) => /^forgeloop-dsh-.*\.tgz$/.test(name))
        .sort()
        .at(-1)
    : undefined
  const path = input ? resolve(root, input) : packed ? join(dist, packed) : ''
  if (!path || !existsSync(path)) throw new Error('容器内没有可验证的候选 tarball')
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex')
  const expected = process.env.FORGELOOP_CANDIDATE_SHA256
  if (expected && expected !== sha256) throw new Error('容器内候选 tarball 摘要与本轮输入不一致')
  return { path, sha256 }
}
