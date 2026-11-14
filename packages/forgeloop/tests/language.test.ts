import { describe, expect, it } from 'vitest'
import { parseTaskPlanDraft } from '../src/domain/task-plan.js'
import { outsideActiveSource, unknownPackages } from '../src/domain/language.js'
import type { TaskPlan } from '../src/domain/task-plan.js'

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

describe('active project scope', () => {
  it('accepts a plan whose files stay inside the active project', () => {
    const candidate = plan(
      ['npm', 'run', 'check', '--workspace', 'forgeloop-dsh'],
      ['packages/forgeloop/src/index.ts'],
    )
    expect(outsideActiveSource(candidate)).toEqual([])
  })

  it('accepts any language or file extension inside the active project', () => {
    // 目标项目自己决定用什么语言；程序不再按扩展名禁止文件。
    const candidate = plan(['python3', '-m', 'pytest'], ['packages/forgeloop/src/app.py'])
    expect(outsideActiveSource(candidate)).toEqual([])
  })

  it('accepts a Python test command and a legacy-shaped path by scope alone', () => {
    const candidate = plan(
      ['.venv/bin/python', '-m', 'pytest', 'tests/test_app.py'],
      ['packages/forgeloop/src/app.py'],
    )
    expect(outsideActiveSource(candidate)).toEqual([])
  })

  it('rejects files outside the active project roots', () => {
    const candidate = plan(['npm', 'test'], ['unrelated/notes.txt'])
    expect(outsideActiveSource(candidate).length).toBeGreaterThan(0)
  })
})

describe('outsideActiveSource roots', () => {
  const plan = (file: string): TaskPlan =>
    ({
      tasks: [
        {
          taskId: 't1',
          title: 't1',
          files: [file],
          testCommand: ['node', '-e', 'process.exit(0)'],
        },
      ],
    }) as unknown as TaskPlan

  it('rejects files outside the built-in ForgeLoop roots by default', () => {
    expect(outsideActiveSource(plan('src/service.mjs'))).toHaveLength(1)
  })

  it('uses the target project roots when配置给出', () => {
    expect(outsideActiveSource(plan('src/service.mjs'), ['src/', 'test/'])).toEqual([])
    expect(outsideActiveSource(plan('packages/x.ts'), ['src/', 'test/'])).toHaveLength(1)
  })
})

describe('unknown packages', () => {
  const plan = (file: string): TaskPlan =>
    ({
      tasks: [{ taskId: 't1', title: 't1', files: [file], testCommand: ['npm', 'test'] }],
    }) as unknown as TaskPlan

  it('rejects a package that does not exist without naming a fixed plugin package', () => {
    const violations = unknownPackages(plan('packages/other/src/a.ts'), ['forgeloop'])
    expect(violations).toHaveLength(1)
    expect(violations[0]?.reason).not.toContain('packages/forgeloop')
  })

  it('accepts an existing package', () => {
    expect(unknownPackages(plan('packages/forgeloop/src/a.ts'), ['forgeloop'])).toEqual([])
  })
})
