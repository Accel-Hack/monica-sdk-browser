/** getItem / setItem だけの Storage。client が使うのはこの 2 つ */
export function memoryStorage(entries: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(entries));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  } as Storage;
}

/**
 * 稼働確認が当面 due にならない storage。稼働確認を見ないテストの fetch に
 * ページ読み込み時の client_report が混ざらないようにする
 */
export function presenceNotDue(): Storage {
  return memoryStorage({
    "monica.presence": JSON.stringify({ intervalStartedAt: 0, intervalMs: Number.MAX_SAFE_INTEGER }),
  });
}
