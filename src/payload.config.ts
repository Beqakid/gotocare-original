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
import { CaregiverDocuments } from './collections/CaregiverDocuments'

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
  collections: [Users, Media, Agencies, Locations, Clients, Caregivers, Services, Shifts, Timesheets, Invoices, Leads, CaregiverDocuments],
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
            requiredSkills: data.requiredSkills || [],
            preferredLanguage: data.preferredLanguage || '',
            careHoursPerWeek: data.careHoursPerWeek || null,
            urgency: data.urgency || 'routine',
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
              leadSource: lead.source || 'website',
              agency: agencyId,
              location: locationId,
              requiredSkills: lead.requiredSkills || [],
              preferredLanguage: lead.preferredLanguage || '',
              careHoursPerWeek: lead.careHoursPerWeek || null,
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
          // Count onboarding caregivers
          const onboardingWhere = { ...agencyFilter, onboardingStatus: { in: ['invited', 'in_progress', 'review'] } }
          const onboarding = await req.payload.find({ collection: 'caregivers', where: onboardingWhere, limit: 0 })
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
              onboardingCaregivers: onboarding.totalDocs,
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
    // ====== CAREGIVER-CLIENT MATCHING ALGORITHM ======
    {
      path: '/match-caregivers',
      method: 'get',
      handler: async (req) => {
        try {
          const user = req.user
          if (!user) {
            return Response.json({ success: false, error: 'Authentication required' }, { status: 401 })
          }
          const url = new URL(req.url)
          const leadId = url.searchParams.get('leadId')
          const clientId = url.searchParams.get('clientId')
          if (!leadId && !clientId) {
            return Response.json({ success: false, error: 'leadId or clientId is required' }, { status: 400 })
          }

          // Fetch the lead or client to get requirements
          let target = null
          if (leadId) {
            target = await req.payload.findByID({ collection: 'leads', id: leadId, depth: 0 })
          } else {
            target = await req.payload.findByID({ collection: 'clients', id: clientId, depth: 0 })
          }
          if (!target) {
            return Response.json({ success: false, error: 'Lead/Client not found' }, { status: 404 })
          }

          // Determine agency scope
          const agencyId = target.agency || (user.agency ? (typeof user.agency === 'object' ? user.agency.id : user.agency) : null)

          // Build caregiver query — same agency, active or onboarding-complete
          const cgWhere = {}
          if (agencyId) {
            cgWhere.agency = { equals: agencyId }
          }
          cgWhere.status = { equals: 'active' }

          const caregivers = await req.payload.find({
            collection: 'caregivers',
            where: cgWhere,
            limit: 200,
            depth: 0,
          })

          // Get current shift counts for workload balancing
          const shiftCounts = {}
          for (const cg of caregivers.docs) {
            const shifts = await req.payload.find({
              collection: 'shifts',
              where: {
                caregiver: { equals: cg.id },
                status: { in: ['scheduled', 'in_progress'] },
              },
              limit: 0,
            })
            shiftCounts[cg.id] = shifts.totalDocs
          }

          // Get document compliance status
          const complianceMap = {}
          for (const cg of caregivers.docs) {
            const docs = await req.payload.find({
              collection: 'caregiver-documents',
              where: { caregiver: { equals: cg.id } },
              limit: 100,
            })
            const total = docs.totalDocs
            const verified = docs.docs.filter((d) => d.status === 'verified').length
            const expired = docs.docs.filter((d) => d.status === 'expired').length
            complianceMap[cg.id] = { total, verified, expired, compliant: expired === 0 && total > 0 }
          }

          // Extract target requirements
          const requiredSkills = target.requiredSkills || []
          const preferredLang = (target.preferredLanguage || '').toLowerCase()
          const targetLocation = target.location
          const targetCity = (target.addressCity || '').toLowerCase()
          const targetState = (target.addressState || '').toLowerCase()

          // Score each caregiver
          const scored = caregivers.docs.map((cg) => {
            let score = 0
            const breakdown = {}

            // 1. LOCATION MATCH (max 25 points)
            const cgLocation = cg.location
            const locationId = typeof targetLocation === 'object' ? targetLocation?.id : targetLocation
            const cgLocationId = typeof cgLocation === 'object' ? cgLocation?.id : cgLocation
            if (locationId && cgLocationId && String(locationId) === String(cgLocationId)) {
              score += 25
              breakdown.location = 25
            } else {
              // Partial: same city/state
              const cgCity = (cg.addressCity || '').toLowerCase()
              const cgState = (cg.addressState || '').toLowerCase()
              if (targetCity && cgCity === targetCity) {
                score += 15
                breakdown.location = 15
              } else if (targetState && cgState === targetState) {
                score += 8
                breakdown.location = 8
              } else {
                breakdown.location = 0
              }
            }

            // 2. SKILLS MATCH (max 30 points)
            const cgSkills = cg.skills || []
            if (requiredSkills.length > 0 && cgSkills.length > 0) {
              const matched = requiredSkills.filter((s) => cgSkills.includes(s)).length
              const skillScore = Math.round((matched / requiredSkills.length) * 30)
              score += skillScore
              breakdown.skills = skillScore
              breakdown.skillsMatched = matched
              breakdown.skillsRequired = requiredSkills.length
            } else if (requiredSkills.length === 0) {
              score += 15 // no requirements = partial credit
              breakdown.skills = 15
            } else {
              breakdown.skills = 0
            }

            // 3. LANGUAGE MATCH (max 15 points)
            const cgLangs = (cg.languages || '').toLowerCase()
            if (preferredLang && cgLangs.includes(preferredLang)) {
              score += 15
              breakdown.language = 15
            } else if (!preferredLang) {
              score += 8
              breakdown.language = 8
            } else {
              breakdown.language = 0
            }

            // 4. COMPLIANCE (max 10 points — required gate)
            const compliance = complianceMap[cg.id] || { total: 0, verified: 0, expired: 0, compliant: false }
            if (compliance.compliant) {
              score += 10
              breakdown.compliance = 10
            } else if (compliance.expired > 0) {
              score -= 20 // heavy penalty for expired docs
              breakdown.compliance = -20
            } else {
              breakdown.compliance = 0
            }

            // 5. WORKLOAD (max 10 points — fewer shifts = more available)
            const currentShifts = shiftCounts[cg.id] || 0
            const maxHours = cg.maxHoursPerWeek || 40
            if (currentShifts === 0) {
              score += 10
              breakdown.workload = 10
            } else if (currentShifts < 5) {
              score += 7
              breakdown.workload = 7
            } else if (currentShifts < 10) {
              score += 3
              breakdown.workload = 3
            } else {
              breakdown.workload = 0
            }
            breakdown.currentShifts = currentShifts

            // 6. EXPERIENCE (max 10 points)
            const exp = cg.experienceYears || 0
            const expScore = Math.min(exp * 2, 10)
            score += expScore
            breakdown.experience = expScore

            // Normalize to percentage (max possible = 100)
            const matchPercent = Math.max(0, Math.min(100, score))

            return {
              caregiverId: cg.id,
              firstName: cg.firstName,
              lastName: cg.lastName,
              email: cg.email,
              phone: cg.phone,
              skills: cg.skills || [],
              languages: cg.languages,
              experienceYears: cg.experienceYears,
              hourlyRate: cg.hourlyRate,
              location: cg.location,
              addressCity: cg.addressCity,
              addressState: cg.addressState,
              complianceStatus: cg.complianceStatus,
              matchScore: matchPercent,
              breakdown: breakdown,
            }
          })

          // Sort by score descending
          scored.sort((a, b) => b.matchScore - a.matchScore)

          // Return top 10
          const topMatches = scored.slice(0, 10)

          return Response.json({
            success: true,
            targetId: leadId || clientId,
            targetType: leadId ? 'lead' : 'client',
            totalCaregivers: caregivers.totalDocs,
            matches: topMatches,
          })
        } catch (error) {
          return Response.json({ success: false, error: 'Matching failed' }, { status: 500 })
        }
      },
    },
    // ====== INVITE CAREGIVER (starts onboarding) ======
    {
      path: '/invite-caregiver',
      method: 'post',
      handler: async (req) => {
        try {
          const user = req.user
          if (!user) {
            return Response.json({ success: false, error: 'Authentication required' }, { status: 401 })
          }
          const data = await req.json()
          if (!data.email || !data.firstName || !data.lastName) {
            return Response.json({ success: false, error: 'email, firstName, lastName are required' }, { status: 400 })
          }
          const agencyId = data.agencyId || (user.agency ? (typeof user.agency === 'object' ? user.agency.id : user.agency) : null)
          // Generate unique invite token
          const token = 'INV-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 8)
          const caregiver = await req.payload.create({
            collection: 'caregivers',
            data: {
              firstName: data.firstName,
              lastName: data.lastName,
              email: data.email,
              phone: data.phone || '',
              agency: agencyId,
              location: data.locationId || null,
              status: 'onboarding',
              onboardingStatus: 'invited',
              inviteToken: token,
              invitedAt: new Date().toISOString(),
              onboardingProgress: {
                profile: false,
                documents: false,
                skills: false,
                availability: false,
                compliance: false,
                training: false,
                eSignature: false,
              },
            },
          })
          return Response.json({
            success: true,
            caregiverId: caregiver.id,
            inviteToken: token,
            inviteLink: '/onboarding?token=' + token,
          })
        } catch (error) {
          return Response.json({ success: false, error: 'Failed to invite caregiver' }, { status: 500 })
        }
      },
    },
    // ====== GET ONBOARDING STATUS ======
    {
      path: '/onboarding-status',
      method: 'get',
      handler: async (req) => {
        try {
          const url = new URL(req.url)
          const token = url.searchParams.get('token')
          const caregiverId = url.searchParams.get('caregiverId')
          if (!token && !caregiverId) {
            return Response.json({ success: false, error: 'token or caregiverId required' }, { status: 400 })
          }
          let caregiver = null
          if (token) {
            const results = await req.payload.find({
              collection: 'caregivers',
              where: { inviteToken: { equals: token } },
              limit: 1,
              depth: 1,
              overrideAccess: true,
            })
            caregiver = results.docs[0] || null
          } else {
            caregiver = await req.payload.findByID({ collection: 'caregivers', id: caregiverId, depth: 1, overrideAccess: true })
          }
          if (!caregiver) {
            return Response.json({ success: false, error: 'Caregiver not found' }, { status: 404 })
          }
          // Fetch documents
          const docs = await req.payload.find({
            collection: 'caregiver-documents',
            where: { caregiver: { equals: caregiver.id } },
            limit: 50,
            overrideAccess: true,
          })
          const progress = caregiver.onboardingProgress || {}
          const steps = ['profile', 'documents', 'skills', 'availability', 'compliance', 'training', 'eSignature']
          const completed = steps.filter((s) => progress[s] === true).length
          const percent = Math.round((completed / steps.length) * 100)
          return Response.json({
            success: true,
            caregiverId: caregiver.id,
            firstName: caregiver.firstName,
            lastName: caregiver.lastName,
            email: caregiver.email,
            onboardingStatus: caregiver.onboardingStatus,
            progress: progress,
            completionPercent: percent,
            stepsTotal: steps.length,
            stepsCompleted: completed,
            documents: docs.docs,
            documentsCount: docs.totalDocs,
          })
        } catch (error) {
          return Response.json({ success: false, error: 'Failed to get onboarding status' }, { status: 500 })
        }
      },
    },
    // ====== COMPLETE ONBOARDING STEP ======
    {
      path: '/complete-onboarding-step',
      method: 'post',
      handler: async (req) => {
        try {
          const data = await req.json()
          const { caregiverId, token, step, stepData } = data
          if (!step) {
            return Response.json({ success: false, error: 'step is required' }, { status: 400 })
          }
          let caregiver = null
          if (caregiverId) {
            caregiver = await req.payload.findByID({ collection: 'caregivers', id: caregiverId, overrideAccess: true })
          } else if (token) {
            const results = await req.payload.find({
              collection: 'caregivers',
              where: { inviteToken: { equals: token } },
              limit: 1,
              overrideAccess: true,
            })
            caregiver = results.docs[0] || null
          }
          if (!caregiver) {
            return Response.json({ success: false, error: 'Caregiver not found' }, { status: 404 })
          }
          const progress = caregiver.onboardingProgress || {}
          const updateData = {}

          // Handle each step
          if (step === 'profile') {
            if (stepData) {
              if (stepData.phone) updateData.phone = stepData.phone
              if (stepData.addressStreet) updateData.addressStreet = stepData.addressStreet
              if (stepData.addressCity) updateData.addressCity = stepData.addressCity
              if (stepData.addressState) updateData.addressState = stepData.addressState
              if (stepData.addressZip) updateData.addressZip = stepData.addressZip
              if (stepData.emergencyContactName) updateData.emergencyContactName = stepData.emergencyContactName
              if (stepData.emergencyContactPhone) updateData.emergencyContactPhone = stepData.emergencyContactPhone
              if (stepData.emergencyContactRelation) updateData.emergencyContactRelation = stepData.emergencyContactRelation
              if (stepData.languages) updateData.languages = stepData.languages
              if (stepData.photoUrl) updateData.photoUrl = stepData.photoUrl
            }
            progress.profile = true
          } else if (step === 'skills') {
            if (stepData && stepData.skills) {
              updateData.skills = stepData.skills
            }
            if (stepData && stepData.experienceYears !== undefined) {
              updateData.experienceYears = stepData.experienceYears
            }
            if (stepData && stepData.certifications) {
              updateData.certifications = stepData.certifications
            }
            progress.skills = true
          } else if (step === 'availability') {
            if (stepData && stepData.availabilityJson) {
              updateData.availabilityJson = stepData.availabilityJson
            }
            if (stepData && stepData.maxHoursPerWeek) {
              updateData.maxHoursPerWeek = stepData.maxHoursPerWeek
            }
            if (stepData && stepData.availability) {
              updateData.availability = stepData.availability
            }
            progress.availability = true
          } else if (step === 'documents') {
            progress.documents = true
          } else if (step === 'compliance') {
            progress.compliance = true
          } else if (step === 'training') {
            updateData.trainingAcknowledged = true
            updateData.hipaaAcknowledged = stepData?.hipaaAcknowledged || false
            progress.training = true
          } else if (step === 'eSignature') {
            if (stepData && stepData.signature) {
              updateData.eSignature = stepData.signature
              updateData.eSignatureDate = new Date().toISOString()
            }
            progress.eSignature = true
          }

          updateData.onboardingProgress = progress

          // Check if all steps complete
          const steps = ['profile', 'documents', 'skills', 'availability', 'compliance', 'training', 'eSignature']
          const allDone = steps.every((s) => progress[s] === true)
          if (allDone) {
            updateData.onboardingStatus = 'review'
            updateData.onboardingCompletedAt = new Date().toISOString()
          } else {
            updateData.onboardingStatus = 'in_progress'
          }

          await req.payload.update({
            collection: 'caregivers',
            id: caregiver.id,
            data: updateData,
            overrideAccess: true,
          })

          const completed = steps.filter((s) => progress[s] === true).length
          return Response.json({
            success: true,
            step: step,
            progress: progress,
            completionPercent: Math.round((completed / steps.length) * 100),
            allComplete: allDone,
            onboardingStatus: allDone ? 'review' : 'in_progress',
          })
        } catch (error) {
          return Response.json({ success: false, error: 'Failed to update onboarding' }, { status: 500 })
        }
      },
    },
    // ====== APPROVE/REJECT CAREGIVER ONBOARDING ======
    {
      path: '/approve-caregiver',
      method: 'post',
      handler: async (req) => {
        try {
          const user = req.user
          if (!user) {
            return Response.json({ success: false, error: 'Authentication required' }, { status: 401 })
          }
          const data = await req.json()
          if (!data.caregiverId || !data.action) {
            return Response.json({ success: false, error: 'caregiverId and action (approve/reject) required' }, { status: 400 })
          }
          const updateData = {}
          if (data.action === 'approve') {
            updateData.onboardingStatus = 'active'
            updateData.status = 'active'
            updateData.complianceStatus = 'compliant'
            updateData.hireDate = new Date().toISOString()
          } else if (data.action === 'reject') {
            updateData.onboardingStatus = 'rejected'
            updateData.status = 'inactive'
          }
          await req.payload.update({
            collection: 'caregivers',
            id: data.caregiverId,
            data: updateData,
            overrideAccess: true,
          })
          return Response.json({ success: true, action: data.action, caregiverId: data.caregiverId })
        } catch (error) {
          return Response.json({ success: false, error: 'Failed to process approval' }, { status: 500 })
        }
      },
    },
    // ====== CLIENT PORTAL ENDPOINTS ======
    {
      path: '/client-login',
      method: 'post',
      handler: async (req) => {
        try {
          const data = await req.json()
          if (!data.email || !data.accessCode) {
            return Response.json({ error: 'Email and access code are required' }, { status: 400 })
          }
          const clients = await req.payload.find({
            collection: 'clients',
            where: {
              email: { equals: data.email },
              accessCode: { equals: data.accessCode },
            },
            limit: 1,
            depth: 1,
            overrideAccess: true,
          })
          if (clients.docs.length === 0) {
            return Response.json({ error: 'Invalid email or access code' }, { status: 401 })
          }
          const client = clients.docs[0]
          if (client.status === 'inactive') {
            return Response.json({ error: 'Account is inactive. Contact your care agency.' }, { status: 403 })
          }
          const agencyName = client.agency && typeof client.agency === 'object' ? client.agency.name : 'Your Care Agency'
          return Response.json({
            success: true,
            client: {
              id: client.id,
              firstName: client.firstName,
              lastName: client.lastName,
              email: client.email,
              phone: client.phone,
              agency: typeof client.agency === 'object' ? client.agency.id : client.agency,
              location: typeof client.location === 'object' ? client.location?.id : client.location,
              address: [client.addressStreet, client.addressCity, client.addressState, client.addressZip].filter(Boolean).join(', '),
              careNeeds: client.careNeeds,
              emergencyContact: client.emergencyContactName,
              emergencyPhone: client.emergencyContactPhone,
              preferredLanguage: client.preferredLanguage,
            },
            agencyName: agencyName,
          })
        } catch (error) {
          return Response.json({ error: 'Login failed' }, { status: 500 })
        }
      },
    },
    {
      path: '/client-portal/schedule',
      method: 'get',
      handler: async (req) => {
        try {
          const url = new URL(req.url)
          const clientId = url.searchParams.get('clientId')
          if (!clientId) {
            return Response.json({ error: 'clientId is required' }, { status: 400 })
          }
          const shifts = await req.payload.find({
            collection: 'shifts',
            where: { client: { equals: clientId } },
            sort: '-date',
            limit: 100,
            depth: 1,
            overrideAccess: true,
          })
          const mapped = shifts.docs.map((s) => ({
            id: s.id,
            date: s.date ? s.date.split('T')[0] : '',
            startTime: s.startTime || '',
            endTime: s.endTime || '',
            status: s.status || 'scheduled',
            shiftType: s.shiftType || s.serviceType || '',
            notes: s.notes || '',
            caregiver: s.caregiver && typeof s.caregiver === 'object' ? {
              id: s.caregiver.id,
              firstName: s.caregiver.firstName,
              lastName: s.caregiver.lastName,
              phone: s.caregiver.phone,
              photo: s.caregiver.photoUrl,
            } : null,
          }))
          return Response.json({ success: true, shifts: mapped })
        } catch (error) {
          return Response.json({ error: 'Failed to load schedule' }, { status: 500 })
        }
      },
    },
    {
      path: '/client-portal/caregivers',
      method: 'get',
      handler: async (req) => {
        try {
          const url = new URL(req.url)
          const clientId = url.searchParams.get('clientId')
          if (!clientId) {
            return Response.json({ error: 'clientId is required' }, { status: 400 })
          }
          // Find all caregivers who have had shifts with this client
          const shifts = await req.payload.find({
            collection: 'shifts',
            where: { client: { equals: clientId } },
            limit: 500,
            depth: 1,
            overrideAccess: true,
          })
          const seen = new Set()
          const caregivers = []
          for (const s of shifts.docs) {
            const cg = s.caregiver && typeof s.caregiver === 'object' ? s.caregiver : null
            if (cg && !seen.has(cg.id)) {
              seen.add(cg.id)
              caregivers.push({
                id: cg.id,
                firstName: cg.firstName,
                lastName: cg.lastName,
                email: cg.email,
                phone: cg.phone,
                photo: cg.photoUrl,
                skills: typeof cg.skills === 'string' ? cg.skills : (Array.isArray(cg.skills) ? cg.skills.join(', ') : ''),
                specializations: cg.specializations || cg.certifications || '',
                languages: cg.languages || '',
                experienceYears: cg.experienceYears,
                bio: cg.bio || '',
              })
            }
          }
          // Also check matched caregiver on the client record
          const client = await req.payload.findByID({ collection: 'clients', id: clientId, depth: 1, overrideAccess: true })
          if (client.matchedCaregiver && typeof client.matchedCaregiver === 'object' && !seen.has(client.matchedCaregiver.id)) {
            const mc = client.matchedCaregiver
            caregivers.unshift({
              id: mc.id,
              firstName: mc.firstName,
              lastName: mc.lastName,
              email: mc.email,
              phone: mc.phone,
              photo: mc.photoUrl,
              skills: typeof mc.skills === 'string' ? mc.skills : (Array.isArray(mc.skills) ? mc.skills.join(', ') : ''),
              specializations: mc.specializations || mc.certifications || '',
              languages: mc.languages || '',
              experienceYears: mc.experienceYears,
              bio: mc.bio || '',
            })
          }
          return Response.json({ success: true, caregivers: caregivers })
        } catch (error) {
          return Response.json({ error: 'Failed to load caregivers' }, { status: 500 })
        }
      },
    },
    {
      path: '/client-portal/invoices',
      method: 'get',
      handler: async (req) => {
        try {
          const url = new URL(req.url)
          const clientId = url.searchParams.get('clientId')
          if (!clientId) {
            return Response.json({ error: 'clientId is required' }, { status: 400 })
          }
          const invoices = await req.payload.find({
            collection: 'invoices',
            where: { client: { equals: clientId } },
            sort: '-issuedDate',
            limit: 100,
            depth: 0,
            overrideAccess: true,
          })
          const mapped = invoices.docs.map((inv) => ({
            id: inv.id,
            invoiceNumber: inv.invoiceNumber || 'INV-' + inv.id,
            date: inv.issuedDate ? inv.issuedDate.split('T')[0] : '',
            dueDate: inv.dueDate ? inv.dueDate.split('T')[0] : '',
            totalAmount: inv.totalAmount || inv.amount || 0,
            status: inv.status || 'draft',
            lineItems: inv.lineItems || '',
            pdfUrl: inv.pdfUrl || '',
          }))
          return Response.json({ success: true, invoices: mapped })
        } catch (error) {
          return Response.json({ error: 'Failed to load invoices' }, { status: 500 })
        }
      },
    },
    {
      path: '/client-portal/profile',
      method: 'get',
      handler: async (req) => {
        try {
          const url = new URL(req.url)
          const clientId = url.searchParams.get('clientId')
          if (!clientId) {
            return Response.json({ error: 'clientId is required' }, { status: 400 })
          }
          const client = await req.payload.findByID({ collection: 'clients', id: clientId, depth: 1, overrideAccess: true })
          const agencyName = client.agency && typeof client.agency === 'object' ? client.agency.name : ''
          return Response.json({
            success: true,
            profile: {
              id: client.id,
              firstName: client.firstName,
              lastName: client.lastName,
              email: client.email,
              phone: client.phone,
              addressStreet: client.addressStreet,
              addressCity: client.addressCity,
              addressState: client.addressState,
              addressZip: client.addressZip,
              emergencyContactName: client.emergencyContactName,
              emergencyContactPhone: client.emergencyContactPhone,
              emergencyContactRelationship: client.emergencyContactRelationship,
              preferredLanguage: client.preferredLanguage,
              careNeeds: client.careNeeds,
              preferredSchedule: client.preferredSchedule,
              agencyName: agencyName,
            },
          })
        } catch (error) {
          return Response.json({ error: 'Failed to load profile' }, { status: 500 })
        }
      },
    },
    {
      path: '/client-portal/profile',
      method: 'post',
      handler: async (req) => {
        try {
          const url = new URL(req.url)
          const clientId = url.searchParams.get('clientId')
          if (!clientId) {
            return Response.json({ error: 'clientId is required' }, { status: 400 })
          }
          const data = await req.json()
          const updateData = {}
          if (data.phone !== undefined) updateData.phone = data.phone
          if (data.address !== undefined) updateData.addressStreet = data.address
          if (data.addressStreet !== undefined) updateData.addressStreet = data.addressStreet
          if (data.addressCity !== undefined) updateData.addressCity = data.addressCity
          if (data.addressState !== undefined) updateData.addressState = data.addressState
          if (data.addressZip !== undefined) updateData.addressZip = data.addressZip
          if (data.emergencyContact !== undefined) updateData.emergencyContactName = data.emergencyContact
          if (data.emergencyContactName !== undefined) updateData.emergencyContactName = data.emergencyContactName
          if (data.emergencyPhone !== undefined) updateData.emergencyContactPhone = data.emergencyPhone
          if (data.emergencyContactPhone !== undefined) updateData.emergencyContactPhone = data.emergencyContactPhone
          if (data.preferredLanguage !== undefined) updateData.preferredLanguage = data.preferredLanguage
          if (data.careNeeds !== undefined) updateData.careNeeds = data.careNeeds
          if (data.preferredSchedule !== undefined) updateData.preferredSchedule = data.preferredSchedule
          await req.payload.update({
            collection: 'clients',
            id: clientId,
            data: updateData,
            overrideAccess: true,
          })
          return Response.json({ success: true, message: 'Profile updated' })
        } catch (error) {
          return Response.json({ error: 'Failed to update profile' }, { status: 500 })
        }
      },
    },
  ],
})
