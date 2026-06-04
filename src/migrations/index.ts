import * as migration_20250929_111647 from './20250929_111647'
import * as migration_20260423_233127 from './20260423_233127'
import * as migration_20260603_000001 from './20260603_000001'
import * as migration_20260603_000002 from './20260603_000002'

export const migrations = [
  {
    up: migration_20250929_111647.up,
    down: migration_20250929_111647.down,
    name: '20250929_111647',
  },
  {
    up: migration_20260423_233127.up,
    down: migration_20260423_233127.down,
    name: '20260423_233127',
  },
  {
    up: migration_20260603_000001.up,
    down: migration_20260603_000001.down,
    name: '20260603_000001',
  },
  {
    up: migration_20260603_000002.up,
    down: migration_20260603_000002.down,
    name: '20260603_000002',
  },
]
