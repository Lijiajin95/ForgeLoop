import { describe, expect, it } from 'vitest'
import { parseTaskPlanDraft } from '../src/domain/task-plan.js'
import { languageViolations, outsideActiveSource } from '../src/domain/language.js'

const context = {
  requirementId: 'req-1',
  project: 'forgeloop',
  planVersion: 1,
  requirementVersion: 1,
  now: 'now',
}

function plan(testCommand: string[], files: string[]) {
  return parseTaskPlanDraft(
    {
      tasks: [
        { task_id: 'a', goal: 'g', files, acceptance: 'a', test_command: testCommand },
        {
          task_id: 'b',
          goal: 'g',
          files: ['packages/forgeloop/src/index.ts'],
          acceptance: 'a',
          test_command: ['npm', 'test'],
          depends_on: ['a'],
        },
      ],
    },
    context,
  )
}

describe('TypeScript language boundary', () => {
  it('accepts a TypeScript-only plan', () => {
    const candidate = plan(['npm', 'run', 'check', '--workspace', 'forgeloop-dsh'], ['packages/forgeloop/src/index.ts'])
    expect(languageViolations(candidate)).toEqual([])
    expect(outsideActiveSource(candidate)).toEqual([])
  })

  it('rejects Python interpreters and the old virtualenv in test commands', () => {
    const candidate = plan(['.venv/bin/python', '-m', 'forgeloop'], ['packages/forgeloop/src/index.ts'])
    const violations = languageViolations(candidate)
    expect(violations.some((violation) => violation.field === 'test_command')).toBe(true)
  })

  it('rejects the legacy forgeloop CLI as a test command', () => {
    const candidate = plan(['forgeloop', 'requirement', 'status'], ['packages/forgeloop/src/index.ts'])
    expect(languageViolations(candidate).some((violation) => /旧 forgeloop/.test(violation.reason))).toBe(true)
  })

  it('rejects retired Python/frontend paths in the file list', () => {
    const candidate = plan(['npm', 'test'], ['src/forgeloop/domain/requirement.py'])
    expect(languageViolations(candidate).some((violation) => violation.field === 'files')).toBe(true)
  })

  it('rejects files outside the active TypeScript project', () => {
    const candidate = plan(['npm', 'test'], ['unrelated/notes.txt'])
    expect(outsideActiveSource(candidate).length).toBeGreaterThan(0)
  })
})
