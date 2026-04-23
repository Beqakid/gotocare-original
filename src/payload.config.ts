// @ts-nocheck
import { buildConfig } from 'payload'
import { sqliteD1Adapter } from '@payloadcms/db-d1-sqlite'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { getCloudflareContext } from '@opennextjs/cloudflare'
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
import { Agencies } from './collections/Agencies'
import { Locations } from './collections/Locations'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)
const realpath = (value) => (fs.existsSync(value) ? fs.realpathSync(value) : undefined)

const isCLI = process.argv.some((value) => realpath(value)?.endsWith(path.join('payload', 'bin.js')))
const isProduction = process.env.NODE_ENV === 'production'

function getCloudflareContextFromWrangler() {
  return import(`${'__wrangler'.replaceAll('_', '')}`).then(
    ({ getPlatformProxy }) =>
      getPlatformProxy({
        environment: process.env.CLOUDFLARE_ENV,
        remoteBindings: isProduction,
      }),
  )
}

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
  collections: [Users, Media, Agencies, Locations, Clients, Caregivers, Services, Shifts, Timesheets, Invoices, Leads],
  secret: process.env.PAYLOAD_SECRET || 'gotocare-super-secret-key-2024',
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
  db: sqliteD1Adapter({ binding: cloudflare.env.D1 }),
  graphQL: false,
  cors: '*',
  plugins: [
    r2Storage({
      bucket: cloudflare.env.R2,
      collections: { media: true },
    }),
  ],
    endpoints: [
    {
      path: '/submit-lead',
      method: 'post',
      handler: async (req) => {
        try {
          const data = await req.json()
          const leadData = {
            firstName: data.firstName || '',
            lastName: data.lastName || '',
            email: data.email || '',
            phone: data.phone || '',
            careType: data.careType || 'home_care',
            message: data.message || '',
            source: data.source || 'landing_page',
            status: 'new',
            agency: data.agencyId || null,
            location: data.locationId || null,
          }
          const lead = await req.payload.create({
            collection: 'leads',
            data: leadData,
          })
          return Response.json({ success: true, id: lead.id })
        } catch (error) {
          return Response.json({ success: false, error: 'Failed to submit lead' }, { status: 500 })
        }
      },
    },
    {
      path: '/request-demo',
      method: 'post',
      handler: async (req) => {
        try {
          const data = await req.json()
          const lead = await req.payload.create({
            collection: 'leads',
            data: {
              firstName: data.firstName || data.name || '',
              lastName: data.lastName || '',
              email: data.email || '',
              phone: data.phone || '',
              company: data.company || '',
              message: data.message || 'Demo request',
              source: 'demo_request',
              status: 'new',
            },
          })
          return Response.json({ success: true, id: lead.id })
        } catch (error) {
          return Response.json({ success: false, error: 'Failed to submit demo request' }, { status: 500 })
        }
      },
    },
    {
      path: '/convert-lead',
      method: 'post',
      handler: async (req) => {
        try {
          const user = req.user
          if (!user) {
            return Response.json({ success: false, error: 'Authentication required' }, { status: 401 })
          }
          const data = await req.json()
          const leadId = data.leadId
          if (!leadId) {
            return Response.json({ success: false, error: 'leadId is required' }, { status: 400 })
          }
          const lead = await req.payload.findByID({ collection: 'leads', id: leadId })
          if (!lead) {
            return Response.json({ success: false, error: 'Lead not found' }, { status: 404 })
          }
          const agencyId = lead.agency || (user.agency ? (typeof user.agency === 'object' ? user.agency.id : user.agency) : null)
          const locationId = lead.location || null
          const client = await req.payload.create({
            collection: 'clients',
            data: {
              firstName: lead.firstName || '',
              lastName: lead.lastName || '',
              email: lead.email || '',
              phone: lead.phone || '',
              status: 'active',
              leadSource: 'website',
              agency: agencyId,
              location: locationId,
            },
          })
          await req.payload.update({
            collection: 'leads',
            id: leadId,
            data: {
              status: 'converted',
              convertedClientId: String(client.id),
            },
          })
          return Response.json({ success: true, clientId: client.id })
        } catch (error) {
          return Response.json({ success: false, error: 'Failed to convert lead' }, { status: 500 })
        }
      },
    },
    {
      path: '/dashboard-stats',
      method: 'get',
      handler: async (req) => {
        try {
          const user = req.user
          if (!user) {
            return Response.json({ success: false, error: 'Authentication required' }, { status: 401 })
          }
          const agencyFilter = {}
          if (user.role !== 'admin' && user.agency) {
            const agencyId = typeof user.agency === 'object' ? user.agency.id : user.agency
            agencyFilter.agency = { equals: agencyId }
          }
          const url = new URL(req.url)
          const locationId = url.searchParams.get('locationId')
          if (locationId) {
            agencyFilter.location = { equals: locationId }
          }
          const leads = await req.payload.find({ collection: 'leads', where: agencyFilter, limit: 0 })
          const clients = await req.payload.find({ collection: 'clients', where: agencyFilter, limit: 0 })
          const caregivers = await req.payload.find({ collection: 'caregivers', where: agencyFilter, limit: 0 })
          const shifts = await req.payload.find({ collection: 'shifts', where: agencyFilter, limit: 0 })
          const timesheets = await req.payload.find({ collection: 'timesheets', where: agencyFilter, limit: 0 })
          const invoices = await req.payload.find({ collection: 'invoices', where: agencyFilter, limit: 0 })
          let agencyCount = 0
          if (user.role === 'admin') {
            const agencies = await req.payload.find({ collection: 'agencies', limit: 0 })
            agencyCount = agencies.totalDocs
          }
          let locations = []
          if (user.agency) {
            const agencyId = typeof user.agency === 'object' ? user.agency.id : user.agency
            const locs = await req.payload.find({
              collection: 'locations',
              where: { agency: { equals: agencyId } },
              limit: 100,
            })
            locations = locs.docs.map((l) => ({ id: l.id, name: l.name, city: l.addressCity, state: l.addressState }))
          } else if (user.role === 'admin') {
            const locs = await req.payload.find({ collection: 'locations', limit: 100 })
            locations = locs.docs.map((l) => ({ id: l.id, name: l.name, city: l.addressCity, state: l.addressState, agency: l.agency }))
          }
          return Response.json({
            success: true,
            stats: {
              leads: leads.totalDocs,
              clients: clients.totalDocs,
              caregivers: caregivers.totalDocs,
              shifts: shifts.totalDocs,
              timesheets: timesheets.totalDocs,
              invoices: invoices.totalDocs,
              agencies: agencyCount,
            },
            locations: locations,
          })
        } catch (error) {
          return Response.json({ success: false, error: 'Failed to get stats' }, { status: 500 })
        }
      },
    },
    {
      path: '/clock-in',
      method: 'post',
      handler: async (req) => {
        try {
          const user = req.user
          if (!user) {
            return Response.json({ success: false, error: 'Authentication required' }, { status: 401 })
          }
          const data = await req.json()
          if (!data.shiftId) {
            return Response.json({ success: false, error: 'shiftId is required' }, { status: 400 })
          }
          const shift = await req.payload.findByID({ collection: 'shifts', id: data.shiftId })
          if (!shift) {
            return Response.json({ success: false, error: 'Shift not found' }, { status: 404 })
          }
          const now = new Date().toISOString()
          const timesheet = await req.payload.create({
            collection: 'timesheets',
            data: {
              shift: shift.id,
              caregiver: shift.caregiver,
              client: shift.client,
              agency: shift.agency || null,
              date: now,
              clockIn: now,
              status: 'clocked_in',
              notes: data.notes || '',
            },
          })
          await req.payload.update({
            collection: 'shifts',
            id: shift.id,
            data: { status: 'in_progress' },
          })
          return Response.json({ success: true, timesheetId: timesheet.id })
        } catch (error) {
          return Response.json({ success: false, error: 'Failed to clock in' }, { status: 500 })
        }
      },
    },
    {
      path: '/clock-out',
      method: 'post',
      handler: async (req) => {
        try {
          const user = req.user
          if (!user) {
            return Response.json({ success: false, error: 'Authentication required' }, { status: 401 })
          }
          const data = await req.json()
          if (!data.timesheetId) {
            return Response.json({ success: false, error: 'timesheetId is required' }, { status: 400 })
          }
          const timesheet = await req.payload.findByID({ collection: 'timesheets', id: data.timesheetId })
          if (!timesheet) {
            return Response.json({ success: false, error: 'Timesheet not found' }, { status: 404 })
          }
          const clockOut = new Date()
          const clockIn = new Date(timesheet.clockIn)
          const hoursWorked = Math.round(((clockOut.getTime() - clockIn.getTime()) / 3600000) * 100) / 100
          const hourlyRate = data.hourlyRate || timesheet.hourlyRate || 0
          const totalPay = Math.round(hoursWorked * hourlyRate * 100) / 100
          await req.payload.update({
            collection: 'timesheets',
            id: data.timesheetId,
            data: {
              clockOut: clockOut.toISOString(),
              hoursWorked: hoursWorked,
              hourlyRate: hourlyRate,
              totalPay: totalPay,
              status: 'pending',
            },
          })
          if (timesheet.shift) {
            const shiftId = typeof timesheet.shift === 'object' ? timesheet.shift.id : timesheet.shift
            await req.payload.update({
              collection: 'shifts',
              id: shiftId,
              data: {
                status: 'completed',
                totalHours: hoursWorked,
              },
            })
          }
          return Response.json({ success: true, hoursWorked, totalPay })
        } catch (error) {
          return Response.json({ success: false, error: 'Failed to clock out' }, { status: 500 })
        }
      },
    },
    {
      path: '/generate-invoice',
      method: 'post',
      handler: async (req) => {
        try {
          const user = req.user
          if (!user) {
            return Response.json({ success: false, error: 'Authentication required' }, { status: 401 })
          }
          const data = await req.json()
          if (!data.clientId) {
            return Response.json({ success: false, error: 'clientId is required' }, { status: 400 })
          }
          const periodStart = data.periodStart || new Date(Date.now() - 30 * 86400000).toISOString()
          const periodEnd = data.periodEnd || new Date().toISOString()
          const timesheets = await req.payload.find({
            collection: 'timesheets',
            where: {
              client: { equals: data.clientId },
              status: { equals: 'approved' },
            },
            limit: 1000,
          })
          let totalHours = 0
          let totalAmount = 0
          const sheets = timesheets.docs || []
          for (const ts of sheets) {
            totalHours += ts.hoursWorked || 0
            totalAmount += ts.totalPay || 0
          }
          const hourlyRate = sheets.length > 0 && totalHours > 0 ? Math.round((totalAmount / totalHours) * 100) / 100 : data.hourlyRate || 0
          if (totalAmount === 0 && data.amount) {
            totalAmount = data.amount
          }
          const tax = data.taxRate ? Math.round(totalAmount * data.taxRate * 100) / 100 : 0
          const grandTotal = Math.round((totalAmount + tax) * 100) / 100
          const invoiceNumber = 'INV-' + Date.now().toString(36).toUpperCase()
          const agencyId = data.agencyId || (user.agency ? (typeof user.agency === 'object' ? user.agency.id : user.agency) : null)
          const invoice = await req.payload.create({
            collection: 'invoices',
            data: {
              client: data.clientId,
              caregiver: data.caregiverId || null,
              agency: agencyId,
              invoiceNumber: invoiceNumber,
              periodStart: periodStart,
              periodEnd: periodEnd,
              totalHours: totalHours,
              hourlyRate: hourlyRate,
              amount: totalAmount,
              tax: tax,
              totalAmount: grandTotal,
              status: 'draft',
              issuedDate: new Date().toISOString(),
              dueDate: new Date(Date.now() + 30 * 86400000).toISOString(),
              notes: data.notes || '',
            },
          })
          return Response.json({
            success: true,
            invoiceId: invoice.id,
            invoiceNumber: invoiceNumber,
            totalHours,
            amount: totalAmount,
            tax,
            totalAmount: grandTotal,
            timesheetsIncluded: sheets.length,
          })
        } catch (error) {
          return Response.json({ success: false, error: 'Failed to generate invoice' }, { status: 500 })
        }
      },
    },
    {
      path: '/recurring-shifts',
      method: 'post',
      handler: async (req) => {
        try {
          const user = req.user
          if (!user) {
            return Response.json({ success: false, error: 'Authentication required' }, { status: 401 })
          }
          const data = await req.json()
          if (!data.clientId || !data.caregiverId || !data.startDate || !data.startTime || !data.endTime) {
            return Response.json({ success: false, error: 'clientId, caregiverId, startDate, startTime, endTime are required' }, { status: 400 })
          }
          const weeks = data.weeks || 4
          const daysOfWeek = data.daysOfWeek || [1]
          const groupId = 'REC-' + Date.now().toString(36).toUpperCase()
          const agencyId = data.agencyId || (user.agency ? (typeof user.agency === 'object' ? user.agency.id : user.agency) : null)
          const created = []
          const startDate = new Date(data.startDate)
          for (let w = 0; w < weeks; w++) {
            for (const dayOfWeek of daysOfWeek) {
              const shiftDate = new Date(startDate)
              shiftDate.setDate(startDate.getDate() + (w * 7) + ((dayOfWeek - startDate.getDay() + 7) % 7))
              if (shiftDate < startDate && w === 0) {
                shiftDate.setDate(shiftDate.getDate() + 7)
              }
              const shift = await req.payload.create({
                collection: 'shifts',
                data: {
                  client: data.clientId,
                  caregiver: data.caregiverId,
                  agency: agencyId,
                  location: data.locationId || null,
                  date: shiftDate.toISOString(),
                  startTime: data.startTime,
                  endTime: data.endTime,
                  status: 'scheduled',
                  priority: data.priority || 'normal',
                  recurringGroupId: groupId,
                  notes: data.notes || 'Recurring shift',
                },
              })
              created.push({ id: shift.id, date: shiftDate.toISOString().split('T')[0] })
            }
          }
          return Response.json({
            success: true,
            recurringGroupId: groupId,
            shiftsCreated: created.length,
            shifts: created,
          })
        } catch (error) {
          return Response.json({ success: false, error: 'Failed to create recurring shifts' }, { status: 500 })
        }
      },
    },
    {
      path: '/my-shifts',
      method: 'get',
      handler: async (req) => {
        try {
          const user = req.user
          if (!user) {
            return Response.json({ success: false, error: 'Authentication required' }, { status: 401 })
          }
          const url = new URL(req.url)
          const caregiverId = url.searchParams.get('caregiverId')
          if (!caregiverId) {
            return Response.json({ success: false, error: 'caregiverId is required' }, { status: 400 })
          }
          const shifts = await req.payload.find({
            collection: 'shifts',
            where: {
              caregiver: { equals: caregiverId },
              status: { in: ['scheduled', 'in_progress'] },
            },
            sort: 'date',
            limit: 50,
            depth: 1,
          })
          const timesheets = await req.payload.find({
            collection: 'timesheets',
            where: {
              caregiver: { equals: caregiverId },
              status: { equals: 'clocked_in' },
            },
            limit: 10,
          })
          return Response.json({
            success: true,
            shifts: shifts.docs,
            activeTimesheets: timesheets.docs,
            totalUpcoming: shifts.totalDocs,
          })
        } catch (error) {
          return Response.json({ success: false, error: 'Failed to fetch shifts' }, { status: 500 })
        }
      },
    },
    {
      path: '/register-agency',
      method: 'post',
      handler: async (req) => {
        try {
          const data = await req.json()
          if (!data.agencyName || !data.email || !data.password) {
            return Response.json({ success: false, error: 'agencyName, email, password are required' }, { status: 400 })
          }
          const slug = data.agencyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
          const agency = await req.payload.create({
            collection: 'agencies',
            data: {
              name: data.agencyName,
              slug: slug,
              ownerEmail: data.email,
              phone: data.phone || '',
              addressCity: data.city || '',
              addressState: data.state || '',
              status: 'trial',
              plan: 'starter',
              trialEndsAt: new Date(Date.now() + 14 * 86400000).toISOString(),
              maxCaregivers: 10,
            },
          })
          // Create default HQ location
          const locationSlug = slug + '-hq'
          const location = await req.payload.create({
            collection: 'locations',
            data: {
              agency: agency.id,
              name: data.locationName || 'Main Office',
              slug: locationSlug,
              addressCity: data.city || '',
              addressState: data.state || '',
              addressStreet: data.address || '',
              addressZip: data.zip || '',
              phone: data.phone || '',
              email: data.email,
              status: 'active',
            },
          })
          const user = await req.payload.create({
            collection: 'users',
            data: {
              email: data.email,
              password: data.password,
              name: data.ownerName || '',
              role: 'agency_owner',
              agency: agency.id,
            },
          })
          return Response.json({
            success: true,
            agencyId: agency.id,
            agencySlug: slug,
            locationId: location.id,
            userId: user.id,
            trialEndsAt: agency.trialEndsAt,
          })
        } catch (error) {
          return Response.json({ success: false, error: 'Failed to register agency' }, { status: 500 })
        }
      },
    },
    {
      path: '/agency-locations',
      method: 'get',
      handler: async (req) => {
        try {
          const url = new URL(req.url)
          const agencySlug = url.searchParams.get('agencySlug')
          const agencyId = url.searchParams.get('agencyId')
          if (!agencySlug && !agencyId) {
            return Response.json({ success: false, error: 'agencySlug or agencyId is required' }, { status: 400 })
          }
          let agency = null
          if (agencySlug) {
            const agencies = await req.payload.find({
              collection: 'agencies',
              where: { slug: { equals: agencySlug } },
              limit: 1,
            })
            if (agencies.docs.length === 0) {
              return Response.json({ success: false, error: 'Agency not found' }, { status: 404 })
            }
            agency = agencies.docs[0]
          } else {
            agency = await req.payload.findByID({ collection: 'agencies', id: agencyId })
          }
          const locations = await req.payload.find({
            collection: 'locations',
            where: {
              agency: { equals: agency.id },
              status: { equals: 'active' },
            },
            limit: 100,
          })
          return Response.json({
            success: true,
            agency: { id: agency.id, name: agency.name, slug: agency.slug },
            locations: locations.docs.map((l) => ({
              id: l.id,
              name: l.name,
              slug: l.slug,
              city: l.addressCity,
              state: l.addressState,
              phone: l.phone,
            })),
          })
        } catch (error) {
          return Response.json({ success: false, error: 'Failed to fetch locations' }, { status: 500 })
        }
      },
    },
  ],
})
