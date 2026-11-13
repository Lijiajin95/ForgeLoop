/**
 * 所有者回答回写需求库：回答原文是授权，直接生成 confirmed 决策条目。
 * 只处理能对上分析缺口（topic）的答案；没有 topic 或主题已被 confirmed 覆盖时跳过。
 */

import { LIBRARY_DOC_DIR, parseLibraryReview, type LibraryGap } from '../domain/library.js'
import { writeProjectDoc } from './project-docs.js'

export interface AnswerDecisionInput {
  readonly projectPath: string
  readonly reqId: string
  readonly now: string
  readonly answers: ReadonlyArray<{
    readonly questionId: string
    readonly question: string
    readonly answer: string
  }>
  readonly gaps: readonly LibraryGap[]
  readonly existing: ReadonlyArray<{
    readonly id: string
    readonly status: string
    readonly topics: readonly string[]
  }>
}

export interface AnswerDecisionResult {
  readonly written: readonly string[]
  readonly skipped: readonly string[]
}

/** 从最近一次分析尝试的 library_review 里取出缺口；损坏时返回空数组。 */
export function gapsFromReviewText(text: string): readonly LibraryGap[] {
  if (!text.trim()) return []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return []
  }
  try {
    return parseLibraryReview(raw)?.gaps ?? []
  } catch {
    return []
  }
}

function normalizeTopic(value: string): string {
  return value.trim().toLowerCase()
}

function decisionId(reqId: string, questionId: string): string {
  return `decision.${reqId}.${questionId}`.toLowerCase().replace(/[^a-z0-9._-]/g, '-')
}

function oneLine(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed
}

function headerOf(input: {
  id: string
  question: string
  topic: string
  answer: string
  reqId: string
  questionId: string
  updatedAt: string
}): string {
  return JSON.stringify(
    {
      id: input.id,
      title: `决策：${oneLine(input.question, 80)}`,
      status: 'confirmed',
      topics: [input.topic],
      summary: oneLine(input.answer, 200),
      source: `owner-answer:${input.reqId}#${input.questionId}`,
      updatedAt: input.updatedAt,
    },
    null,
    2,
  )
}

/** 写入一条决策条目；返回项目内相对路径。 */
export function writeAnswerDecision(input: {
  projectPath: string
  reqId: string
  now: string
  questionId: string
  question: string
  answer: string
  topic: string
}): string {
  const id = decisionId(input.reqId, input.questionId)
  const path = `${LIBRARY_DOC_DIR}/decisions/${id}.md`
  const body = [
    `# 决策：${oneLine(input.question, 80)}`,
    '',
    `- 问题：${input.question}`,
    `- 来源：owner-answer:${input.reqId}#${input.questionId}`,
    '',
    '所有者回答（原文）：',
    '',
    ...input.answer.split(/\r?\n/).map((line) => `> ${line}`),
    '',
  ].join('\n')
  const content = `<!-- library\n${headerOf({
    id,
    question: input.question,
    topic: input.topic,
    answer: input.answer,
    reqId: input.reqId,
    questionId: input.questionId,
    updatedAt: input.now.slice(0, 10),
  })}\n-->\n\n${body}\n`
  const written = writeProjectDoc(input.projectPath, path, content)
  if (!written.ok) throw new Error(`决策条目写入失败：${written.reason}`)
  return path
}

/** 逐条回写可归因的回答；写入失败时抛错，由调用方决定告警或降级。 */
export function writeAnswerDecisions(input: AnswerDecisionInput): AnswerDecisionResult {
  const confirmed = new Set<string>()
  for (const entry of input.existing) {
    if (entry.status !== 'confirmed') continue
    for (const topic of entry.topics) confirmed.add(normalizeTopic(topic))
  }
  const written: string[] = []
  const skipped: string[] = []
  for (const answer of input.answers) {
    const gap = input.gaps.find((item) => item.question === answer.question)
    if (!gap) {
      skipped.push(`${answer.questionId}：没有对应的库缺口`)
      continue
    }
    const key = normalizeTopic(gap.topic)
    if (confirmed.has(key)) {
      skipped.push(`${answer.questionId}：主题 ${gap.topic} 已有 confirmed 结论`)
      continue
    }
    writeAnswerDecision({
      projectPath: input.projectPath,
      reqId: input.reqId,
      now: input.now,
      questionId: answer.questionId,
      question: answer.question,
      answer: answer.answer,
      topic: gap.topic,
    })
    confirmed.add(key)
    written.push(answer.questionId)
  }
  return { written, skipped }
}
