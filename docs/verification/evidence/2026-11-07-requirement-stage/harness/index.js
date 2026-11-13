import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const name = 'fl-scen-harness'
export const inject = ['agents', 'agentLoop', 'tools']

export function apply(ctx) {
  const scriptPath = process.env.FL_SCENARIO_SCRIPT
  const outPath = process.env.FL_SCENARIO_OUTPUT
  if (!scriptPath || !outPath) return
  const keepAlive = setInterval(() => {}, 1000)
  const finish = (payload) => {
    try {
      mkdirSync(dirname(outPath), { recursive: true })
      writeFileSync(outPath, JSON.stringify(payload, null, 2))
    } catch (error) {
      console.error('[fl-scen] write failed', error)
    }
    clearInterval(keepAlive)
    setTimeout(() => process.exit(payload.ok ? 0 : 1), 200)
  }
  queueMicrotask(async () => {
    const result = { ok: false, steps: [], model: null, error: null }
    try {
      const runtimeUrl = process.env.FL_RUNTIME_URL
      const configUrl = process.env.FL_CONFIG_URL
      const { ForgeLoopRuntime } = await import(runtimeUrl)
      const { resolveConfig } = await import(configUrl)
      const raw = JSON.parse(readFileSync(scriptPath, 'utf8'))
      const config = resolveConfig(raw.config, raw.config.projectPath)
      const runtime = new ForgeLoopRuntime({ ctx, config })
      let lastReq = ''
      result.model = `${config.agent.provider}/${config.agent.model}`
      for (const step of raw.steps) {
        const stepResult = { name: step.name, call: step.call, ok: false, code: '', message: '', data: null }
        const reqId = step.reqId === '$req' ? lastReq : step.reqId
        try {
          if (step.call === 'submit') {
            const outcome = runtime.submit({ text: step.text, by: raw.owner ?? 'owner', source: step.source ?? 'verification:real-model', analyze: false })
            stepResult.ok = outcome.ok
            stepResult.code = outcome.code
            stepResult.message = outcome.message
            stepResult.data = outcome.data
            lastReq = outcome.data?.reqId ?? lastReq
          } else if (step.call === 'analyze') {
            const outcome = await runtime.analyzeRequirement(reqId)
            stepResult.ok = outcome.ok
            stepResult.code = outcome.code
            stepResult.message = outcome.message
            stepResult.data = outcome.analysis ?? null
          } else if (step.call === 'open') {
            const open = runtime.openClarifications(reqId)
            stepResult.ok = true
            stepResult.data = open.map((q) => ({ questionId: q.questionId, text: q.text, analysisVersion: q.analysisVersion }))
          } else if (step.call === 'answer') {
            const open = step.all === true ? runtime.openClarifications(reqId) : null
            if (open && open.length === 0 && step.optional === true) {
              stepResult.ok = true
              stepResult.message = 'no open questions; skipped'
              result.steps.push(stepResult)
              continue
            }
            const outcome = await runtime.answerClarifications({
              reqId,
              answer: step.text,
              by: raw.owner ?? 'owner',
              source: step.source ?? 'verification:real-model',
              questionIds: open ? open.map((q) => q.questionId) : step.questionIds,
            })
            stepResult.ok = outcome.ok
            stepResult.code = outcome.code
            stepResult.message = outcome.message
            stepResult.data = { requirementVersion: outcome.requirementVersion, answeredQuestionIds: outcome.answeredQuestionIds, analysis: outcome.analysis }
          } else if (step.call === 'revise') {
            const outcome = runtime.revise({ reqId, text: step.text, by: raw.owner ?? 'owner', source: 'verification:real-model' })
            stepResult.ok = outcome.ok
            stepResult.code = outcome.code
            stepResult.message = outcome.message
          } else if (step.call === 'detail') {
            const outcome = runtime.requirementDetail(reqId)
            stepResult.ok = outcome.ok
            stepResult.data = outcome.data
          } else if (step.call === 'wait') {
            await new Promise((done) => setTimeout(done, step.ms ?? 1000))
            stepResult.ok = true
          }
        } catch (error) {
          stepResult.message = error instanceof Error ? error.message : String(error)
        }
        result.steps.push(stepResult)
      }
      result.ok = result.steps.every((step) => step.ok)
    } catch (error) {
      result.error = error instanceof Error ? error.stack ?? error.message : String(error)
    }
    finish(result)
  })
}
