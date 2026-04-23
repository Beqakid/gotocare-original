import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-d1-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`CREATE TABLE \`agencies\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`name\` text NOT NULL,
  	\`slug\` text NOT NULL,
  	\`owner_email\` text NOT NULL,
  	\`phone\` text,
  	\`address_street\` text,
  	\`address_city\` text,
  	\`address_state\` text,
  	\`address_zip\` text,
  	\`website\` text,
  	\`license_number\` text,
  	\`plan\` text DEFAULT 'starter',
  	\`status\` text DEFAULT 'active' NOT NULL,
  	\`trial_ends_at\` text,
  	\`max_caregivers\` numeric DEFAULT 10,
  	\`notes\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX \`agencies_slug_idx\` ON \`agencies\` (\`slug\`);`)
  await db.run(sql`CREATE INDEX \`agencies_updated_at_idx\` ON \`agencies\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`agencies_created_at_idx\` ON \`agencies\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`locations\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`agency_id\` integer NOT NULL,
  	\`name\` text NOT NULL,
  	\`slug\` text NOT NULL,
  	\`address_street\` text,
  	\`address_city\` text NOT NULL,
  	\`address_state\` text NOT NULL,
  	\`address_zip\` text,
  	\`phone\` text,
  	\`email\` text,
  	\`license_number\` text,
  	\`license_expiry\` text,
  	\`service_radius\` numeric,
  	\`manager_id\` integer,
  	\`status\` text DEFAULT 'active' NOT NULL,
  	\`notes\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`agency_id\`) REFERENCES \`agencies\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`manager_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE INDEX \`locations_agency_idx\` ON \`locations\` (\`agency_id\`);`)
  await db.run(sql`CREATE INDEX \`locations_manager_idx\` ON \`locations\` (\`manager_id\`);`)
  await db.run(sql`CREATE INDEX \`locations_updated_at_idx\` ON \`locations\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`locations_created_at_idx\` ON \`locations\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`clients\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`agency_id\` integer,
  	\`location_id\` integer,
  	\`first_name\` text NOT NULL,
  	\`last_name\` text NOT NULL,
  	\`email\` text,
  	\`phone\` text,
  	\`address_street\` text,
  	\`address_city\` text,
  	\`address_state\` text,
  	\`address_zip\` text,
  	\`date_of_birth\` text,
  	\`emergency_contact_name\` text,
  	\`emergency_contact_phone\` text,
  	\`emergency_contact_relationship\` text,
  	\`care_needs\` text,
  	\`preferred_schedule\` text,
  	\`insurance_provider\` text,
  	\`insurance_policy_number\` text,
  	\`lead_source\` text,
  	\`status\` text DEFAULT 'pending' NOT NULL,
  	\`notes\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`agency_id\`) REFERENCES \`agencies\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`location_id\`) REFERENCES \`locations\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE INDEX \`clients_agency_idx\` ON \`clients\` (\`agency_id\`);`)
  await db.run(sql`CREATE INDEX \`clients_location_idx\` ON \`clients\` (\`location_id\`);`)
  await db.run(sql`CREATE INDEX \`clients_updated_at_idx\` ON \`clients\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`clients_created_at_idx\` ON \`clients\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`caregivers\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`agency_id\` integer,
  	\`location_id\` integer,
  	\`linked_user_id\` integer,
  	\`first_name\` text NOT NULL,
  	\`last_name\` text NOT NULL,
  	\`email\` text NOT NULL,
  	\`phone\` text,
  	\`address_street\` text,
  	\`address_city\` text,
  	\`address_state\` text,
  	\`address_zip\` text,
  	\`certifications\` text,
  	\`hourly_rate\` numeric,
  	\`experience_years\` numeric,
  	\`languages\` text,
  	\`availability\` text,
  	\`status\` text DEFAULT 'pending' NOT NULL,
  	\`hire_date\` text,
  	\`specialties\` text,
  	\`notes\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`agency_id\`) REFERENCES \`agencies\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`location_id\`) REFERENCES \`locations\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`linked_user_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE INDEX \`caregivers_agency_idx\` ON \`caregivers\` (\`agency_id\`);`)
  await db.run(sql`CREATE INDEX \`caregivers_location_idx\` ON \`caregivers\` (\`location_id\`);`)
  await db.run(sql`CREATE INDEX \`caregivers_linked_user_idx\` ON \`caregivers\` (\`linked_user_id\`);`)
  await db.run(sql`CREATE INDEX \`caregivers_updated_at_idx\` ON \`caregivers\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`caregivers_created_at_idx\` ON \`caregivers\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`services\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`agency_id\` integer,
  	\`name\` text NOT NULL,
  	\`description\` text,
  	\`default_rate\` numeric,
  	\`category\` text NOT NULL,
  	\`status\` text DEFAULT 'active' NOT NULL,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`agency_id\`) REFERENCES \`agencies\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE INDEX \`services_agency_idx\` ON \`services\` (\`agency_id\`);`)
  await db.run(sql`CREATE INDEX \`services_updated_at_idx\` ON \`services\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`services_created_at_idx\` ON \`services\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`shifts\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`agency_id\` integer,
  	\`location_id\` integer,
  	\`client_id\` integer NOT NULL,
  	\`caregiver_id\` integer NOT NULL,
  	\`date\` text NOT NULL,
  	\`start_time\` text NOT NULL,
  	\`end_time\` text NOT NULL,
  	\`total_hours\` numeric,
  	\`status\` text DEFAULT 'scheduled' NOT NULL,
  	\`priority\` text DEFAULT 'normal',
  	\`recurring_group_id\` text,
  	\`notes\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`agency_id\`) REFERENCES \`agencies\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`location_id\`) REFERENCES \`locations\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`client_id\`) REFERENCES \`clients\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`caregiver_id\`) REFERENCES \`caregivers\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE INDEX \`shifts_agency_idx\` ON \`shifts\` (\`agency_id\`);`)
  await db.run(sql`CREATE INDEX \`shifts_location_idx\` ON \`shifts\` (\`location_id\`);`)
  await db.run(sql`CREATE INDEX \`shifts_client_idx\` ON \`shifts\` (\`client_id\`);`)
  await db.run(sql`CREATE INDEX \`shifts_caregiver_idx\` ON \`shifts\` (\`caregiver_id\`);`)
  await db.run(sql`CREATE INDEX \`shifts_updated_at_idx\` ON \`shifts\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`shifts_created_at_idx\` ON \`shifts\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`timesheets\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`agency_id\` integer,
  	\`shift_id\` integer,
  	\`caregiver_id\` integer NOT NULL,
  	\`client_id\` integer,
  	\`date\` text NOT NULL,
  	\`clock_in\` text NOT NULL,
  	\`clock_out\` text,
  	\`hours_worked\` numeric,
  	\`hourly_rate\` numeric,
  	\`total_pay\` numeric,
  	\`status\` text DEFAULT 'clocked_in' NOT NULL,
  	\`approved_by\` text,
  	\`notes\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`agency_id\`) REFERENCES \`agencies\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`shift_id\`) REFERENCES \`shifts\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`caregiver_id\`) REFERENCES \`caregivers\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`client_id\`) REFERENCES \`clients\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE INDEX \`timesheets_agency_idx\` ON \`timesheets\` (\`agency_id\`);`)
  await db.run(sql`CREATE INDEX \`timesheets_shift_idx\` ON \`timesheets\` (\`shift_id\`);`)
  await db.run(sql`CREATE INDEX \`timesheets_caregiver_idx\` ON \`timesheets\` (\`caregiver_id\`);`)
  await db.run(sql`CREATE INDEX \`timesheets_client_idx\` ON \`timesheets\` (\`client_id\`);`)
  await db.run(sql`CREATE INDEX \`timesheets_updated_at_idx\` ON \`timesheets\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`timesheets_created_at_idx\` ON \`timesheets\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`invoices\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`agency_id\` integer,
  	\`client_id\` integer NOT NULL,
  	\`caregiver_id\` integer,
  	\`invoice_number\` text NOT NULL,
  	\`period_start\` text,
  	\`period_end\` text,
  	\`total_hours\` numeric,
  	\`hourly_rate\` numeric,
  	\`amount\` numeric NOT NULL,
  	\`tax\` numeric DEFAULT 0,
  	\`total_amount\` numeric,
  	\`status\` text DEFAULT 'draft' NOT NULL,
  	\`issued_date\` text,
  	\`due_date\` text,
  	\`paid_date\` text,
  	\`payment_method\` text,
  	\`notes\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`agency_id\`) REFERENCES \`agencies\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`client_id\`) REFERENCES \`clients\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`caregiver_id\`) REFERENCES \`caregivers\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE INDEX \`invoices_agency_idx\` ON \`invoices\` (\`agency_id\`);`)
  await db.run(sql`CREATE INDEX \`invoices_client_idx\` ON \`invoices\` (\`client_id\`);`)
  await db.run(sql`CREATE INDEX \`invoices_caregiver_idx\` ON \`invoices\` (\`caregiver_id\`);`)
  await db.run(sql`CREATE UNIQUE INDEX \`invoices_invoice_number_idx\` ON \`invoices\` (\`invoice_number\`);`)
  await db.run(sql`CREATE INDEX \`invoices_updated_at_idx\` ON \`invoices\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`invoices_created_at_idx\` ON \`invoices\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`leads\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`agency_id\` integer,
  	\`location_id\` integer,
  	\`first_name\` text NOT NULL,
  	\`last_name\` text NOT NULL,
  	\`email\` text NOT NULL,
  	\`phone\` text,
  	\`care_type\` text,
  	\`message\` text,
  	\`source\` text DEFAULT 'website',
  	\`status\` text DEFAULT 'new' NOT NULL,
  	\`assigned_to\` text,
  	\`follow_up_date\` text,
  	\`converted_client_id\` numeric,
  	\`company\` text,
  	\`notes\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`agency_id\`) REFERENCES \`agencies\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`location_id\`) REFERENCES \`locations\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE INDEX \`leads_agency_idx\` ON \`leads\` (\`agency_id\`);`)
  await db.run(sql`CREATE INDEX \`leads_location_idx\` ON \`leads\` (\`location_id\`);`)
  await db.run(sql`CREATE INDEX \`leads_updated_at_idx\` ON \`leads\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`leads_created_at_idx\` ON \`leads\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`payload_kv\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`key\` text NOT NULL,
  	\`data\` text NOT NULL
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX \`payload_kv_key_idx\` ON \`payload_kv\` (\`key\`);`)
  await db.run(sql`ALTER TABLE \`users\` ADD \`name\` text;`)
  await db.run(sql`ALTER TABLE \`users\` ADD \`phone\` text;`)
  await db.run(sql`ALTER TABLE \`users\` ADD \`role\` text DEFAULT 'agency_owner' NOT NULL;`)
  await db.run(sql`ALTER TABLE \`users\` ADD \`agency_id\` integer REFERENCES agencies(id);`)
  await db.run(sql`CREATE INDEX \`users_agency_idx\` ON \`users\` (\`agency_id\`);`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`agencies_id\` integer REFERENCES agencies(id);`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`locations_id\` integer REFERENCES locations(id);`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`clients_id\` integer REFERENCES clients(id);`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`caregivers_id\` integer REFERENCES caregivers(id);`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`services_id\` integer REFERENCES services(id);`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`shifts_id\` integer REFERENCES shifts(id);`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`timesheets_id\` integer REFERENCES timesheets(id);`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`invoices_id\` integer REFERENCES invoices(id);`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`leads_id\` integer REFERENCES leads(id);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_agencies_id_idx\` ON \`payload_locked_documents_rels\` (\`agencies_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_locations_id_idx\` ON \`payload_locked_documents_rels\` (\`locations_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_clients_id_idx\` ON \`payload_locked_documents_rels\` (\`clients_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_caregivers_id_idx\` ON \`payload_locked_documents_rels\` (\`caregivers_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_services_id_idx\` ON \`payload_locked_documents_rels\` (\`services_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_shifts_id_idx\` ON \`payload_locked_documents_rels\` (\`shifts_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_timesheets_id_idx\` ON \`payload_locked_documents_rels\` (\`timesheets_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_invoices_id_idx\` ON \`payload_locked_documents_rels\` (\`invoices_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_leads_id_idx\` ON \`payload_locked_documents_rels\` (\`leads_id\`);`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP TABLE \`agencies\`;`)
  await db.run(sql`DROP TABLE \`locations\`;`)
  await db.run(sql`DROP TABLE \`clients\`;`)
  await db.run(sql`DROP TABLE \`caregivers\`;`)
  await db.run(sql`DROP TABLE \`services\`;`)
  await db.run(sql`DROP TABLE \`shifts\`;`)
  await db.run(sql`DROP TABLE \`timesheets\`;`)
  await db.run(sql`DROP TABLE \`invoices\`;`)
  await db.run(sql`DROP TABLE \`leads\`;`)
  await db.run(sql`DROP TABLE \`payload_kv\`;`)
  await db.run(sql`PRAGMA foreign_keys=OFF;`)
  await db.run(sql`CREATE TABLE \`__new_users\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`email\` text NOT NULL,
  	\`reset_password_token\` text,
  	\`reset_password_expiration\` text,
  	\`salt\` text,
  	\`hash\` text,
  	\`login_attempts\` numeric DEFAULT 0,
  	\`lock_until\` text
  );
  `)
  await db.run(sql`INSERT INTO \`__new_users\`("id", "updated_at", "created_at", "email", "reset_password_token", "reset_password_expiration", "salt", "hash", "login_attempts", "lock_until") SELECT "id", "updated_at", "created_at", "email", "reset_password_token", "reset_password_expiration", "salt", "hash", "login_attempts", "lock_until" FROM \`users\`;`)
  await db.run(sql`DROP TABLE \`users\`;`)
  await db.run(sql`ALTER TABLE \`__new_users\` RENAME TO \`users\`;`)
  await db.run(sql`PRAGMA foreign_keys=ON;`)
  await db.run(sql`CREATE INDEX \`users_updated_at_idx\` ON \`users\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`users_created_at_idx\` ON \`users\` (\`created_at\`);`)
  await db.run(sql`CREATE UNIQUE INDEX \`users_email_idx\` ON \`users\` (\`email\`);`)
  await db.run(sql`CREATE TABLE \`__new_payload_locked_documents_rels\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`order\` integer,
  	\`parent_id\` integer NOT NULL,
  	\`path\` text NOT NULL,
  	\`users_id\` integer,
  	\`media_id\` integer,
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`payload_locked_documents\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`users_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`media_id\`) REFERENCES \`media\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`INSERT INTO \`__new_payload_locked_documents_rels\`("id", "order", "parent_id", "path", "users_id", "media_id") SELECT "id", "order", "parent_id", "path", "users_id", "media_id" FROM \`payload_locked_documents_rels\`;`)
  await db.run(sql`DROP TABLE \`payload_locked_documents_rels\`;`)
  await db.run(sql`ALTER TABLE \`__new_payload_locked_documents_rels\` RENAME TO \`payload_locked_documents_rels\`;`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_order_idx\` ON \`payload_locked_documents_rels\` (\`order\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_parent_idx\` ON \`payload_locked_documents_rels\` (\`parent_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_path_idx\` ON \`payload_locked_documents_rels\` (\`path\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_users_id_idx\` ON \`payload_locked_documents_rels\` (\`users_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_media_id_idx\` ON \`payload_locked_documents_rels\` (\`media_id\`);`)
}
