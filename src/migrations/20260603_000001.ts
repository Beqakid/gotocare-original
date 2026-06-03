import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-d1-sqlite'

async function tryRun(db: any, statement: any) {
  try {
    await db.run(statement)
  } catch (_) {}
}

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await tryRun(db, sql`ALTER TABLE \`caregiver_bookings\` ADD COLUMN \`caregiver_hidden\` integer DEFAULT 0;`)
  await tryRun(db, sql`ALTER TABLE \`caregiver_bookings\` ADD COLUMN \`caregiver_hidden_at\` text;`)
  await tryRun(db, sql`ALTER TABLE \`caregiver_bookings\` ADD COLUMN \`caregiver_hidden_reason\` text;`)
  await tryRun(db, sql`ALTER TABLE \`hire_agreements\` ADD COLUMN \`caregiver_hidden\` integer DEFAULT 0;`)
  await tryRun(db, sql`ALTER TABLE \`hire_agreements\` ADD COLUMN \`caregiver_hidden_at\` text;`)
  await tryRun(db, sql`ALTER TABLE \`hire_agreements\` ADD COLUMN \`caregiver_hidden_reason\` text;`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await tryRun(db, sql`UPDATE \`caregiver_bookings\` SET \`caregiver_hidden\` = 0, \`caregiver_hidden_at\` = NULL, \`caregiver_hidden_reason\` = NULL;`)
  await tryRun(db, sql`UPDATE \`hire_agreements\` SET \`caregiver_hidden\` = 0, \`caregiver_hidden_at\` = NULL, \`caregiver_hidden_reason\` = NULL;`)
}
