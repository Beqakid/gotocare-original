// @ts-nocheck
import fs from 'fs'
import path from 'path'
import { sqliteD1Adapter } from '@payloadcms/db-d1-sqlite'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { buildConfig } from 'payload'
import { fileURLToPath } from 'url'
import { CloudflareContext, getCloudflareContext } from '@opennextjs/cloudflare'
import { GetPlatformProxyOptions } from 'wrangler'
import { r2Storage } from '@payloadcms/storage-r2'

import { Users } from './collections/Users'
import { Media } from './collections/Media'
import { Clients } from './collections/Clients'
import { Caregivers } from './collections/Caregivers'
import { Services } from './collections/Services'
import { Shifts } from './collections/Shifts'
import { Timesheets } from './collections/Timesheets'
import { Invoices } from './collections/Invoices'
import { Leads } from './collections/Leads'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)
const realpath = (value: string) => (fs.existsSync(value) ? fs.realpathSync(value) : undefined)

const isCLI = process.argv.some((value) => realpath(value)?.endsWith(path.join('payload', 'bin.js')))
const isProduction = process.env.NODE_ENV === 'production'

// Cloudflare-compatible structured logger
const createLog =
  (level: string, fn: typeof console.log) => (objOrMsg: object | string, msg?: string) => {
    if (typeof objOrMsg === 'string') {
      fn(JSON.stringify({ level, msg: objOrMsg }))
    } else {
      fn(JSON.stringify({ level, ...objOrMsg, msg: msg ?? (objOrMsg as { msg?: string }).msg }))
    }
  }

const cloudflareLogger = {
  level: process.env.PAYLOAD_LOG_LEVEL || 'info',
  trace: createLog('trace', console.debug),
  debug: createLog('debug', console.debug),
  info: createLog('info', console.log),
  warn: createLog('warn', console.warn),
  error: createLog('error', console.error),
  fatal: createLog('fatal', console.error),
  silent: () => {},
} as any

const cloudflare =
  isCLI || !isProduction
    ? await getCloudflareContextFromWrangler()
    : await getCloudflareContext({ async: true })

export default buildConfig({
  admin: {
    user: Users.slug,
    importMap: {
      baseDir: path.resolve(dirname),
    },
  },
  collections: [
    Users,
    Media,
    Clients,
    Caregivers,
    Services,
    Shifts,
    Timesheets,
    Invoices,
    Leads,
  ],
  editor: lexicalEditor(),
  secret: process.env.PAYLOAD_SECRET || '',
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },

  // Disable GraphQL (not needed, and playground breaks CI builds)
  graphQL: false,

  // D1 SQLite adapter
  db: sqliteD1Adapter({ binding: cloudflare.env.D1 }),

  // Structured logging in production
  logger: isProduction ? cloudflareLogger : undefined,

  // CORS — add all frontend URLs
  cors: [
    'http://localhost:3000',
    'http://localhost:3001',
    'https://gotocare-original.jjioji.workers.dev',
  ],

  // R2 storage for media uploads
  plugins: [
    r2Storage({
      bucket: cloudflare.env.R2,
      collections: { media: true },
    }),
  ],

  // Custom API endpoints
  endpoints: [
    // Public lead submission endpoint (for landing page forms)
    {
      path: '/submit-lead',
      method: 'post',
      handler: async (req) => {
        try {
          const body = await req.json()
          const { firstName, lastName, email, phone, careType, message, source } = body

          if (!firstName || !lastName || !email) {
            return Response.json(
              { error: 'First name, last name, and email are required.' },
              { status: 400 },
            )
          }

          const lead = await req.payload.create({
            collection: 'leads',
            data: {
              firstName,
              lastName,
              email,
              phone: phone || '',
              careType: careType || null,
              message: message || '',
              source: source || 'website',
              status: 'new',
            },
            overrideAccess: true,
          })

          return Response.json({ success: true, id: lead.id })
        } catch (error) {
          return Response.json(
            { error: 'Failed to submit lead. Please try again.' },
            { status: 500 },
          )
        }
      },
    },
    // Demo request endpoint
    {
      path: '/request-demo',
      method: 'post',
      handler: async (req) => {
        try {
          const body = await req.json()
          const { firstName, lastName, email, phone, message } = body

          if (!firstName || !lastName || !email) {
            return Response.json(
              { error: 'First name, last name, and email are required.' },
              { status: 400 },
            )
          }

          const lead = await req.payload.create({
            collection: 'leads',
            data: {
              firstName,
              lastName,
              email,
              phone: phone || '',
              message: message || 'Demo request',
              source: 'website',
              careType: null,
              status: 'new',
              notes: 'DEMO REQUEST',
            },
            overrideAccess: true,
          })

          return Response.json({ success: true, id: lead.id })
        } catch (error) {
          return Response.json(
            { error: 'Failed to submit demo request. Please try again.' },
            { status: 500 },
          )
        }
      },
    },
  ],
})

// Wrangler context helper for local dev & CLI
function getCloudflareContextFromWrangler(): Promise<CloudflareContext> {
  return import(/* webpackIgnore: true */ `${'__wrangler'.replaceAll('_', '')}`).then(
    ({ getPlatformProxy }) =>
      getPlatformProxy({
        environment: process.env.CLOUDFLARE_ENV,
        remoteBindings: isProduction,
      } satisfies GetPlatformProxyOptions),
  )
}
