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



// ═══════════════════════════════════════════════════════════════════════
// DISPATCH ENGINE — ZIP CENTROIDS + SCORING HELPERS
// ═══════════════════════════════════════════════════════════════════════
const _DISPATCH_ZIP_CENTROIDS: Record<string, { lat: number; lon: number }> = {
  '95823': { lat: 38.4895, lon: -121.4531 }, '95828': { lat: 38.4710, lon: -121.4007 },
  '95864': { lat: 38.5765, lon: -121.3817 }, '95814': { lat: 38.5816, lon: -121.4944 },
  '95816': { lat: 38.5682, lon: -121.4684 }, '95817': { lat: 38.5477, lon: -121.4540 },
  '95818': { lat: 38.5658, lon: -121.5070 }, '95819': { lat: 38.5681, lon: -121.4414 },
  '95820': { lat: 38.5348, lon: -121.4531 }, '95821': { lat: 38.6116, lon: -121.3797 },
  '95822': { lat: 38.5197, lon: -121.4876 }, '95824': { lat: 38.5143, lon: -121.4366 },
  '95825': { lat: 38.5790, lon: -121.4028 }, '95826': { lat: 38.5478, lon: -121.3853 },
  '95827': { lat: 38.5506, lon: -121.3605 }, '95829': { lat: 38.4841, lon: -121.3579 },
  '95831': { lat: 38.5013, lon: -121.5250 }, '95832': { lat: 38.4737, lon: -121.4882 },
  '95833': { lat: 38.6128, lon: -121.4954 }, '95834': { lat: 38.6384, lon: -121.4872 },
  '95835': { lat: 38.6715, lon: -121.4871 }, '95838': { lat: 38.6415, lon: -121.4418 },
  '95841': { lat: 38.6410, lon: -121.3494 }, '95842': { lat: 38.6713, lon: -121.3590 },
  '95843': { lat: 38.7003, lon: -121.3617 },
};
function _haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3959; const dLat = (lat2-lat1)*Math.PI/180; const dLon = (lon2-lon1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function _getZipDist(z1: string, z2: string): number {
  if (z1===z2) return 0;
  const c1=_DISPATCH_ZIP_CENTROIDS[z1]; const c2=_DISPATCH_ZIP_CENTROIDS[z2];
  return c1&&c2 ? _haversine(c1.lat,c1.lon,c2.lat,c2.lon) : 10;
}
function _dispatchScore(cg: any, careType: string, dist: number): number {
  const skills: string[] = JSON.parse(cg.skills||'[]'); const ct=careType.toLowerCase();
  const ctMatch = skills.some((s:string)=>s.toLowerCase()===ct)?35:skills.some((s:string)=>s.toLowerCase().includes(ct.split(' ')[0]))?20:0;
  const distScore = dist<=2?20:dist<=5?18:dist<=10?14:dist<=15?10:dist<=25?5:0;
  const onlineScore = cg.is_online?10:3; const trustScore=Math.min(100,cg.trust_score||50)/100*10;
  const respScore=cg.avg_response_minutes?Math.max(0,5-Math.min(5,cg.avg_response_minutes/20)):3;
  const ratingScore=(cg.avg_rating||4.0)/5*5; const availScore=skills.length>0?12:6;
  return Math.round(ctMatch+distScore+onlineScore+trustScore+respScore+ratingScore+availScore);
}
const _ROUND_DURATION_MINS=[2,3,5,10];
async function _findDispatchCgs(db: any, zip: string, careType: string, radius: number, limit: number): Promise<any[]> {
  const { results } = await db.prepare(`
    SELECT ca.id,ca.name,ca.zip_code,ca.skills,ca.hourly_rate,ca.photo_url,ca.city,ca.state,
           COALESCE(cos.is_online,0) as is_online, COALESCE(cts.score,50) as trust_score,
           COALESCE(crm.avg_response_minutes,60) as avg_response_minutes, COALESCE(crm.avg_rating,4.0) as avg_rating
    FROM caregiver_accounts ca
    LEFT JOIN caregiver_online_status cos ON cos.caregiver_id=ca.id
    LEFT JOIN caregiver_trust_scores cts ON cts.caregiver_id=ca.id
    LEFT JOIN caregiver_response_metrics crm ON crm.caregiver_id=ca.id
    WHERE ca.zip_code IS NOT NULL LIMIT 300
  `).all();
  return results.map((cg: any)=>{const d=_getZipDist(zip,cg.zip_code||'');return{...cg,distance_miles:Math.round(d*10)/10,dispatch_score:_dispatchScore(cg,careType,d)};}).filter((cg:any)=>cg.distance_miles<=radius).sort((a:any,b:any)=>b.dispatch_score-a.dispatch_score).slice(0,limit);
}
async function _signVAPIDJWT(endpoint: string, pubKey: string, privKeyB64: string): Promise<string> {
  const origin=new URL(endpoint).origin;
  const hdr=btoa(JSON.stringify({typ:'JWT',alg:'ES256'})).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const pay=btoa(JSON.stringify({aud:origin,exp:Math.floor(Date.now()/1000)+43200,sub:'mailto:hello@carehia.com'})).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const si=`${hdr}.${pay}`;
  const der=Uint8Array.from(atob(privKeyB64.replace(/-/g,'+').replace(/_/g,'/')),(c:string)=>c.charCodeAt(0));
  const ck=await crypto.subtle.importKey('pkcs8',der.buffer,{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
  const sig=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},ck,new TextEncoder().encode(si));
  const sb=btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  return `${si}.${sb}`;
}
async function _sendPushBatch(db: any, cgIds: number[], vapidPub: string, vapidPriv: string): Promise<number> {
  if(!cgIds.length||!vapidPriv||!vapidPub) return 0;
  const ph=cgIds.map(()=>'?').join(',');
  const {results:subs}=await db.prepare(`SELECT * FROM push_subscriptions WHERE caregiver_id IN (${ph})`).bind(...cgIds).all();
  let sent=0;
  for(const sub of subs){
    try{
      const jwt=await _signVAPIDJWT(sub.endpoint,vapidPub,vapidPriv);
      const r=await fetch(sub.endpoint,{method:'POST',headers:{'Authorization':`vapid t=${jwt},k=${vapidPub}`,'TTL':'86400','Content-Length':'0'}});
      if(r.ok){sent++;await db.prepare(`UPDATE push_subscriptions SET last_used_at=datetime('now') WHERE id=?`).bind(sub.id).run();}
      else if(r.status===410){await db.prepare(`DELETE FROM push_subscriptions WHERE id=?`).bind(sub.id).run();}
    }catch(_){}
  }
  return sent;
}

export default buildConfig({
  admin: {
    user: Users.slug,
    importMap: {
      baseDir: path.resolve(dirname),
    },
  },
  collections: [Users, Media, Agencies, Locations, Clients, Caregivers, Services, Shifts, Timesheets, Invoices, Leads, CaregiverDocuments, MarketingPosts, SocialAccounts],
  secret: process.env.PAYLOAD_SECRET || 'carehia-super-secret-key-2024',
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
<title>Payment Successful - Carehia</title>
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
<html><head><meta charset="utf-8"><title>Payment Cancelled - Carehia</title>
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
          // Send email nudge to caregiver (fire and forget)
          try {
            const cgRow = await cloudflare.env.D1.prepare(
              'SELECT name, email FROM caregiver_accounts WHERE id = ?'
            ).bind(String(caregiverId)).first() as any
            if (cgRow?.email) {
              const bookingRow = await cloudflare.env.D1.prepare(
                'SELECT last_insert_rowid() as id'
              ).first() as any
              fetch('https://gotocare-original.jjioji.workers.dev/api/send-booking-nudge', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  caregiverEmail: cgRow.email,
                  caregiverName: cgRow.name || '',
                }),
              }).catch(() => {})
            }
          } catch (e) {}
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


    // ====== RESCHEDULE BOOKING ======
    {
      path: '/reschedule-booking',
      method: 'post',
      handler: async (req) => {
        try {
          const body = await req.json()
          const { bookingId, clientEmail, preferredDate, preferredTime, interviewType, notes } = body
          if (!bookingId || !clientEmail) return Response.json({ error: 'bookingId and clientEmail required' }, { status: 400 })

          // Verify this booking belongs to the client
          const booking = await cloudflare.env.D1.prepare(
            'SELECT id, status FROM caregiver_bookings WHERE id = ? AND client_email = ?'
          ).bind(bookingId, clientEmail.toLowerCase()).first()
          if (!booking) return Response.json({ error: 'Booking not found' }, { status: 404 })
          if (booking.status === 'cancelled' || booking.status === 'hired') {
            return Response.json({ error: 'Cannot reschedule a ' + booking.status + ' booking' }, { status: 400 })
          }

          await cloudflare.env.D1.prepare(
            'UPDATE caregiver_bookings SET preferred_date = ?, preferred_time = ?, interview_type = ?, notes = ?, status = ? WHERE id = ? AND client_email = ?'
          ).bind(
            preferredDate || null,
            preferredTime || null,
            interviewType || 'video',
            notes || null,
            'pending',
            bookingId,
            clientEmail.toLowerCase()
          ).run()

          return Response.json({ success: true, message: 'Booking rescheduled successfully' })
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 })
        }
      },
    },

    // ====== CANCEL BOOKING ======
    {
      path: '/cancel-booking',
      method: 'post',
      handler: async (req) => {
        try {
          const body = await req.json()
          const { bookingId, clientEmail } = body
          if (!bookingId || !clientEmail) return Response.json({ error: 'bookingId and clientEmail required' }, { status: 400 })

          // Verify this booking belongs to the client
          const booking = await cloudflare.env.D1.prepare(
            'SELECT id, status FROM caregiver_bookings WHERE id = ? AND client_email = ?'
          ).bind(bookingId, clientEmail.toLowerCase()).first()
          if (!booking) return Response.json({ error: 'Booking not found' }, { status: 404 })
          if (booking.status === 'hired') {
            return Response.json({ error: 'Cannot cancel a hired booking' }, { status: 400 })
          }

          await cloudflare.env.D1.prepare(
            "UPDATE caregiver_bookings SET status = 'cancelled' WHERE id = ? AND client_email = ?"
          ).bind(bookingId, clientEmail.toLowerCase()).run()

          return Response.json({ success: true, message: 'Booking cancelled' })
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
            'SELECT id, email, name, zip_code, care_types, phone, bio, photo_url, setup_complete, city, state, languages, hourly_rate, skills, certifications FROM caregiver_accounts WHERE id = ?'
          ).bind(session.account_id).first()
          if (!account) return Response.json({ error: 'Account not found' }, { status: 404 })

          return Response.json({
            success: true,
            account: {
              id: account.id,
              email: account.email,
              name: account.name,
              zipCode: account.zip_code || '',
              careTypes: account.care_types ? (() => { try { return JSON.parse(account.care_types) } catch { return [] } })() : [],
              phone: account.phone || '',
              bio: account.bio || '',
              photoUrl: account.photo_url || '',
              setupComplete: account.setup_complete === 1 || account.setup_complete === true,
              city: account.city || '',
              state: account.state || '',
              languages: account.languages ? (() => { try { return JSON.parse(account.languages) } catch { return [] } })() : [],
              hourlyRate: account.hourly_rate || 0,
              skills: account.skills ? (() => { try { return JSON.parse(account.skills) } catch { return [] } })() : [],
              certifications: account.certifications ? (() => { try { return JSON.parse(account.certifications) } catch { return [] } })() : [],
            },
          })
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 })
        }
      },
    },


    // ====== CAREGIVER PROFILE UPDATE (D1-backed, all fields) ======
    {
      path: '/caregiver-profile',
      method: 'post',
      handler: async (req) => {
        try {
          const body = await req.json()
          const { token, name, phone, city, state, bio, hourlyRate, languages, skills, certifications, photoUrl } = body
          if (!token) return Response.json({ error: 'token required' }, { status: 401 })

          const session = await cloudflare.env.D1.prepare(
            "SELECT account_id FROM caregiver_sessions WHERE token = ? AND expires_at > datetime('now')"
          ).bind(token).first()
          if (!session) return Response.json({ error: 'Session expired. Please sign in again.' }, { status: 401 })

          const updates: string[] = []
          const values: any[] = []

          if (name !== undefined)          { updates.push('name = ?');          values.push(name) }
          if (phone !== undefined)         { updates.push('phone = ?');         values.push(phone) }
          if (city !== undefined)          { updates.push('city = ?');          values.push(city) }
          if (state !== undefined)         { updates.push('state = ?');         values.push(state) }
          if (bio !== undefined)           { updates.push('bio = ?');           values.push(bio) }
          if (hourlyRate !== undefined)    { updates.push('hourly_rate = ?');   values.push(hourlyRate) }
          if (languages !== undefined)     { updates.push('languages = ?');     values.push(JSON.stringify(languages)) }
          if (skills !== undefined)        { updates.push('skills = ?');        values.push(JSON.stringify(skills)) }
          if (certifications !== undefined){ updates.push('certifications = ?');values.push(JSON.stringify(certifications)) }
          if (photoUrl !== undefined)      { updates.push('photo_url = ?');     values.push(photoUrl) }

          if (updates.length === 0) return Response.json({ success: true, message: 'Nothing to update' })

          updates.push('updated_at = CURRENT_TIMESTAMP')
          values.push(session.account_id)

          await cloudflare.env.D1.prepare(
            `UPDATE caregiver_accounts SET ${updates.join(', ')} WHERE id = ?`
          ).bind(...values).run()

          return Response.json({ success: true, message: 'Profile updated' })
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
    // ====== CLIENT TEAM (hired + active bookings + past) ======
    {
      path: '/client-team',
      method: 'get',
      handler: async (req) => {
        try {
          const url = new URL(req.url)
          const token = url.searchParams.get('token')
          if (!token) return Response.json({ error: 'token required' }, { status: 400 })

          // Validate client session (field is session_token, not token)
          const session = await cloudflare.env.D1.prepare(
            'SELECT email FROM client_sessions WHERE session_token = ? AND expires_at > datetime("now")'
          ).bind(token).first() as any
          if (!session) return Response.json({ error: 'Invalid or expired session' }, { status: 401 })

          const clientEmail = session.email.toLowerCase()

          // ── 1. Formally hired caregivers from client_team ──
          const hiredRows = await cloudflare.env.D1.prepare(
            'SELECT * FROM client_team WHERE client_email = ? AND status = ? ORDER BY hired_at DESC'
          ).bind(clientEmail, 'active').all()

          const hired: any[] = []
          for (const row of (hiredRows.results || []) as any[]) {
            const cg = await cloudflare.env.D1.prepare(
              'SELECT id, name, email, photo_url, hourly_rate, skills, certifications, city, state, zip_code, care_types, bio FROM caregiver_accounts WHERE id = ?'
            ).bind(Number(row.caregiver_id)).first() as any

            const parseJSON = (v: any) => { try { return JSON.parse(v) } catch { return [] } }
            const careTypes = cg?.care_types ? parseJSON(cg.care_types) : []
            const skills = cg?.skills ? parseJSON(cg.skills) : []
            const certs = cg?.certifications ? parseJSON(cg.certifications) : []

            hired.push({
              id: cg?.id || row.caregiver_id,
              name: cg?.name || 'Caregiver',
              email: cg?.email || '',
              photoUrl: cg?.photo_url || null,
              hourlyRate: cg?.hourly_rate || 28,
              skills,
              certifications: certs,
              specialty: skills.length > 0 ? skills[0] : (careTypes.length > 0 ? careTypes[0] : 'Home Care'),
              city: cg?.city || '',
              state: cg?.state || '',
              bio: cg?.bio || '',
              bookingId: row.booking_id,
              hiredAt: row.hired_at,
              isHired: true,
            })
          }

          // ── 2. Accepted bookings NOT yet formally hired ──
          const hiredCgIds = hired.map((h: any) => h.id)
          const bookingResult = await cloudflare.env.D1.prepare(
            'SELECT * FROM caregiver_bookings WHERE client_email = ? AND status IN ("accepted") ORDER BY preferred_date DESC LIMIT 50'
          ).bind(clientEmail).all()

          const active: any[] = []
          for (const b of (bookingResult.results || []) as any[]) {
            if (hiredCgIds.includes(Number(b.caregiver_id))) continue // already in hired list
            const cg = await cloudflare.env.D1.prepare(
              'SELECT id, name, email, photo_url, hourly_rate, skills, care_types FROM caregiver_accounts WHERE id = ?'
            ).bind(Number(b.caregiver_id)).first() as any

            const parseJSON = (v: any) => { try { return JSON.parse(v) } catch { return [] } }
            const careTypes = cg?.care_types ? parseJSON(cg.care_types) : []
            const skills = cg?.skills ? parseJSON(cg.skills) : []

            active.push({
              id: b.caregiver_id,
              name: cg?.name || 'Caregiver',
              email: cg?.email || '',
              photoUrl: cg?.photo_url || null,
              hourlyRate: cg?.hourly_rate || 28,
              specialty: skills.length > 0 ? skills[0] : (careTypes.length > 0 ? careTypes[0] : 'Home Care'),
              preferredDate: b.preferred_date,
              preferredTime: b.preferred_time,
              interviewType: b.interview_type,
              bookingId: b.id,
              status: b.status,
              isHired: false,
            })
          }

          // ── 3. Past / removed ──
          const pastRows = await cloudflare.env.D1.prepare(
            "SELECT * FROM client_team WHERE client_email = ? AND status IN ('removed','completed') ORDER BY hired_at DESC"
          ).bind(clientEmail).all()

          const past: any[] = []
          for (const row of (pastRows.results || []) as any[]) {
            const cg = await cloudflare.env.D1.prepare(
              'SELECT id, name, email, photo_url, hourly_rate, skills FROM caregiver_accounts WHERE id = ?'
            ).bind(Number(row.caregiver_id)).first() as any
            const parseJSON = (v: any) => { try { return JSON.parse(v) } catch { return [] } }
            const skills = cg?.skills ? parseJSON(cg.skills) : []
            past.push({
              id: cg?.id || row.caregiver_id,
              name: cg?.name || 'Caregiver',
              email: cg?.email || '',
              photoUrl: cg?.photo_url || null,
              hourlyRate: cg?.hourly_rate || 28,
              specialty: skills.length > 0 ? skills[0] : 'Home Care',
              status: row.status,
            })
          }

          return Response.json({ success: true, hired, active, past, email: clientEmail })
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 })
        }
      },
    },
    // ====== HIRE CAREGIVER (add to My Team) ======
    {
      path: '/hire-caregiver',
      method: 'post',
      handler: async (req) => {
        try {
          const body = await req.json() as any
          const { caregiverId, bookingId, token } = body
          if (!token || !caregiverId) return Response.json({ error: 'token and caregiverId required' }, { status: 400 })

          const session = await cloudflare.env.D1.prepare(
            'SELECT email FROM client_sessions WHERE session_token = ? AND expires_at > datetime("now")'
          ).bind(token).first() as any
          if (!session) return Response.json({ error: 'Invalid or expired session' }, { status: 401 })

          const clientEmail = session.email.toLowerCase()

          // Upsert into client_team
          await cloudflare.env.D1.prepare(
            'INSERT OR REPLACE INTO client_team (client_email, caregiver_id, booking_id, status, hired_at) VALUES (?, ?, ?, "active", datetime("now"))'
          ).bind(clientEmail, Number(caregiverId), bookingId ? Number(bookingId) : null).run()

          // Update booking status to hired
          if (bookingId) {
            await cloudflare.env.D1.prepare(
              'UPDATE caregiver_bookings SET status = "hired" WHERE id = ? AND client_email = ?'
            ).bind(Number(bookingId), clientEmail).run()
          }

          // Return updated caregiver info
          const cg = await cloudflare.env.D1.prepare(
            'SELECT id, name, email, photo_url, hourly_rate, skills, city, state FROM caregiver_accounts WHERE id = ?'
          ).bind(Number(caregiverId)).first() as any

          return Response.json({ success: true, caregiverName: cg?.name || 'Caregiver' })
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 })
        }
      },
    },
    // ====== REMOVE FROM TEAM ======
    {
      path: '/remove-from-team',
      method: 'post',
      handler: async (req) => {
        try {
          const body = await req.json() as any
          const { caregiverId, token } = body
          if (!token || !caregiverId) return Response.json({ error: 'token and caregiverId required' }, { status: 400 })

          const session = await cloudflare.env.D1.prepare(
            'SELECT email FROM client_sessions WHERE session_token = ? AND expires_at > datetime("now")'
          ).bind(token).first() as any
          if (!session) return Response.json({ error: 'Invalid or expired session' }, { status: 401 })

          await cloudflare.env.D1.prepare(
            'UPDATE client_team SET status = "removed" WHERE client_email = ? AND caregiver_id = ?'
          ).bind(session.email.toLowerCase(), Number(caregiverId)).run()

          return Response.json({ success: true })
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 })
        }
      },
    },
    // ====== MY CLIENTS (caregiver portal — who hired me) ======
    {
      path: '/my-clients',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const env = req.env as any
          const url = new URL(req.url)
          const token = url.searchParams.get('token') || ''
          if (!token) return Response.json({ success: false, error: 'Token required' }, { headers })

          const sess = await env.D1.prepare(
            "SELECT email FROM caregiver_sessions WHERE token = ? AND expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!sess) return Response.json({ success: false, error: 'Invalid session' }, { headers })

          const cgRow = await env.D1.prepare(
            'SELECT id FROM caregiver_accounts WHERE email = ?'
          ).bind(sess.email).first() as any
          if (!cgRow) return Response.json({ success: false, error: 'Caregiver not found' }, { headers })

          const rows = await env.D1.prepare(
            'SELECT ct.*, ca.name AS client_name, ca.email AS client_email_addr FROM client_team ct LEFT JOIN client_accounts ca ON ca.email = ct.client_email WHERE ct.caregiver_id = ? AND ct.status = "active" ORDER BY ct.hired_at DESC'
          ).bind(Number(cgRow.id)).all()

          const clients = (rows.results || []).map((r: any) => ({
            clientEmail: r.client_email,
            name: r.client_name || r.client_email,
            hiredAt: r.hired_at,
            bookingId: r.booking_id,
          }))

          return Response.json({ success: true, clients }, { headers })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { headers })
        }
      },
    },
    // ============ CAREGIVER DOCUMENTS ============
    {
      path: '/caregiver-documents',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const env = req.env as any
          const url = new URL(req.url)
          const token = url.searchParams.get('token') || ''
          if (!token) return Response.json({ success: false, error: 'Token required' }, { headers })
          const sess = await env.D1.prepare('SELECT email FROM caregiver_sessions WHERE token = ? AND expires_at > datetime(\'now\')').bind(token).first()
          if (!sess) return Response.json({ success: false, error: 'Invalid session' }, { headers })
          const docs = await env.D1.prepare('SELECT * FROM caregiver_documents WHERE caregiver_email = ? ORDER BY created_at DESC').bind(sess.email).all()
          // Compute status for each doc
          const now = Date.now()
          const withStatus = (docs.results || []).map((d: any) => {
            if (!d.expiry_date) return { ...d, status: 'no_expiry' }
            const diff = (new Date(d.expiry_date).getTime() - now) / (1000 * 86400)
            if (diff < 0) return { ...d, status: 'expired' }
            if (diff < 30) return { ...d, status: 'expiring_soon' }
            return { ...d, status: 'valid' }
          })
          return Response.json({ success: true, documents: withStatus }, { headers })
        } catch (e: any) {
          return Response.json({ success: false, error: e.message }, { headers })
        }
      },
    },
    {
      path: '/caregiver-documents',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const env = req.env as any
          const formData = await req.formData()
          const token = formData.get('token') || ''
          const name = formData.get('name') || ''
          const docType = formData.get('doc_type') || 'certification'
          const expiryDate = formData.get('expiry_date') || ''
          const file = formData.get('file')
          if (!token) return Response.json({ success: false, error: 'Token required' }, { headers })
          if (!name) return Response.json({ success: false, error: 'Document name required' }, { headers })
          const sess = await env.D1.prepare('SELECT email FROM caregiver_sessions WHERE token = ? AND expires_at > datetime(\'now\')').bind(token).first()
          if (!sess) return Response.json({ success: false, error: 'Invalid session' }, { headers })
          const id = crypto.randomUUID()
          let r2Key = null
          let fileName = null
          if (file && typeof file === 'object' && file.name) {
            r2Key = `caregiver-docs/${sess.email}/${id}-${file.name}`
            fileName = file.name
            const buffer = await file.arrayBuffer()
            await env.R2.put(r2Key, buffer, { httpMetadata: { contentType: file.type || 'application/octet-stream' } })
          }
          // Compute status
          let status = 'no_expiry'
          if (expiryDate) {
            const diff = (new Date(expiryDate).getTime() - Date.now()) / (1000 * 86400)
            if (diff < 0) status = 'expired'
            else if (diff < 30) status = 'expiring_soon'
            else status = 'valid'
          }
          await env.D1.prepare('INSERT INTO caregiver_documents (id, caregiver_email, name, doc_type, r2_key, file_name, expiry_date, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, sess.email, name, docType, r2Key, fileName, expiryDate || null, status).run()
          const doc = { id, caregiver_email: sess.email, name, doc_type: docType, r2_key: r2Key, file_name: fileName, expiry_date: expiryDate || null, status }
          return Response.json({ success: true, document: doc }, { headers })
        } catch (e: any) {
          return Response.json({ success: false, error: e.message }, { headers })
        }
      },
    },
    {
      path: '/caregiver-documents',
      method: 'delete',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const env = req.env as any
          const url = new URL(req.url)
          const token = url.searchParams.get('token') || ''
          const id = url.searchParams.get('id') || ''
          if (!token || !id) return Response.json({ success: false, error: 'Token and id required' }, { headers })
          const sess = await env.D1.prepare('SELECT email FROM caregiver_sessions WHERE token = ? AND expires_at > datetime(\'now\')').bind(token).first()
          if (!sess) return Response.json({ success: false, error: 'Invalid session' }, { headers })
          // Get the doc to delete from R2 too
          const doc = await env.D1.prepare('SELECT r2_key FROM caregiver_documents WHERE id = ? AND caregiver_email = ?').bind(id, sess.email).first()
          if (doc?.r2_key) {
            try { await env.R2.delete(doc.r2_key) } catch {}
          }
          await env.D1.prepare('DELETE FROM caregiver_documents WHERE id = ? AND caregiver_email = ?').bind(id, sess.email).run()
          return Response.json({ success: true }, { headers })
        } catch (e: any) {
          return Response.json({ success: false, error: e.message }, { headers })
        }
      },
    },
    {
      path: '/caregiver-documents/file',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*' }
        try {
          const env = req.env as any
          const url = new URL(req.url)
          const key = url.searchParams.get('key') || ''
          const token = url.searchParams.get('token') || ''
          if (!key || !token) return Response.json({ error: 'Key and token required' }, { status: 400, headers })
          const sess = await env.D1.prepare('SELECT email FROM caregiver_sessions WHERE token = ? AND expires_at > datetime(\'now\')').bind(token).first()
          if (!sess) return Response.json({ error: 'Unauthorized' }, { status: 401, headers })
          const obj = await env.R2.get(key)
          if (!obj) return Response.json({ error: 'File not found' }, { status: 404, headers })
          const contentType = obj.httpMetadata?.contentType || 'application/octet-stream'
          return new Response(obj.body, { headers: { ...headers, 'Content-Type': contentType, 'Content-Disposition': 'inline' } })
        } catch (e: any) {
          return Response.json({ error: e.message }, { status: 500, headers })
        }
      },
    },
    {
      path: '/caregiver-profile-docs',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const env = req.env as any
          const url = new URL(req.url)
          const caregiverEmail = url.searchParams.get('email') || ''
          const clientToken = url.searchParams.get('clientToken') || ''
          if (!caregiverEmail) return Response.json({ success: false, error: 'Caregiver email required' }, { headers })
          // Get all docs for this caregiver
          const docs = await env.D1.prepare('SELECT id, name, doc_type, expiry_date, status FROM caregiver_documents WHERE caregiver_email = ? ORDER BY created_at DESC').bind(caregiverEmail).all()
          const docList = docs.results || []
          const count = docList.length
          // Check if client has paid subscription
          if (clientToken) {
            const sess = await env.D1.prepare('SELECT email FROM client_sessions WHERE token = ? AND expires_at > datetime(\'now\')').bind(clientToken).first()
            if (sess) {
              const sub = await env.D1.prepare('SELECT plan, status FROM client_subscriptions WHERE email = ? AND status = \'active\'').bind(sess.email).first()
              if (sub) {
                // Subscriber: return full doc metadata (no files)
                return Response.json({ success: true, subscribed: true, documents: docList, count }, { headers })
              }
            }
          }
          // Not subscribed: return count only
          return Response.json({ success: true, subscribed: false, documents: [], count }, { headers })
        } catch (e: any) {
          return Response.json({ success: false, error: e.message }, { headers })
        }
      },
    },

    {
      path: '/team-live-status',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const env = req.env as any
          const url = new URL(req.url)
          const clientToken = url.searchParams.get('clientToken') || ''
          if (!clientToken) return Response.json({ success: false, error: 'Token required' }, { headers })
          const sess = await env.D1.prepare('SELECT email FROM client_sessions WHERE token = ? AND expires_at > datetime(\'now\')').bind(clientToken).first()
          if (!sess) return Response.json({ success: false, error: 'Invalid session' }, { headers })
          const clientEmail = (sess as any).email
          // Get all accepted bookings for this client, join caregiver_accounts for email
          const bookings = await env.D1.prepare(
            'SELECT cb.id, cb.caregiver_id, ca.email as caregiver_email, ca.name as caregiver_name, cb.care_needs FROM caregiver_bookings cb JOIN caregiver_accounts ca ON ca.id = cb.caregiver_id WHERE cb.client_email = ? AND cb.status = \'accepted\' AND cb.unlocked = 1'
          ).bind(clientEmail).all()
          const caregivers = (bookings.results || []) as any[]
          const liveStatuses = []
          for (const cg of caregivers) {
            const timer = await env.D1.prepare(
              'SELECT start_time, client_name, is_running FROM caregiver_active_timer WHERE caregiver_email = ? AND is_running = 1'
            ).bind(cg.caregiver_email).first() as any
            liveStatuses.push({
              bookingId: cg.id,
              caregiverId: cg.caregiver_id,
              caregiverEmail: cg.caregiver_email,
              caregiverName: cg.caregiver_name,
              careNeeds: cg.care_needs,
              isOnsite: !!timer,
              startTime: timer ? timer.start_time : null,
              clientName: timer ? timer.client_name : null,
            })
          }
          return Response.json({ success: true, statuses: liveStatuses }, { headers })
        } catch (e: any) {
          return Response.json({ success: false, error: e.message }, { headers })
        }
      },
    },
    {
      path: '/care-schedule',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const env = req.env as any
          const body = await req.json() as any
          const { clientToken, caregiverEmail, days, startTime, endTime, careType, notes, isRecurring } = body
          if (!clientToken || !caregiverEmail || !days || !startTime || !endTime) {
            return Response.json({ success: false, error: 'Missing required fields' }, { headers })
          }
          const sess = await env.D1.prepare('SELECT email FROM client_sessions WHERE token = ? AND expires_at > datetime(\'now\')').bind(clientToken).first() as any
          if (!sess) return Response.json({ success: false, error: 'Invalid session' }, { headers })
          const daysStr = Array.isArray(days) ? days.join(',') : days
          // Upsert: delete existing then insert
          await env.D1.prepare('DELETE FROM care_schedules WHERE client_email = ? AND caregiver_email = ?').bind(sess.email, caregiverEmail).run()
          await env.D1.prepare(
            'INSERT INTO care_schedules (client_email, caregiver_email, days, start_time, end_time, care_type, notes, is_recurring) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(sess.email, caregiverEmail, daysStr, startTime, endTime, careType || '', notes || '', isRecurring ? 1 : 0).run()
          return Response.json({ success: true }, { headers })
        } catch (e: any) {
          return Response.json({ success: false, error: e.message }, { headers })
        }
      },
    },
    {
      path: '/care-schedule',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const env = req.env as any
          const url = new URL(req.url)
          const clientToken = url.searchParams.get('clientToken') || ''
          const caregiverEmail = url.searchParams.get('caregiverEmail') || ''
          if (!clientToken) return Response.json({ success: false, error: 'Token required' }, { headers })
          const sess = await env.D1.prepare('SELECT email FROM client_sessions WHERE token = ? AND expires_at > datetime(\'now\')').bind(clientToken).first() as any
          if (!sess) return Response.json({ success: false, error: 'Invalid session' }, { headers })
          if (caregiverEmail) {
            const schedule = await env.D1.prepare('SELECT * FROM care_schedules WHERE client_email = ? AND caregiver_email = ?').bind(sess.email, caregiverEmail).first()
            return Response.json({ success: true, schedule: schedule || null }, { headers })
          } else {
            const schedules = await env.D1.prepare('SELECT * FROM care_schedules WHERE client_email = ?').bind(sess.email).all()
            return Response.json({ success: true, schedules: schedules.results || [] }, { headers })
          }
        } catch (e: any) {
          return Response.json({ success: false, error: e.message }, { headers })
        }
      },
    },

    // ====== CAREGIVER TIME ENTRIES ======
    {
      path: '/caregiver-time-entries',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const url = new URL(req.url)
          const token = url.searchParams.get('token') || ''
          if (!token) return Response.json({ success: false, error: 'token required' }, { status: 401, headers })
          const sessionRow = await cloudflare.env.D1.prepare(
            "SELECT ca.email FROM caregiver_sessions cs JOIN caregiver_accounts ca ON cs.account_id = ca.id WHERE cs.token = ? AND cs.expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!sessionRow) return Response.json({ success: false, error: 'Session expired' }, { status: 401, headers })
          const result = await cloudflare.env.D1.prepare(
            'SELECT * FROM caregiver_time_entries WHERE caregiver_email = ? ORDER BY date DESC, created_at DESC LIMIT 200'
          ).bind(sessionRow.email).all()
          const entries = (result.results || []).map((e: any) => ({
            id: 'cloud_' + e.id,
            cloudId: String(e.id),
            clientName: e.client_name,
            date: e.date,
            startTime: e.start_time,
            endTime: e.end_time,
            duration: e.duration_mins,
            status: e.status || 'completed',
            hourlyRate: e.hourly_rate,
            totalPay: e.total_pay,
            regularHours: e.regular_hours,
            overtimeHours: e.overtime_hours,
            regularPay: e.regular_pay,
            overtimePay: e.overtime_pay,
            billingType: e.billing_type || 'hourly',
            otAfterHrs: e.ot_after_hrs,
            otMultiplier: e.ot_multiplier,
            notes: e.notes || '',
            isInvoiced: e.is_invoiced === 1,
          }))
          return Response.json({ success: true, entries }, { headers })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500, headers })
        }
      },
    },
    {
      path: '/caregiver-time-entries',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const body = await req.json()
          const { token, entry } = body
          if (!token) return Response.json({ success: false, error: 'token required' }, { status: 401, headers })
          const sessionRow2 = await cloudflare.env.D1.prepare(
            "SELECT ca.email FROM caregiver_sessions cs JOIN caregiver_accounts ca ON cs.account_id = ca.id WHERE cs.token = ? AND cs.expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!sessionRow2) return Response.json({ success: false, error: 'Session expired' }, { status: 401, headers })
          const r = await cloudflare.env.D1.prepare(
            `INSERT INTO caregiver_time_entries 
             (caregiver_email, client_name, date, start_time, end_time, duration_mins, status, hourly_rate, total_pay, regular_hours, overtime_hours, regular_pay, overtime_pay, billing_type, ot_after_hrs, ot_multiplier, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            sessionRow2.email,
            entry.clientName || '', entry.date || '', entry.startTime || '', entry.endTime || '',
            entry.duration || 0, entry.status || 'completed',
            entry.hourlyRate || 0, entry.totalPay || 0,
            entry.regularHours || 0, entry.overtimeHours || 0,
            entry.regularPay || 0, entry.overtimePay || 0,
            entry.billingType || 'hourly', entry.otAfterHrs || 8, entry.otMultiplier || 1.5,
            entry.notes || ''
          ).run() as any
          return Response.json({ success: true, cloudId: String(r.meta?.last_row_id || r.lastRowId || '') }, { headers })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500, headers })
        }
      },
    },
    {
      path: '/caregiver-time-entries',
      method: 'delete',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const url = new URL(req.url)
          const token = url.searchParams.get('token') || ''
          const cloudId = url.searchParams.get('cloudId') || ''
          if (!token || !cloudId) return Response.json({ success: false, error: 'token and cloudId required' }, { status: 400, headers })
          const sessionRow3 = await cloudflare.env.D1.prepare(
            "SELECT ca.email FROM caregiver_sessions cs JOIN caregiver_accounts ca ON cs.account_id = ca.id WHERE cs.token = ? AND cs.expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!sessionRow3) return Response.json({ success: false, error: 'Session expired' }, { status: 401, headers })
          await cloudflare.env.D1.prepare(
            'DELETE FROM caregiver_time_entries WHERE id = ? AND caregiver_email = ?'
          ).bind(Number(cloudId), sessionRow3.email).run()
          return Response.json({ success: true }, { headers })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500, headers })
        }
      },
    },


    {
      path: '/caregiver-time-entries',
      method: 'put',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const body = await req.json()
          const { token, cloudIds } = body
          if (!token || !Array.isArray(cloudIds) || cloudIds.length === 0) {
            return Response.json({ success: false, error: 'token and cloudIds required' }, { status: 400, headers })
          }
          const sessionRow4 = await cloudflare.env.D1.prepare(
            "SELECT ca.email FROM caregiver_sessions cs JOIN caregiver_accounts ca ON cs.account_id = ca.id WHERE cs.token = ? AND cs.expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!sessionRow4) return Response.json({ success: false, error: 'Session expired' }, { status: 401, headers })
          // Mark each entry as invoiced (only if owned by this caregiver)
          for (const cloudId of cloudIds) {
            await cloudflare.env.D1.prepare(
              'UPDATE caregiver_time_entries SET is_invoiced = 1 WHERE id = ? AND caregiver_email = ?'
            ).bind(Number(cloudId), sessionRow4.email).run()
          }
          return Response.json({ success: true, marked: cloudIds.length }, { headers })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500, headers })
        }
      },
    },

    // ====== ACTIVE TIMER ======
    {
      path: '/caregiver-active-timer',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const url = new URL(req.url)
          const token = url.searchParams.get('token') || ''
          if (!token) return Response.json({ timer: null }, { headers })
          const session = await cloudflare.env.D1.prepare(
            "SELECT account_id FROM caregiver_sessions WHERE token = ? AND expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!session) return Response.json({ timer: null }, { headers })
          const row = await cloudflare.env.D1.prepare(
            'SELECT * FROM caregiver_active_timer WHERE caregiver_id = ?'
          ).bind(session.account_id).first() as any
          if (!row) return Response.json({ timer: null }, { headers })
          return Response.json({ timer: JSON.parse(row.timer_json || 'null') }, { headers })
        } catch (error) {
          return Response.json({ timer: null }, { headers })
        }
      },
    },
    {
      path: '/caregiver-active-timer',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const body = await req.json()
          const { token, timer } = body
          if (!token) return Response.json({ success: false, error: 'token required' }, { status: 401, headers })
          const session = await cloudflare.env.D1.prepare(
            "SELECT account_id FROM caregiver_sessions WHERE token = ? AND expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!session) return Response.json({ success: false, error: 'Session expired' }, { status: 401, headers })
          if (timer === null) {
            await cloudflare.env.D1.prepare('DELETE FROM caregiver_active_timer WHERE caregiver_id = ?').bind(session.account_id).run()
          } else {
            await cloudflare.env.D1.prepare(
              'INSERT OR REPLACE INTO caregiver_active_timer (caregiver_id, timer_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)'
            ).bind(session.account_id, JSON.stringify(timer)).run()
          }
          return Response.json({ success: true }, { headers })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500, headers })
        }
      },
    },

    // ====== PERSONAL INVOICES ======
    {
      path: '/caregiver-personal-invoices',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const url = new URL(req.url)
          const token = url.searchParams.get('token') || ''
          if (!token) return Response.json({ success: false, error: 'token required' }, { status: 401, headers })
          const session = await cloudflare.env.D1.prepare(
            "SELECT account_id FROM caregiver_sessions WHERE token = ? AND expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!session) return Response.json({ success: false, error: 'Session expired' }, { status: 401, headers })
          const result = await cloudflare.env.D1.prepare(
            'SELECT * FROM caregiver_personal_invoices WHERE caregiver_id = ? ORDER BY created_at DESC LIMIT 100'
          ).bind(session.account_id).all()
          const invoices = (result.results || []).map((inv: any) => ({
            id: 'cloud_' + inv.id,
            cloudId: String(inv.id),
            invoiceNumber: inv.invoice_number,
            clientName: inv.client_name,
            amount: inv.amount,
            status: inv.status,
            issuedDate: inv.issued_date,
            dueDate: inv.due_date,
            lineItems: inv.line_items ? (() => { try { return JSON.parse(inv.line_items) } catch { return [] } })() : [],
            notes: inv.notes || '',
          }))
          return Response.json({ success: true, invoices }, { headers })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500, headers })
        }
      },
    },
    {
      path: '/caregiver-personal-invoices',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const body = await req.json()
          const { token, invoice, cloudId, updates, action } = body
          if (!token) return Response.json({ success: false, error: 'token required' }, { status: 401, headers })
          const session = await cloudflare.env.D1.prepare(
            "SELECT account_id FROM caregiver_sessions WHERE token = ? AND expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!session) return Response.json({ success: false, error: 'Session expired' }, { status: 401, headers })

          // UPDATE STATUS (replaces PATCH)
          if (cloudId && updates) {
            const fields: string[] = []
            const vals: any[] = []
            if (updates.status !== undefined) { fields.push('status = ?'); vals.push(updates.status) }
            if (fields.length === 0) return Response.json({ success: true }, { headers })
            vals.push(Number(cloudId), session.account_id)
            await cloudflare.env.D1.prepare(
              `UPDATE caregiver_personal_invoices SET ${fields.join(', ')} WHERE id = ? AND caregiver_id = ?`
            ).bind(...vals).run()
            return Response.json({ success: true }, { headers })
          }

          // CREATE NEW INVOICE
          if (!invoice) return Response.json({ success: false, error: 'invoice required' }, { status: 400, headers })
          const r = await cloudflare.env.D1.prepare(
            `INSERT INTO caregiver_personal_invoices
             (caregiver_id, invoice_number, client_name, amount, status, issued_date, due_date, line_items, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            session.account_id,
            invoice.invoiceNumber || '', invoice.clientName || '',
            invoice.amount || 0, invoice.status || 'draft',
            invoice.issuedDate || '', invoice.dueDate || '',
            JSON.stringify(invoice.lineItems || []), invoice.notes || ''
          ).run() as any
          return Response.json({ success: true, cloudId: String(r.meta?.last_row_id || r.lastRowId || '') }, { headers })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500, headers })
        }
      },
    },
    {
      path: '/caregiver-personal-invoices',
      method: 'delete',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const url = new URL(req.url)
          const token = url.searchParams.get('token') || ''
          const cloudId = url.searchParams.get('cloudId') || ''
          if (!token || !cloudId) return Response.json({ success: false, error: 'token and cloudId required' }, { status: 400, headers })
          const session = await cloudflare.env.D1.prepare(
            "SELECT account_id FROM caregiver_sessions WHERE token = ? AND expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!session) return Response.json({ success: false, error: 'Session expired' }, { status: 401, headers })
          await cloudflare.env.D1.prepare(
            'DELETE FROM caregiver_personal_invoices WHERE id = ? AND caregiver_id = ?'
          ).bind(Number(cloudId), session.account_id).run()
          return Response.json({ success: true }, { headers })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500, headers })
        }
      },
    },

    // ====== PRIVATE CLIENTS ======
    {
      path: '/caregiver-private-clients',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const url = new URL(req.url)
          const token = url.searchParams.get('token') || ''
          if (!token) return Response.json({ success: false, error: 'token required' }, { status: 401, headers })
          const session = await cloudflare.env.D1.prepare(
            "SELECT cs.account_id, ca.email AS caregiver_email FROM caregiver_sessions cs JOIN caregiver_accounts ca ON ca.id = cs.account_id WHERE cs.token = ? AND cs.expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!session) return Response.json({ success: false, error: 'Session expired' }, { status: 401, headers })
          const result = await cloudflare.env.D1.prepare(
            'SELECT * FROM caregiver_private_clients WHERE caregiver_email = ? ORDER BY name ASC'
          ).bind(session.caregiver_email).all()
          const clients = (result.results || []).map((c: any) => ({
            id: 'cloud_' + c.id,
            cloudId: String(c.id),
            name: c.name,
            email: c.email || '',
            phone: c.phone || '',
            hourlyRate: c.hourly_rate || 0,
            careType: c.care_type || '',
            billingType: c.billing_type || 'hourly',
            overtimeAfterHours: c.ot_after_hrs || 8,
            overtimeMultiplier: c.ot_multiplier || 1.5,
          }))
          return Response.json({ success: true, clients }, { headers })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500, headers })
        }
      },
    },
    {
      path: '/caregiver-private-clients',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const body = await req.json()
          const { token, client } = body
          if (!token || !client) return Response.json({ success: false, error: 'token and client required' }, { status: 400, headers })
          const session = await cloudflare.env.D1.prepare(
            "SELECT cs.account_id, ca.email AS caregiver_email FROM caregiver_sessions cs JOIN caregiver_accounts ca ON ca.id = cs.account_id WHERE cs.token = ? AND cs.expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!session) return Response.json({ success: false, error: 'Session expired' }, { status: 401, headers })
          const r = await cloudflare.env.D1.prepare(
            'INSERT INTO caregiver_private_clients (caregiver_email, name, email, phone, hourly_rate, care_type, billing_type, ot_after_hrs, ot_multiplier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(
            session.caregiver_email, client.name || '', client.email || '',
            client.phone || '', client.hourlyRate || 0, client.careType || '',
            client.billingType || 'hourly', client.otAfterHrs || 8, client.otMultiplier || 1.5
          ).run() as any
          return Response.json({ success: true, cloudId: String(r.meta?.last_row_id || r.lastRowId || '') }, { headers })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500, headers })
        }
      },
    },
    {
      path: '/caregiver-private-clients',
      method: 'delete',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const url = new URL(req.url)
          const token = url.searchParams.get('token') || ''
          const cloudId = url.searchParams.get('cloudId') || ''
          if (!token || !cloudId) return Response.json({ success: false, error: 'token and cloudId required' }, { status: 400, headers })
          const session = await cloudflare.env.D1.prepare(
            "SELECT cs.account_id, ca.email AS caregiver_email FROM caregiver_sessions cs JOIN caregiver_accounts ca ON ca.id = cs.account_id WHERE cs.token = ? AND cs.expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!session) return Response.json({ success: false, error: 'Session expired' }, { status: 401, headers })
          await cloudflare.env.D1.prepare(
            'DELETE FROM caregiver_private_clients WHERE id = ? AND caregiver_email = ?'
          ).bind(Number(cloudId), session.caregiver_email).run()
          return Response.json({ success: true }, { headers })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500, headers })
        }
      },
    },

    // ====== MILEAGE ======
    {
      path: '/caregiver-mileage',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const url = new URL(req.url)
          const token = url.searchParams.get('token') || ''
          if (!token) return Response.json({ success: false, error: 'token required' }, { status: 401, headers })
          const session = await cloudflare.env.D1.prepare(
            "SELECT account_id FROM caregiver_sessions WHERE token = ? AND expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!session) return Response.json({ success: false, error: 'Session expired' }, { status: 401, headers })
          const result = await cloudflare.env.D1.prepare(
            'SELECT * FROM caregiver_mileage WHERE caregiver_id = ? ORDER BY date DESC LIMIT 200'
          ).bind(session.account_id).all()
          const entries = (result.results || []).map((m: any) => ({
            id: 'cloud_' + m.id,
            cloudId: String(m.id),
            date: m.date,
            clientName: m.client_name,
            miles: m.miles,
            purpose: m.purpose || '',
            notes: m.notes || '',
          }))
          return Response.json({ success: true, entries }, { headers })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500, headers })
        }
      },
    },
    {
      path: '/caregiver-mileage',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const body = await req.json()
          const { token, entry } = body
          if (!token || !entry) return Response.json({ success: false, error: 'token and entry required' }, { status: 400, headers })
          const session = await cloudflare.env.D1.prepare(
            "SELECT account_id FROM caregiver_sessions WHERE token = ? AND expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!session) return Response.json({ success: false, error: 'Session expired' }, { status: 401, headers })
          const r = await cloudflare.env.D1.prepare(
            'INSERT INTO caregiver_mileage (caregiver_id, date, client_name, miles, purpose, notes) VALUES (?, ?, ?, ?, ?, ?)'
          ).bind(
            session.account_id, entry.date || '', entry.clientName || '',
            entry.miles || 0, entry.purpose || '', entry.notes || ''
          ).run() as any
          return Response.json({ success: true, cloudId: String(r.meta?.last_row_id || r.lastRowId || '') }, { headers })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500, headers })
        }
      },
    },
    {
      path: '/caregiver-mileage',
      method: 'delete',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const url = new URL(req.url)
          const token = url.searchParams.get('token') || ''
          const cloudId = url.searchParams.get('cloudId') || ''
          if (!token || !cloudId) return Response.json({ success: false, error: 'token and cloudId required' }, { status: 400, headers })
          const session = await cloudflare.env.D1.prepare(
            "SELECT account_id FROM caregiver_sessions WHERE token = ? AND expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!session) return Response.json({ success: false, error: 'Session expired' }, { status: 401, headers })
          await cloudflare.env.D1.prepare(
            'DELETE FROM caregiver_mileage WHERE id = ? AND caregiver_id = ?'
          ).bind(Number(cloudId), session.account_id).run()
          return Response.json({ success: true }, { headers })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500, headers })
        }
      },
    },

    // ====== SEND BOOKING NUDGE EMAIL (Resend) ======
    {
      path: '/send-booking-nudge',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const body = await req.json()
          const { caregiverEmail, caregiverName, bookingId } = body
          if (!caregiverEmail) return Response.json({ success: false, error: 'caregiverEmail required' }, { status: 400, headers })

          const resendKey = cloudflare.env.RESEND_API_KEY
          if (!resendKey) return Response.json({ success: false, error: 'RESEND_API_KEY not configured' }, { status: 500, headers })

          const firstName = caregiverName ? caregiverName.split(' ')[0] : 'there'

          const emailRes = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${resendKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              from: 'Carehia <hello@carehia.com>',
              to: [caregiverEmail],
              subject: '🔔 You have a new care request!',
              html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#7C5CFF 0%,#4A90E2 100%);padding:32px 40px;text-align:center;">
            <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;letter-spacing:-0.5px;">Carehia</h1>
            <p style="margin:8px 0 0;color:rgba(255,255,255,0.85);font-size:14px;">Your caregiving platform</p>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:40px;">
            <h2 style="margin:0 0 16px;color:#0f172a;font-size:22px;font-weight:700;">Hi ${firstName}! 👋</h2>
            <p style="margin:0 0 24px;color:#475569;font-size:16px;line-height:1.6;">
              You have a <strong>new care request</strong> waiting for you on Carehia.
            </p>
            <div style="background:#f1f5f9;border-radius:12px;padding:20px 24px;margin:0 0 28px;">
              <p style="margin:0;color:#64748b;font-size:14px;">A family is looking for care and you're a great match. Open your portal to see the details and decide if you'd like to connect.</p>
            </div>
            <!-- CTA Button -->
            <div style="text-align:center;margin:0 0 28px;">
              <a href="https://gotocare-caregiver-portal.pages.dev/?tab=requests" 
                 style="display:inline-block;background:linear-gradient(135deg,#7C5CFF 0%,#4A90E2 100%);color:#ffffff;text-decoration:none;padding:14px 36px;border-radius:50px;font-size:16px;font-weight:600;letter-spacing:0.3px;">
                View Care Request →
              </a>
            </div>
            <p style="margin:0;color:#94a3b8;font-size:13px;text-align:center;line-height:1.5;">
              To protect privacy, client details are revealed only after you unlock the request.<br>
              Unlocking a single request costs just $4.99.
            </p>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="background:#f8fafc;padding:20px 40px;text-align:center;border-top:1px solid #e2e8f0;">
            <p style="margin:0;color:#94a3b8;font-size:12px;">
              © ${new Date().getFullYear()} Carehia · 
              <a href="https://gotocare-caregiver-portal.pages.dev" style="color:#7C5CFF;text-decoration:none;">Open Portal</a> · 
              Questions? <a href="mailto:support@carehia.com" style="color:#7C5CFF;text-decoration:none;">support@carehia.com</a><br>
              You're receiving this because you're a registered caregiver on Carehia.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
            }),
          })

          const emailData = await emailRes.json() as any
          if (!emailRes.ok) {
            return Response.json({ success: false, error: emailData.message || 'Email send failed' }, { status: 500, headers })
          }
          return Response.json({ success: true, emailId: emailData.id }, { headers })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500, headers })
        }
      },
    },

    // ============================================================
    // META OAUTH + POSTING ENDPOINTS
    // ============================================================

    // Setup Meta D1 tables
    {
      path: '/meta-setup',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const db = (cloudflare as any).env.D1
          await db.exec(`CREATE TABLE IF NOT EXISTS meta_connections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_email TEXT NOT NULL,
            owner_type TEXT NOT NULL DEFAULT 'caregiver',
            page_id TEXT NOT NULL,
            page_name TEXT,
            page_access_token TEXT NOT NULL,
            ig_account_id TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(owner_email, page_id)
          )`)
          await db.exec(`CREATE TABLE IF NOT EXISTS meta_posts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_email TEXT NOT NULL,
            page_id TEXT NOT NULL,
            message TEXT NOT NULL,
            image_url TEXT,
            fb_post_id TEXT,
            ig_post_id TEXT,
            status TEXT DEFAULT 'posted',
            posted_at TEXT DEFAULT (datetime('now')),
            created_at TEXT DEFAULT (datetime('now'))
          )`)
          return Response.json({ success: true, message: 'Meta tables created' }, { headers })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500, headers })
        }
      },
    },

    // Start Meta OAuth flow
    {
      path: '/meta-oauth-start',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const url = new URL(req.url)
          const ownerEmail = url.searchParams.get('ownerEmail') || ''
          const ownerType = url.searchParams.get('ownerType') || 'caregiver'
          const appId = (cloudflare as any).env.META_APP_ID
          if (!appId) return Response.json({ success: false, error: 'META_APP_ID not configured' }, { status: 500, headers })
          const redirectUri = encodeURIComponent('https://gotocare-original.jjioji.workers.dev/api/meta-oauth-callback')
          const stateJson = JSON.stringify({ ownerEmail, ownerType })
          const state = btoa(stateJson)
          const scope = 'pages_show_list,pages_manage_posts,pages_read_engagement,instagram_basic,instagram_content_publish'
          const oauthUrl = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${appId}&redirect_uri=${redirectUri}&state=${state}&scope=${scope}&response_type=code`
          return Response.json({ success: true, oauthUrl }, { headers })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500, headers })
        }
      },
    },

    // Meta OAuth callback
    {
      path: '/meta-oauth-callback',
      method: 'get',
      handler: async (req: any) => {
        try {
          const url = new URL(req.url)
          const code = url.searchParams.get('code')
          const stateB64 = url.searchParams.get('state') || ''
          const errorParam = url.searchParams.get('error')
          if (errorParam || !code) {
            return Response.redirect('https://gotocare-caregiver-portal.pages.dev/?tab=marketing&meta=denied', 302)
          }
          let ownerEmail = '', ownerType = 'caregiver'
          try {
            const stateData = JSON.parse(atob(stateB64))
            ownerEmail = stateData.ownerEmail || ''
            ownerType = stateData.ownerType || 'caregiver'
          } catch {}
          const appId = (cloudflare as any).env.META_APP_ID
          const appSecret = (cloudflare as any).env.META_APP_SECRET
          const redirectUri = encodeURIComponent('https://gotocare-original.jjioji.workers.dev/api/meta-oauth-callback')
          // Exchange code for short-lived token
          const tokenRes = await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?client_id=${appId}&redirect_uri=${redirectUri}&client_secret=${appSecret}&code=${code}`)
          const tokenData = await tokenRes.json() as any
          if (!tokenData.access_token) {
            return Response.redirect('https://gotocare-caregiver-portal.pages.dev/?tab=marketing&meta=error', 302)
          }
          // Exchange for long-lived token
          const llRes = await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${tokenData.access_token}`)
          const llData = await llRes.json() as any
          const longLivedToken = llData.access_token || tokenData.access_token
          // Get user pages
          const pagesRes = await fetch(`https://graph.facebook.com/v19.0/me/accounts?access_token=${longLivedToken}`)
          const pagesData = await pagesRes.json() as any
          const db = (cloudflare as any).env.D1
          // Ensure tables exist
          await db.exec(`CREATE TABLE IF NOT EXISTS meta_connections (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_email TEXT NOT NULL, owner_type TEXT NOT NULL DEFAULT 'caregiver', page_id TEXT NOT NULL, page_name TEXT, page_access_token TEXT NOT NULL, ig_account_id TEXT, created_at TEXT DEFAULT (datetime('now')), UNIQUE(owner_email, page_id))`)
          if (pagesData.data && pagesData.data.length > 0) {
            for (const page of pagesData.data) {
              let igAccountId = null
              try {
                const igRes = await fetch(`https://graph.facebook.com/v19.0/${page.id}?fields=instagram_business_account&access_token=${page.access_token}`)
                const igData = await igRes.json() as any
                if (igData.instagram_business_account) igAccountId = igData.instagram_business_account.id
              } catch {}
              await db.prepare(`INSERT OR REPLACE INTO meta_connections (owner_email, owner_type, page_id, page_name, page_access_token, ig_account_id) VALUES (?, ?, ?, ?, ?, ?)`).bind(ownerEmail, ownerType, page.id, page.name, page.access_token, igAccountId).run()
            }
          }
          return Response.redirect('https://gotocare-caregiver-portal.pages.dev/?tab=marketing&meta=connected', 302)
        } catch (error) {
          return Response.redirect('https://gotocare-caregiver-portal.pages.dev/?tab=marketing&meta=error', 302)
        }
      },
    },

    // Get connected Meta pages
    {
      path: '/meta-pages',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const url = new URL(req.url)
          const ownerEmail = url.searchParams.get('ownerEmail') || ''
          if (!ownerEmail) return Response.json({ success: false, error: 'ownerEmail required' }, { status: 400, headers })
          const db = (cloudflare as any).env.D1
          const result = await db.prepare('SELECT id, page_id, page_name, ig_account_id, created_at FROM meta_connections WHERE owner_email = ?').bind(ownerEmail).all()
          return Response.json({ success: true, pages: result.results }, { headers })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500, headers })
        }
      },
    },

    // Create Meta post (FB + optionally IG)
    {
      path: '/meta-post',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const body = await req.json()
          const { ownerEmail, pageId, message, imageUrl, postToInstagram } = body
          if (!ownerEmail || !pageId || !message) return Response.json({ success: false, error: 'ownerEmail, pageId, message required' }, { status: 400, headers })
          const db = (cloudflare as any).env.D1
          const conn = await db.prepare('SELECT * FROM meta_connections WHERE owner_email = ? AND page_id = ?').bind(ownerEmail, pageId).first() as any
          if (!conn) return Response.json({ success: false, error: 'Page not connected. Please reconnect your Facebook page.' }, { status: 404, headers })
          const pageToken = conn.page_access_token
          let fbPostId = null, igPostId = null
          // Post to Facebook
          const fbEndpoint = imageUrl ? `https://graph.facebook.com/v19.0/${pageId}/photos` : `https://graph.facebook.com/v19.0/${pageId}/feed`
          const fbPayload: any = { message, access_token: pageToken }
          if (imageUrl) fbPayload.url = imageUrl
          const fbRes = await fetch(fbEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fbPayload) })
          const fbData = await fbRes.json() as any
          fbPostId = fbData.id || null
          // Post to Instagram if requested and image provided
          if (postToInstagram && conn.ig_account_id && imageUrl) {
            const containerRes = await fetch(`https://graph.facebook.com/v19.0/${conn.ig_account_id}/media`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image_url: imageUrl, caption: message, access_token: pageToken }) })
            const containerData = await containerRes.json() as any
            if (containerData.id) {
              const publishRes = await fetch(`https://graph.facebook.com/v19.0/${conn.ig_account_id}/media_publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ creation_id: containerData.id, access_token: pageToken }) })
              const publishData = await publishRes.json() as any
              igPostId = publishData.id || null
            }
          }
          // Ensure posts table exists
          await db.exec(`CREATE TABLE IF NOT EXISTS meta_posts (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_email TEXT NOT NULL, page_id TEXT NOT NULL, message TEXT NOT NULL, image_url TEXT, fb_post_id TEXT, ig_post_id TEXT, status TEXT DEFAULT 'posted', posted_at TEXT DEFAULT (datetime('now')), created_at TEXT DEFAULT (datetime('now')))`)
          await db.prepare(`INSERT INTO meta_posts (owner_email, page_id, message, image_url, fb_post_id, ig_post_id, status) VALUES (?, ?, ?, ?, ?, ?, 'posted')`).bind(ownerEmail, pageId, message, imageUrl || null, fbPostId, igPostId).run()
          return Response.json({ success: true, fbPostId, igPostId }, { headers })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500, headers })
        }
      },
    },

    // Generate AI post content
    {
      path: '/meta-generate-post',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const body = await req.json()
          const { topic, tone, ownerType } = body
          const openaiKey = (cloudflare as any).env.OPENAI_API_KEY
          if (!openaiKey) return Response.json({ success: false, error: 'OPENAI_API_KEY not configured' }, { status: 500, headers })
          const prompt = ownerType === 'caregiver'
            ? `Write a compelling Facebook/Instagram post for a professional caregiver promoting their services. Topic: ${topic || 'caregiving services'}. Tone: ${tone || 'warm and professional'}. Include 3-5 relevant hashtags at the end. Keep it under 200 words. Do not use quotation marks around the post.`
            : `Write a compelling Facebook/Instagram post for a home care platform. Topic: ${topic || 'finding trusted care'}. Tone: ${tone || 'professional and caring'}. Include 3-5 relevant hashtags at the end. Keep it under 200 words. Do not use quotation marks.`
          const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 300 })
          })
          const aiData = await aiRes.json() as any
          const content = aiData.choices?.[0]?.message?.content || ''
          return Response.json({ success: true, content }, { headers })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500, headers })
        }
      },
    },

    // Get post history
    {
      path: '/meta-posts',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const url = new URL(req.url)
          const ownerEmail = url.searchParams.get('ownerEmail') || ''
          if (!ownerEmail) return Response.json({ success: false, error: 'ownerEmail required' }, { status: 400, headers })
          const db = (cloudflare as any).env.D1
          const result = await db.prepare('SELECT id, page_id, message, image_url, fb_post_id, ig_post_id, status, posted_at FROM meta_posts WHERE owner_email = ? ORDER BY created_at DESC LIMIT 50').bind(ownerEmail).all()
          return Response.json({ success: true, posts: result.results }, { headers })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500, headers })
        }
      },
    },

    // Public caregiver profile (no auth required)
    {
      path: '/public-profile',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const url = new URL(req.url)
          const id = url.searchParams.get('id')
          if (!id) return Response.json({ success: false, error: 'id required' }, { status: 400, headers })
          const db = (cloudflare as any).env.D1
          const result = await db.prepare(
            'SELECT id, name, bio, photo_url, zip_code, city, state, care_types, skills, certifications, hourly_rate, created_at FROM caregiver_accounts WHERE id = ?'
          ).bind(parseInt(id)).first()
          if (!result) return Response.json({ success: false, error: 'Profile not found' }, { status: 404, headers })
          let skills = []
          let certifications = []
          try { skills = JSON.parse((result as any).skills || '[]') } catch {}
          try { certifications = JSON.parse((result as any).certifications || '[]') } catch {}
          return Response.json({ success: true, profile: { ...(result as any), skills, certifications } }, { headers })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500, headers })
        }
      },
    },

    // Save/get caregiver availability
    {
      path: '/caregiver-availability',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const url = new URL(req.url)
          const token = url.searchParams.get('token')
          if (!token) return Response.json({ success: false, error: 'token required' }, { status: 401, headers })
          const db = (cloudflare as any).env.D1
          const session = await db.prepare('SELECT caregiver_id FROM caregiver_sessions WHERE token = ?').bind(token).first()
          if (!session) return Response.json({ success: false, error: 'Invalid token' }, { status: 401, headers })
          await db.exec(`CREATE TABLE IF NOT EXISTS caregiver_availability (id INTEGER PRIMARY KEY AUTOINCREMENT, caregiver_id INTEGER NOT NULL UNIQUE, availability_json TEXT, updated_at TEXT DEFAULT (datetime('now')))`)
          const avail = await db.prepare('SELECT availability_json FROM caregiver_availability WHERE caregiver_id = ?').bind((session as any).caregiver_id).first()
          return Response.json({ success: true, availability: avail ? JSON.parse((avail as any).availability_json || '{}') : {} }, { headers })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500, headers })
        }
      },
    },
    {
      path: '/caregiver-availability',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const url = new URL(req.url)
          const token = url.searchParams.get('token')
          const body = await req.json()
          if (!token) return Response.json({ success: false, error: 'token required' }, { status: 401, headers })
          const db = (cloudflare as any).env.D1
          const session = await db.prepare('SELECT caregiver_id FROM caregiver_sessions WHERE token = ?').bind(token).first()
          if (!session) return Response.json({ success: false, error: 'Invalid token' }, { status: 401, headers })
          await db.exec(`CREATE TABLE IF NOT EXISTS caregiver_availability (id INTEGER PRIMARY KEY AUTOINCREMENT, caregiver_id INTEGER NOT NULL UNIQUE, availability_json TEXT, updated_at TEXT DEFAULT (datetime('now')))`)
          await db.prepare('INSERT OR REPLACE INTO caregiver_availability (caregiver_id, availability_json, updated_at) VALUES (?, ?, datetime(\'now\'))').bind((session as any).caregiver_id, JSON.stringify(body.availability || {})).run()
          return Response.json({ success: true }, { headers })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500, headers })
        }
      },
    },


    // ====== TRUST STATUS (get full trust data for logged-in caregiver) ======
    {
      path: '/trust-status',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const url = new URL(req.url)
          const token = url.searchParams.get('token')
          if (!token) return Response.json({ success: false, error: 'token required' }, { status: 401, headers })
          const db = (cloudflare as any).env.D1
          const session = await db.prepare('SELECT caregiver_id FROM caregiver_sessions WHERE token = ?').bind(token).first()
          if (!session) return Response.json({ success: false, error: 'Invalid token' }, { status: 401, headers })
          const cgId = (session as any).caregiver_id
          const cg = await db.prepare('SELECT bio, photo_url, hourly_rate, skills FROM caregiver_accounts WHERE id = ?').bind(cgId).first()
          const idVerif = await db.prepare('SELECT status, doc_type, submitted_at FROM caregiver_verifications WHERE caregiver_id = ? ORDER BY id DESC LIMIT 1').bind(cgId).first()
          const bgCheck = await db.prepare('SELECT status, initiated_at, completed_at, expires_at FROM caregiver_background_checks WHERE caregiver_id = ?').bind(cgId).first()
          const certRows = await db.prepare("SELECT doc_type as name, status, notes FROM caregiver_verifications WHERE caregiver_id = ? AND doc_type IN ('cpr','cna','hha','lvn','rn','dementia','hospice','tb')").bind(cgId).all()
          const certifications = (certRows.results || []).map((c) => ({ name: (c as any).name?.toUpperCase() || '', status: (c as any).status || 'pending', expiry: (c as any).notes?.replace('Expires: ','') || '' }))
          const reviewRows = await db.prepare('SELECT id, rating, review_text, is_repeat_client, is_punctual, is_caring, is_professional, would_hire_again, created_at FROM caregiver_reviews WHERE caregiver_id = ? AND is_visible = 1 ORDER BY created_at DESC LIMIT 10').bind(cgId).all()
          const reviews = reviewRows.results || []
          const reviewCount = reviews.length
          const avgRating = reviewCount > 0 ? (reviews as any[]).reduce((s, r) => s + (r.rating || 0), 0) / reviewCount : 0
          const metrics = await db.prepare('SELECT avg_response_minutes, total_requests, accepted, completed_shifts, repeat_bookings FROM caregiver_response_metrics WHERE caregiver_id = ?').bind(cgId).first()
          const bookingCount = await db.prepare("SELECT COUNT(*) as cnt FROM caregiver_bookings WHERE caregiver_id = ? AND status = 'accepted'").bind(String(cgId)).first()
          const cgData = cg as any
          let skills = []; try { skills = JSON.parse(cgData?.skills || '[]') } catch {}
          const profileComplete = !!(cgData?.bio && cgData?.photo_url && cgData?.hourly_rate && skills.length > 0)
          const idVerified = (idVerif as any)?.status === 'verified'
          const bgChecked = (bgCheck as any)?.status === 'verified'
          const hasCPR = certifications.some(c => c.name === 'CPR' && c.status === 'verified')
          const hasCNA = certifications.some(c => ['CNA','HHA'].includes(c.name) && c.status === 'verified')
          const shifts5plus = ((bookingCount as any)?.cnt || 0) >= 5
          const fastResponder = (metrics as any)?.avg_response_minutes > 0 && (metrics as any)?.avg_response_minutes <= 5
          const repeatClients = ((metrics as any)?.repeat_bookings || 0) >= 3
          const fiveStarAvg = avgRating >= 4.9 && reviewCount >= 3
          const score = (idVerified?20:0)+(bgChecked?20:0)+(hasCPR?15:0)+(hasCNA?10:0)+(profileComplete?10:0)+(shifts5plus?10:0)+(fastResponder?5:0)+(repeatClients?5:0)+(fiveStarAvg?5:0)
          const level = score>=90?'Elite Caregiver':score>=70?'Verified Pro':score>=40?'Trusted':'Basic'
          return Response.json({ success: true, score, level, breakdown: { id_verified: idVerified, background_checked: bgChecked, cpr_certified: hasCPR, cna_verified: hasCNA, profile_complete: profileComplete, shifts_5plus: shifts5plus, fast_responder: fastResponder, repeat_clients: repeatClients, five_star_avg: fiveStarAvg }, idVerification: idVerif || null, backgroundCheck: bgCheck || null, certifications, reviews, reviewCount, avgRating: Math.round(avgRating*10)/10, metrics: metrics || null }, { headers })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500, headers })
        }
      },
    },

    // ====== PUBLIC TRUST SCORE ======
    {
      path: '/trust-score',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const url = new URL(req.url)
          const id = url.searchParams.get('id')
          if (!id) return Response.json({ success: false, error: 'id required' }, { status: 400, headers })
          const db = (cloudflare as any).env.D1
          const cgId = parseInt(id)
          const idVerif = await db.prepare('SELECT status FROM caregiver_verifications WHERE caregiver_id = ? AND doc_type IN (?) ORDER BY id DESC LIMIT 1').bind(cgId, 'drivers_license,state_id,passport').first()
          const bgCheck = await db.prepare('SELECT status FROM caregiver_background_checks WHERE caregiver_id = ?').bind(cgId).first()
          const certRows = await db.prepare("SELECT doc_type as name, status FROM caregiver_verifications WHERE caregiver_id = ? AND doc_type IN ('cpr','cna','hha')").bind(cgId).all()
          const cg = await db.prepare('SELECT bio, photo_url, hourly_rate, skills FROM caregiver_accounts WHERE id = ?').bind(cgId).first()
          const reviewAgg = await db.prepare('SELECT COUNT(*) as cnt, AVG(rating) as avg FROM caregiver_reviews WHERE caregiver_id = ? AND is_visible = 1').bind(cgId).first()
          const bookingCount = await db.prepare("SELECT COUNT(*) as cnt FROM caregiver_bookings WHERE caregiver_id = ? AND status = 'accepted'").bind(String(cgId)).first()
          const metrics = await db.prepare('SELECT avg_response_minutes, repeat_bookings FROM caregiver_response_metrics WHERE caregiver_id = ?').bind(cgId).first()
          const cgData = cg as any; let skills = []; try { skills = JSON.parse(cgData?.skills||'[]') } catch {}
          const profileComplete = !!(cgData?.bio && cgData?.photo_url && cgData?.hourly_rate && skills.length>0)
          const certs = certRows.results || []
          const hasCPR = (certs as any[]).some(c => c.name==='cpr' && c.status==='verified')
          const hasCNA = (certs as any[]).some(c => ['cna','hha'].includes(c.name) && c.status==='verified')
          const ra = reviewAgg as any; const bk = bookingCount as any; const mt = metrics as any
          const score = ((idVerif as any)?.status==='verified'?20:0)+((bgCheck as any)?.status==='verified'?20:0)+(hasCPR?15:0)+(hasCNA?10:0)+(profileComplete?10:0)+((bk?.cnt||0)>=5?10:0)+(mt?.avg_response_minutes<=5&&mt?.avg_response_minutes>0?5:0)+((mt?.repeat_bookings||0)>=3?5:0)+((ra?.avg||0)>=4.9&&(ra?.cnt||0)>=3?5:0)
          const level = score>=90?'Elite Caregiver':score>=70?'Verified Pro':score>=40?'Trusted':'Basic'
          return Response.json({ success: true, score, level, idVerified: (idVerif as any)?.status==='verified', backgroundChecked: (bgCheck as any)?.status==='verified', hasCPR, hasCNA, reviewCount: ra?.cnt||0, avgRating: Math.round((ra?.avg||0)*10)/10, fastResponder: mt?.avg_response_minutes<=5&&mt?.avg_response_minutes>0 }, { headers })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500, headers })
        }
      },
    },

    // ====== INITIATE BACKGROUND CHECK ======
    {
      path: '/trust-background',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const url = new URL(req.url)
          const token = url.searchParams.get('token')
          if (!token) return Response.json({ success: false, error: 'token required' }, { status: 401, headers })
          const db = (cloudflare as any).env.D1
          const session = await db.prepare('SELECT caregiver_id FROM caregiver_sessions WHERE token = ?').bind(token).first()
          if (!session) return Response.json({ success: false, error: 'Invalid token' }, { status: 401, headers })
          const cgId = (session as any).caregiver_id
          const now = new Date().toISOString()
          const exp = new Date(Date.now() + 365*24*3600*1000).toISOString()
          await db.prepare('INSERT OR REPLACE INTO caregiver_background_checks (caregiver_id, status, provider, initiated_at, expires_at) VALUES (?, ?, ?, ?, ?)').bind(cgId, 'pending', 'manual_review', now, exp).run()
          return Response.json({ success: true, status: 'pending', message: 'Background check initiated. Our team will contact you within 1-2 business days.' }, { headers })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500, headers })
        }
      },
    },

    // ====== UPLOAD ID VERIFICATION ======
    {
      path: '/trust-id-upload',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const url = new URL(req.url)
          const token = url.searchParams.get('token')
          if (!token) return Response.json({ success: false, error: 'token required' }, { status: 401, headers })
          const db = (cloudflare as any).env.D1
          const session = await db.prepare('SELECT caregiver_id FROM caregiver_sessions WHERE token = ?').bind(token).first()
          if (!session) return Response.json({ success: false, error: 'Invalid token' }, { status: 401, headers })
          const cgId = (session as any).caregiver_id
          const formData = await req.formData()
          const file = formData.get('file')
          const docType = formData.get('doc_type') || 'id_document'
          let frontUrl = ''
          if (file && (file as File).size) {
            const r2 = (cloudflare as any).env.R2
            const f = file as File
            const key = `caregiver-id/${cgId}/${docType}-${Date.now()}-${f.name}`
            await r2.put(key, await f.arrayBuffer(), { httpMetadata: { contentType: f.type } })
            frontUrl = key
          }
          const now = new Date().toISOString()
          await db.prepare('INSERT OR REPLACE INTO caregiver_verifications (caregiver_id, doc_type, front_url, status, submitted_at) VALUES (?, ?, ?, ?, ?)').bind(cgId, docType, frontUrl, 'pending', now).run()
          return Response.json({ success: true, status: 'pending', message: 'ID submitted for review.' }, { headers })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500, headers })
        }
      },
    },

    // ====== ADD CERTIFICATION ======
    {
      path: '/trust-certification',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const url = new URL(req.url)
          const token = url.searchParams.get('token')
          if (!token) return Response.json({ success: false, error: 'token required' }, { status: 401, headers })
          const db = (cloudflare as any).env.D1
          const session = await db.prepare('SELECT caregiver_id FROM caregiver_sessions WHERE token = ?').bind(token).first()
          if (!session) return Response.json({ success: false, error: 'Invalid token' }, { status: 401, headers })
          const cgId = (session as any).caregiver_id
          const formData = await req.formData()
          const certType = formData.get('cert_type') || 'other'
          const expiry = formData.get('expiry') || ''
          const file = formData.get('file')
          let fileUrl = ''
          if (file && (file as File).size) {
            const r2 = (cloudflare as any).env.R2
            const f = file as File
            const key = `caregiver-certs/${cgId}/${certType}-${Date.now()}-${f.name}`
            await r2.put(key, await f.arrayBuffer(), { httpMetadata: { contentType: f.type } })
            fileUrl = key
          }
          const now = new Date().toISOString()
          await db.prepare('INSERT INTO caregiver_verifications (caregiver_id, doc_type, front_url, status, submitted_at, notes) VALUES (?, ?, ?, ?, ?, ?)').bind(cgId, certType, fileUrl, 'pending', now, expiry ? `Expires: ${expiry}` : '').run()
          return Response.json({ success: true, status: 'pending', message: 'Certification submitted for review.' }, { headers })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500, headers })
        }
      },
    },

    // ====== GET CAREGIVER REVIEWS (public) ======
    {
      path: '/caregiver-reviews',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const url = new URL(req.url)
          const id = url.searchParams.get('id')
          if (!id) return Response.json({ success: false, error: 'id required' }, { status: 400, headers })
          const db = (cloudflare as any).env.D1
          const rows = await db.prepare('SELECT rating, review_text, is_repeat_client, is_punctual, is_caring, is_professional, would_hire_again, created_at FROM caregiver_reviews WHERE caregiver_id = ? AND is_visible = 1 ORDER BY created_at DESC LIMIT 20').bind(parseInt(id)).all()
          const reviews = rows.results || []
          const avg = reviews.length > 0 ? (reviews as any[]).reduce((s, r) => s + (r as any).rating, 0) / reviews.length : 0
          return Response.json({ success: true, reviews, avgRating: Math.round(avg*10)/10, reviewCount: reviews.length }, { headers })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500, headers })
        }
      },
    },

    // ====== SUBMIT REVIEW (from client portal) ======
    {
      path: '/submit-review',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const body = await req.json()
          const { clientToken, caregiverId, bookingId, rating, reviewText, isPunctual, isCaring, isCommunicative, isProfessional, wouldHireAgain } = body
          if (!caregiverId || !rating) return Response.json({ success: false, error: 'caregiverId and rating required' }, { status: 400, headers })
          if (rating < 1 || rating > 5) return Response.json({ success: false, error: 'rating must be 1-5' }, { status: 400, headers })
          const db = (cloudflare as any).env.D1
          let clientEmail = body.clientEmail || 'anonymous'
          if (clientToken) {
            const sess = await db.prepare('SELECT email FROM client_sessions WHERE token = ?').bind(clientToken).first()
            if (sess) clientEmail = (sess as any).email
          }
          const prior = await db.prepare("SELECT COUNT(*) as cnt FROM caregiver_bookings WHERE caregiver_id = ? AND client_email = ? AND status = 'accepted'").bind(String(caregiverId), clientEmail).first()
          const isRepeat = ((prior as any)?.cnt || 0) > 1 ? 1 : 0
          await db.prepare('INSERT INTO caregiver_reviews (caregiver_id, client_email, booking_id, rating, review_text, is_punctual, is_caring, is_communicative, is_professional, would_hire_again, is_repeat_client, is_visible) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)').bind(parseInt(caregiverId), clientEmail, bookingId||null, rating, reviewText||'', isPunctual?1:0, isCaring?1:0, isCommunicative?1:0, isProfessional?1:0, wouldHireAgain?1:0, isRepeat).run()
          if (isRepeat) {
            await db.prepare("INSERT INTO caregiver_response_metrics (caregiver_id, repeat_bookings, total_requests, accepted, completed_shifts, avg_response_minutes) VALUES (?, 1, 0, 0, 0, 0) ON CONFLICT(caregiver_id) DO UPDATE SET repeat_bookings = repeat_bookings + 1, updated_at = datetime('now')").bind(parseInt(caregiverId)).run()
          }
          return Response.json({ success: true, message: 'Review submitted. Thank you!' }, { headers })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500, headers })
        }
      },
    },

    // ====== UPDATE RESPONSE METRICS ======
    {
      path: '/update-response-metrics',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const body = await req.json()
          const { caregiverId, responseMinutes, accepted, completed } = body
          if (!caregiverId) return Response.json({ success: false, error: 'caregiverId required' }, { status: 400, headers })
          const db = (cloudflare as any).env.D1
          const cgId = parseInt(caregiverId)
          const existing = await db.prepare('SELECT * FROM caregiver_response_metrics WHERE caregiver_id = ?').bind(cgId).first()
          if (existing) {
            const ex = existing as any
            const newTotal = (ex.total_requests||0) + 1
            const newAccepted = (ex.accepted||0) + (accepted?1:0)
            const newCompleted = (ex.completed_shifts||0) + (completed?1:0)
            const avgResp = responseMinutes != null ? ((ex.avg_response_minutes||0)*(ex.total_requests||1) + responseMinutes) / newTotal : ex.avg_response_minutes||0
            await db.prepare("UPDATE caregiver_response_metrics SET total_requests=?,accepted=?,completed_shifts=?,avg_response_minutes=?,updated_at=datetime('now') WHERE caregiver_id=?").bind(newTotal,newAccepted,newCompleted,avgResp,cgId).run()
          } else {
            await db.prepare("INSERT INTO caregiver_response_metrics (caregiver_id,total_requests,accepted,completed_shifts,avg_response_minutes,repeat_bookings) VALUES (?,?,?,?,?,0)").bind(cgId,1,accepted?1:0,completed?1:0,responseMinutes||0).run()
          }
          return Response.json({ success: true }, { headers })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500, headers })
        }
      },
    },



    // ====== PHASE 1A: CARE REQUEST DISPATCH ======
    {
      path: '/care-request',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers })
        try {
          const body = await req.json()
          const { care_type, care_types, description, zip_code, city, state, start_date, start_time, duration_hours, pay_rate, client_email, client_id } = body
          if (!care_type || !zip_code) return Response.json({ error: 'care_type and zip_code required' }, { status: 400, headers })
          const db = (cloudflare as any).env.D1
          const env = (cloudflare as any).env
          const insert = await db.prepare(`INSERT INTO care_requests (client_id,client_email,care_type,care_types,description,zip_code,city,state,start_date,start_time,duration_hours,pay_rate,status,round_1_sent_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'dispatching',datetime('now'),datetime('now')) RETURNING id`).bind(client_id||null,client_email||null,care_type,JSON.stringify(care_types||[care_type]),description||'',zip_code,city||'',state||'',start_date||'',start_time||'',duration_hours||null,pay_rate||25).all()
          const requestId = insert.results[0]?.id
          if (!requestId) return Response.json({ error: 'Failed to create request' }, { status: 500, headers })
          const caregivers = await _findDispatchCgs(db, zip_code, care_type, 5, 10)
          for (const cg of caregivers) { await db.prepare(`INSERT OR IGNORE INTO dispatch_notifications (request_id,caregiver_id,round,status,dispatch_score,distance_miles) VALUES (?,?,1,'sent',?,?)`).bind(requestId,cg.id,cg.dispatch_score,cg.distance_miles).run() }
          await db.prepare(`UPDATE care_requests SET caregivers_notified=? WHERE id=?`).bind(caregivers.length, requestId).run()
          const pushSent = await _sendPushBatch(db, caregivers.map((c:any)=>c.id), env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY)
          const { results: ms } = await db.prepare(`SELECT COUNT(*) as cnt FROM booking_milestones`).all()
          const bn = ((ms[0] as any)?.cnt||0)+1
          await db.prepare(`INSERT INTO booking_milestones (request_id,booking_number,zip_code,care_type,client_id,caregivers_notified,request_created_at,first_notification_at) VALUES (?,?,?,?,?,?,datetime('now'),datetime('now'))`).bind(requestId,bn,zip_code,care_type,client_id||null,caregivers.length).run()
          return Response.json({ success:true, request_id:requestId, booking_number:bn, caregivers_notified:caregivers.length, push_sent:pushSent, round:1, message:`Found ${caregivers.length} caregivers near you. Notifying them now.` }, { headers })
        } catch (error) { return Response.json({ error: String(error) }, { status: 500, headers }) }
      },
    },

    // ====== CARE REQUEST STATUS (CLIENT POLLS) ======
    {
      path: '/care-request-status',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const url = new URL(req.url||'', 'http://x'); const requestId = url.searchParams.get('id')
          if (!requestId) return Response.json({ error: 'id required' }, { status: 400, headers })
          const db = (cloudflare as any).env.D1; const env = (cloudflare as any).env
          const { results } = await db.prepare(`SELECT * FROM care_requests WHERE id=?`).bind(requestId).all()
          const request = (results as any[])[0]; if (!request) return Response.json({ error: 'Not found' }, { status: 404, headers })
          const { results: notifs } = await db.prepare(`SELECT status,COUNT(*) as cnt FROM dispatch_notifications WHERE request_id=? GROUP BY status`).bind(requestId).all()
          const byStatus: any = {}; (notifs as any[]).forEach((n:any)=>{ byStatus[n.status]=n.cnt })
          const viewing = byStatus['viewed']||0; const now = Date.now()
          const elapsedMins = (now - new Date(request.created_at).getTime())/60000
          let progressMessage = 'Finding caregivers near you'; let progressStep = 1
          if (request.status==='accepted') { progressMessage='A caregiver accepted your request!'; progressStep=4 }
          else if (viewing>0) { progressMessage=`${viewing} caregiver${viewing>1?'s are':' is'} reviewing your request`; progressStep=3 }
          else if (request.caregivers_notified>0) {
            progressMessage=`Notified ${request.caregivers_notified} caregivers`; progressStep=2
            if (elapsedMins>5) { progressMessage='Still searching — expanding search radius'; progressStep=5 }
          }
          // Advance round if needed
          const roundFields=['round_1_sent_at','round_2_sent_at','round_3_sent_at','round_4_sent_at']
          const roundConfigs=[{afterMins:0,radius:5,limit:10},{afterMins:2,radius:10,limit:15},{afterMins:5,radius:15,limit:25},{afterMins:10,radius:25,limit:50}]
          if (request.status==='dispatching') {
            for (let r=1;r<4;r++) {
              const prevSent=(request as any)[roundFields[r-1]]; const thisSent=(request as any)[roundFields[r]]
              if (prevSent&&!thisSent&&(now-new Date(prevSent).getTime())/60000>=roundConfigs[r].afterMins) {
                const newCgs=await _findDispatchCgs(db,request.zip_code,request.care_type,roundConfigs[r].radius,roundConfigs[r].limit)
                const {results:ex}=await db.prepare(`SELECT caregiver_id FROM dispatch_notifications WHERE request_id=?`).bind(requestId).all()
                const exIds=new Set((ex as any[]).map((n:any)=>n.caregiver_id))
                const newOnly=newCgs.filter((cg:any)=>!exIds.has(cg.id))
                for(const cg of newOnly){await db.prepare(`INSERT OR IGNORE INTO dispatch_notifications (request_id,caregiver_id,round,status,dispatch_score,distance_miles) VALUES (?,?,?,'sent',?,?)`).bind(requestId,cg.id,r+1,cg.dispatch_score,cg.distance_miles).run()}
                await db.prepare(`UPDATE care_requests SET current_round=?,${roundFields[r]}=datetime('now'),caregivers_notified=caregivers_notified+? WHERE id=?`).bind(r+1,newOnly.length,requestId).run()
                await _sendPushBatch(db,newOnly.map((c:any)=>c.id),env.VAPID_PUBLIC_KEY,env.VAPID_PRIVATE_KEY); break
              }
            }
          }
          let acceptedCaregiver = null
          if (request.accepted_caregiver_id) {
            const {results:cgs}=await db.prepare(`SELECT id,name,photo_url,hourly_rate,city FROM caregiver_accounts WHERE id=?`).bind(request.accepted_caregiver_id).all()
            acceptedCaregiver=(cgs as any[])[0]||null
          }
          return Response.json({ request_id:request.id, status:request.status, current_round:request.current_round||1, caregivers_notified:request.caregivers_notified, caregivers_viewing:viewing, caregivers_declined:byStatus['declined']||0, progress_message:progressMessage, progress_step:progressStep, accepted_caregiver:acceptedCaregiver, created_at:request.created_at, accepted_at:request.accepted_at }, { headers })
        } catch (error) { return Response.json({ error: String(error) }, { status: 500, headers }) }
      },
    },

    // ====== CAREGIVER LIVE REQUESTS (CAREGIVER POLLS) ======
    {
      path: '/caregiver-live-requests',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const url = new URL(req.url||'','http://x'); const token = url.searchParams.get('token')
          if (!token) return Response.json({ error: 'Unauthorized' }, { status: 401, headers })
          const db = (cloudflare as any).env.D1
          const {results:sess}=await db.prepare(`SELECT caregiver_id FROM caregiver_sessions WHERE token=?`).bind(token).all()
          if (!(sess as any[])[0]) return Response.json({ error: 'Unauthorized' }, { status: 401, headers })
          const caregiverId=(sess as any[])[0].caregiver_id
          const {results:cgRows}=await db.prepare(`SELECT * FROM caregiver_accounts WHERE id=?`).bind(caregiverId).all()
          const cg=(cgRows as any[])[0]; if(!cg) return Response.json({ error:'Not found' }, { status:404, headers })
          await db.prepare(`UPDATE dispatch_notifications SET status='viewed',viewed_at=datetime('now') WHERE caregiver_id=? AND status='sent'`).bind(caregiverId).run()
          await db.prepare(`INSERT OR REPLACE INTO caregiver_online_status (caregiver_id,is_online,zip_code,last_seen,updated_at) VALUES (?,1,?,datetime('now'),datetime('now'))`).bind(caregiverId,cg.zip_code||'').run()
          const {results:dispatches}=await db.prepare(`
            SELECT dn.id as dispatch_id,dn.request_id,dn.round,dn.status as dispatch_status,dn.dispatch_score,dn.distance_miles,dn.sent_at,
                   cr.care_type,cr.description,cr.zip_code,cr.city,cr.state,cr.start_date,cr.start_time,cr.duration_hours,
                   cr.pay_rate,cr.status as request_status,cr.created_at,cr.current_round,cr.round_1_sent_at,cr.round_2_sent_at,cr.round_3_sent_at,cr.round_4_sent_at,cr.accepted_caregiver_id
            FROM dispatch_notifications dn JOIN care_requests cr ON cr.id=dn.request_id
            WHERE dn.caregiver_id=? AND cr.status IN ('pending','dispatching') AND dn.status NOT IN ('declined','expired')
            ORDER BY cr.created_at DESC LIMIT 20
          `).bind(caregiverId).all()
          const enriched=(dispatches as any[]).map((d:any)=>{
            const ri=(d.current_round||1)-1
            const rsf=[d.round_1_sent_at,d.round_2_sent_at,d.round_3_sent_at,d.round_4_sent_at]
            const expiresAt=rsf[ri]?new Date(rsf[ri]).getTime()+(_ROUND_DURATION_MINS[ri]||2)*60000:Date.now()+120000
            const remaining=expiresAt-Date.now(); const taken=d.accepted_caregiver_id&&d.accepted_caregiver_id!==caregiverId
            return {dispatch_id:d.dispatch_id,request_id:d.request_id,care_type:d.care_type,description:d.description||'',zip_code:d.zip_code,city:d.city,distance_miles:d.distance_miles,pay_rate:d.pay_rate,start_date:d.start_date,start_time:d.start_time,duration_hours:d.duration_hours,dispatch_score:d.dispatch_score,round:d.current_round,request_status:taken?'taken':remaining<=0?'expired':d.request_status,expires_at:new Date(expiresAt).toISOString(),expires_in_ms:Math.max(0,remaining),is_expired:remaining<=0||taken,sent_at:d.sent_at}
          })
          return Response.json({ requests:enriched, count:enriched.length }, { headers })
        } catch (error) { return Response.json({ error: String(error) }, { status: 500, headers }) }
      },
    },

    // ====== DISPATCH ACCEPT (ATOMIC FIRST-ACCEPT-WINS) ======
    {
      path: '/dispatch-accept',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const body = await req.json()
          const { token, request_id } = body
          if (!token||!request_id) return Response.json({ error: 'token and request_id required' }, { status: 400, headers })
          const db = (cloudflare as any).env.D1
          const {results:sess}=await db.prepare(`SELECT caregiver_id FROM caregiver_sessions WHERE token=?`).bind(token).all()
          if (!(sess as any[])[0]) return Response.json({ error: 'Unauthorized' }, { status: 401, headers })
          const caregiverId=(sess as any[])[0].caregiver_id
          const {results:dn}=await db.prepare(`SELECT * FROM dispatch_notifications WHERE request_id=? AND caregiver_id=?`).bind(request_id,caregiverId).all()
          if (!(dn as any[])[0]) return Response.json({ error: 'Not dispatched to you' }, { status: 403, headers })
          const result=await db.prepare(`UPDATE care_requests SET status='accepted',accepted_caregiver_id=?,accepted_at=datetime('now') WHERE id=? AND status IN ('pending','dispatching')`).bind(caregiverId,request_id).run()
          if (result.meta.changes===0) {
            const {results:ex}=await db.prepare(`SELECT accepted_caregiver_id FROM care_requests WHERE id=?`).bind(request_id).all()
            if ((ex as any[])[0]?.accepted_caregiver_id===caregiverId) return Response.json({ success:true, message:'You already accepted this booking.' }, { headers })
            return Response.json({ error:'This booking has already been accepted by another caregiver.',taken:true }, { status: 409, headers })
          }
          await db.prepare(`UPDATE dispatch_notifications SET status='accepted',responded_at=datetime('now') WHERE request_id=? AND caregiver_id=?`).bind(request_id,caregiverId).run()
          await db.prepare(`UPDATE dispatch_notifications SET status='expired' WHERE request_id=? AND caregiver_id!=?`).bind(request_id,caregiverId).run()
          const {results:crRow}=await db.prepare(`SELECT * FROM care_requests WHERE id=?`).bind(request_id).all()
          const cr=(crRow as any[])[0]
          if (cr) {
            const secs=Math.round((Date.now()-new Date(cr.created_at).getTime())/1000)
            await db.prepare(`UPDATE booking_milestones SET caregiver_id=?,accepted_at=datetime('now'),time_to_accept_seconds=? WHERE request_id=?`).bind(caregiverId,secs,request_id).run()
          }
          await db.prepare(`INSERT INTO caregiver_response_metrics (caregiver_id,total_requests,accepted,avg_response_minutes,updated_at) VALUES (?,1,1,5,datetime('now')) ON CONFLICT(caregiver_id) DO UPDATE SET total_requests=total_requests+1,accepted=accepted+1,updated_at=datetime('now')`).bind(caregiverId).run()
          return Response.json({ success:true, message:'Booking accepted! View the details below.', request:{ id:cr?.id, care_type:cr?.care_type, zip_code:cr?.zip_code, city:cr?.city, start_date:cr?.start_date, start_time:cr?.start_time, pay_rate:cr?.pay_rate } }, { headers })
        } catch (error) { return Response.json({ error: String(error) }, { status: 500, headers }) }
      },
    },

    // ====== DISPATCH DECLINE ======
    {
      path: '/dispatch-decline',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const body = await req.json()
          const { token, request_id } = body
          if (!token||!request_id) return Response.json({ error: 'token and request_id required' }, { status: 400, headers })
          const db = (cloudflare as any).env.D1
          const {results:sess}=await db.prepare(`SELECT caregiver_id FROM caregiver_sessions WHERE token=?`).bind(token).all()
          if (!(sess as any[])[0]) return Response.json({ error: 'Unauthorized' }, { status: 401, headers })
          const caregiverId=(sess as any[])[0].caregiver_id
          await db.prepare(`UPDATE dispatch_notifications SET status='declined',responded_at=datetime('now') WHERE request_id=? AND caregiver_id=?`).bind(request_id,caregiverId).run()
          await db.prepare(`UPDATE care_requests SET caregivers_declined=caregivers_declined+1 WHERE id=?`).bind(request_id).run()
          await db.prepare(`INSERT INTO caregiver_response_metrics (caregiver_id,total_requests,accepted,avg_response_minutes,updated_at) VALUES (?,1,0,5,datetime('now')) ON CONFLICT(caregiver_id) DO UPDATE SET total_requests=total_requests+1,updated_at=datetime('now')`).bind(caregiverId).run()
          return Response.json({ success:true, message:'Request passed.' }, { headers })
        } catch (error) { return Response.json({ error: String(error) }, { status: 500, headers }) }
      },
    },

    // ====== CAREGIVER ONLINE STATUS ======
    {
      path: '/caregiver-online-status',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const body = await req.json()
          const { token, is_online } = body
          if (!token) return Response.json({ error: 'token required' }, { status: 400, headers })
          const db = (cloudflare as any).env.D1
          const {results:sess}=await db.prepare(`SELECT caregiver_id FROM caregiver_sessions WHERE token=?`).bind(token).all()
          if (!(sess as any[])[0]) return Response.json({ error: 'Unauthorized' }, { status: 401, headers })
          const caregiverId=(sess as any[])[0].caregiver_id
          const {results:cgRows}=await db.prepare(`SELECT zip_code FROM caregiver_accounts WHERE id=?`).bind(caregiverId).all()
          const zip=(cgRows as any[])[0]?.zip_code||''
          await db.prepare(`INSERT OR REPLACE INTO caregiver_online_status (caregiver_id,is_online,zip_code,last_seen,updated_at) VALUES (?,?,?,datetime('now'),datetime('now'))`).bind(caregiverId,is_online?1:0,zip).run()
          return Response.json({ success:true, is_online:!!is_online }, { headers })
        } catch (error) { return Response.json({ error: String(error) }, { status: 500, headers }) }
      },
    },

    // ====== PUSH SUBSCRIBE ======
    {
      path: '/push-subscribe',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const body = await req.json()
          const { token, endpoint, p256dh, auth, user_agent } = body
          if (!token||!endpoint) return Response.json({ error: 'token and endpoint required' }, { status: 400, headers })
          const db = (cloudflare as any).env.D1
          const {results:sess}=await db.prepare(`SELECT caregiver_id FROM caregiver_sessions WHERE token=?`).bind(token).all()
          if (!(sess as any[])[0]) return Response.json({ error: 'Unauthorized' }, { status: 401, headers })
          const caregiverId=(sess as any[])[0].caregiver_id
          await db.prepare(`INSERT OR REPLACE INTO push_subscriptions (caregiver_id,endpoint,p256dh,auth,user_agent,created_at,last_used_at) VALUES (?,?,?,?,?,datetime('now'),datetime('now'))`).bind(caregiverId,endpoint,p256dh||null,auth||null,user_agent||null).run()
          return Response.json({ success:true, message:'Push subscription saved.' }, { headers })
        } catch (error) { return Response.json({ error: String(error) }, { status: 500, headers }) }
      },
    },

    // ====== PUSH UNSUBSCRIBE ======
    {
      path: '/push-unsubscribe',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const body = await req.json()
          const { token } = body
          if (!token) return Response.json({ error: 'token required' }, { status: 400, headers })
          const db = (cloudflare as any).env.D1
          const {results:sess}=await db.prepare(`SELECT caregiver_id FROM caregiver_sessions WHERE token=?`).bind(token).all()
          if (!(sess as any[])[0]) return Response.json({ error: 'Unauthorized' }, { status: 401, headers })
          await db.prepare(`DELETE FROM push_subscriptions WHERE caregiver_id=?`).bind((sess as any[])[0].caregiver_id).run()
          return Response.json({ success:true }, { headers })
        } catch (error) { return Response.json({ error: String(error) }, { status: 500, headers }) }
      },
    },

    // ====== PUSH TEST ======
    {
      path: '/push-test',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const body = await req.json()
          const { token } = body
          if (!token) return Response.json({ error: 'token required' }, { status: 400, headers })
          const db = (cloudflare as any).env.D1; const env = (cloudflare as any).env
          const {results:sess}=await db.prepare(`SELECT caregiver_id FROM caregiver_sessions WHERE token=?`).bind(token).all()
          if (!(sess as any[])[0]) return Response.json({ error: 'Unauthorized' }, { status: 401, headers })
          const caregiverId=(sess as any[])[0].caregiver_id
          const sent=await _sendPushBatch(db,[caregiverId],env.VAPID_PUBLIC_KEY,env.VAPID_PRIVATE_KEY)
          return Response.json({ success:true, sent, message:sent>0?'Test notification sent!':'No push subscription found. Enable notifications first.' }, { headers })
        } catch (error) { return Response.json({ error: String(error) }, { status: 500, headers }) }
      },
    },

    // ====== ADMIN LAUNCH METRICS ======
    {
      path: '/admin-launch-metrics',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        const url = new URL(req.url||'','http://x'); const adminKey=url.searchParams.get('key')
        if (adminKey!=='carehia_launch_2026') return Response.json({ error:'Unauthorized' }, { status:401, headers })
        try {
          const db = (cloudflare as any).env.D1
          const TARGET_ZIPS = ['95823','95828','95864']
          const zipMetrics: any[] = []
          for (const zip of TARGET_ZIPS) {
            const {results:t}=await db.prepare(`SELECT COUNT(*) as cnt FROM caregiver_accounts WHERE zip_code=?`).bind(zip).all()
            const {results:o}=await db.prepare(`SELECT COUNT(*) as cnt FROM caregiver_online_status WHERE zip_code=? AND is_online=1`).bind(zip).all()
            const {results:p}=await db.prepare(`SELECT COUNT(*) as cnt FROM caregiver_accounts WHERE zip_code=? AND skills IS NOT NULL AND bio IS NOT NULL AND photo_url IS NOT NULL`).bind(zip).all()
            const {results:pu}=await db.prepare(`SELECT COUNT(DISTINCT ps.caregiver_id) as cnt FROM push_subscriptions ps JOIN caregiver_accounts ca ON ca.id=ps.caregiver_id WHERE ca.zip_code=?`).bind(zip).all()
            const {results:tv}=await db.prepare(`SELECT COUNT(DISTINCT cts.caregiver_id) as cnt FROM caregiver_trust_scores cts JOIN caregiver_accounts ca ON ca.id=cts.caregiver_id WHERE ca.zip_code=? AND cts.score>=60`).bind(zip).all()
            const tc=(t[0] as any)?.cnt||0,oc=(o[0] as any)?.cnt||0,pc=(p[0] as any)?.cnt||0,puc=(pu[0] as any)?.cnt||0,tvc=(tv[0] as any)?.cnt||0
            const lr=tc>=30&&pc>=15&&oc>=10&&puc>=8; const bs=tc>=10&&pc>=5
            zipMetrics.push({ zip, city:zip==='95823'?'Sacramento (South)':zip==='95828'?'Sacramento (SE)':'Sacramento (NE)', total_caregivers:tc, online_caregivers:oc, profile_complete:pc, push_enabled:puc, trust_verified:tvc, launch_status:lr?'Launch Ready ✅':bs?'Building Supply 🔄':'Weak Supply ⚠️', launch_ready:lr })
          }
          const {results:tc2}=await db.prepare(`SELECT COUNT(*) as cnt FROM caregiver_accounts`).all()
          const {results:to}=await db.prepare(`SELECT COUNT(*) as cnt FROM caregiver_online_status WHERE is_online=1`).all()
          const {results:tr}=await db.prepare(`SELECT COUNT(*) as cnt FROM care_requests`).all()
          const {results:ta}=await db.prepare(`SELECT COUNT(*) as cnt FROM care_requests WHERE status='accepted'`).all()
          const {results:ar}=await db.prepare(`SELECT AVG(time_to_accept_seconds) as avg FROM booking_milestones WHERE time_to_accept_seconds>0`).all()
          return Response.json({ target_zips:zipMetrics, overall:{ total_caregivers:(tc2[0] as any)?.cnt||0, online_caregivers:(to[0] as any)?.cnt||0, total_requests:(tr[0] as any)?.cnt||0, accepted_requests:(ta[0] as any)?.cnt||0, avg_response_seconds:Math.round((ar[0] as any)?.avg||0) }, thresholds:{total:30,profile_complete:15,online:10,push_enabled:8}, generated_at:new Date().toISOString() }, { headers })
        } catch (error) { return Response.json({ error: String(error) }, { status: 500, headers }) }
      },
    },

    // ====== ADMIN FIRST 20 BOOKINGS ======
    {
      path: '/admin-first-20',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        const url = new URL(req.url||'','http://x'); const adminKey=url.searchParams.get('key')
        if (adminKey!=='carehia_launch_2026') return Response.json({ error:'Unauthorized' }, { status:401, headers })
        try {
          const db = (cloudflare as any).env.D1
          const {results:ms}=await db.prepare(`SELECT * FROM booking_milestones ORDER BY booking_number ASC LIMIT 20`).all()
          const {results:s}=await db.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN accepted_at IS NOT NULL THEN 1 ELSE 0 END) as accepted, SUM(booking_completed) as completed, AVG(CASE WHEN time_to_accept_seconds>0 THEN time_to_accept_seconds END) as avg_time, SUM(review_left) as reviews, SUM(client_rebooked) as rebooked FROM booking_milestones`).all()
          const sum=(s[0] as any)||{}; const total=sum.total||0; const accepted=sum.accepted||0
          return Response.json({
            bookings:ms, summary:{ total_created:total, total_accepted:accepted, total_completed:sum.completed||0, acceptance_rate:total>0?Math.round((accepted/total)*100):0, avg_time_to_accept_secs:Math.round(sum.avg_time||0), review_rate:accepted>0?Math.round(((sum.reviews||0)/accepted)*100):0, repeat_booking_rate:accepted>0?Math.round(((sum.rebooked||0)/accepted)*100):0 },
            milestones:[{goal:1,reached:total>=1,label:'🎉 First Booking!'},{goal:5,reached:total>=5,label:'🚀 5 Bookings'},{goal:10,reached:total>=10,label:'🔥 10 Bookings'},{goal:20,reached:total>=20,label:'🏆 20 Bookings — Goal Reached!'}],
            goal_message:'Goal: Complete first 20 bookings in the launch ZIPs.',generated_at:new Date().toISOString()
          }, { headers })
        } catch (error) { return Response.json({ error: String(error) }, { status: 500, headers }) }
      },
    },

    // ====== CLIENT ONSITE CAREGIVER TRACKER ======
    {
      path: '/client-onsite-caregiver',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const url = new URL(req.url || '', 'http://x')
          const clientToken = url.searchParams.get('clientToken')
          if (!clientToken) return Response.json({ active: false, error: 'clientToken required' }, { status: 400, headers })

          const db = (cloudflare as any).env.D1

          // Validate token — check client_sessions
          const session = await db.prepare(
            "SELECT client_email FROM client_sessions WHERE token = ? AND expires_at > datetime('now')"
          ).bind(clientToken).first() as any

          if (!session) return Response.json({ active: false, error: 'Invalid or expired token' }, { status: 401, headers })

          const clientEmail = session.client_email

          // Get caregivers on this client's team
          const teamResult = await db.prepare(
            "SELECT caregiver_id FROM client_team WHERE client_email = ? AND status = 'active'"
          ).bind(clientEmail.toLowerCase()).all()

          const caregiverIds: number[] = ((teamResult.results || []) as any[]).map((r: any) => r.caregiver_id)

          if (!caregiverIds.length) {
            return Response.json({ active: false, message: 'No caregivers on team' }, { headers })
          }

          // Find any caregiver on team who has an active timer running
          // caregiver_active_timer uses caregiver_email — join via caregiver_accounts
          const ph = caregiverIds.map(() => '?').join(',')
          const timerRow = await db.prepare(
            `SELECT cat.start_time, cat.client_name, ca.name as caregiver_name, ca.photo_url, ca.id as caregiver_id
             FROM caregiver_active_timer cat
             JOIN caregiver_accounts ca ON ca.email = cat.caregiver_email
             WHERE ca.id IN (${ph})
             ORDER BY cat.start_time DESC LIMIT 1`
          ).bind(...caregiverIds).first() as any

          if (!timerRow) {
            return Response.json({ active: false, message: 'No caregiver currently onsite' }, { headers })
          }

          return Response.json({
            active: true,
            caregiver_name: timerRow.caregiver_name || 'Caregiver',
            caregiver_id: timerRow.caregiver_id,
            photo_url: timerRow.photo_url || null,
            start_time: timerRow.start_time,
            client_name: timerRow.client_name || '',
          }, { headers })
        } catch (error) {
          return Response.json({ active: false, error: String(error) }, { status: 500, headers })
        }
      },
    },

    // ====== CLIENT PREFERENCES (save/load zip + care needs) ======
    {
      path: '/client-preferences',
      method: 'get',
      handler: async (req) => {
        try {
          const url = new URL(req.url)
          const token = url.searchParams.get('clientToken')
          if (!token) return Response.json({ error: 'clientToken required' }, { status: 400 })
          const headers = { 'Access-Control-Allow-Origin': '*' }
          const db = (cloudflare.env as any).D1
          // Validate session
          const session = await db.prepare(
            "SELECT client_email FROM client_sessions WHERE token = ? AND expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!session) return Response.json({ error: 'Invalid or expired token' }, { status: 401, headers })
          // Get zip + care_types from client_accounts
          const client = await db.prepare(
            'SELECT zip, care_types, name FROM client_accounts WHERE email = ?'
          ).bind(session.client_email).first() as any
          if (!client) return Response.json({ zip: null, careNeeds: [], headers })
          return Response.json({
            success: true,
            zip: client.zip || null,
            careNeeds: client.care_types ? JSON.parse(client.care_types) : [],
            name: client.name || '',
          }, { headers })
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 })
        }
      },
    },
    {
      path: '/client-preferences',
      method: 'post',
      handler: async (req) => {
        try {
          const url = new URL(req.url)
          const token = url.searchParams.get('clientToken')
          const body = await req.json()
          if (!token) return Response.json({ error: 'clientToken required' }, { status: 400 })
          const headers = { 'Access-Control-Allow-Origin': '*' }
          const db = (cloudflare.env as any).D1
          const session = await db.prepare(
            "SELECT client_email FROM client_sessions WHERE token = ? AND expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!session) return Response.json({ error: 'Invalid or expired token' }, { status: 401, headers })
          const { zip, careNeeds } = body
          await db.prepare(
            'UPDATE client_accounts SET zip = ?, care_types = ? WHERE email = ?'
          ).bind(zip || null, careNeeds ? JSON.stringify(careNeeds) : null, session.client_email).run()
          return Response.json({ success: true }, { headers })
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 })
        }
      },
    },
    // ====== CLIENT SHORTLIST (persist across sessions) ======
    {
      path: '/client-shortlist',
      method: 'get',
      handler: async (req) => {
        try {
          const url = new URL(req.url)
          const token = url.searchParams.get('clientToken')
          if (!token) return Response.json({ error: 'clientToken required' }, { status: 400 })
          const headers = { 'Access-Control-Allow-Origin': '*' }
          const db = (cloudflare.env as any).D1
          const session = await db.prepare(
            "SELECT client_email FROM client_sessions WHERE token = ? AND expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!session) return Response.json({ items: [] }, { headers })
          const result = await db.prepare(
            'SELECT caregiver_id, caregiver_data, saved_at FROM client_shortlist WHERE client_email = ? ORDER BY saved_at DESC'
          ).bind(session.client_email).all()
          const items = (result.results || []).map((r: any) => ({
            caregiverId: r.caregiver_id,
            savedAt: r.saved_at,
            data: r.caregiver_data ? JSON.parse(r.caregiver_data) : null,
          }))
          return Response.json({ success: true, items }, { headers })
        } catch (error) {
          return Response.json({ items: [], error: String(error) }, { status: 500 })
        }
      },
    },
    {
      path: '/client-shortlist',
      method: 'post',
      handler: async (req) => {
        try {
          const url = new URL(req.url)
          const token = url.searchParams.get('clientToken')
          const body = await req.json()
          if (!token) return Response.json({ error: 'clientToken required' }, { status: 400 })
          const headers = { 'Access-Control-Allow-Origin': '*' }
          const db = (cloudflare.env as any).D1
          const session = await db.prepare(
            "SELECT client_email FROM client_sessions WHERE token = ? AND expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!session) return Response.json({ error: 'Not authenticated' }, { status: 401, headers })
          const { action, caregiverId, caregiverData } = body
          if (action === 'add') {
            await db.prepare(
              'INSERT OR REPLACE INTO client_shortlist (client_email, caregiver_id, caregiver_data) VALUES (?, ?, ?)'
            ).bind(session.client_email, String(caregiverId), caregiverData ? JSON.stringify(caregiverData) : null).run()
          } else if (action === 'remove') {
            await db.prepare(
              'DELETE FROM client_shortlist WHERE client_email = ? AND caregiver_id = ?'
            ).bind(session.client_email, String(caregiverId)).run()
          } else if (action === 'clear') {
            await db.prepare(
              'DELETE FROM client_shortlist WHERE client_email = ?'
            ).bind(session.client_email).run()
          }
          return Response.json({ success: true }, { headers })
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 })
        }
      },
    },

  ],
})
