import { sql } from '@payloadcms/db-d1-sqlite'
import type { MigrateUpArgs, MigrateDownArgs } from '@payloadcms/db-d1-sqlite'

async function tryRun(db: any, statement: any) {
  try { await db.run(statement) } catch (_) {}
}

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await tryRun(db, sql`ALTER TABLE \`caregiver_bookings\` ADD COLUMN \`client_hidden\` integer DEFAULT 0;`)
  await tryRun(db, sql`ALTER TABLE \`caregiver_bookings\` ADD COLUMN \`client_hidden_at\` text;`)
  await tryRun(db, sql`ALTER TABLE \`caregiver_bookings\` ADD COLUMN \`client_hidden_reason\` text;`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await tryRun(db, sql`UPDATE \`caregiver_bookings\` SET \`client_hidden\` = 0, \`client_hidden_at\` = NULL, \`client_hidden_reason\` = NULL;`)
}
