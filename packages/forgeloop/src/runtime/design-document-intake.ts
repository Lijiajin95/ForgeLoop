import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import type { ForgeLoopConfig } from '../config.js'
import {
  designDocumentSnapshot,
  type DesignDocumentSnapshot,
  type DocumentIntakeOutcome,
} from '../domain/design-document.js'
import type { Requirement } from '../domain/requirement.js'
import { isTerminal } from '../domain/status.js'
import type { Repository } from '../records/repository.js'
import { recordRevisionInvalidation } from './analysis-lifecycle.js'
import { MAX_DOC_READ_BYTES, resolveProjectDoc } from './project-docs.js'
import { fail, ok, type OperationResult } from './operation-result.js'

export interface DesignDocumentRuntime {
  readonly config: ForgeLoopConfig
  readonly repo: Repository
  readonly analysisQueue: {
    accepted(
      requirement: Requirement,
      input: { created: boolean; source: string; analyze: boolean },
    ): string
  }
  requirementView(requirement: Requirement): unknown
}

export interface DesignDocumentIntakeRequest {
  readonly path: string
  readonly by: string
  readonly source: string
  readonly clientKey?: string | undefined
  readonly analyze?: boolean | undefined
}

type DocumentRead =
  | { readonly ok: true; readonly path: string; readonly text: string }
  | { readonly ok: false; readonly code: string; readonly message: string }

function readDesignDocument(projectPath: string, reference: string): DocumentRead {
  const target = resolveProjectDoc(projectPath, reference)
  if (!target.ok) {
    return { ok: false, code: 'document_invalid', message: `设计文档不可用：${target.reason}` }
  }
  try {
    const info = statSync(target.path)
    if (info.size > MAX_DOC_READ_BYTES) {
      return {
        ok: false,
        code: 'document_too_large',
        message: `设计文档超过 ${MAX_DOC_READ_BYTES} 字节上限，请拆分后再提交：${target.relative}`,
      }
    }
    const text = readFileSync(target.path, 'utf8')
    if (!text.trim()) {
      return {
        ok: false,
        code: 'document_invalid',
        message: `设计文档没有可受理的正文：${target.relative}`,
      }
    }
    return { ok: true, path: target.relative, text }
  } catch {
    return {
      ok: false,
      code: 'document_not_found',
      message: `设计文档不存在或不可读：${target.relative}`,
    }
  }
}

function reqIdOf(now: string): string {
  return `req-${now.replace(/[-:TZ.]/g, '').slice(0, 14)}-${randomUUID().slice(0, 6)}`
}

export class DesignDocumentIntake {
  constructor(
    private readonly runtime: DesignDocumentRuntime,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  intake(input: DesignDocumentIntakeRequest): OperationResult {
    const reference = input.path.trim()
    if (!reference) {
      return fail(
        'document_invalid',
        '文档入口必须给出项目内 Markdown 路径，例如“文档：docs/product/feature.md”',
      )
    }
    const read = readDesignDocument(this.runtime.config.projectPath, reference)
    if (!read.ok) return fail(read.code, read.message)

    const document = designDocumentSnapshot(read.text, { kind: 'project-doc', path: read.path })
    const bound = this.runtime.repo.latestDocumentByPath(this.runtime.config.project, read.path)
    if (bound && bound.sha256 === document.sha256) {
      const requirement = this.runtime.repo.getRequirement(bound.reqId)
      if (requirement) {
        return ok(
          `设计文档 ${read.path} 已受理为需求 ${requirement.reqId}（版本 ${bound.requirementVersion}），未重复创建`,
          {
            reqId: requirement.reqId,
            requirementVersion: bound.requirementVersion,
            outcome: 'duplicate',
            document,
            requirement: this.runtime.requirementView(requirement),
          },
        )
      }
    }

    const previous = bound ? this.runtime.repo.getRequirement(bound.reqId) : null
    if (previous && !isTerminal(previous.status)) {
      return this.reviseFromDocument({
        requirement: previous,
        text: read.text,
        path: read.path,
        by: input.by,
        source: input.source,
        analyze: input.analyze ?? true,
        document,
      })
    }
    return this.create({
      text: read.text,
      path: read.path,
      by: input.by,
      source: input.source,
      clientKey: input.clientKey,
      analyze: input.analyze ?? true,
      outcome: previous ? 'recreated' : 'created',
      replaced: previous?.reqId ?? '',
      document,
    })
  }

  private reviseFromDocument(input: {
    requirement: Requirement
    text: string
    path: string
    by: string
    source: string
    analyze: boolean
    document: DesignDocumentSnapshot
  }): OperationResult {
    const now = this.clock()
    const updated = this.runtime.repo.appendVersion({
      reqId: input.requirement.reqId,
      text: input.text,
      revisedBy: input.by,
      source: input.source,
      now,
      document: { kind: 'project-doc', path: input.path },
    })
    recordRevisionInvalidation({
      repository: this.runtime.repo,
      reqId: input.requirement.reqId,
      invalidated: this.runtime.repo.latestAnalysis(input.requirement.reqId),
      toRequirementVersion: updated.versions.length,
      now,
    })
    this.runtime.repo.dismissPendingFor(
      input.requirement.reqId,
      '需求修订：旧请求所依据的版本已过期',
      now,
    )
    const handoff = this.runtime.analysisQueue.accepted(updated, {
      created: true,
      source: input.source,
      analyze: input.analyze,
    })
    const message =
      `已按设计文档 ${input.path} 修订需求 ${input.requirement.reqId}（版本 ${updated.versions.length}）；` +
      '旧版本、旧快照与既有证据保留，后续按新版本重新分析' +
      (handoff ? `；${handoff.replace(/^；/, '')}` : '')
    return ok(message, {
      reqId: input.requirement.reqId,
      requirementVersion: updated.versions.length,
      outcome: 'revised',
      document: input.document,
      requirement: this.runtime.requirementView(updated),
    })
  }

  private create(input: {
    text: string
    path: string
    by: string
    source: string
    clientKey?: string | undefined
    analyze: boolean
    outcome: DocumentIntakeOutcome
    replaced: string
    document: DesignDocumentSnapshot
  }): OperationResult {
    const now = this.clock()
    const reqId = reqIdOf(now)
    const { requirement, created } = this.runtime.repo.submit({
      reqId,
      project: this.runtime.config.project,
      text: input.text,
      submittedBy: input.by,
      source: input.source,
      clientKey: input.clientKey ?? '',
      now,
      document: { kind: 'project-doc', path: input.path },
    })
    const handoff = this.runtime.analysisQueue.accepted(requirement, {
      created,
      source: input.source,
      analyze: input.analyze,
    })
    const prefix = input.replaced
      ? `原需求 ${input.replaced} 已终态；修订后的设计文档按新需求受理为`
      : '已受理设计文档为需求'
    const message = `${prefix} ${requirement.reqId}（版本 1）${handoff.replace(/^；/, '；')}`
    return ok(message, {
      reqId: requirement.reqId,
      requirementVersion: 1,
      outcome: input.outcome,
      document: input.document,
      requirement: this.runtime.requirementView(requirement),
    })
  }
}

export function designDocumentIntakeOf(
  runtime: DesignDocumentRuntime,
  clock?: () => string,
): DesignDocumentIntake {
  return new DesignDocumentIntake(runtime, clock)
}
