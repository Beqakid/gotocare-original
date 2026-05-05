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
import { MarketingPosts } from './collections/MarketingPosts'
import { SocialAccounts } from './collections/SocialAccounts'

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
  collections: [Users, Media, Agencies, Locations, Clients, Caregivers, Services, Shifts, Timesheets, Invoices, Leads, CaregiverDocuments, MarketingPosts, SocialAccounts],
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
    // ====== STRIPE PAYMENT FLOW ======
    {
      path: '/client-portal/create-checkout',
      method: 'post',
      handler: async (req) => {
        try {
          const data = await req.json()
          if (!data.invoiceId || !data.clientId) {
            return Response.json({ error: 'invoiceId and clientId are required' }, { status: 400 })
          }
          const invoice = await req.payload.findByID({ collection: 'invoices', id: data.invoiceId, depth: 1, overrideAccess: true })
          if (!invoice) {
            return Response.json({ error: 'Invoice not found' }, { status: 404 })
          }
          if (invoice.status === 'paid') {
            return Response.json({ error: 'Invoice is already paid' }, { status: 400 })
          }
          const amount = Math.round((invoice.totalAmount || invoice.amount || 0) * 100)
          if (amount <= 0) {
            return Response.json({ error: 'Invalid invoice amount' }, { status: 400 })
          }
          const clientName = invoice.client && typeof invoice.client === 'object'
            ? `${invoice.client.firstName} ${invoice.client.lastName}`
            : 'Client'
          const stripeKey = cloudflare.env.STRIPE_SECRET_KEY
          if (!stripeKey) {
            return Response.json({ error: 'Payment system not configured' }, { status: 500 })
          }
          const params = new URLSearchParams()
          params.append('line_items[0][price_data][currency]', 'usd')
          params.append('line_items[0][price_data][product_data][name]', `Invoice ${invoice.invoiceNumber || 'INV-' + invoice.id}`)
          params.append('line_items[0][price_data][product_data][description]', `Care services for ${clientName}`)
          params.append('line_items[0][price_data][unit_amount]', String(amount))
          params.append('line_items[0][quantity]', '1')
          params.append('mode', 'payment')
          params.append('success_url', `https://gotocare-original.jjioji.workers.dev/api/payment-success?session_id={CHECKOUT_SESSION_ID}`)
          params.append('cancel_url', `https://gotocare-original.jjioji.workers.dev/api/payment-cancel`)
          params.append('metadata[invoice_id]', String(invoice.id))
          params.append('metadata[client_id]', String(data.clientId))
          if (data.email) {
            params.append('customer_email', data.email)
          }
          const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${stripeKey}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: params.toString(),
          })
          const session = await stripeRes.json()
          if (!stripeRes.ok) {
            return Response.json({ error: session.error?.message || 'Failed to create checkout' }, { status: 500 })
          }
          await req.payload.update({
            collection: 'invoices',
            id: invoice.id,
            data: { stripeSessionId: session.id, status: 'pending' },
            overrideAccess: true,
          })
          return Response.json({ success: true, checkoutUrl: session.url, sessionId: session.id })
        } catch (error) {
          return Response.json({ error: 'Failed to create checkout session' }, { status: 500 })
        }
      },
    },
    {
      path: '/payment-success',
      method: 'get',
      handler: async (req) => {
        try {
          const url = new URL(req.url)
          const sessionId = url.searchParams.get('session_id')
          if (!sessionId) {
            return new Response('<h1>Invalid payment session</h1>', { headers: { 'Content-Type': 'text/html' } })
          }
          const stripeKey = cloudflare.env.STRIPE_SECRET_KEY
          const stripeRes = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
            headers: { 'Authorization': `Bearer ${stripeKey}` },
          })
          const session = await stripeRes.json()
          if (session.payment_status === 'paid') {
            const invoiceId = session.metadata?.invoice_id
            if (invoiceId) {
              await req.payload.update({
                collection: 'invoices',
                id: invoiceId,
                data: {
                  status: 'paid',
                  paidDate: new Date().toISOString(),
                  paymentMethod: 'stripe',
                  stripePaymentId: session.payment_intent,
                  stripeSessionId: sessionId,
                },
                overrideAccess: true,
              })
            }
            const amountStr = session.amount_total ? (session.amount_total / 100).toFixed(2) : '0.00'
            return new Response(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payment Successful - GoToCare</title>
<style>
body{margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#fff;border-radius:20px;padding:48px;text-align:center;max-width:480px;box-shadow:0 20px 60px rgba(0,0,0,.2)}
.check{width:80px;height:80px;background:#10b981;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 24px}
.check svg{width:40px;height:40px;fill:none;stroke:#fff;stroke-width:3}
h1{color:#1e293b;font-size:24px;margin-bottom:8px}
p{color:#64748b;font-size:16px;line-height:1.5}
.amount{font-size:32px;font-weight:700;color:#667eea;margin:16px 0}
</style></head><body>
<div class="card">
<div class="check"><svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
<h1>Payment Successful!</h1>
<div class="amount">$${amountStr}</div>
<p>Thank you for your payment. Your invoice has been marked as paid.</p>
<p style="margin-top:24px;font-size:14px;color:#94a3b8">You can close this window and return to your portal.</p>
</div></body></html>`, { headers: { 'Content-Type': 'text/html' } })
          } else {
            return new Response(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Payment Processing</title>
<style>body{margin:0;padding:40px;font-family:sans-serif;text-align:center;background:#f8fafc}
h1{color:#f59e0b;margin-top:80px}p{color:#64748b}</style></head>
<body><h1>&#9203; Payment Processing</h1><p>Your payment is being processed. The invoice will be updated shortly.</p></body></html>`,
              { headers: { 'Content-Type': 'text/html' } })
          }
        } catch (error) {
          return new Response('<h1>Error processing payment</h1>', { status: 500, headers: { 'Content-Type': 'text/html' } })
        }
      },
    },
    {
      path: '/payment-cancel',
      method: 'get',
      handler: async (req) => {
        return new Response(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Payment Cancelled - GoToCare</title>
<style>body{margin:0;padding:40px;font-family:sans-serif;text-align:center;background:#f8fafc}
h1{color:#ef4444;margin-top:80px}p{color:#64748b}</style></head>
<body><h1>Payment Cancelled</h1><p>Your payment was cancelled. You can return to your portal and try again.</p></body></html>`,
          { headers: { 'Content-Type': 'text/html' } })
      },
    },
    {
      path: '/stripe-webhook',
      method: 'post',
      handler: async (req) => {
        try {
          const body = await req.text()
          const event = JSON.parse(body)
          if (event.type === 'checkout.session.completed') {
            const session = event.data.object
            // Handle invoice payment
            const invoiceId = session.metadata?.invoice_id
            if (invoiceId && session.payment_status === 'paid') {
              await req.payload.update({
                collection: 'invoices',
                id: invoiceId,
                data: {
                  status: 'paid',
                  paidDate: new Date().toISOString(),
                  paymentMethod: 'stripe',
                  stripePaymentId: session.payment_intent,
                  stripeSessionId: session.id,
                },
                overrideAccess: true,
              })
            }
            // Handle client subscription
            const subType = session.metadata?.type
            // Handle booking unlock ($4.99 one-time)
            if (subType === 'booking_unlock') {
              const bookingId = session.metadata?.booking_id
              if (bookingId) {
                await cloudflare.env.D1.prepare(
                  'UPDATE caregiver_bookings SET is_unlocked = 1 WHERE id = ?'
                ).bind(Number(bookingId)).run()
              }
            }
            // Handle caregiver unlimited subscription ($19.99/mo)
            if (subType === 'caregiver_subscription') {
              const cgId = session.metadata?.caregiver_id
              if (cgId) {
                // Unlock all pending bookings for this caregiver
                await cloudflare.env.D1.prepare(
                  'UPDATE caregiver_bookings SET is_unlocked = 1 WHERE caregiver_id = ?'
                ).bind(String(cgId)).run()
              }
            }
            if (subType === 'client_subscription') {
              const clientEmail = session.metadata?.client_email || session.customer_email || ''
              const plan = session.metadata?.plan || 'essential'
              if (clientEmail) {
                await (req as any).payload.db.execute({
                  sql: 'INSERT INTO client_subscriptions (email, plan, stripe_customer_id, stripe_subscription_id, stripe_session_id, status, current_period_end) VALUES (?, ?, ?, ?, ?, ?, ?)',
                  values: [
                    clientEmail.toLowerCase(),
                    plan,
                    session.customer || '',
                    session.subscription || '',
                    session.id,
                    'active',
                    new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
                  ],
                })
              }
            }
          }
          if (event.type === 'customer.subscription.deleted' || event.type === 'customer.subscription.updated') {
            const sub = event.data.object
            if (sub.status === 'canceled' || sub.status === 'unpaid') {
              await (req as any).payload.db.execute({
                sql: "UPDATE client_subscriptions SET status = 'cancelled', updated_at = datetime('now') WHERE stripe_subscription_id = ?",
                values: [sub.id],
              })
            }
          }
          return Response.json({ received: true })
        } catch (error) {
          return Response.json({ error: 'Webhook processing failed' }, { status: 400 })
        }
      },
    },
    // ====== CHECK INVOICE PAYMENT STATUS ======
    {
      path: '/client-portal/check-payment',
      method: 'get',
      handler: async (req) => {
        try {
          const url = new URL(req.url)
          const invoiceId = url.searchParams.get('invoiceId')
          if (!invoiceId) {
            return Response.json({ error: 'invoiceId is required' }, { status: 400 })
          }
          const invoice = await req.payload.findByID({ collection: 'invoices', id: invoiceId, depth: 0, overrideAccess: true })
          return Response.json({
            success: true,
            invoiceId: invoice.id,
            status: invoice.status,
            paidDate: invoice.paidDate,
            stripePaymentId: invoice.stripePaymentId,
          })
        } catch (error) {
          return Response.json({ error: 'Failed to check payment status' }, { status: 500 })
        }
      },
    },
    // ====== AI MARKETING CONTENT GENERATOR ======
    {
      path: '/marketing/generate-content',
      method: 'post',
      handler: async (req) => {
        try {
          const body = await req.json()
          const { platform, contentType, agencyId, customPrompt, agencyName: directName, location } = body

          // Get agency info for personalization
          let agencyName = directName || 'Your Home Care Agency'
          let agencyCity = ''
          let agencyState = ''
          if (location) {
            const parts = location.split(',').map((s: string) => s.trim())
            agencyCity = parts[0] || ''
            agencyState = parts[1] || ''
          }
          if (agencyId && !directName) {
            try {
              const agency = await req.payload.findByID({ collection: 'agencies', id: agencyId, depth: 0, overrideAccess: true })
              if (agency) {
                agencyName = agency.name || agencyName
                agencyCity = agencyCity || agency.addressCity || ''
                agencyState = agencyState || agency.addressState || ''
              }
            } catch (e) {}
          }

          const platformGuides = {
            facebook: 'Write for Facebook. Use engaging, conversational tone. 200-300 words. Include emojis sparingly.',
            instagram: 'Write for Instagram. Visual-first, use line breaks for readability. 150-200 words. Heavy emoji usage. End with CTA.',
            tiktok: 'Write for TikTok caption. Short, punchy, trendy. 100-150 words. Use trending language. Include hooks.',
            twitter: 'Write for X/Twitter. Concise, impactful. Under 280 characters for main message. Thread-friendly.',
            linkedin: 'Write for LinkedIn. Professional but warm tone. 200-300 words. Include industry insights.',
            google_business: 'Write for Google Business post. Local-focused. 150-200 words. Include location references.',
          }

          const contentTypeGuides = {
            care_tip: 'Share a practical health/wellness tip for families caring for elderly loved ones.',
            hiring: 'Create an exciting job posting for caregivers. Highlight benefits, growth, and purpose.',
            testimonial: 'Write a heartfelt (anonymized) client testimonial story. Make it emotional and authentic.',
            spotlight: 'Feature a caregiver team member. Celebrate their dedication and impact.',
            seasonal: 'Create seasonal/holiday content relevant to home care and senior wellness.',
            educational: 'Share educational content about home care industry, Medicare, insurance, or care planning.',
            behind_scenes: 'Show a day-in-the-life of a caregiver. Make it relatable and inspiring.',
            community: 'Highlight community involvement, local events, or volunteer work.',
          }

          const systemPrompt = `You are a social media marketing expert for home care agencies. You create engaging, HIPAA-compliant content that builds trust with families seeking care for their loved ones.

Agency: ${agencyName}${agencyCity ? `, based in ${agencyCity}, ${agencyState}` : ''}

Rules:
- NEVER use real patient/client names or identifiable information
- Always be warm, compassionate, and professional
- Include a clear call-to-action
- Make content shareable and engaging
- Use the agency's location for local relevance when possible

${platformGuides[platform] || platformGuides.facebook}
${contentTypeGuides[contentType] || contentTypeGuides.care_tip}

Return a JSON object with these fields:
{ "title": "short post title", "content": "the full post content", "hashtags": "relevant hashtags", "cta": "call to action text" }`

          const userPrompt = customPrompt || `Generate a ${contentType.replace('_', ' ')} post for ${platform} for ${agencyName}.`

          // Try OpenAI if key is available
          const { env } = await getCloudflareContext({ async: true })
          const openaiKey = env.OPENAI_API_KEY

          if (openaiKey) {
            const aiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${openaiKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [
                  { role: 'system', content: systemPrompt },
                  { role: 'user', content: userPrompt },
                ],
                temperature: 0.8,
                max_tokens: 1000,
              }),
            })

            const aiData = await aiResponse.json() as any
            if (aiData.error) {
              return Response.json({ success: false, error: aiData.error.message || 'OpenAI API error', code: aiData.error.code })
            }
            const aiText = aiData.choices?.[0]?.message?.content || ''

            // Try to parse JSON from response
            try {
              const jsonMatch = aiText.match(/\{[\s\S]*\}/)
              if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0])
                return Response.json({
                  success: true,
                  title: parsed.title || 'Untitled Post',
                  content: parsed.content || aiText,
                  hashtags: parsed.hashtags || '',
                  cta: parsed.cta || '',
                  ai_generated: true,
                  model: 'gpt-4o-mini',
                })
              }
            } catch (e) {}

            return Response.json({
              success: true,
              title: 'AI Generated Post',
              content: aiText,
              hashtags: '',
              cta: '',
              ai_generated: true,
              model: 'gpt-4o-mini',
            })
          }

          // Fallback: return template-based content
          return Response.json({
            success: false,
            error: 'OPENAI_API_KEY not configured. Using template content.',
            useTemplate: true,
          })
        } catch (error) {
          return Response.json({ error: 'Failed to generate content' }, { status: 500 })
        }
      },
    },
    // --- Marketing Posts CRUD ---
    {
      path: '/marketing/posts',
      method: 'post',
      handler: async (req) => {
        try {
          const body = await req.json()
          const { agency_id, platform, content, title, hashtags, cta, status, scheduled_at, post_type, media_url, ai_generated } = body
          
          if (!agency_id || !platform || !content) {
            return Response.json({ success: false, error: 'agency_id, platform, and content are required' }, { status: 400 })
          }
          
          const post = await req.payload.create({
            collection: 'marketing-posts',
            data: {
              agency_id: Number(agency_id),
              platform: platform || 'facebook',
              title: title || '',
              content,
              hashtags: hashtags || '',
              cta: cta || '',
              status: status || 'draft',
              scheduled_at: scheduled_at || '',
              post_type: post_type || 'text',
              media_url: media_url || '',
              ai_generated: ai_generated || false,
              engagement_likes: 0,
              engagement_comments: 0,
              engagement_shares: 0,
            },
            overrideAccess: true,
          })
          
          return Response.json({ success: true, post })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500 })
        }
      },
    },
    {
      path: '/marketing/posts',
      method: 'get',
      handler: async (req) => {
        try {
          const url = new URL(req.url)
          const agency_id = url.searchParams.get('agency_id')
          const status = url.searchParams.get('status')
          const platform = url.searchParams.get('platform')
          const limit = parseInt(url.searchParams.get('limit') || '50')
          
          if (!agency_id) {
            return Response.json({ success: false, error: 'agency_id is required' }, { status: 400 })
          }
          
          const where: any = { agency_id: { equals: Number(agency_id) } }
          if (status) where.status = { equals: status }
          if (platform) where.platform = { equals: platform }
          
          const posts = await req.payload.find({
            collection: 'marketing-posts',
            where,
            limit,
            sort: '-createdAt',
            overrideAccess: true,
          })
          
          return Response.json({ success: true, posts: posts.docs, totalDocs: posts.totalDocs })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500 })
        }
      },
    },
    {
      path: '/marketing/posts',
      method: 'patch' as any,
      handler: async (req) => {
        try {
          const body = await req.json()
          const { id, ...updates } = body
          
          if (!id) {
            return Response.json({ success: false, error: 'id is required' }, { status: 400 })
          }
          
          const post = await req.payload.update({
            collection: 'marketing-posts',
            id,
            data: updates,
            overrideAccess: true,
          })
          
          return Response.json({ success: true, post })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500 })
        }
      },
    },
    {
      path: '/marketing/posts',
      method: 'delete' as any,
      handler: async (req) => {
        try {
          const url = new URL(req.url)
          const id = url.searchParams.get('id')
          
          if (!id) {
            return Response.json({ success: false, error: 'id is required' }, { status: 400 })
          }
          
          await req.payload.delete({
            collection: 'marketing-posts',
            id,
            overrideAccess: true,
          })
          
          return Response.json({ success: true, message: 'Post deleted' })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500 })
        }
      },
    },
    // --- Social Account / Platform Connection ---
    {
      path: '/marketing/connect-platform',
      method: 'post',
      handler: async (req) => {
        try {
          const body = await req.json()
          const { agency_id, platform, account_name, account_id, access_token, token_expires_at } = body
          
          if (!agency_id || !platform) {
            return Response.json({ success: false, error: 'agency_id and platform are required' }, { status: 400 })
          }
          
          // Check if already connected
          const existing = await req.payload.find({
            collection: 'social-accounts',
            where: {
              and: [
                { agency_id: { equals: Number(agency_id) } },
                { platform: { equals: platform } },
              ]
            },
            overrideAccess: true,
          })
          
          if (existing.docs.length > 0) {
            // Update existing
            const updated = await req.payload.update({
              collection: 'social-accounts',
              id: existing.docs[0].id,
              data: {
                account_name: account_name || '',
                account_id: account_id || '',
                access_token: access_token || '',
                token_expires_at: token_expires_at || '',
                is_connected: true,
              },
              overrideAccess: true,
            })
            return Response.json({ success: true, account: updated })
          }
          
          const account = await req.payload.create({
            collection: 'social-accounts',
            data: {
              agency_id: Number(agency_id),
              platform,
              account_name: account_name || '',
              account_id: account_id || '',
              access_token: access_token || '',
              token_expires_at: token_expires_at || '',
              is_connected: true,
            },
            overrideAccess: true,
          })
          
          return Response.json({ success: true, account })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500 })
        }
      },
    },
    // ====== CREATE SUBSCRIPTION CHECKOUT ======
    {
      path: '/create-subscription-checkout',
      method: 'post',
      handler: async (req) => {
        try {
          const body = await req.json()
          const { email, plan } = body
          if (!email || !plan) return Response.json({ error: 'email and plan required' }, { status: 400 })

          const priceMap: Record<string, string> = {
            essential: 'price_1TQhO56E8zcVOY4tJyqfoiwi',
            family: 'price_1TQhO56E8zcVOY4t4q1gjG7a',
            premium: 'price_1TQhO66E8zcVOY4tmYqFthdT',
          }
          const priceId = priceMap[plan.toLowerCase()]
          if (!priceId) return Response.json({ error: 'Invalid plan' }, { status: 400 })

          const stripeKey = cloudflare.env.STRIPE_SECRET_KEY
          const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${stripeKey}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
              'mode': 'subscription',
              'customer_email': email,
              'line_items[0][price]': priceId,
              'line_items[0][quantity]': '1',
              'success_url': 'https://gotocare-client-portal.pages.dev/?subscription=success&plan=' + plan + '&email=' + encodeURIComponent(email),
              'cancel_url': 'https://gotocare-client-portal.pages.dev/?subscription=cancelled',
              'metadata[plan]': plan,
              'metadata[client_email]': email,
              'metadata[type]': 'client_subscription',
              'allow_promotion_codes': 'true',
            }).toString(),
          })
          const session = await stripeRes.json() as any
          if (!session.url) return Response.json({ error: 'Stripe session failed', details: session }, { status: 500 })
          return Response.json({ success: true, url: session.url, sessionId: session.id })
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 })
        }
      },
    },
    // ====== CHECK SUBSCRIPTION STATUS ======
    {
      path: '/check-subscription',
      method: 'get',
      handler: async (req) => {
        try {
          const url = new URL(req.url)
          const email = url.searchParams.get('email')
          if (!email) return Response.json({ subscribed: false, error: 'email required' }, { status: 400 })

          const db = (req as any).payload?.db?.drizzle || (globalThis as any).D1
          // Use raw D1 query via the adapter
          const result = await (req as any).payload.db.execute({
            sql: 'SELECT * FROM client_subscriptions WHERE email = ? AND status = ? ORDER BY created_at DESC LIMIT 1',
            values: [email.toLowerCase(), 'active'],
          })
          const sub = result?.rows?.[0] || null
          if (!sub) return Response.json({ subscribed: false, plan: null })
          // Check if subscription is still valid
          const now = new Date()
          const periodEnd = sub.current_period_end ? new Date(sub.current_period_end) : null
          const isValid = !periodEnd || periodEnd > now
          return Response.json({
            subscribed: isValid,
            plan: sub.plan,
            status: sub.status,
            currentPeriodEnd: sub.current_period_end,
            contactUnlocksUsed: sub.contact_unlocks_used || 0,
          })
        } catch (error) {
          return Response.json({ subscribed: false, error: String(error) }, { status: 500 })
        }
      },
    },
    // ====== UNLOCK CAREGIVER CONTACT ======
    {
      path: '/unlock-contact',
      method: 'post',
      handler: async (req) => {
        try {
          const body = await req.json()
          const { email, caregiverId } = body
          if (!email || !caregiverId) return Response.json({ error: 'email and caregiverId required' }, { status: 400 })

          // Check subscription
          const subResult = await (req as any).payload.db.execute({
            sql: 'SELECT * FROM client_subscriptions WHERE email = ? AND status = ? ORDER BY created_at DESC LIMIT 1',
            values: [email.toLowerCase(), 'active'],
          })
          const sub = subResult?.rows?.[0]
          if (!sub) return Response.json({ error: 'No active subscription', requiresSubscription: true }, { status: 403 })

          // Check if already unlocked
          const unlockCheck = await (req as any).payload.db.execute({
            sql: 'SELECT id FROM client_contact_unlocks WHERE client_email = ? AND caregiver_id = ?',
            values: [email.toLowerCase(), caregiverId],
          })
          if (unlockCheck?.rows?.length > 0) {
            // Already unlocked — get caregiver contact info
          } else {
            // Check monthly limit for essential plan
            if (sub.plan === 'essential') {
              const month = new Date().toISOString().slice(0, 7)
              const countResult = await (req as any).payload.db.execute({
                sql: "SELECT COUNT(*) as cnt FROM client_contact_unlocks WHERE client_email = ? AND strftime('%Y-%m', unlocked_at) = ?",
                values: [email.toLowerCase(), month],
              })
              const count = countResult?.rows?.[0]?.cnt || 0
              if (count >= 5) return Response.json({ error: 'Monthly unlock limit reached. Upgrade to Family plan for unlimited unlocks.', limitReached: true }, { status: 403 })
            }
            // Record the unlock
            await (req as any).payload.db.execute({
              sql: 'INSERT INTO client_contact_unlocks (client_email, caregiver_id, subscription_id) VALUES (?, ?, ?)',
              values: [email.toLowerCase(), caregiverId, sub.id],
            })
          }

          // Get caregiver contact info
          const caregiver = await req.payload.findByID({ collection: 'caregivers', id: caregiverId, depth: 0, overrideAccess: true })
          return Response.json({
            success: true,
            contact: {
              phone: caregiver.phone || caregiver.phoneNumber || '',
              email: caregiver.email || '',
              name: `${caregiver.firstName} ${caregiver.lastName}`,
            },
          })
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 })
        }
      },
    },
    {
      path: '/marketing/platforms',
      method: 'get',
      handler: async (req) => {
        try {
          const url = new URL(req.url)
          const agency_id = url.searchParams.get('agency_id')
          
          if (!agency_id) {
            return Response.json({ success: false, error: 'agency_id is required' }, { status: 400 })
          }
          
          const accounts = await req.payload.find({
            collection: 'social-accounts',
            where: { agency_id: { equals: Number(agency_id) } },
            overrideAccess: true,
          })
          
          return Response.json({ success: true, platforms: accounts.docs })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500 })
        }
      },
    },

    // ====== SEARCH CAREGIVERS (marketplace) ======
    {
      path: '/search-caregivers',
      method: 'get',
      handler: async (req) => {
        try {
          const url = new URL(req.url)
          const location = url.searchParams.get('location') || ''
          const specialty = url.searchParams.get('specialty') || ''
          const page = parseInt(url.searchParams.get('page') || '1')
          const limit = parseInt(url.searchParams.get('limit') || '20')
          const where: any = { status: { equals: 'active' } }
          if (specialty) {
            where.specializations = { like: specialty }
          }
          const caregivers = await req.payload.find({
            collection: 'caregivers',
            where,
            limit,
            page,
            depth: 0,
            overrideAccess: true,
          })
          const mapped = caregivers.docs.map((cg: any) => ({
            id: cg.id,
            firstName: cg.firstName,
            lastName: cg.lastName,
            specializations: cg.specializations || cg.certifications || '',
            skills: cg.skills || [],
            hourlyRate: cg.hourlyRate || 28,
            rating: cg.rating || 4.8,
            reviews: cg.reviews || 0,
            yearsExp: cg.experienceYears || 3,
            bio: cg.bio || '',
            languages: cg.languages || 'English',
            availability: cg.availability || [1,1,1,1,1,0,0],
            avatar: '\u{1F469}\u200D\u2695\uFE0F',
            matchScore: 85 + Math.floor(Math.random() * 12),
          }))
          return Response.json({ success: true, caregivers: mapped, totalDocs: caregivers.totalDocs })
        } catch (error) {
          return Response.json({ success: false, caregivers: [], error: String(error) }, { status: 500 })
        }
      },
    },
    // ====== SUBMIT BOOKING (marketplace) ======
    {
      path: '/submit-booking',
      method: 'post',
      handler: async (req) => {
        try {
          const body = await req.json()
          const { caregiverId, clientName, clientEmail, clientPhone, careNeeds, startDate, hours } = body
          await req.payload.create({
            collection: 'leads',
            data: {
              firstName: clientName?.split(' ')[0] || 'Guest',
              lastName: clientName?.split(' ').slice(1).join(' ') || '',
              email: clientEmail || '',
              phone: clientPhone || '',
              careType: Array.isArray(careNeeds) ? careNeeds[0] : careNeeds || 'home_care',
              message: `Booking request: ${hours} hours starting ${startDate}. Care needs: ${Array.isArray(careNeeds) ? careNeeds.join(', ') : careNeeds}`,
              source: 'marketplace',
              status: 'new',
            },
            overrideAccess: true,
          })
          return Response.json({ success: true, message: 'Booking submitted' })
        } catch (error) {
          return Response.json({ success: true, message: 'Booking noted' })
        }
      },
    },
    // ====== CREATE MARKETPLACE CHECKOUT ======
    {
      path: '/create-marketplace-checkout',
      method: 'post',
      handler: async (req) => {
        try {
          const body = await req.json()
          const { caregiverId, clientEmail, clientName, hours, careNeeds, startDate } = body
          const stripeKey = cloudflare.env.STRIPE_SECRET_KEY
          const hourlyRate = 28
          const total = Math.round(hours * hourlyRate * 1.1 * 100)
          const needs = Array.isArray(careNeeds) ? careNeeds.join(', ') : (careNeeds || 'Home Care')
          const params = new URLSearchParams({
            'mode': 'payment',
            'line_items[0][price_data][currency]': 'usd',
            'line_items[0][price_data][product_data][name]': `Care Session — ${needs}`,
            'line_items[0][price_data][product_data][description]': `${hours} hours on ${startDate}`,
            'line_items[0][price_data][unit_amount]': String(total),
            'line_items[0][quantity]': '1',
            'customer_email': clientEmail || '',
            'success_url': 'https://gotocare-client-portal.pages.dev/?booking=success',
            'cancel_url': 'https://gotocare-client-portal.pages.dev/?booking=cancelled',
            'metadata[caregiver_id]': String(caregiverId || ''),
            'metadata[type]': 'marketplace_booking',
          })
          const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
          })
          const session = await stripeRes.json() as any
          if (!session.url) return Response.json({ error: 'Checkout failed', demo: true })
          return Response.json({ success: true, url: session.url })
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 })
        }
      },
    },
    // ====== BOOK INTERVIEW ======
    {
      path: '/book-interview',
      method: 'post',
      handler: async (req) => {
        try {
          const body = await req.json()
          const { caregiverId, clientEmail, careNeeds, preferredDate, preferredTime, interviewType, notes } = body
          if (!caregiverId || !clientEmail || !preferredDate) {
            return Response.json({ error: 'caregiverId, clientEmail, preferredDate required' }, { status: 400 })
          }
          await cloudflare.env.D1.prepare(
            'INSERT INTO caregiver_bookings (caregiver_id, client_email, care_needs, preferred_date, preferred_time, interview_type, notes, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(String(caregiverId), clientEmail.toLowerCase(), careNeeds || '', preferredDate, preferredTime || '', interviewType || 'video', notes || '', 'pending').run()
          return Response.json({ success: true, message: 'Interview request sent' })
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 })
        }
      },
    },
    // ====== GET CAREGIVER BOOKINGS ======
    {
      path: '/caregiver-bookings',
      method: 'get',
      handler: async (req) => {
        try {
          const url = new URL(req.url)
          const caregiverId = url.searchParams.get('caregiverId')
          if (!caregiverId) return Response.json({ error: 'caregiverId required' }, { status: 400 })
          const result = await cloudflare.env.D1.prepare(
            'SELECT * FROM caregiver_bookings WHERE caregiver_id = ? ORDER BY created_at DESC LIMIT 50'
          ).bind(String(caregiverId)).all()
          const bookings = (result.results || []).map((b: any) => ({
            id: b.id,
            clientEmail: b.is_unlocked ? b.client_email : (b.client_email ? b.client_email.substring(0, 2) + '***@***' : ''),
            careNeeds: b.care_needs,
            preferredDate: b.is_unlocked ? b.preferred_date : null,
            preferredTime: b.is_unlocked ? b.preferred_time : null,
            interviewType: b.interview_type,
            notes: b.is_unlocked ? b.notes : '',
            status: b.status,
            isUnlocked: b.is_unlocked === 1,
            createdAt: b.created_at,
          }))
          return Response.json({ success: true, bookings })
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 })
        }
      },
    },
    // ====== UNLOCK BOOKING ($4.99 one-time) ======
    {
      path: '/unlock-booking',
      method: 'post',
      handler: async (req) => {
        try {
          const body = await req.json()
          const { bookingId, caregiverId } = body
          if (!bookingId) return Response.json({ error: 'bookingId required' }, { status: 400 })
          const stripeKey = cloudflare.env.STRIPE_SECRET_KEY
          const params = new URLSearchParams({
            'mode': 'payment',
            'line_items[0][price]': 'price_1TQmae6E8zcVOY4tSunkjW89',
            'line_items[0][quantity]': '1',
            'success_url': 'https://gotocare-caregiver-portal.pages.dev/?booking_unlocked=' + bookingId,
            'cancel_url': 'https://gotocare-caregiver-portal.pages.dev/?booking_cancelled=1',
            'metadata[booking_id]': String(bookingId),
            'metadata[caregiver_id]': String(caregiverId || ''),
            'metadata[type]': 'booking_unlock',
          })
          const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
          })
          const session = await stripeRes.json() as any
          if (!session.url) return Response.json({ error: 'Stripe session failed', details: session }, { status: 500 })
          return Response.json({ success: true, url: session.url })
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 })
        }
      },
    },
    // ====== CREATE CAREGIVER SUBSCRIPTION ($19.99/mo) ======
    {
      path: '/create-caregiver-subscription-checkout',
      method: 'post',
      handler: async (req) => {
        try {
          const body = await req.json()
          const { caregiverId } = body
          const stripeKey = cloudflare.env.STRIPE_SECRET_KEY
          const params = new URLSearchParams({
            'mode': 'subscription',
            'line_items[0][price]': 'price_1TQmcY6E8zcVOY4tSOJ9E3X2',
            'line_items[0][quantity]': '1',
            'success_url': 'https://gotocare-caregiver-portal.pages.dev/?subscription=success&caregiver=' + (caregiverId || ''),
            'cancel_url': 'https://gotocare-caregiver-portal.pages.dev/?subscription=cancelled',
            'metadata[caregiver_id]': String(caregiverId || ''),
            'metadata[type]': 'caregiver_subscription',
          })
          const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
          })
          const session = await stripeRes.json() as any
          if (!session.url) return Response.json({ error: 'Stripe session failed', details: session }, { status: 500 })
          return Response.json({ success: true, url: session.url })
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 })
        }
      },
    },

    // ====== UPDATE BOOKING STATUS (caregiver accept/decline) ======
    {
      path: '/update-booking',
      method: 'post',
      handler: async (req) => {
        try {
          const body = await req.json()
          const { bookingId, status } = body
          if (!bookingId || !['accepted', 'declined'].includes(status)) {
            return Response.json({ error: 'bookingId and valid status (accepted/declined) required' }, { status: 400 })
          }
          await cloudflare.env.D1.prepare(
            'UPDATE caregiver_bookings SET status = ? WHERE id = ?'
          ).bind(status, Number(bookingId)).run()
          return Response.json({ success: true, bookingId, status })
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 })
        }
      },
    },
    // ====== MY BOOKINGS (client view their interview requests) ======
    {
      path: '/my-bookings',
      method: 'get',
      handler: async (req) => {
        try {
          const url = new URL(req.url)
          const email = url.searchParams.get('email')
          if (!email) return Response.json({ error: 'email required' }, { status: 400 })
          const result = await cloudflare.env.D1.prepare(
            'SELECT * FROM caregiver_bookings WHERE client_email = ? ORDER BY created_at DESC LIMIT 50'
          ).bind(email.toLowerCase()).all()
          const bookings = (result.results || []).map((b: any) => ({
            id: b.id,
            caregiverId: b.caregiver_id,
            careNeeds: b.care_needs,
            preferredDate: b.preferred_date,
            preferredTime: b.preferred_time,
            interviewType: b.interview_type,
            notes: b.notes,
            status: b.status,
            createdAt: b.created_at,
          }))
          return Response.json({ success: true, bookings })
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 })
        }
      },
    },


    // ====== CAREGIVER SELF-REGISTRATION ======
    {
      path: '/caregiver-register',
      method: 'post',
      handler: async (req) => {
        try {
          const body = await req.json()
          const { name, email, password } = body
          if (!email) return Response.json({ error: 'email required' }, { status: 400 })
          if (!password) return Response.json({ error: 'password required' }, { status: 400 })

          const existing = await cloudflare.env.D1.prepare(
            'SELECT id FROM caregiver_accounts WHERE email = ?'
          ).bind(email.toLowerCase()).first()
          if (existing) return Response.json({ error: 'Account already exists. Sign in instead.' }, { status: 409 })

          const salt = crypto.randomUUID()
          const enc = new TextEncoder()
          const hashBuffer = await crypto.subtle.digest('SHA-256', enc.encode(password + salt))
          const passwordHash = Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('')

          await cloudflare.env.D1.prepare(
            'INSERT INTO caregiver_accounts (email, name, password_hash, salt) VALUES (?, ?, ?, ?)'
          ).bind(email.toLowerCase(), name || '', passwordHash, salt).run()

          const account = await cloudflare.env.D1.prepare(
            'SELECT id, email, name, setup_complete FROM caregiver_accounts WHERE email = ?'
          ).bind(email.toLowerCase()).first()

          const token = crypto.randomUUID() + '-' + crypto.randomUUID()
          await cloudflare.env.D1.prepare(
            "INSERT INTO caregiver_sessions (token, account_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))"
          ).bind(token, account.id).run()

          return Response.json({
            success: true,
            token,
            account: { id: account.id, email: account.email, name: account.name, setupComplete: false },
          })
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 })
        }
      },
    },

    // ====== CAREGIVER LOGIN ======
    {
      path: '/caregiver-login',
      method: 'post',
      handler: async (req) => {
        try {
          const body = await req.json()
          const { email, password } = body
          if (!email || !password) return Response.json({ error: 'email and password required' }, { status: 400 })

          const account = await cloudflare.env.D1.prepare(
            "SELECT * FROM caregiver_accounts WHERE email = ? AND status = 'active'"
          ).bind(email.toLowerCase()).first()
          if (!account) return Response.json({ error: 'Invalid email or password' }, { status: 401 })

          const enc = new TextEncoder()
          const hashBuffer = await crypto.subtle.digest('SHA-256', enc.encode(password + account.salt))
          const passwordHash = Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('')
          if (passwordHash !== account.password_hash) return Response.json({ error: 'Invalid email or password' }, { status: 401 })

          const token = crypto.randomUUID() + '-' + crypto.randomUUID()
          await cloudflare.env.D1.prepare(
            "INSERT INTO caregiver_sessions (token, account_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))"
          ).bind(token, account.id).run()

          return Response.json({
            success: true,
            token,
            account: {
              id: account.id,
              email: account.email,
              name: account.name,
              zipCode: account.zip_code || '',
              careTypes: account.care_types ? JSON.parse(account.care_types) : [],
              phone: account.phone || '',
              bio: account.bio || '',
              photoUrl: account.photo_url || '',
              setupComplete: account.setup_complete === 1 || account.setup_complete === true,
            },
          })
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 })
        }
      },
    },

    // ====== GOOGLE OAUTH FOR CAREGIVERS ======
    {
      path: '/caregiver-auth/google',
      method: 'post',
      handler: async (req) => {
        try {
          const body = await req.json()
          const { credential } = body
          if (!credential) return Response.json({ error: 'Google credential required' }, { status: 400 })

          const tokenRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`)
          const tokenData = await tokenRes.json() as any
          if (tokenData.error) return Response.json({ error: 'Invalid Google token' }, { status: 401 })

          const googleSub = tokenData.sub
          const email = tokenData.email?.toLowerCase()
          const name = tokenData.name || ((tokenData.given_name || '') + ' ' + (tokenData.family_name || '')).trim()
          const picture = tokenData.picture || ''

          if (!email || !googleSub) return Response.json({ error: 'Invalid Google token payload' }, { status: 401 })

          let account = await cloudflare.env.D1.prepare(
            'SELECT * FROM caregiver_accounts WHERE google_sub = ? OR email = ?'
          ).bind(googleSub, email).first()

          if (!account) {
            await cloudflare.env.D1.prepare(
              'INSERT INTO caregiver_accounts (email, name, google_sub, photo_url) VALUES (?, ?, ?, ?)'
            ).bind(email, name, googleSub, picture).run()
            account = await cloudflare.env.D1.prepare(
              'SELECT * FROM caregiver_accounts WHERE email = ?'
            ).bind(email).first()
          } else if (!account.google_sub) {
            await cloudflare.env.D1.prepare(
              'UPDATE caregiver_accounts SET google_sub = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
            ).bind(googleSub, account.id).run()
          }

          const token = crypto.randomUUID() + '-' + crypto.randomUUID()
          await cloudflare.env.D1.prepare(
            "INSERT INTO caregiver_sessions (token, account_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))"
          ).bind(token, account.id).run()

          return Response.json({
            success: true,
            token,
            account: {
              id: account.id,
              email: account.email,
              name: account.name || name,
              zipCode: account.zip_code || '',
              careTypes: account.care_types ? JSON.parse(account.care_types) : [],
              phone: account.phone || '',
              bio: account.bio || '',
              photoUrl: account.photo_url || picture,
              setupComplete: account.setup_complete === 1 || account.setup_complete === true,
            },
          })
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 })
        }
      },
    },

    // ====== VALIDATE CAREGIVER SESSION ======
    {
      path: '/caregiver-account',
      method: 'get',
      handler: async (req) => {
        try {
          const url = new URL(req.url)
          const token = url.searchParams.get('token') || req.headers.get('x-caregiver-token') || ''
          if (!token) return Response.json({ error: 'token required' }, { status: 401 })

          const session = await cloudflare.env.D1.prepare(
            "SELECT account_id FROM caregiver_sessions WHERE token = ? AND expires_at > datetime('now')"
          ).bind(token).first()
          if (!session) return Response.json({ error: 'Session expired. Please sign in again.' }, { status: 401 })

          const account = await cloudflare.env.D1.prepare(
            'SELECT id, email, name, zip_code, care_types, phone, bio, photo_url, setup_complete FROM caregiver_accounts WHERE id = ?'
          ).bind(session.account_id).first()
          if (!account) return Response.json({ error: 'Account not found' }, { status: 404 })

          return Response.json({
            success: true,
            account: {
              id: account.id,
              email: account.email,
              name: account.name,
              zipCode: account.zip_code || '',
              careTypes: account.care_types ? JSON.parse(account.care_types) : [],
              phone: account.phone || '',
              bio: account.bio || '',
              photoUrl: account.photo_url || '',
              setupComplete: account.setup_complete === 1 || account.setup_complete === true,
            },
          })
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 })
        }
      },
    },

    // ====== CAREGIVER PROFILE SETUP (post-registration) ======
    {
      path: '/caregiver-setup',
      method: 'post',
      handler: async (req) => {
        try {
          const body = await req.json()
          const { token, zipCode, careTypes, name, phone, bio } = body
          if (!token) return Response.json({ error: 'token required' }, { status: 401 })

          const session = await cloudflare.env.D1.prepare(
            "SELECT account_id FROM caregiver_sessions WHERE token = ? AND expires_at > datetime('now')"
          ).bind(token).first()
          if (!session) return Response.json({ error: 'Session expired' }, { status: 401 })

          await cloudflare.env.D1.prepare(
            'UPDATE caregiver_accounts SET zip_code = ?, care_types = ?, setup_complete = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
          ).bind(zipCode || '', JSON.stringify(careTypes || []), session.account_id).run()

          if (name) {
            await cloudflare.env.D1.prepare(
              'UPDATE caregiver_accounts SET name = ? WHERE id = ? AND (name = "" OR name IS NULL)'
            ).bind(name, session.account_id).run()
          }

          return Response.json({ success: true, message: 'Profile setup complete' })
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 })
        }
      },
    },


    // ====== CLIENT SELF-REGISTRATION ======
    {
      path: '/client-register',
      method: 'post',
      handler: async (req) => {
        try {
          const body = await req.json()
          const { name, email, password } = body
          if (!email) return Response.json({ error: 'email required' }, { status: 400 })
          if (!password) return Response.json({ error: 'password required' }, { status: 400 })

          const existing = await cloudflare.env.D1.prepare(
            'SELECT id FROM client_accounts WHERE email = ?'
          ).bind(email.toLowerCase()).first()
          if (existing) return Response.json({ error: 'Account already exists. Sign in instead.' }, { status: 409 })

          const salt = crypto.randomUUID()
          const enc = new TextEncoder()
          const hashBuffer = await crypto.subtle.digest('SHA-256', enc.encode(password + salt))
          const passwordHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('')

          await cloudflare.env.D1.prepare(
            'INSERT INTO client_accounts (email, password_hash, salt, name) VALUES (?, ?, ?, ?)'
          ).bind(email.toLowerCase(), passwordHash, salt, name || '').run()

          const sessionToken = crypto.randomUUID() + '-' + crypto.randomUUID()
          const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
          await cloudflare.env.D1.prepare(
            'INSERT INTO client_sessions (email, session_token, expires_at) VALUES (?, ?, ?)'
          ).bind(email.toLowerCase(), sessionToken, expiresAt).run()

          return Response.json({ success: true, sessionToken, name: name || '', email: email.toLowerCase() })
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 })
        }
      },
    },

    // ====== CLIENT EMAIL LOGIN ======
    {
      path: '/client-auth/login',
      method: 'post',
      handler: async (req) => {
        try {
          const body = await req.json()
          const { email, password } = body
          if (!email || !password) return Response.json({ error: 'email and password required' }, { status: 400 })

          const account = await cloudflare.env.D1.prepare(
            'SELECT * FROM client_accounts WHERE email = ?'
          ).bind(email.toLowerCase()).first() as any
          if (!account) return Response.json({ error: 'No account found. Please register first.' }, { status: 404 })

          const enc = new TextEncoder()
          const hashBuffer = await crypto.subtle.digest('SHA-256', enc.encode(password + account.salt))
          const passwordHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('')
          if (passwordHash !== account.password_hash) return Response.json({ error: 'Incorrect password.' }, { status: 401 })

          const sessionToken = crypto.randomUUID() + '-' + crypto.randomUUID()
          const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
          await cloudflare.env.D1.prepare(
            'INSERT INTO client_sessions (email, session_token, expires_at) VALUES (?, ?, ?)'
          ).bind(email.toLowerCase(), sessionToken, expiresAt).run()

          return Response.json({ success: true, sessionToken, name: account.name || '', email: email.toLowerCase() })
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 })
        }
      },
    },

    // ====== CLIENT GOOGLE AUTH ======
    {
      path: '/client-auth/google',
      method: 'post',
      handler: async (req) => {
        try {
          const body = await req.json()
          const { idToken, name, email, googleId } = body
          if (!email) return Response.json({ error: 'email required' }, { status: 400 })

          const existing = await cloudflare.env.D1.prepare(
            'SELECT * FROM client_accounts WHERE email = ?'
          ).bind(email.toLowerCase()).first() as any

          if (!existing) {
            await cloudflare.env.D1.prepare(
              'INSERT INTO client_accounts (email, name, google_id) VALUES (?, ?, ?)'
            ).bind(email.toLowerCase(), name || '', googleId || '').run()
          } else if (!existing.google_id && googleId) {
            await cloudflare.env.D1.prepare(
              'UPDATE client_accounts SET google_id = ?, name = COALESCE(NULLIF(name,""), ?) WHERE email = ?'
            ).bind(googleId, name || '', email.toLowerCase()).run()
          }

          const sessionToken = crypto.randomUUID() + '-' + crypto.randomUUID()
          const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
          await cloudflare.env.D1.prepare(
            'INSERT INTO client_sessions (email, session_token, expires_at) VALUES (?, ?, ?)'
          ).bind(email.toLowerCase(), sessionToken, expiresAt).run()

          const account = await cloudflare.env.D1.prepare(
            'SELECT * FROM client_accounts WHERE email = ?'
          ).bind(email.toLowerCase()).first() as any

          return Response.json({ success: true, sessionToken, name: account?.name || name || '', email: email.toLowerCase() })
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 })
        }
      },
    },

    // ====== VALIDATE CLIENT SESSION ======
    {
      path: '/client-account',
      method: 'get',
      handler: async (req) => {
        try {
          const url = new URL(req.url)
          const token = url.searchParams.get('token') || req.headers.get('x-session-token') || ''
          if (!token) return Response.json({ error: 'token required' }, { status: 400 })

          const session = await cloudflare.env.D1.prepare(
            'SELECT * FROM client_sessions WHERE session_token = ?'
          ).bind(token).first() as any
          if (!session) return Response.json({ valid: false, error: 'Session not found' }, { status: 401 })

          const now = new Date()
          const expiresAt = new Date(session.expires_at)
          if (expiresAt < now) return Response.json({ valid: false, error: 'Session expired' }, { status: 401 })

          const account = await cloudflare.env.D1.prepare(
            'SELECT id, email, name, zip, care_types, created_at FROM client_accounts WHERE email = ?'
          ).bind(session.email).first() as any
          if (!account) return Response.json({ valid: false, error: 'Account not found' }, { status: 404 })

          return Response.json({
            valid: true,
            account: {
              id: account.id,
              email: account.email,
              name: account.name || '',
              zip: account.zip || '',
              careTypes: account.care_types ? JSON.parse(account.care_types) : [],
            },
          })
        } catch (error) {
          return Response.json({ valid: false, error: String(error) }, { status: 500 })
        }
      },
    },
    // ====== CLIENT TEAM (active + past caregivers) ======
    {
      path: '/client-team',
      method: 'get',
      handler: async (req) => {
        try {
          const url = new URL(req.url)
          const token = url.searchParams.get('token')
          if (!token) return Response.json({ error: 'token required' }, { status: 400 })

          // Validate client session
          const session = await cloudflare.env.D1.prepare(
            'SELECT email FROM client_sessions WHERE token = ? AND expires_at > datetime("now")'
          ).bind(token).first()
          if (!session) return Response.json({ error: 'Invalid or expired session' }, { status: 401 })

          const email = (session as any).email as string
          const today = new Date().toISOString().split('T')[0]

          // Get all accepted bookings for this client
          const result = await cloudflare.env.D1.prepare(
            'SELECT * FROM caregiver_bookings WHERE client_email = ? AND status = ? ORDER BY preferred_date DESC LIMIT 50'
          ).bind(email.toLowerCase(), 'accepted').all()

          const bookings = result.results || []
          const active: any[] = []
          const past: any[] = []

          for (const b of bookings as any[]) {
            // Get caregiver info from caregiver_accounts
            const cg = await cloudflare.env.D1.prepare(
              'SELECT id, name, email, zip, care_types, created_at FROM caregiver_accounts WHERE id = ?'
            ).bind(Number(b.caregiver_id)).first() as any

            const careTypes = cg?.care_types
              ? (typeof cg.care_types === 'string' ? (() => { try { return JSON.parse(cg.care_types) } catch { return [] } })() : cg.care_types)
              : []

            const caregiverInfo = {
              id: b.caregiver_id,
              name: cg?.name || 'Caregiver',
              email: cg?.email || '',
              zip: cg?.zip || '',
              careTypes: careTypes,
              specialty: Array.isArray(careTypes) && careTypes.length > 0 ? careTypes[0] : 'Home Care',
              preferredDate: b.preferred_date,
              preferredTime: b.preferred_time,
              interviewType: b.interview_type,
              status: b.status,
              bookingId: b.id,
              careNeeds: b.care_needs,
              createdAt: b.created_at,
            }

            if (b.preferred_date && b.preferred_date >= today) {
              active.push(caregiverInfo)
            } else {
              past.push(caregiverInfo)
            }
          }

          return Response.json({ success: true, active, past, email })
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 })
        }
      },
    },



  ],
})
