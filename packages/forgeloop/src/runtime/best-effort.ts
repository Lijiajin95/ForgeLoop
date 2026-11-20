export function bestEffort(operation: () => void): void {
  try {
    operation()
  } catch {
    return
  }
}

export function bestEffortValue<T>(operation: () => T, fallback: T): T {
  try {
    return operation()
  } catch {
    return fallback
  }
}

export async function bestEffortAsync(operation: () => Promise<void>): Promise<void> {
  try {
    await operation()
  } catch {
    return
  }
}
