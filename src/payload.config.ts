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
const isCI = !!process.env.CI

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

// During CI builds, provide mock bindings (real bindings come at runtime on Workers)
let cloudflare: any
if (isCI) {
  cloudflare = { env: { D1: {}, R2: {} } }
} else if (isCLI || !isProduction) {
  cloudflare = await getCloudflareContextFromWrangler()
} else {
  cloudflare = await getCloudflareContext({ async: true })
}

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

  // CORS — allow all origins
  cors: '*',

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
    // Convert Lead to Client (authenticated)
    {
      path: '/convert-lead',
      method: 'post',
      handler: async (req) => {
        try {
          if (!req.user) {
            return Response.json({ error: 'Authentication required.' }, { status: 401 })
          }

          const body = await req.json()
          const { leadId } = body

          if (!leadId) {
            return Response.json({ error: 'leadId is required.' }, { status: 400 })
          }

          // Fetch the lead
          const lead = await req.payload.findByID({
            collection: 'leads',
            id: leadId,
            overrideAccess: true,
          })

          if (!lead) {
            return Response.json({ error: 'Lead not found.' }, { status: 404 })
          }

          if (lead.status === 'converted') {
            return Response.json(
              { error: 'Lead already converted.', clientId: lead.convertedClientId },
              { status: 400 },
            )
          }

          // Create client from lead data
          const client = await req.payload.create({
            collection: 'clients',
            data: {
              firstName: lead.firstName,
              lastName: lead.lastName,
              email: lead.email || '',
              phone: lead.phone || '',
              careNeeds: lead.careType ? `Care type: ${lead.careType}. ${lead.message || ''}` : lead.message || '',
              leadSource: lead.source || 'website',
              status: 'pending',
              notes: `Converted from lead #${lead.id} on ${new Date().toISOString().split('T')[0]}`,
            },
            overrideAccess: true,
          })

          // Update lead status to converted
          await req.payload.update({
            collection: 'leads',
            id: leadId,
            data: {
              status: 'converted',
              convertedClientId: client.id,
            },
            overrideAccess: true,
          })

          return Response.json({
            success: true,
            message: 'Lead converted to client successfully.',
            clientId: client.id,
            leadId: lead.id,
          })
        } catch (error) {
          return Response.json(
            { error: 'Failed to convert lead. Please try again.' },
            { status: 500 },
          )
        }
      },
    },
    // Dashboard stats endpoint (authenticated)
    {
      path: '/dashboard-stats',
      method: 'get',
      handler: async (req) => {
        try {
          if (!req.user) {
            return Response.json({ error: 'Authentication required.' }, { status: 401 })
          }

          const leads = await req.payload.find({ collection: 'leads', limit: 0, overrideAccess: true })
          const clients = await req.payload.find({ collection: 'clients', limit: 0, overrideAccess: true })
          const caregivers = await req.payload.find({ collection: 'caregivers', limit: 0, overrideAccess: true })
          const shifts = await req.payload.find({ collection: 'shifts', limit: 0, overrideAccess: true })

          // Count leads by status
          const allLeads = await req.payload.find({ collection: 'leads', limit: 100, overrideAccess: true })
          const leadsByStatus = { new: 0, contacted: 0, qualified: 0, converted: 0, lost: 0 }
          for (const l of allLeads.docs) {
            if (leadsByStatus[l.status] !== undefined) leadsByStatus[l.status]++
          }

          // Count clients by status
          const allClients = await req.payload.find({ collection: 'clients', limit: 100, overrideAccess: true })
          const clientsByStatus = { active: 0, inactive: 0, pending: 0 }
          for (const c of allClients.docs) {
            if (clientsByStatus[c.status] !== undefined) clientsByStatus[c.status]++
          }

          // Count shifts by status
          const allShifts = await req.payload.find({ collection: 'shifts', limit: 100, overrideAccess: true })
          const shiftsByStatus = { scheduled: 0, in_progress: 0, completed: 0, cancelled: 0 }
          for (const s of allShifts.docs) {
            if (shiftsByStatus[s.status] !== undefined) shiftsByStatus[s.status]++
          }

          return Response.json({
            totalLeads: leads.totalDocs,
            totalClients: clients.totalDocs,
            totalCaregivers: caregivers.totalDocs,
            totalShifts: shifts.totalDocs,
            leadsByStatus,
            clientsByStatus,
            shiftsByStatus,
            recentLeads: allLeads.docs.slice(0, 5),
          })
        } catch (error) {
          return Response.json(
            { error: 'Failed to fetch dashboard stats.' },
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
