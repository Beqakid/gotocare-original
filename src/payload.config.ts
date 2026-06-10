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
  // Phase 14C: Added travel_radius_miles to SELECT
  const { results } = await db.prepare(`
    SELECT ca.id,ca.name,ca.zip_code,ca.skills,ca.hourly_rate,ca.photo_url,ca.city,ca.state,
           COALESCE(ca.travel_radius_miles,10) as travel_radius_miles,
           COALESCE(cos.is_online,0) as is_online, COALESCE(cts.score,50) as trust_score,
           COALESCE(crm.avg_response_minutes,60) as avg_response_minutes
    FROM caregiver_accounts ca
    LEFT JOIN caregiver_online_status cos ON cos.caregiver_id=ca.id
    LEFT JOIN caregiver_trust_scores cts ON cts.caregiver_id=ca.id
    LEFT JOIN caregiver_response_metrics crm ON crm.caregiver_id=ca.id
    WHERE ca.zip_code IS NOT NULL
    AND COALESCE(ca.safety_status, 'active') NOT IN ('suspended','blocked','deactivated')
    LIMIT 300
  `).all();
  // Phase 14C: Dual radius filter — caregiver must be within BOTH system dispatch radius
  // AND their own personal travel radius preference (default 10 mi if not set)
  return results
    .map((cg: any) => {
      const d = _getZipDist(zip, cg.zip_code || '');
      const cgRadius = cg.travel_radius_miles || 10;
      return { ...cg, distance_miles: Math.round(d*10)/10, travel_radius_miles: cgRadius, dispatch_score: _dispatchScore(cg, careType, d), matched_by_radius: true };
    })
    .filter((cg: any) => {
      if (!cg.zip_code) return false; // edge case: missing_caregiver_location
      const cgRadius = cg.travel_radius_miles || 10;
      // Must satisfy system dispatch radius AND caregiver's personal travel preference
      return cg.distance_miles <= Math.min(radius, cgRadius);
    })
    .sort((a: any, b: any) => b.dispatch_score - a.dispatch_score)
    .slice(0, limit);
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


// ═══════════════════════════════════════════════════════════════════════
// AUTHORIZATION HELPERS — strict role enforcement
// All helpers close over cloudflare.env.D1
// ═══════════════════════════════════════════════════════════════════════

/** Validate caregiver session. Returns { account_id, email } or null.
 *  Accepts: Authorization: Bearer <token>, x-caregiver-token header, or ?token= query param. */
async function _requireCgAuth(req: any): Promise<{ account_id: number; email: string } | null> {
  const url = new URL(req.url)
  const authHdr = req.headers?.get('Authorization') || ''
  const token = (authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '') ||
    req.headers?.get('x-caregiver-token') || url.searchParams.get('token') || ''
  if (!token) return null
  const row = await (cloudflare.env as any).D1.prepare(
    "SELECT cs.account_id, ca.email FROM caregiver_sessions cs JOIN caregiver_accounts ca ON ca.id = cs.account_id WHERE cs.token = ? AND cs.expires_at > datetime('now')"
  ).bind(token).first() as any
  if (!row) return null
  return { account_id: row.account_id, email: row.email }
}

/** Validate client session. Returns { email } or null.
 *  Accepts: Authorization: Bearer <token>, x-session-token header, or ?clientToken= / ?token= query param. */
async function _requireClientAuth(req: any): Promise<{ email: string } | null> {
  const url = new URL(req.url)
  const authHdr = req.headers?.get('Authorization') || ''
  const token = (authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '') ||
    req.headers?.get('x-session-token') || url.searchParams.get('clientToken') || url.searchParams.get('token') || ''
  if (!token) return null
  const row = await (cloudflare.env as any).D1.prepare(
    "SELECT email FROM client_sessions WHERE session_token = ? AND expires_at > datetime('now')"
  ).bind(token).first() as any
  if (!row) return null
  return { email: row.email }
}

/** Extract clientToken from body or headers (for POST endpoints). */
async function _requireClientAuthFromBody(req: any, body: any): Promise<{ email: string } | null> {
  const authHdr = req.headers?.get('Authorization') || ''
  const token = (authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '') ||
    req.headers?.get('x-session-token') || body?.clientToken || ''
  if (!token) return null
  const row = await (cloudflare.env as any).D1.prepare(
    "SELECT email FROM client_sessions WHERE session_token = ? AND expires_at > datetime('now')"
  ).bind(token).first() as any
  if (!row) return null
  return { email: row.email }
}

/** Validate platform admin session. Returns { email, name } or null. */
async function _requireAdminAuth(req: any): Promise<{ email: string; name: string } | null> {
  const url = new URL(req.url)
  const authHdr = req.headers?.get('Authorization') || ''
  const token = (authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '') ||
    req.headers?.get('x-session-token') || url.searchParams.get('adminToken') || url.searchParams.get('token') || ''
  if (!token) return null
  const row = await (cloudflare.env as any).D1.prepare(
    'SELECT ca.email, ca.name FROM client_sessions cs JOIN client_accounts ca ON ca.email = cs.email WHERE cs.session_token = ? AND cs.expires_at > datetime(\'now\') AND ca.is_admin = 1 LIMIT 1'
  ).bind(token).first() as any
  if (!row) return null
  return { email: row.email, name: row.name || row.email }
}

const _HIDEABLE_INTERVIEW_STATUSES = new Set(['completed', 'cancelled', 'declined', 'expired', 'no_show'])
const _HIDEABLE_HIRE_OFFER_STATUSES = new Set(['declined', 'expired', 'cancelled', 'rejected', 'completed'])

const _ID_VERIFICATION_TYPES = new Set(['drivers_license', 'driver_license', 'state_id', 'passport', 'id_document', 'identity_document', 'id_front'])
const _CERTIFICATION_VERIFICATION_TYPES = new Set(['cpr', 'first_aid', 'cna', 'hha', 'lvn', 'rn', 'dementia', 'hospice', 'tb', 'tb_clearance', 'other_certification'])

async function _ensureCaregiverRequestHideColumns(db: any): Promise<void> {
  const statements = [
    'ALTER TABLE caregiver_bookings ADD COLUMN caregiver_hidden INTEGER DEFAULT 0',
    'ALTER TABLE caregiver_bookings ADD COLUMN caregiver_hidden_at TEXT',
    'ALTER TABLE caregiver_bookings ADD COLUMN caregiver_hidden_reason TEXT',
    'ALTER TABLE caregiver_bookings ADD COLUMN client_hidden INTEGER DEFAULT 0',
    'ALTER TABLE caregiver_bookings ADD COLUMN client_hidden_at TEXT',
    'ALTER TABLE caregiver_bookings ADD COLUMN client_hidden_reason TEXT',
    'ALTER TABLE hire_agreements ADD COLUMN caregiver_hidden INTEGER DEFAULT 0',
    'ALTER TABLE hire_agreements ADD COLUMN caregiver_hidden_at TEXT',
    'ALTER TABLE hire_agreements ADD COLUMN caregiver_hidden_reason TEXT',
  ]
  for (const statement of statements) {
    try { await db.prepare(statement).run() } catch (_) {}
  }
}

async function _ensureVerificationTables(db: any): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS caregiver_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caregiver_id INTEGER NOT NULL,
      doc_type TEXT NOT NULL,
      r2_key TEXT,
      front_url TEXT,
      file_name TEXT,
      mime_type TEXT,
      consent_given INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      submitted_at TEXT DEFAULT (datetime('now')),
      reviewed_at TEXT,
      approved_at TEXT,
      reviewer_email TEXT,
      rejection_reason TEXT,
      admin_notes TEXT,
      notes TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS caregiver_trust_scores (
      caregiver_id INTEGER PRIMARY KEY,
      score INTEGER DEFAULT 0,
      level TEXT DEFAULT 'Basic',
      id_verified INTEGER DEFAULT 0,
      background_checked INTEGER DEFAULT 0,
      cpr_certified INTEGER DEFAULT 0,
      cna_verified INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS caregiver_background_checks (
      caregiver_id INTEGER PRIMARY KEY,
      status TEXT DEFAULT 'not_started',
      provider TEXT,
      initiated_at TEXT,
      completed_at TEXT,
      expires_at TEXT,
      reviewed_at TEXT,
      reviewer_email TEXT,
      notes TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS verification_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caregiver_id INTEGER NOT NULL,
      verification_id INTEGER,
      action TEXT NOT NULL,
      actor_email TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    'ALTER TABLE caregiver_verifications ADD COLUMN r2_key TEXT',
    'ALTER TABLE caregiver_verifications ADD COLUMN front_url TEXT',
    'ALTER TABLE caregiver_verifications ADD COLUMN file_name TEXT',
    'ALTER TABLE caregiver_verifications ADD COLUMN mime_type TEXT',
    'ALTER TABLE caregiver_verifications ADD COLUMN consent_given INTEGER DEFAULT 0',
    'ALTER TABLE caregiver_verifications ADD COLUMN reviewed_at TEXT',
    'ALTER TABLE caregiver_verifications ADD COLUMN approved_at TEXT',
    'ALTER TABLE caregiver_verifications ADD COLUMN reviewer_email TEXT',
    'ALTER TABLE caregiver_verifications ADD COLUMN rejection_reason TEXT',
    'ALTER TABLE caregiver_verifications ADD COLUMN admin_notes TEXT',
    'ALTER TABLE caregiver_verifications ADD COLUMN notes TEXT',
    'ALTER TABLE caregiver_trust_scores ADD COLUMN level TEXT DEFAULT \'Basic\'',
    'ALTER TABLE caregiver_trust_scores ADD COLUMN id_verified INTEGER DEFAULT 0',
    'ALTER TABLE caregiver_trust_scores ADD COLUMN background_checked INTEGER DEFAULT 0',
    'ALTER TABLE caregiver_trust_scores ADD COLUMN cpr_certified INTEGER DEFAULT 0',
    'ALTER TABLE caregiver_trust_scores ADD COLUMN cna_verified INTEGER DEFAULT 0',
    'ALTER TABLE caregiver_trust_scores ADD COLUMN updated_at TEXT',
    'ALTER TABLE verification_audit_logs ADD COLUMN actor_email TEXT',
    'ALTER TABLE caregiver_accounts ADD COLUMN travel_radius_miles INTEGER DEFAULT 10',
  ]
  for (const statement of statements) {
    try { await db.prepare(statement).run() } catch (_) {}
  }
}

async function _refreshCaregiverTrustScore(db: any, caregiverId: number): Promise<void> {
  await _ensureVerificationTables(db)
  const idRow = await db.prepare(
    `SELECT id FROM caregiver_verifications
     WHERE caregiver_id = ? AND status = 'verified' AND doc_type IN ('drivers_license','driver_license','state_id','passport','id_document','identity_document','id_front')
     LIMIT 1`
  ).bind(caregiverId).first() as any
  const bgRow = await db.prepare("SELECT status FROM caregiver_background_checks WHERE caregiver_id = ?").bind(caregiverId).first() as any
  const certRows = await db.prepare(
    `SELECT doc_type FROM caregiver_verifications
     WHERE caregiver_id = ? AND status = 'verified' AND doc_type IN ('cpr','first_aid','cna','hha','lvn','rn','dementia','hospice','tb','tb_clearance')`
  ).bind(caregiverId).all() as any
  const cg = await db.prepare('SELECT bio, photo_url, hourly_rate, skills FROM caregiver_accounts WHERE id = ?').bind(caregiverId).first() as any
  const certTypes = new Set((certRows.results || []).map((row: any) => row.doc_type))
  let skills = []
  try { skills = JSON.parse(cg?.skills || '[]') } catch {}
  const idVerified = !!idRow
  const backgroundChecked = bgRow?.status === 'verified'
  const cprCertified = certTypes.has('cpr') || certTypes.has('first_aid')
  const cnaVerified = certTypes.has('cna') || certTypes.has('hha')
  const profileComplete = !!(cg?.bio && cg?.photo_url && cg?.hourly_rate && skills.length > 0)
  const score = (idVerified ? 20 : 0) + (backgroundChecked ? 20 : 0) + (cprCertified ? 15 : 0) + (cnaVerified ? 10 : 0) + (profileComplete ? 10 : 0)
  const level = score >= 90 ? 'Elite Caregiver' : score >= 70 ? 'Verified Pro' : score >= 40 ? 'Trusted' : 'Basic'
  const existing = await db.prepare('SELECT caregiver_id FROM caregiver_trust_scores WHERE caregiver_id = ?').bind(caregiverId).first() as any
  if (existing) {
    await db.prepare(
      `UPDATE caregiver_trust_scores
       SET score = ?, level = ?, id_verified = ?, background_checked = ?, cpr_certified = ?, cna_verified = ?, updated_at = datetime('now')
       WHERE caregiver_id = ?`
    ).bind(score, level, idVerified ? 1 : 0, backgroundChecked ? 1 : 0, cprCertified ? 1 : 0, cnaVerified ? 1 : 0, caregiverId).run()
  } else {
    await db.prepare(
      `INSERT INTO caregiver_trust_scores
       (caregiver_id, score, level, id_verified, background_checked, cpr_certified, cna_verified, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).bind(caregiverId, score, level, idVerified ? 1 : 0, backgroundChecked ? 1 : 0, cprCertified ? 1 : 0, cnaVerified ? 1 : 0).run()
  }
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

          // Verify Stripe signature (if STRIPE_WEBHOOK_SECRET is configured)
          const webhookSecret = cloudflare.env.STRIPE_WEBHOOK_SECRET
          if (webhookSecret) {
            const sig = req.headers.get('stripe-signature') || ''
            const tPart = sig.split(',').find((p: string) => p.startsWith('t='))?.slice(2)
            const v1Part = sig.split(',').find((p: string) => p.startsWith('v1='))?.slice(3)
            if (!tPart || !v1Part) {
              return Response.json({ error: 'Missing Stripe signature' }, { status: 400 })
            }
            const encoder = new TextEncoder()
            const key = await crypto.subtle.importKey(
              'raw', encoder.encode(webhookSecret),
              { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
            )
            const sigBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(`${tPart}.${body}`))
            const computed = Array.from(new Uint8Array(sigBytes)).map(b => b.toString(16).padStart(2,'0')).join('')
            if (computed !== v1Part) {
              return Response.json({ error: 'Invalid Stripe signature' }, { status: 400 })
            }
          }

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
                // Phase 19 fix: use cloudflare.env.D1 directly (payload.db.execute is broken on D1)
                await cloudflare.env.D1.prepare(
                  'INSERT OR REPLACE INTO client_subscriptions (email, plan, stripe_customer_id, stripe_subscription_id, stripe_session_id, status, current_period_end) VALUES (?, ?, ?, ?, ?, ?, ?)'
                ).bind(
                  clientEmail.toLowerCase(),
                  plan,
                  session.customer || '',
                  session.subscription || '',
                  session.id,
                  'active',
                  new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
                ).run()
              }
            }
          }
          if (event.type === 'customer.subscription.deleted' || event.type === 'customer.subscription.updated') {
            const sub = event.data.object
            if (sub.status === 'canceled' || sub.status === 'unpaid') {
              // Phase 19 fix: use D1 directly
              await cloudflare.env.D1.prepare(
                "UPDATE client_subscriptions SET status = 'cancelled', updated_at = datetime('now') WHERE stripe_subscription_id = ?"
              ).bind(sub.id).run()
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
          const caregiverId = (body as any).caregiverId || null
          // Phase 26A: extract careAction and returnContext for success_url embedding
          const careAction = (body as any).careAction || null
          const returnContext = (body as any).returnContext || null
          if (!email || !plan) return Response.json({ error: 'email and plan required' }, { status: 400 })

          // Phase 21C: validate plan against subscription_plans DB (audience, active, public)
          const db21c = (cloudflare.env as any).D1 as D1Database
          const planRow = await db21c.prepare(
            'SELECT stripe_price_id, is_active, is_public, audience FROM subscription_plans WHERE slug = ? LIMIT 1'
          ).bind(plan.toLowerCase()).first() as any | null

          if (planRow) {
            // Plan exists in DB — enforce audience, active, public gates
            if (!planRow.is_active)  return Response.json({ error: 'This plan is no longer available.' }, { status: 400 })
            if (!planRow.is_public)  return Response.json({ error: 'This plan is not available.' }, { status: 400 })
            if (planRow.audience !== 'client') return Response.json({ error: 'Invalid plan for this portal.' }, { status: 403 })
          }

          // Hardcoded fallback price IDs (used when DB row has no stripe_price_id)
          const priceMap: Record<string, string> = {
            essential: 'price_1TQhO56E8zcVOY4tJyqfoiwi',
            family: 'price_1TQhO56E8zcVOY4t4q1gjG7a',
            premium: 'price_1TQhO66E8zcVOY4tmYqFthdT',
          }
          const priceId = (planRow?.stripe_price_id) || priceMap[plan.toLowerCase()]
          if (!priceId) return Response.json({ error: 'No payment configuration for this plan.' }, { status: 400 })

          // Phase 26A: Build success_url with full context so app can restore caregiver + action
          const successBase = 'https://app.carehia.com/'
          const successParams = new URLSearchParams({
            subscription: 'success',
            plan,
            email,
            session_id: '{CHECKOUT_SESSION_ID}',
            return_to: 'findcare',
          })
          if (caregiverId) successParams.set('caregiver_return', String(caregiverId))
          if (careAction) successParams.set('care_action', careAction)
          const successUrl = successBase + '?' + successParams.toString() + '#findcare'

          // Phase 26A: Build cancel_url — use correct domain, pass context for retry
          const cancelParams = new URLSearchParams({
            subscription: 'cancelled',
            return_to: 'findcare',
          })
          if (caregiverId) cancelParams.set('caregiver_return', String(caregiverId))
          if (careAction) cancelParams.set('care_action', careAction)
          const cancelUrl = 'https://app.carehia.com/?' + cancelParams.toString() + '#findcare'

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
              'success_url': successUrl,
              'cancel_url': cancelUrl,
              'metadata[plan]': plan,
              'metadata[client_email]': email,
              'metadata[type]': 'client_subscription',
              ...(caregiverId ? { 'metadata[caregiver_id]': String(caregiverId) } : {}),
              ...(careAction ? { 'metadata[care_action]': careAction } : {}),
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

          // Phase 19 fix: use cloudflare.env.D1 directly (payload.db.execute is broken on D1)
          const sub = await cloudflare.env.D1.prepare(
            'SELECT * FROM client_subscriptions WHERE email = ? AND status = ? ORDER BY created_at DESC LIMIT 1'
          ).bind(email.toLowerCase(), 'active').first() as any
          if (!sub) return Response.json({ subscribed: false, plan: null })
          // Check if subscription is still valid
          const now = new Date()
          const periodEnd = sub.current_period_end ? new Date(sub.current_period_end.replace(' ', 'T')) : null
          const isValid = !periodEnd || periodEnd > now

          // Phase 19b fix: count unlocks from client_contact_unlocks table (not a column on client_subscriptions)
          let contactUnlocksUsed = 0
          try {
            await cloudflare.env.D1.prepare(
              `CREATE TABLE IF NOT EXISTS client_contact_unlocks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                client_email TEXT NOT NULL,
                caregiver_id TEXT NOT NULL,
                subscription_id INTEGER,
                unlocked_at TEXT DEFAULT (datetime('now')),
                UNIQUE(client_email, caregiver_id)
              )`
            ).run()
            const month = now.toISOString().slice(0, 7)
            const countRow = await cloudflare.env.D1.prepare(
              "SELECT COUNT(*) as cnt FROM client_contact_unlocks WHERE client_email = ? AND strftime('%Y-%m', unlocked_at) = ?"
            ).bind(email.toLowerCase(), month).first() as any
            contactUnlocksUsed = countRow?.cnt || 0
          } catch (_e) { /* table may not exist yet */ }

          return Response.json({
            subscribed: isValid,
            plan: sub.plan,
            status: sub.status,
            currentPeriodEnd: sub.current_period_end,
            stripeCustomerId: sub.stripe_customer_id || null,
            contactUnlocksUsed,
          })
        } catch (error) {
          return Response.json({ subscribed: false, error: String(error) }, { status: 500 })
        }
      },
    },

    // ====== CONFIRM CLIENT SUBSCRIPTION (called after Stripe redirect) ======
    {
      path: '/confirm-client-subscription',
      method: 'post',
      handler: async (req) => {
        try {
          const body = await req.json()
          const { email, plan, sessionId } = body
          if (!email || !plan) return Response.json({ error: 'email and plan required' }, { status: 400 })

          // Check if already recorded (idempotent)
          const existing = await cloudflare.env.D1.prepare(
            'SELECT id FROM client_subscriptions WHERE email = ? AND plan = ? AND status = ?'
          ).bind(email.toLowerCase(), plan, 'active').first()

          if (!existing) {
            const periodEnd = new Date()
            periodEnd.setMonth(periodEnd.getMonth() + 1)
            await cloudflare.env.D1.prepare(
              `INSERT INTO client_subscriptions (email, plan, stripe_session_id, status, current_period_end)
               VALUES (?, ?, ?, 'active', ?)`
            ).bind(email.toLowerCase(), plan, sessionId || '', periodEnd.toISOString()).run()
          }

          return Response.json({ success: true, plan })
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 })
        }
      },
    },

    // ====== CLIENT BILLING PORTAL (Phase 19) ======
    {
      path: '/create-client-billing-portal',
      method: 'post',
      handler: async (req) => {
        try {
          const body = await req.json()
          const { email } = body
          if (!email) return Response.json({ error: 'email required' }, { status: 400 })

          // Look up Stripe customer ID from subscription
          const sub = await cloudflare.env.D1.prepare(
            'SELECT stripe_customer_id FROM client_subscriptions WHERE email = ? AND status = ? ORDER BY created_at DESC LIMIT 1'
          ).bind(email.toLowerCase(), 'active').first() as any

          if (!sub?.stripe_customer_id) {
            return Response.json({ error: 'No active subscription with Stripe customer found. Please contact support.' }, { status: 404 })
          }

          const stripeKey = cloudflare.env.STRIPE_SECRET_KEY
          const params = new URLSearchParams({
            'customer': sub.stripe_customer_id,
            'return_url': 'https://app.carehia.com/#profile',
          })
          const stripeRes = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${stripeKey}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: params.toString(),
          })
          const session = await stripeRes.json() as any
          if (!session.url) return Response.json({ error: 'Could not create billing portal session', details: session }, { status: 500 })
          return Response.json({ success: true, url: session.url })
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 })
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
          // AUTHZ-07: Require client session — derive email from session, not body
          const clientSess = await _requireClientAuthFromBody(req, body)
          if (!clientSess) return Response.json({ error: 'Authentication required' }, { status: 401 })
          const { caregiverId } = body
          const email = clientSess.email  // always use authenticated session email
          if (!caregiverId) return Response.json({ error: 'caregiverId required' }, { status: 400 })

          // Phase 19 fix: use cloudflare.env.D1 directly
          // Auto-create contact_unlocks table if not exists
          await cloudflare.env.D1.prepare(
            `CREATE TABLE IF NOT EXISTS client_contact_unlocks (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              client_email TEXT NOT NULL,
              caregiver_id TEXT NOT NULL,
              subscription_id INTEGER,
              unlocked_at TEXT DEFAULT (datetime('now')),
              UNIQUE(client_email, caregiver_id)
            )`
          ).run()

          // Check subscription
          const sub = await cloudflare.env.D1.prepare(
            'SELECT * FROM client_subscriptions WHERE email = ? AND status = ? ORDER BY created_at DESC LIMIT 1'
          ).bind(email.toLowerCase(), 'active').first() as any
          if (!sub) return Response.json({ error: 'No active subscription', requiresSubscription: true }, { status: 403 })

          // Check if already unlocked
          const existing = await cloudflare.env.D1.prepare(
            'SELECT id FROM client_contact_unlocks WHERE client_email = ? AND caregiver_id = ?'
          ).bind(email.toLowerCase(), String(caregiverId)).first()

          if (!existing) {
            // Check monthly limit for essential plan
            if (sub.plan === 'essential') {
              const month = new Date().toISOString().slice(0, 7)
              const countRow = await cloudflare.env.D1.prepare(
                "SELECT COUNT(*) as cnt FROM client_contact_unlocks WHERE client_email = ? AND strftime('%Y-%m', unlocked_at) = ?"
              ).bind(email.toLowerCase(), month).first() as any
              const count = countRow?.cnt || 0
              if (count >= 5) return Response.json({ error: 'Monthly unlock limit reached. Upgrade to Family plan for unlimited unlocks.', limitReached: true }, { status: 403 })
            }
            // Record the unlock
            await cloudflare.env.D1.prepare(
              'INSERT INTO client_contact_unlocks (client_email, caregiver_id, subscription_id) VALUES (?, ?, ?)'
            ).bind(email.toLowerCase(), String(caregiverId), sub.id || 0).run()
          }

          // Phase 19 fix: use D1 caregiver_accounts instead of Payload collection
          const caregiver = await cloudflare.env.D1.prepare(
            'SELECT id, name, email, phone FROM caregiver_accounts WHERE id = ?'
          ).bind(String(caregiverId)).first() as any
          if (!caregiver) return Response.json({ error: 'Caregiver not found' }, { status: 404 })

          return Response.json({
            success: true,
            contact: {
              phone: caregiver.phone || '',
              email: caregiver.email || '',
              name: caregiver.name || '',
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
          const specialty = (url.searchParams.get('specialty') || '').toLowerCase().trim()
          const limit = parseInt(url.searchParams.get('limit') || '50')
          // Query D1 caregiver_accounts — this is where marketplace caregivers self-register
          // Phase 14C: Accept optional client zip for travel radius filtering
          const clientZip = (url.searchParams.get('zip') || '').trim()
          const { results: rows } = await cloudflare.env.D1.prepare(
            `SELECT id, name, bio, photo_url, zip_code, city, state,
                    languages, hourly_rate, skills, certifications, care_types, created_at,
                    COALESCE(travel_radius_miles, 10) as travel_radius_miles
             FROM caregiver_accounts
             WHERE email_verified = 1
             ORDER BY created_at DESC
             LIMIT ?`
          ).bind(limit).all()
          // ---- Profile completeness gate (70%) ----
          // Scoring matches frontend calculateCompleteness in utils/storage.ts (10 items × 10%)
          const calcProfileCompleteness = (cg: any) => {
            let s = 0
            if (cg.name && cg.name.trim()) s += 10
            if (cg.photo_url) s += 10
            if (cg.bio && cg.bio.length > 20) s += 10
            if (cg.hourly_rate && parseFloat(String(cg.hourly_rate)) > 0) s += 10
            try { if (JSON.parse(cg.skills || '[]').length >= 3) s += 10 } catch {}
            if (cg.phone) s += 10
            if (cg.city) s += 10
            try { if (JSON.parse(cg.languages || '[]').length > 0) s += 10 } catch {}
            try { if (JSON.parse(cg.certifications || '[]').length > 0) s += 10 } catch {}
            try { if (JSON.parse(cg.care_types || '[]').length > 0) s += 10 } catch {}
            return s
          }
          const filteredRows = (rows || []).filter((cg: any) => {
            if (calcProfileCompleteness(cg) < 70) return false;
            // Phase 14C: Travel radius filter — only show caregivers who serve client's area
            if (clientZip && cg.zip_code) {
              const dist = _getZipDist(clientZip, cg.zip_code);
              const cgRadius = cg.travel_radius_miles || 10;
              if (dist > cgRadius) return false; // outside caregiver's travel radius
            }
            return true;
          })
          const mapped = filteredRows.map((cg: any) => {
            const nameParts = (cg.name || 'Caregiver').trim().split(' ')
            const firstName = nameParts[0] || 'Caregiver'
            const lastName = nameParts.slice(1).join(' ') || ''
            let skills: string[] = []
            try { skills = JSON.parse(cg.skills || '[]') } catch { skills = [] }
            let certs: string[] = []
            try { certs = JSON.parse(cg.certifications || '[]') } catch { certs = [] }
            let langs = 'English'
            try {
              const l = JSON.parse(cg.languages || '["English"]')
              langs = Array.isArray(l) ? l.join(', ') : String(l)
            } catch { langs = cg.languages || 'English' }
            const rate = parseFloat(cg.hourly_rate) || 28
            // Match score based on specialty alignment
            let matchScore = 82 + Math.floor(Math.random() * 10)
            if (specialty && skills.length > 0) {
              const exact = skills.some((s: string) => s.toLowerCase() === specialty)
              const partial = skills.some((s: string) => s.toLowerCase().includes(specialty.split(' ')[0]))
              if (exact) matchScore = 93 + Math.floor(Math.random() * 5)
              else if (partial) matchScore = 86 + Math.floor(Math.random() * 6)
              else matchScore = 76 + Math.floor(Math.random() * 8)
            }
            // Phase 14C: Calculate distance for display (private — never exposes caregiver address)
            const distMiles = clientZip && cg.zip_code ? Math.round(_getZipDist(clientZip, cg.zip_code) * 10) / 10 : null;
            return {
              id: cg.id,
              firstName,
              lastName,
              specializations: skills.slice(0, 3).join(', ') || 'Home Care',
              skills,
              certifications: certs,
              hourlyRate: rate,
              rating: 4.8,
              reviews: 0,
              yearsExp: 3,
              bio: cg.bio || '',
              languages: langs,
              availability: [1,1,1,1,1,0,0],
              avatar: cg.photo_url || '👩‍⚕️',
              city: cg.city || '',
              state: cg.state || '',
              zip_code: cg.zip_code || '',
              matchScore,
              distanceMiles: distMiles,        // approx distance — no exact address exposed
              servesYourArea: distMiles !== null ? true : null,
              travelRadiusMiles: cg.travel_radius_miles || 10,
            }
          })
          mapped.sort((a: any, b: any) => b.matchScore - a.matchScore)
          return Response.json({ success: true, caregivers: mapped, totalDocs: mapped.length })
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
            'success_url': 'https://app.carehia.com/?booking=success#bookings',
            'cancel_url': 'https://app.carehia.com/?booking=cancelled#findcare',
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
          // AUTHZ-05: Require client session — derive email from token, not body
          const clientSess = await _requireClientAuthFromBody(req, body)
          if (!clientSess) return Response.json({ error: 'Authentication required. Please sign in to book an interview.' }, { status: 401 })
          const { caregiverId, careNeeds, preferredDate, preferredTime, interviewType, notes } = body
          const clientEmail = clientSess.email  // always use authenticated session email
          if (!caregiverId || !preferredDate) {
            return Response.json({ error: 'caregiverId and preferredDate required' }, { status: 400 })
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
          // SECURITY (RISK-02): Accept Authorization: Bearer header OR ?token= query param
          const authHdr = req.headers.get('Authorization') || ''
          const token = (authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '') || url.searchParams.get('token') || ''
          if (!token) return Response.json({ error: 'token required' }, { status: 400 })
          // Resolve token → account_id
          const sess = await cloudflare.env.D1.prepare(
            "SELECT account_id FROM caregiver_sessions WHERE token = ? AND expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!sess) return Response.json({ error: 'Invalid or expired token' }, { status: 401 })
          const caregiverId = sess.account_id
          await _ensureCaregiverRequestHideColumns(cloudflare.env.D1)
          // Fetch bookings, JOIN client_accounts for real contact info when unlocked
          const result = await cloudflare.env.D1.prepare(
            `SELECT cb.*,
              CASE WHEN cb.is_unlocked = 1 THEN ca.name ELSE NULL END as client_name
             FROM caregiver_bookings cb
             LEFT JOIN client_accounts ca ON ca.email = cb.client_email
             WHERE cb.caregiver_id = ? AND COALESCE(cb.caregiver_hidden, 0) = 0
             ORDER BY cb.created_at DESC LIMIT 50`
          ).bind(String(caregiverId)).all()
          const bookings = (result.results || []).map((b: any) => ({
            id: b.id,
            clientEmail: b.is_unlocked ? b.client_email : (b.client_email ? b.client_email.substring(0, 2) + '***@***' : ''),
            clientName: b.is_unlocked ? (b.client_name || null) : null,
            clientPhone: b.is_unlocked ? (b.client_phone || null) : null,
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
            'success_url': 'https://work.carehia.com/?booking_unlocked=' + bookingId + '#requests',
            'cancel_url': 'https://work.carehia.com/?booking_cancelled=1',
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
    // ====== CONFIRM BOOKING UNLOCK (webhook fallback — trust Stripe success_url redirect) ======
    {
      path: '/confirm-booking-unlock',
      method: 'post',
      handler: async (req) => {
        try {
          const body = await req.json()
          const { token, bookingId } = body
          if (!token || !bookingId) return Response.json({ error: 'token and bookingId required' }, { status: 400 })
          // Validate caregiver token
          const sessionRow = await cloudflare.env.D1.prepare(
            "SELECT account_id FROM caregiver_sessions WHERE token = ? AND expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!sessionRow) return Response.json({ error: 'Invalid token' }, { status: 401 })
          const caregiverId = sessionRow.account_id
          // Mark this booking as unlocked (trust Stripe's success_url redirect)
          await cloudflare.env.D1.prepare(
            'UPDATE caregiver_bookings SET is_unlocked = 1 WHERE id = ? AND caregiver_id = ?'
          ).bind(Number(bookingId), caregiverId).run()
          // Return the now-unlocked booking with client details
          const booking = await cloudflare.env.D1.prepare(`
            SELECT cb.*, ca.name as client_name, ca.email as client_email
            FROM caregiver_bookings cb
            LEFT JOIN client_accounts ca ON cb.client_email = ca.email
            WHERE cb.id = ? AND cb.caregiver_id = ?
          `).bind(Number(bookingId), caregiverId).first() as any
          return Response.json({ success: true, booking: booking || { id: bookingId, is_unlocked: 1 } })
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 })
        }
      },
    },
    // ====== CONFIRM CAREGIVER SUBSCRIPTION (called from success URL) ======
    {
      path: '/confirm-caregiver-subscription',
      method: 'post',
      handler: async (req) => {
        try {
          const body = await req.json()
          const { token } = body
          if (!token) return Response.json({ error: 'token required' }, { status: 400 })

          // Look up caregiver from session token
          const session = await cloudflare.env.D1.prepare(
            'SELECT account_id FROM caregiver_sessions WHERE token = ?'
          ).bind(token).first() as any
          if (!session) return Response.json({ error: 'Invalid token' }, { status: 401 })
          const caregiverId = String(session.account_id)

          // Insert subscription record
          await cloudflare.env.D1.prepare(
            `INSERT OR REPLACE INTO caregiver_subscriptions (caregiver_id, plan, status, created_at)
             VALUES (?, 'unlimited', 'active', datetime('now'))`
          ).bind(caregiverId).run()

          // Unlock ALL pending bookings for this caregiver
          await cloudflare.env.D1.prepare(
            'UPDATE caregiver_bookings SET is_unlocked = 1 WHERE caregiver_id = ?'
          ).bind(caregiverId).run()

          return Response.json({ success: true, caregiverId })
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
          const { token } = body
          if (!token) return Response.json({ error: 'token required' }, { status: 400 })

          // Look up caregiver ID from session token
          const session = await cloudflare.env.D1.prepare(
            'SELECT account_id FROM caregiver_sessions WHERE token = ?'
          ).bind(token).first() as any
          if (!session) return Response.json({ error: 'Invalid token' }, { status: 401 })
          const caregiverId = String(session.account_id)

          const stripeKey = cloudflare.env.STRIPE_SECRET_KEY
          // Phase 26B: contextual success/cancel URLs with action restore params
          const cAct = String(body.caregiverAction || 'unlock_request')
          const cRt  = String(body.returnTab  || 'work')
          const cRv  = String(body.returnView || 'requests')
          const cRid = String(body.requestId  || '')
          const cHash = cRt === 'work' ? 'schedule' : cRt === 'today' ? 'home' : cRt === 'money' ? 'earnings' : cRt
          const successUrl = `https://work.carehia.com/?subscription=success&role=caregiver&session_id={CHECKOUT_SESSION_ID}&plan=unlimited&caregiver_action=${encodeURIComponent(cAct)}&request_id=${encodeURIComponent(cRid)}&return_tab=${encodeURIComponent(cRt)}&return_view=${encodeURIComponent(cRv)}#${cHash}`
          const cancelUrl  = `https://work.carehia.com/?subscription=cancelled&role=caregiver&caregiver_action=${encodeURIComponent(cAct)}&request_id=${encodeURIComponent(cRid)}&return_tab=${encodeURIComponent(cRt)}&return_view=${encodeURIComponent(cRv)}#${cHash}`
          // Phase 21C: validate caregiver unlimited plan from subscription_plans DB
          const db21cCg = (cloudflare.env as any).D1 as D1Database
          const cgPlanRow = await db21cCg.prepare(
            "SELECT stripe_price_id, is_active, is_public FROM subscription_plans WHERE audience = 'caregiver' AND slug = 'unlimited' LIMIT 1"
          ).first() as any | null
          if (cgPlanRow && (!cgPlanRow.is_active || !cgPlanRow.is_public)) {
            return Response.json({ error: 'This plan is no longer available.' }, { status: 400 })
          }
          const cgPriceId = (cgPlanRow?.stripe_price_id) || 'price_1TQmcY6E8zcVOY4tSOJ9E3X2'

          const params = new URLSearchParams({
            'mode': 'subscription',
            'line_items[0][price]': cgPriceId,
            'line_items[0][quantity]': '1',
            'success_url': successUrl,
            'cancel_url': cancelUrl,
            'metadata[caregiver_id]': caregiverId,
            'metadata[type]': 'caregiver_subscription',
            'metadata[caregiver_action]': cAct,
            'metadata[return_tab]': cRt,
          })
          const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
          })
          const stripeSession = await stripeRes.json() as any
          if (!stripeSession.url) return Response.json({ error: 'Stripe session failed', details: stripeSession }, { status: 500 })
          return Response.json({ success: true, url: stripeSession.url })
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
          // AUTHZ-02: Require caregiver session + verify booking ownership
          const cgSess = await _requireCgAuth(req)
          if (!cgSess) return Response.json({ error: 'Caregiver authentication required' }, { status: 401 })
          const body = await req.json()
          const { bookingId, status } = body
          if (!bookingId || !['accepted', 'declined'].includes(status)) {
            return Response.json({ error: 'bookingId and valid status (accepted/declined) required' }, { status: 400 })
          }
          // Verify this booking was dispatched to this caregiver
          const booking = await (cloudflare.env as any).D1.prepare(
            'SELECT id FROM caregiver_bookings WHERE id = ? AND caregiver_id = ?'
          ).bind(Number(bookingId), cgSess.account_id).first()
          if (!booking) return Response.json({ error: 'Booking not found or not assigned to you' }, { status: 403 })
          await cloudflare.env.D1.prepare(
            'UPDATE caregiver_bookings SET status = ? WHERE id = ? AND caregiver_id = ?'
          ).bind(status, Number(bookingId), cgSess.account_id).run()
          return Response.json({ success: true, bookingId, status })
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 })
        }
      },
    },
    // ====== HIDE CAREGIVER REQUEST ITEM (soft delete from caregiver view only) ======
    {
      path: '/caregiver-requests/hide',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const cgSess = await _requireCgAuth(req)
          if (!cgSess) return Response.json({ success: false, error: 'Caregiver authentication required' }, { status: 401, headers })

          const body = await req.json()
          const { itemId, itemType, reason } = body || {}
          if (!itemId || !['hire_offer', 'interview'].includes(itemType)) {
            return Response.json({ success: false, error: 'itemId and valid itemType required' }, { status: 400, headers })
          }

          const db = (cloudflare.env as any).D1
          await _ensureCaregiverRequestHideColumns(db)
          const hideReason = String(reason || 'user_removed').slice(0, 80)

          if (itemType === 'interview') {
            const booking = await db.prepare(
              'SELECT id, status FROM caregiver_bookings WHERE id = ? AND caregiver_id = ?'
            ).bind(Number(itemId), String(cgSess.account_id)).first() as any
            if (!booking) return Response.json({ success: false, error: 'Item not found' }, { status: 404, headers })
            const status = String(booking.status || '').toLowerCase()
            if (!_HIDEABLE_INTERVIEW_STATUSES.has(status)) {
              return Response.json({ success: false, error: 'Interview cannot be removed in its current status' }, { status: 409, headers })
            }
            await db.prepare(
              "UPDATE caregiver_bookings SET caregiver_hidden = 1, caregiver_hidden_at = datetime('now'), caregiver_hidden_reason = ? WHERE id = ? AND caregiver_id = ?"
            ).bind(hideReason, Number(itemId), String(cgSess.account_id)).run()
            return Response.json({ success: true, hidden: true, itemId, itemType }, { headers })
          }

          const agreement = await db.prepare(
            'SELECT id, status FROM hire_agreements WHERE id = ? AND caregiver_id = ?'
          ).bind(Number(itemId), String(cgSess.account_id)).first() as any
          if (!agreement) return Response.json({ success: false, error: 'Item not found' }, { status: 404, headers })
          const status = String(agreement.status || '').toLowerCase()
          if (!_HIDEABLE_HIRE_OFFER_STATUSES.has(status)) {
            return Response.json({ success: false, error: 'Hire offer cannot be removed in its current status' }, { status: 409, headers })
          }
          await db.prepare(
            "UPDATE hire_agreements SET caregiver_hidden = 1, caregiver_hidden_at = datetime('now'), caregiver_hidden_reason = ? WHERE id = ? AND caregiver_id = ?"
          ).bind(hideReason, Number(itemId), String(cgSess.account_id)).run()
          return Response.json({ success: true, hidden: true, itemId, itemType }, { headers })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500, headers })
        }
      },
    },
    // ====== MY BOOKINGS (client view their interview requests) ======
    {
      path: '/my-bookings',
      method: 'get',
      handler: async (req) => {
        try {
          // AUTHZ-01: Require valid client session — email alone is not sufficient auth
          const clientSess = await _requireClientAuth(req)
          if (!clientSess) return Response.json({ error: 'Authentication required' }, { status: 401 })
          const email = clientSess.email  // derive from session, ignore URL param
          await _ensureCaregiverRequestHideColumns(cloudflare.env.D1)
          const result = await cloudflare.env.D1.prepare(
            `SELECT cb.id, cb.caregiver_id, cb.care_needs, cb.preferred_date, cb.preferred_time,
             cb.interview_type, cb.notes, cb.status, cb.created_at,
             ca.name as caregiver_name, ca.photo_url as caregiver_photo, ca.hourly_rate, ca.city, ca.state
             FROM caregiver_bookings cb
             LEFT JOIN caregiver_accounts ca ON ca.id = cb.caregiver_id
             WHERE cb.client_email = ? AND COALESCE(cb.client_hidden, 0) = 0 ORDER BY cb.created_at DESC LIMIT 50`
          ).bind(email.toLowerCase()).all()
          const bookings = (result.results || []).map((b: any) => ({
            id: b.id,
            caregiverId: b.caregiver_id,
            caregiverName: b.caregiver_name || 'Caregiver',
            caregiverPhoto: b.caregiver_photo || null,
            hourlyRate: b.hourly_rate || null,
            city: b.city || null,
            state: b.state || null,
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

    // ====== HIDE CLIENT BOOKING ITEM (soft delete from client view only) ======
    {
      path: '/client-bookings/hide',
      method: 'post',
      handler: async (req) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const body = await req.json()
          const clientSess = await _requireClientAuthFromBody(req, body)
          if (!clientSess) return Response.json({ success: false, error: 'Authentication required' }, { status: 401, headers })
          const { bookingId, reason } = body || {}
          if (!bookingId) return Response.json({ success: false, error: 'bookingId required' }, { status: 400, headers })

          const db = (cloudflare.env as any).D1
          await _ensureCaregiverRequestHideColumns(db)
          const booking = await db.prepare(
            'SELECT id, status FROM caregiver_bookings WHERE id = ? AND client_email = ?'
          ).bind(Number(bookingId), clientSess.email.toLowerCase()).first() as any
          if (!booking) return Response.json({ success: false, error: 'Booking not found' }, { status: 404, headers })

          const hideReason = String(reason || 'user_removed').slice(0, 80)
          await db.prepare(
            "UPDATE caregiver_bookings SET client_hidden = 1, client_hidden_at = datetime('now'), client_hidden_reason = ? WHERE id = ? AND client_email = ?"
          ).bind(hideReason, Number(bookingId), clientSess.email.toLowerCase()).run()

          return Response.json({ success: true, bookingId }, { headers })
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 500, headers })
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
          // AUTHZ-03: Require client session — derive email from token, not from body
          const clientSess = await _requireClientAuthFromBody(req, body)
          if (!clientSess) return Response.json({ error: 'Authentication required' }, { status: 401 })
          const { bookingId, preferredDate, preferredTime, interviewType, notes } = body
          const clientEmail = clientSess.email  // always use session email
          if (!bookingId) return Response.json({ error: 'bookingId required' }, { status: 400 })

          // Verify this booking belongs to the authenticated client
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
          // AUTHZ-04: Require client session — derive email from token, not from body
          const clientSess = await _requireClientAuthFromBody(req, body)
          if (!clientSess) return Response.json({ error: 'Authentication required' }, { status: 401 })
          const { bookingId } = body
          const clientEmail = clientSess.email  // always use session email
          if (!bookingId) return Response.json({ error: 'bookingId required' }, { status: 400 })

          // Verify this booking belongs to the authenticated client
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

          // ---- Rate limiting: 5 registrations per IP per hour ----
          const cgRegIP = req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For') || 'unknown'
          const cgRegWindow = Math.floor(Date.now() / 1000) - 3600
          const cgRegAttempts = await cloudflare.env.D1.prepare(
            'SELECT COUNT(*) as cnt FROM login_attempts WHERE ip = ? AND endpoint = ? AND attempted_at > ?'
          ).bind(cgRegIP, 'caregiver-register', cgRegWindow).first() as any
          if ((cgRegAttempts?.cnt || 0) >= 5) {
            return Response.json({ error: 'Too many registration attempts from this network. Please try again in an hour.' }, { status: 429 })
          }
          await cloudflare.env.D1.prepare(
            'INSERT INTO login_attempts (ip, endpoint, email, attempted_at, success) VALUES (?, ?, ?, ?, 1)'
          ).bind(cgRegIP, 'caregiver-register', email.toLowerCase(), Math.floor(Date.now() / 1000)).run().catch(() => {})

          const existing = await cloudflare.env.D1.prepare(
            'SELECT id FROM caregiver_accounts WHERE email = ?'
          ).bind(email.toLowerCase()).first()
          if (existing) return Response.json({ error: 'Account already exists. Sign in instead.' }, { status: 409 })

          const salt = crypto.randomUUID()
          const enc = new TextEncoder()
          const hashBuffer = await crypto.subtle.digest('SHA-256', enc.encode(password + salt))
          const passwordHash = Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('')

          const verificationToken = crypto.randomUUID() + '-' + crypto.randomUUID()

          await cloudflare.env.D1.prepare(
            'INSERT INTO caregiver_accounts (email, name, password_hash, salt, email_verified, verification_token) VALUES (?, ?, ?, ?, 0, ?)'
          ).bind(email.toLowerCase(), name || '', passwordHash, salt, verificationToken).run()

          const account = await cloudflare.env.D1.prepare(
            'SELECT id, email, name, setup_complete FROM caregiver_accounts WHERE email = ?'
          ).bind(email.toLowerCase()).first()

          const token = crypto.randomUUID() + '-' + crypto.randomUUID()
          await cloudflare.env.D1.prepare(
            "INSERT INTO caregiver_sessions (token, account_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))"
          ).bind(token, account.id).run()

          // ── Phase 20: referral code + acquisition tracking (additive, non-blocking) ──
          try {
            const p20inviteCode = body.invite_code || null
            const p20refCode = body.ref_code || null
            const p20campaign = body.campaign || (p20inviteCode ? 'invite_link' : p20refCode ? 'caregiver_referral' : 'direct_signup')
            const p20source = body.source || 'direct'
            // Deterministic referral code: CGP{id}
            const p20myRefCode = 'CGP' + account.id
            await cloudflare.env.D1.prepare(
              'INSERT OR IGNORE INTO caregiver_referral_codes (caregiver_id, caregiver_email, referral_code) VALUES (?, ?, ?)'
            ).bind(account.id, email.toLowerCase(), p20myRefCode).run()
            await cloudflare.env.D1.prepare(
              'INSERT OR IGNORE INTO caregiver_acquisition (caregiver_id, caregiver_email, invite_code, referral_code, campaign, source) VALUES (?, ?, ?, ?, ?, ?)'
            ).bind(account.id, email.toLowerCase(), p20inviteCode, p20refCode, p20campaign, p20source).run()
            if (p20inviteCode) {
              await cloudflare.env.D1.prepare(
                'UPDATE caregiver_invites SET signups = signups + 1 WHERE code = ?'
              ).bind(p20inviteCode).run()
            }
          } catch (_p20err) { /* non-critical — never fail registration */ }

          // Send verification email via Resend
          const verifyLink = `https://work.carehia.com?verify=${verificationToken}`
          try {
            await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${cloudflare.env.RESEND_API_KEY}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                from: 'Carehia <hello@carehia.com>',
                to: [email.toLowerCase()],
                subject: 'Verify your Carehia account',
                html: `
                  <div style="font-family: sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 24px; background: #0F0A1E; color: #fff; border-radius: 16px;">
                    <div style="text-align: center; margin-bottom: 32px;">
                      <div style="font-size: 28px; font-weight: 800; background: linear-gradient(135deg, #7C5CFF, #4A90E2); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">Carehia</div>
                      <p style="color: #94A3B8; margin-top: 8px;">Your caregiving home base</p>
                    </div>
                    <h2 style="color: #fff; margin-bottom: 8px;">Welcome, ${name || 'Caregiver'}! 👋</h2>
                    <p style="color: #CBD5E1; line-height: 1.6;">Thanks for joining Carehia. Just one step left — verify your email address to activate your account.</p>
                    <div style="text-align: center; margin: 32px 0;">
                      <a href="${verifyLink}" style="display: inline-block; background: linear-gradient(135deg, #7C5CFF, #4A90E2); color: #fff; text-decoration: none; padding: 14px 32px; border-radius: 50px; font-weight: 700; font-size: 16px;">Verify My Email</a>
                    </div>
                    <p style="color: #64748B; font-size: 13px; text-align: center;">This link expires in 24 hours. If you didn't create an account, you can ignore this email.</p>
                    <hr style="border: none; border-top: 1px solid #1E293B; margin: 24px 0;">
                    <p style="color: #64748B; font-size: 12px; text-align: center;">Carehia · <a href="https://carehia.com" style="color: #7C5CFF;">carehia.com</a></p>
                  </div>
                `,
              }),
            })
          } catch (emailErr) {
            console.error('Verification email failed:', emailErr)
          }

          return Response.json({
            success: true,
            token,
            emailVerificationRequired: true,
            account: { id: account.id, email: account.email, name: account.name, setupComplete: false },
          })
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 })
        }
      },
    },

    // ====== CAREGIVER VERIFY EMAIL ======
    {
      path: '/caregiver-verify-email',
      method: 'get',
      handler: async (req) => {
        try {
          const url = new URL(req.url)
          const verifyToken = url.searchParams.get('token')
          if (!verifyToken) return Response.json({ error: 'Verification token required' }, { status: 400 })

          const account = await cloudflare.env.D1.prepare(
            'SELECT id, email, name FROM caregiver_accounts WHERE verification_token = ?'
          ).bind(verifyToken).first()

          if (!account) return Response.json({ error: 'Invalid or expired verification link. Please register again.' }, { status: 404 })

          await cloudflare.env.D1.prepare(
            'UPDATE caregiver_accounts SET email_verified = 1, verification_token = NULL WHERE id = ?'
          ).bind(account.id).run()

          return Response.json({ success: true, message: 'Email verified! Welcome to Carehia.', name: account.name })
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 })
        }
      },
    },

    // ====== CAREGIVER RESEND VERIFICATION EMAIL ======
    {
      path: '/caregiver-resend-verification',
      method: 'post',
      handler: async (req) => {
        try {
          const body = await req.json()
          const { email } = body
          if (!email) return Response.json({ error: 'email required' }, { status: 400 })

          const account = await cloudflare.env.D1.prepare(
            'SELECT id, email, name, email_verified FROM caregiver_accounts WHERE email = ?'
          ).bind(email.toLowerCase()).first()

          if (!account) return Response.json({ error: 'No account found with that email' }, { status: 404 })
          if (account.email_verified) return Response.json({ success: true, message: 'Account already verified' })

          const newToken = crypto.randomUUID() + '-' + crypto.randomUUID()
          await cloudflare.env.D1.prepare(
            'UPDATE caregiver_accounts SET verification_token = ? WHERE id = ?'
          ).bind(newToken, account.id).run()

          const verifyLink = `https://work.carehia.com?verify=${newToken}`
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${cloudflare.env.RESEND_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              from: 'Carehia <hello@carehia.com>',
              to: [email.toLowerCase()],
              subject: 'Verify your Carehia account',
              html: `
                <div style="font-family: sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 24px; background: #0F0A1E; color: #fff; border-radius: 16px;">
                  <div style="text-align: center; margin-bottom: 32px;">
                    <div style="font-size: 28px; font-weight: 800; background: linear-gradient(135deg, #7C5CFF, #4A90E2); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">Carehia</div>
                  </div>
                  <h2 style="color: #fff; margin-bottom: 8px;">Verify your email, ${account.name || 'Caregiver'}</h2>
                  <p style="color: #CBD5E1;">Click below to verify your email and activate your Carehia account.</p>
                  <div style="text-align: center; margin: 32px 0;">
                    <a href="${verifyLink}" style="display: inline-block; background: linear-gradient(135deg, #7C5CFF, #4A90E2); color: #fff; text-decoration: none; padding: 14px 32px; border-radius: 50px; font-weight: 700; font-size: 16px;">Verify My Email</a>
                  </div>
                  <p style="color: #64748B; font-size: 12px; text-align: center;">Carehia · <a href="https://carehia.com" style="color: #7C5CFF;">carehia.com</a></p>
                </div>
              `,
            }),
          })
          return Response.json({ success: true, message: 'Verification email sent' })
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 })
        }
      },
    },

    // ====== CAREGIVER FORGOT PASSWORD ======
    {
      path: '/caregiver-forgot-password',
      method: 'post',
      handler: async (req) => {
        try {
          const body = await req.json()
          const { email } = body
          if (!email) return Response.json({ error: 'email required' }, { status: 400 })

          // SECURITY (RISK-05): Rate-limit — 5 reset requests per IP per 15 min
          const fpIP = req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For') || 'unknown'
          const fpWindow = Math.floor(Date.now() / 1000) - 900
          const fpAttempts = await cloudflare.env.D1.prepare(
            'SELECT COUNT(*) as cnt FROM login_attempts WHERE ip = ? AND endpoint = ? AND attempted_at > ?'
          ).bind(fpIP, 'forgot-password', fpWindow).first() as any
          if ((fpAttempts?.cnt || 0) >= 5) {
            return Response.json({ error: 'Too many requests. Please try again in 15 minutes.' }, { status: 429 })
          }
          await cloudflare.env.D1.prepare(
            'INSERT INTO login_attempts (ip, endpoint, email, attempted_at, success) VALUES (?, ?, ?, ?, 0)'
          ).bind(fpIP, 'forgot-password', email.toLowerCase(), Math.floor(Date.now() / 1000)).run().catch(() => {})

          const account = await cloudflare.env.D1.prepare(
            'SELECT id, name, email FROM caregiver_accounts WHERE email = ? AND email_verified = 1'
          ).bind(email.toLowerCase()).first() as any

          // Always return success to prevent email enumeration
          if (!account) return Response.json({ success: true, message: 'If an account exists, a reset email has been sent.' })

          const resetToken = crypto.randomUUID() + '-' + crypto.randomUUID()
          const expiresAt = Math.floor(Date.now() / 1000) + 3600 // 1 hour

          // Clean up old tokens for this email first
          await cloudflare.env.D1.prepare(
            'DELETE FROM password_reset_tokens WHERE email = ?'
          ).bind(email.toLowerCase()).run()

          await cloudflare.env.D1.prepare(
            'INSERT INTO password_reset_tokens (email, token, expires_at) VALUES (?, ?, ?)'
          ).bind(email.toLowerCase(), resetToken, expiresAt).run()

          const resetLink = `https://work.carehia.com?reset=${resetToken}`
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${cloudflare.env.RESEND_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              from: 'Carehia <hello@carehia.com>',
              to: [email.toLowerCase()],
              subject: 'Reset your Carehia password',
              html: `
                <div style="font-family: sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 24px; background: #0F0A1E; color: #fff; border-radius: 16px;">
                  <div style="text-align: center; margin-bottom: 32px;">
                    <div style="font-size: 28px; font-weight: 800; background: linear-gradient(135deg, #7C5CFF, #4A90E2); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">Carehia</div>
                  </div>
                  <h2 style="color: #fff; margin-bottom: 8px;">Reset your password</h2>
                  <p style="color: #CBD5E1;">Hi ${account.name || 'Caregiver'}, we received a request to reset your Carehia password. Click the button below — this link expires in 1 hour.</p>
                  <div style="text-align: center; margin: 32px 0;">
                    <a href="${resetLink}" style="display: inline-block; background: linear-gradient(135deg, #7C5CFF, #4A90E2); color: #fff; text-decoration: none; padding: 14px 32px; border-radius: 50px; font-weight: 700; font-size: 16px;">Reset My Password</a>
                  </div>
                  <p style="color: #64748B; font-size: 13px;">If you didn't request this, you can safely ignore this email. Your password will not be changed.</p>
                  <p style="color: #64748B; font-size: 12px; text-align: center; margin-top: 24px;">Carehia · <a href="https://carehia.com" style="color: #7C5CFF;">carehia.com</a></p>
                </div>
              `,
            }),
          })
          return Response.json({ success: true, message: 'If an account exists, a reset email has been sent.' })
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 })
        }
      },
    },

    // ====== CAREGIVER RESET PASSWORD ======
    {
      path: '/caregiver-reset-password',
      method: 'post',
      handler: async (req) => {
        try {
          const body = await req.json()
          const { token, new_password } = body
          if (!token || !new_password) return Response.json({ error: 'token and new_password required' }, { status: 400 })
          if (new_password.length < 8) return Response.json({ error: 'Password must be at least 8 characters' }, { status: 400 })

          const now = Math.floor(Date.now() / 1000)
          const resetRecord = await cloudflare.env.D1.prepare(
            'SELECT * FROM password_reset_tokens WHERE token = ? AND expires_at > ? AND used = 0'
          ).bind(token, now).first() as any

          if (!resetRecord) return Response.json({ error: 'This reset link is invalid or has expired. Please request a new one.' }, { status: 400 })

          // Fetch the stored salt so hash matches login (SHA-256(password + salt))
          const accountForReset = await cloudflare.env.D1.prepare(
            'SELECT salt FROM caregiver_accounts WHERE email = ?'
          ).bind(resetRecord.email).first() as any
          if (!accountForReset) return Response.json({ error: 'Account not found.' }, { status: 400 })

          const encoder = new TextEncoder()
          const data = encoder.encode(new_password + accountForReset.salt)
          const hashBuffer = await crypto.subtle.digest('SHA-256', data)
          const hashArray = Array.from(new Uint8Array(hashBuffer))
          const passwordHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')

          await cloudflare.env.D1.prepare(
            'UPDATE caregiver_accounts SET password_hash = ? WHERE email = ?'
          ).bind(passwordHash, resetRecord.email).run()

          await cloudflare.env.D1.prepare(
            'UPDATE password_reset_tokens SET used = 1 WHERE token = ?'
          ).bind(token).run()

          return Response.json({ success: true, message: 'Password updated successfully. You can now sign in.' })
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

          // ---- Rate limiting: 10 failed attempts per IP per 15 min ----
          const cgLoginIP = req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For') || 'unknown'
          const cgLoginWindow = Math.floor(Date.now() / 1000) - 900
          const cgLoginAttempts = await cloudflare.env.D1.prepare(
            'SELECT COUNT(*) as cnt FROM login_attempts WHERE ip = ? AND endpoint = ? AND attempted_at > ? AND success = 0'
          ).bind(cgLoginIP, 'caregiver-login', cgLoginWindow).first() as any
          if ((cgLoginAttempts?.cnt || 0) >= 10) {
            return Response.json({ error: 'Too many failed login attempts. Please try again in 15 minutes.' }, { status: 429 })
          }
          const recordCgLoginFail = () => cloudflare.env.D1.prepare(
            'INSERT INTO login_attempts (ip, endpoint, email, attempted_at, success) VALUES (?, ?, ?, ?, 0)'
          ).bind(cgLoginIP, 'caregiver-login', email.toLowerCase(), Math.floor(Date.now() / 1000)).run().catch(() => {})

          const account = await cloudflare.env.D1.prepare(
            "SELECT * FROM caregiver_accounts WHERE email = ? AND status = 'active'"
          ).bind(email.toLowerCase()).first()
          if (!account) { await recordCgLoginFail(); return Response.json({ error: 'Invalid email or password' }, { status: 401 }) }

          const enc = new TextEncoder()
          const hashBuffer = await crypto.subtle.digest('SHA-256', enc.encode(password + account.salt))
          const passwordHash = Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('')
          if (passwordHash !== account.password_hash) { await recordCgLoginFail(); return Response.json({ error: 'Invalid email or password' }, { status: 401 }) }


          // Phase 20 Bug #1: Enforce email verification before login
          if (account.email_verified !== 1 && account.email_verified !== true) {
            return Response.json({ error: 'Please verify your email before signing in. Check your inbox for a verification link.' }, { status: 403 })
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
          // SECURITY (RISK-02): Accept Authorization: Bearer, x-caregiver-token, or ?token= query param
          const bearerHdr = req.headers.get('Authorization') || ''
          const token = (bearerHdr.startsWith('Bearer ') ? bearerHdr.slice(7) : '') || req.headers.get('x-caregiver-token') || url.searchParams.get('token') || ''
          if (!token) return Response.json({ error: 'token required' }, { status: 401 })

          const session = await cloudflare.env.D1.prepare(
            "SELECT account_id FROM caregiver_sessions WHERE token = ? AND expires_at > datetime('now')"
          ).bind(token).first()
          if (!session) return Response.json({ error: 'Session expired. Please sign in again.' }, { status: 401 })

          const account = await cloudflare.env.D1.prepare(
            'SELECT id, email, name, zip_code, care_types, phone, bio, photo_url, setup_complete, city, state, languages, hourly_rate, skills, certifications, travel_radius_miles FROM caregiver_accounts WHERE id = ?'
          ).bind(session.account_id).first()
          if (!account) return Response.json({ error: 'Account not found' }, { status: 404 })

          const reviewStats = await cloudflare.env.D1.prepare(
            'SELECT AVG(rating) as avg_rating, COUNT(*) as review_count FROM caregiver_reviews WHERE caregiver_id = ? AND is_visible = 1'
          ).bind(session.account_id).first() as any
          const jobStats = await cloudflare.env.D1.prepare(
            'SELECT COUNT(*) as cnt FROM caregiver_bookings WHERE caregiver_id = ?'
          ).bind(session.account_id).first() as any

          // ---- Profile completeness calculation (mirrors frontend storage.ts) ----
          const acct = account as any
          const missingFields: string[] = []
          let completenessScore = 0
          if (acct.name && acct.name.trim()) completenessScore += 10; else missingFields.push('Full name')
          if (acct.photo_url) completenessScore += 10; else missingFields.push('Profile photo')
          if (acct.bio && acct.bio.length > 20) completenessScore += 10; else missingFields.push('Bio (min 20 chars)')
          if (acct.hourly_rate && parseFloat(String(acct.hourly_rate)) > 0) completenessScore += 10; else missingFields.push('Hourly rate')
          try { if (JSON.parse(acct.skills || '[]').length >= 3) completenessScore += 10; else missingFields.push('Skills (add 3 or more)') } catch { missingFields.push('Skills') }
          if (acct.phone) completenessScore += 10; else missingFields.push('Phone number')
          if (acct.city) completenessScore += 10; else missingFields.push('City / location')
          try { if (JSON.parse(acct.languages || '[]').length > 0) completenessScore += 10 } catch {}
          try { if (JSON.parse(acct.certifications || '[]').length > 0) completenessScore += 10; else missingFields.push('A certification or license') } catch { missingFields.push('A certification or license') }
          try { if (JSON.parse(acct.care_types || '[]').length > 0) completenessScore += 10; else missingFields.push('Care specialties') } catch { missingFields.push('Care specialties') }

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
              avgRating: reviewStats?.avg_rating ? Math.round(reviewStats.avg_rating * 10) / 10 : null,
              reviewCount: reviewStats?.review_count || 0,
              totalJobs: jobStats?.cnt || 0,
              completenessScore,
              missingFields,
              isVisibleInSearch: completenessScore >= 70,
              travelRadiusMiles: (account as any).travel_radius_miles || 10,
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
          const { token, name, phone, city, state, bio, hourlyRate, languages, skills, certifications, photoUrl, travelRadiusMiles } = body
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
          if (travelRadiusMiles !== undefined) { updates.push('travel_radius_miles = ?'); values.push(Math.min(50, Math.max(5, Number(travelRadiusMiles) || 10))) }

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

          // ---- Rate limiting: 10 failed attempts per IP per 15 min ----
          const clLoginIP = req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For') || 'unknown'
          const clLoginWindow = Math.floor(Date.now() / 1000) - 900
          const clLoginAttempts = await cloudflare.env.D1.prepare(
            'SELECT COUNT(*) as cnt FROM login_attempts WHERE ip = ? AND endpoint = ? AND attempted_at > ? AND success = 0'
          ).bind(clLoginIP, 'client-login', clLoginWindow).first() as any
          if ((clLoginAttempts?.cnt || 0) >= 10) {
            return Response.json({ error: 'Too many failed login attempts. Please try again in 15 minutes.' }, { status: 429 })
          }
          const recordClLoginFail = () => cloudflare.env.D1.prepare(
            'INSERT INTO login_attempts (ip, endpoint, email, attempted_at, success) VALUES (?, ?, ?, ?, 0)'
          ).bind(clLoginIP, 'client-login', email.toLowerCase(), Math.floor(Date.now() / 1000)).run().catch(() => {})

          const account = await cloudflare.env.D1.prepare(
            'SELECT * FROM client_accounts WHERE email = ?'
          ).bind(email.toLowerCase()).first() as any
          if (!account) { await recordClLoginFail(); return Response.json({ error: 'No account found. Please register first.' }, { status: 404 }) }

          const enc = new TextEncoder()
          const hashBuffer = await crypto.subtle.digest('SHA-256', enc.encode(password + account.salt))
          const passwordHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('')
          if (passwordHash !== account.password_hash) { await recordClLoginFail(); return Response.json({ error: 'Incorrect password.' }, { status: 401 }) }

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
          // SECURITY (P18): Accept Authorization: Bearer header OR ?token= query param
          const authHdr2 = req.headers?.get('Authorization') || ''
          const token = (authHdr2.startsWith('Bearer ') ? authHdr2.slice(7) : '') ||
            req.headers?.get('x-session-token') || url.searchParams.get('token') || ''
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

          // ── 4. Pending hire agreements (pending_caregiver / pending_client) ──
          const pendingRows = await cloudflare.env.D1.prepare(
            "SELECT ct.*, ca.name as cg_name, ca.email as cg_email, ca.photo_url as cg_photo, ca.hourly_rate as cg_rate, ca.skills as cg_skills, ca.care_types as cg_care_types FROM client_team ct LEFT JOIN caregiver_accounts ca ON ca.id = ct.caregiver_id WHERE ct.client_email = ? AND ct.status IN ('pending_caregiver', 'pending_client') ORDER BY ct.hired_at DESC"
          ).bind(clientEmail).all()

          const pending: any[] = []
          for (const row of (pendingRows.results || []) as any[]) {
            const parseJSONp = (v: any) => { try { return JSON.parse(v) } catch { return [] } }
            const pSkills = row.cg_skills ? parseJSONp(row.cg_skills) : []
            const pCareTypes = row.cg_care_types ? parseJSONp(row.cg_care_types) : []
            pending.push({
              id: row.caregiver_id,
              caregiver_id: row.caregiver_id,
              name: row.cg_name || row.caregiver_name || 'Caregiver',
              caregiver_name: row.cg_name || row.caregiver_name || 'Caregiver',
              email: row.cg_email || '',
              photoUrl: row.cg_photo || null,
              hourlyRate: row.cg_rate || row.caregiver_rate || 28,
              caregiver_rate: row.cg_rate || row.caregiver_rate || 28,
              specialty: pSkills.length > 0 ? pSkills[0] : (pCareTypes.length > 0 ? pCareTypes[0] : row.care_types || 'Home Care'),
              care_types: row.care_types || '',
              hiredAt: row.hired_at,
              status: row.status,
              agreement_token: row.agreement_token,
            })
          }

          return Response.json({ success: true, hired, active, past, pending, email: clientEmail })
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
          const env = cloudflare.env as any
          const url = new URL(req.url)
          const token = url.searchParams.get('token') || ''
          if (!token) return Response.json({ success: false, error: 'Token required' }, { headers })

          const sess = await env.D1.prepare(
            "SELECT cs.account_id, ca.email FROM caregiver_sessions cs JOIN caregiver_accounts ca ON ca.id = cs.account_id WHERE cs.token = ? AND cs.expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!sess) return Response.json({ success: false, error: 'Invalid session' }, { headers })

          const rows = await env.D1.prepare(
            'SELECT ct.*, ca.name AS client_name, ca.email AS client_email_addr FROM client_team ct LEFT JOIN client_accounts ca ON ca.email = ct.client_email WHERE ct.caregiver_id = ? AND ct.status = "active" ORDER BY ct.hired_at DESC'
          ).bind(Number(sess.account_id)).all()

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
      path: '/cgp-docs',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const env = cloudflare.env as any
          const url = new URL(req.url)
          const token = url.searchParams.get('token') || ''
          if (!token) return Response.json({ success: false, error: 'Token required' }, { headers })
          // Create marketplace docs table if not exists
          await env.D1.prepare(`CREATE TABLE IF NOT EXISTS cgp_documents (
            id TEXT PRIMARY KEY, caregiver_email TEXT NOT NULL, name TEXT NOT NULL,
            doc_type TEXT DEFAULT 'certification', r2_key TEXT, file_name TEXT,
            expiry_date TEXT, status TEXT DEFAULT 'no_expiry',
            created_at TEXT DEFAULT (datetime('now')))`).run().catch(()=>{})
          const docSess = await env.D1.prepare(
            "SELECT ca.email FROM caregiver_sessions cs JOIN caregiver_accounts ca ON ca.id = cs.account_id WHERE cs.token = ? AND cs.expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!docSess) return Response.json({ success: false, error: 'Invalid session' }, { headers })
          const docs = await env.D1.prepare('SELECT * FROM cgp_documents WHERE caregiver_email = ? ORDER BY created_at DESC').bind(docSess.email).all()
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
      path: '/cgp-docs',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const env = cloudflare.env as any
          const formData = await req.formData()
          const token = formData.get('token') || ''
          const name = formData.get('name') || ''
          const docType = formData.get('doc_type') || 'certification'
          const expiryDate = formData.get('expiry_date') || ''
          const file = formData.get('file')
          if (!token) return Response.json({ success: false, error: 'Token required' }, { headers })
          if (!name) return Response.json({ success: false, error: 'Document name required' }, { headers })
          const docPostSess = await env.D1.prepare(
            "SELECT ca.email FROM caregiver_sessions cs JOIN caregiver_accounts ca ON ca.id = cs.account_id WHERE cs.token = ? AND cs.expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!docPostSess) return Response.json({ success: false, error: 'Invalid session' }, { headers })
          const sess = docPostSess  // alias for remaining code
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
          await env.D1.prepare('INSERT INTO cgp_documents (id, caregiver_email, name, doc_type, r2_key, file_name, expiry_date, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, sess.email, name, docType, r2Key, fileName, expiryDate || null, status).run()
          const doc = { id, caregiver_email: sess.email, name, doc_type: docType, r2_key: r2Key, file_name: fileName, expiry_date: expiryDate || null, status }
          return Response.json({ success: true, document: doc }, { headers })
        } catch (e: any) {
          return Response.json({ success: false, error: e.message }, { headers })
        }
      },
    },
    {
      path: '/cgp-docs',
      method: 'delete',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const env = cloudflare.env as any
          const url = new URL(req.url)
          const token = url.searchParams.get('token') || ''
          const id = url.searchParams.get('id') || ''
          if (!token || !id) return Response.json({ success: false, error: 'Token and id required' }, { headers })
          const docDelSess = await env.D1.prepare(
            "SELECT ca.email FROM caregiver_sessions cs JOIN caregiver_accounts ca ON ca.id = cs.account_id WHERE cs.token = ? AND cs.expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!docDelSess) return Response.json({ success: false, error: 'Invalid session' }, { headers })
          // Get the doc to delete from R2 too
          const doc = await env.D1.prepare('SELECT r2_key FROM cgp_documents WHERE id = ? AND caregiver_email = ?').bind(id, docDelSess.email).first()
          if (doc?.r2_key) {
            try { await env.R2.delete(doc.r2_key) } catch {}
          }
          await env.D1.prepare('DELETE FROM cgp_documents WHERE id = ? AND caregiver_email = ?').bind(id, docDelSess.email).run()
          return Response.json({ success: true }, { headers })
        } catch (e: any) {
          return Response.json({ success: false, error: e.message }, { headers })
        }
      },
    },
    {
      path: '/cgp-docs/file',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*' }
        try {
          const env = cloudflare.env as any
          const url = new URL(req.url)
          const key = url.searchParams.get('key') || ''
          // SECURITY (RISK-02): Accept Authorization: Bearer header OR ?token= query param
          const authHeader = req.headers.get('Authorization') || ''
          const token = (authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '') || url.searchParams.get('token') || ''
          if (!key || !token) return Response.json({ error: 'Key and token required' }, { status: 400, headers })
          const fileDocSess = await env.D1.prepare(
            "SELECT ca.email FROM caregiver_sessions cs JOIN caregiver_accounts ca ON ca.id = cs.account_id WHERE cs.token = ? AND cs.expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!fileDocSess) return Response.json({ error: 'Unauthorized' }, { status: 401, headers })
          // SECURITY (RISK-03): verify document belongs to the authenticated caregiver
          const docOwner = await env.D1.prepare('SELECT id FROM cgp_documents WHERE r2_key = ? AND caregiver_email = ?').bind(key, fileDocSess.email).first()
          if (!docOwner) return Response.json({ error: 'Forbidden' }, { status: 403, headers })
          const obj = await env.R2.get(key)
          if (!obj) return Response.json({ error: 'File not found' }, { status: 404, headers })
          const contentType = obj.httpMetadata?.contentType || 'application/octet-stream'
          return new Response(obj.body, { headers: { ...headers, 'Content-Type': contentType, 'Content-Disposition': 'inline' } })
        } catch (e: any) {
          return Response.json({ error: e.message }, { status: 500, headers })
        }
      },
    },
    // ====== CGP TRUST STATUS — backend-verified trust checklist ======
    {
      path: '/cgp-trust-status',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const env = cloudflare.env as any
          const url = new URL(req.url)
          const token = url.searchParams.get('token') || ''
          if (!token) return Response.json({ error: 'Unauthorized' }, { status: 401, headers })
          const sess = await env.D1.prepare(
            'SELECT cs.account_id FROM caregiver_sessions cs WHERE cs.token = ?'
          ).bind(token).first() as any
          if (!sess) return Response.json({ error: 'Unauthorized' }, { status: 401, headers })
          const caregiverId = sess.account_id

          // Parallel D1 queries
          const [trustRow, verRow, bgRow, reviewRow, sessionRow, metricsRow, acctRow] = await Promise.all([
            env.D1.prepare('SELECT * FROM caregiver_trust_scores WHERE caregiver_id = ?').bind(caregiverId).first(),
            env.D1.prepare('SELECT id, doc_type, status, submitted_at, rejection_reason, admin_notes, file_name FROM caregiver_verifications WHERE caregiver_id = ? ORDER BY submitted_at DESC').bind(caregiverId).all(),
            env.D1.prepare('SELECT status FROM caregiver_background_checks WHERE caregiver_id = ?').bind(caregiverId).first(),
            env.D1.prepare('SELECT COUNT(*) as cnt, AVG(rating) as avg_r FROM caregiver_reviews WHERE caregiver_id = ?').bind(caregiverId).first(),
            env.D1.prepare("SELECT COUNT(*) as cnt FROM caregiver_bookings WHERE caregiver_id = ? AND status IN ('confirmed','completed')").bind(String(caregiverId)).first(),
            env.D1.prepare('SELECT avg_response_minutes, repeat_bookings, completed_shifts FROM caregiver_response_metrics WHERE caregiver_id = ?').bind(caregiverId).first(),
            env.D1.prepare('SELECT skills, bio, photo_url, hourly_rate FROM caregiver_accounts WHERE id = ?').bind(caregiverId).first(),
          ])

          const ts: any = trustRow || {}
          const verifications: any[] = (verRow as any)?.results || []
          const bg: any = bgRow || {}
          const reviewCount = Number((reviewRow as any)?.cnt || 0)
          const avgRating = (reviewRow as any)?.avg_r ? parseFloat(Number((reviewRow as any).avg_r).toFixed(1)) : null
          const sessionCount = Math.max(
            Number((sessionRow as any)?.cnt || 0),
            Number((metricsRow as any)?.completed_shifts || 0)
          )
          const fastResponder = (metricsRow as any)?.avg_response_minutes != null && Number((metricsRow as any).avg_response_minutes) <= 60
          const acct: any = acctRow || {}

          // Profile completeness (simple heuristic)
          let profileComplete = 0
          if (acct.bio && String(acct.bio).trim().length >= 20) profileComplete++
          if (acct.photo_url) profileComplete++
          if (acct.hourly_rate && Number(acct.hourly_rate) > 0) profileComplete++
          try { const sk = JSON.parse(acct.skills || '[]'); if (sk.length >= 3) profileComplete++ } catch {}
          const profileDone = profileComplete >= 3

          // Helper: map verification status from doc array
          const mapIdStatus = (adminVerified: boolean, docs: any[]): string => {
            if (adminVerified) return 'approved'
            if (!docs.length) return 'not_started'
            const latest = docs[0]
            const s = String(latest?.status || 'pending').toLowerCase()
            if (s === 'verified' || s === 'approved') return 'approved'
            if (s === 'rejected' || s === 'needs_more_info') return 'rejected'
            return 'submitted'
          }

          const idDocs = verifications.filter((v: any) => {
            const dt = String(v.doc_type || '').toLowerCase()
            return dt.includes('id') || dt.includes('license') || dt.includes('passport') || dt.includes('drivers') || dt.includes('state_id') || dt.includes('government')
          })
          const cprDocs = verifications.filter((v: any) => {
            const dt = String(v.doc_type || '').toLowerCase()
            return dt.includes('cpr') || dt.includes('first_aid') || dt.includes('first aid')
          })
          const cnaDocs = verifications.filter((v: any) => {
            const dt = String(v.doc_type || '').toLowerCase()
            return dt.includes('cna') || dt.includes('hha') || dt.includes('lvn') || dt.includes('lpn') || dt.includes('rn')
          })

          const idStatus = mapIdStatus(!!ts.id_verified, idDocs)
          const cprStatus = mapIdStatus(!!ts.cpr_certified, cprDocs)
          const cnaStatus = mapIdStatus(!!ts.cna_verified, cnaDocs)
          const bgStatus = (() => {
            if (ts.background_checked) return 'approved'
            const s = String(bg.status || 'not_started').toLowerCase()
            if (s === 'clear' || s === 'verified' || s === 'approved') return 'approved'
            if (s === 'pending' || s === 'in_progress' || s === 'submitted') return 'submitted'
            return 'not_started'
          })()

          const getRejectionReason = (docs: any[]): string | null => {
            const latest = docs[0]
            if (!latest) return null
            const s = String(latest.status || '').toLowerCase()
            if (s !== 'rejected' && s !== 'needs_more_info') return null
            return latest.admin_notes || latest.rejection_reason || 'Please resubmit with a clearer document.'
          }

          // Compute score
          const checklist = [
            { key: 'profile_complete', label: 'Profile Complete', status: profileDone ? 'complete' : 'not_started', points: 10, progress: null, rejection_reason: null },
            { key: 'identity_verified', label: 'Identity Verification', status: idStatus, points: 20, progress: null, rejection_reason: getRejectionReason(idDocs) },
            { key: 'background_check', label: 'Background Check', status: bgStatus, points: 20, progress: null, rejection_reason: null },
            { key: 'cpr_certification', label: 'CPR Certification', status: cprStatus, points: 15, progress: null, rejection_reason: getRejectionReason(cprDocs) },
            { key: 'cna_hha', label: 'CNA / HHA Verification', status: cnaStatus, points: 10, progress: null, rejection_reason: getRejectionReason(cnaDocs) },
            { key: 'completed_shifts', label: '5+ Completed Shifts', status: sessionCount >= 5 ? 'earned' : 'not_earned', points: 10, progress: `${Math.min(sessionCount, 5)}/5`, rejection_reason: null },
            { key: 'fast_responder', label: 'Fast Responder', status: fastResponder ? 'earned' : 'not_earned', points: 5, progress: null, rejection_reason: null },
            { key: 'repeat_clients', label: 'Repeat Clients', status: 'not_earned', points: 5, progress: null, rejection_reason: null },
            { key: 'five_star_avg', label: '5-Star Average', status: avgRating && avgRating >= 5.0 ? 'earned' : 'not_earned', points: 5, progress: avgRating ? `${avgRating}★` : null, rejection_reason: null },
          ]

          const score = checklist.reduce((sum: number, item: any) => {
            if (['approved','complete','earned'].includes(item.status)) return sum + item.points
            return sum
          }, 0)

          const tier = score >= 80 ? 'Platinum' : score >= 60 ? 'Gold' : score >= 40 ? 'Silver' : score >= 20 ? 'Verified' : 'Basic'

          // Next best action
          let next_action: any = null
          if (idStatus === 'not_started') {
            next_action = { type: 'upload_id', status: 'not_started', label: 'Verify Identity', cta: 'Upload ID', points: 20, description: 'Upload a photo ID to verify your identity. Accepted: Driver License, State ID, or Passport.' }
          } else if (idStatus === 'submitted') {
            next_action = { type: 'id_under_review', status: 'submitted', label: 'Identity Verification Under Review', cta: null, points: 20, description: 'Your ID is being reviewed by the Carehia team. This usually takes 1–2 business days.' }
          } else if (idStatus === 'rejected') {
            next_action = { type: 'resubmit_id', status: 'rejected', label: 'Resubmit Identity Verification', cta: 'Resubmit ID', points: 20, description: getRejectionReason(idDocs) || 'Your ID submission needs attention. Please resubmit with a clearer photo.' }
          } else if (bgStatus === 'not_started') {
            next_action = { type: 'background_check', status: 'not_started', label: 'Start Background Check', cta: 'Coming Soon', points: 20, description: 'Background checks are coming soon. Carehia will never start this step without your permission.' }
          } else if (bgStatus === 'submitted') {
            next_action = { type: 'bg_under_review', status: 'submitted', label: 'Background Check Under Review', cta: null, points: 20, description: 'Your background check is being processed. This can take 3–5 business days.' }
          } else {
            next_action = { type: 'add_certification', status: 'not_started', label: 'Add Certification Proof', cta: 'Add Proof', points: 15, description: 'Add CPR, CNA, training certificates, or other credentials to strengthen your profile.' }
          }

          // Badges
          const earnedBadgeNames: string[] = []
          if (profileDone) earnedBadgeNames.push('Profile Complete')
          if (idStatus === 'approved') earnedBadgeNames.push('Identity Verified')
          if (bgStatus === 'approved') earnedBadgeNames.push('Background Checked')
          if (cprStatus === 'approved') earnedBadgeNames.push('CPR Certified')
          if (fastResponder) earnedBadgeNames.push('Fast Responder')
          if (avgRating && avgRating >= 5.0) earnedBadgeNames.push('5-Star Caregiver')
          const allBadges = ['Profile Complete', 'Identity Verified', 'Background Checked', 'CPR Certified', 'Fast Responder', '5-Star Caregiver']
          const nextBadge = allBadges.find(b => !earnedBadgeNames.includes(b)) || null

          return Response.json({
            score,
            tier,
            next_action,
            checklist,
            certifications: verifications.map((v: any) => ({
              id: v.id, doc_type: v.doc_type, file_name: v.file_name,
              status: v.status || 'pending', submitted_at: v.submitted_at,
              rejection_reason: v.admin_notes || v.rejection_reason,
            })),
            reputation: { rating: avgRating, reviews: reviewCount, sessions: sessionCount },
            badges: { earned: earnedBadgeNames, next: nextBadge, total_earned: earnedBadgeNames.length },
          }, { headers })
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
          const env = cloudflare.env as any
          const url = new URL(req.url)
          const caregiverEmail = url.searchParams.get('email') || ''
          // SECURITY (P18): Accept Authorization: Bearer header OR ?clientToken= query param
          const _authHdrPD = req.headers?.get('Authorization') || ''
          const clientToken = (_authHdrPD.startsWith('Bearer ') ? _authHdrPD.slice(7) : '') ||
            req.headers?.get('x-session-token') || url.searchParams.get('clientToken') || ''
          if (!caregiverEmail) return Response.json({ success: false, error: 'Caregiver email required' }, { headers })
          // Get all docs for this caregiver
          const docs = await env.D1.prepare('SELECT id, name, doc_type, expiry_date, status FROM caregiver_documents WHERE caregiver_email = ? ORDER BY created_at DESC').bind(caregiverEmail).all()
          const docList = docs.results || []
          const count = docList.length
          // Check if client has paid subscription
          if (clientToken) {
            const sess = await env.D1.prepare('SELECT email FROM client_sessions WHERE session_token = ? AND expires_at > datetime(\'now\')').bind(clientToken).first()
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
          const env = cloudflare.env as any
          const url = new URL(req.url)
          // SECURITY (P18): Accept Authorization: Bearer header OR ?clientToken= query param
          const _authHdrTL = req.headers?.get('Authorization') || ''
          const clientToken = (_authHdrTL.startsWith('Bearer ') ? _authHdrTL.slice(7) : '') ||
            req.headers?.get('x-session-token') || url.searchParams.get('clientToken') || ''
          if (!clientToken) return Response.json({ success: false, error: 'Token required' }, { headers })
          const sess = await env.D1.prepare('SELECT email FROM client_sessions WHERE session_token = ? AND expires_at > datetime(\'now\')').bind(clientToken).first()
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
          const env = cloudflare.env as any
          const body = await req.json() as any
          const { clientToken, caregiverEmail, days, startTime, endTime, careType, notes, isRecurring } = body
          if (!clientToken || !caregiverEmail || !days || !startTime || !endTime) {
            return Response.json({ success: false, error: 'Missing required fields' }, { headers })
          }
          const sess = await env.D1.prepare('SELECT email FROM client_sessions WHERE session_token = ? AND expires_at > datetime(\'now\')').bind(clientToken).first() as any
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
          const env = cloudflare.env as any
          const url = new URL(req.url)
          // SECURITY (P18): Accept Authorization: Bearer header OR query param
          const _authHdrSG = req.headers?.get('Authorization') || ''
          const clientToken = (_authHdrSG.startsWith('Bearer ') ? _authHdrSG.slice(7) : '') ||
            req.headers?.get('x-session-token') || url.searchParams.get('clientToken') || ''
          const caregiverEmail = url.searchParams.get('caregiverEmail') || ''
          if (!clientToken) return Response.json({ success: false, error: 'Token required' }, { headers })
          const sess = await env.D1.prepare('SELECT email FROM client_sessions WHERE session_token = ? AND expires_at > datetime(\'now\')').bind(clientToken).first() as any
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

    // ====== HIRE AGREEMENTS ======
    {
      path: '/create-hire-agreement',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const env = cloudflare.env as any
          // Migrate client_team: add new columns if missing (SQLite ignores duplicate column errors)
          for (const col of [
            'ALTER TABLE client_team ADD COLUMN caregiver_name TEXT',
            'ALTER TABLE client_team ADD COLUMN caregiver_photo TEXT',
            'ALTER TABLE client_team ADD COLUMN caregiver_rate REAL',
            'ALTER TABLE client_team ADD COLUMN care_types TEXT',
            'ALTER TABLE client_team ADD COLUMN agreement_token TEXT',
          ]) { try { await env.D1.prepare(col).run() } catch (_) {} }
          // Ensure hire_agreements table exists
          await env.D1.prepare(`CREATE TABLE IF NOT EXISTS hire_agreements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agreement_token TEXT UNIQUE NOT NULL,
            client_email TEXT NOT NULL,
            caregiver_id INTEGER NOT NULL,
            caregiver_name TEXT,
            caregiver_photo TEXT,
            caregiver_rate REAL,
            care_types TEXT,
            start_date TEXT,
            schedule_notes TEXT,
            client_name TEXT,
            client_signature TEXT,
            client_signed_at TEXT,
            caregiver_signature TEXT,
            caregiver_signed_at TEXT,
            status TEXT DEFAULT 'pending_caregiver',
            created_at TEXT DEFAULT (datetime('now'))
          )`).run()
          // Add new columns if missing (v2)
          try { await env.D1.prepare("ALTER TABLE hire_agreements ADD COLUMN hours_per_week TEXT DEFAULT ''").run() } catch(_) {}
          const body = await req.json()
          const { clientToken, caregiverId, careTypes, startDate, scheduleNotes, negotiatedRate, hoursPerWeek } = body
          if (!clientToken || !caregiverId) {
            return Response.json({ success: false, error: 'Missing required fields' }, { status: 400, headers })
          }
          // Verify client session
          const sess = await env.D1.prepare(
            "SELECT ca.email, ca.name FROM client_sessions cs JOIN client_accounts ca ON ca.email = cs.email WHERE cs.session_token = ? AND cs.expires_at > datetime('now')"
          ).bind(clientToken).first() as any
          if (!sess) return Response.json({ success: false, error: 'Invalid session' }, { status: 401, headers })
          // Get caregiver info (including email for nudge)
          const cg = await env.D1.prepare('SELECT id, name, email, photo_url, hourly_rate FROM caregiver_accounts WHERE id = ?').bind(caregiverId).first() as any
          if (!cg) return Response.json({ success: false, error: 'Caregiver not found' }, { status: 404, headers })
          const finalRate = negotiatedRate || cg.hourly_rate || 0
          const agreementToken = crypto.randomUUID() + '-' + crypto.randomUUID()
          const now = new Date().toISOString()
          // Insert agreement (no client signature yet - caregiver signs first)
          await env.D1.prepare(
            `INSERT INTO hire_agreements (agreement_token, client_email, caregiver_id, caregiver_name, caregiver_photo, caregiver_rate, care_types, start_date, schedule_notes, client_name, hours_per_week, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_caregiver')`
          ).bind(
            agreementToken, sess.email, caregiverId, cg.name, cg.photo_url || null,
            finalRate, JSON.stringify(careTypes || []),
            startDate || null, scheduleNotes || null,
            sess.name || sess.email, hoursPerWeek || ''
          ).run()
          // Upsert into client_team
          await env.D1.prepare(
            `INSERT INTO client_team (client_email, caregiver_id, caregiver_name, caregiver_photo, caregiver_rate, care_types, status, agreement_token, hired_at)
             VALUES (?, ?, ?, ?, ?, ?, 'pending_caregiver', ?, datetime('now'))
             ON CONFLICT(client_email, caregiver_id) DO UPDATE SET status='pending_caregiver', agreement_token=excluded.agreement_token`
          ).bind(
            sess.email, caregiverId, cg.name, cg.photo_url || null,
            finalRate, JSON.stringify(careTypes || []), agreementToken
          ).run()
          // Nudge email to caregiver
          const clientFirstName = (sess.name || 'A client').split(' ')[0]
          if (cg.email) {
            try {
              await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  from: 'Carehia <hello@carehia.com>',
                  to: cg.email,
                  subject: `New Hire Offer from ${clientFirstName} - Review on Carehia`,
                  html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px"><h2 style="color:#7C5CFF;margin-top:0">You have a new hire offer!</h2><p><strong>${sess.name || 'A client'}</strong> wants to hire you on Carehia.</p><div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:12px;padding:16px;margin:16px 0"><p style="margin:4px 0"><strong>Rate:</strong> $${finalRate}/hr</p><p style="margin:4px 0"><strong>Hours/week:</strong> ${hoursPerWeek || 'Flexible'}</p><p style="margin:4px 0"><strong>Services:</strong> ${(careTypes || []).join(', ')}</p></div><p>Log in to review the agreement and sign it first.</p><a href="https://work.carehia.com" style="display:inline-block;background:#7C5CFF;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:8px">Review &amp; Sign Agreement</a><p style="margin-top:32px;font-size:13px;color:#888">Questions? <a href="mailto:support@carehia.com">support@carehia.com</a></p></div>`
                })
              })
            } catch(_) {}
          }
          return Response.json({ success: true, agreementToken }, { headers })
        } catch (e: any) {
          return Response.json({ success: false, error: e.message }, { headers })
        }
      },
    },
    {
      path: '/sign-hire-agreement',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const env = cloudflare.env as any
          const body = await req.json()
          const { token, agreementToken, caregiverSignature } = body
          if (!token || !agreementToken || !caregiverSignature) {
            return Response.json({ success: false, error: 'Missing required fields' }, { status: 400, headers })
          }
          // Verify caregiver session
          const sess = await env.D1.prepare(
            "SELECT ca.id, ca.name FROM caregiver_sessions cs JOIN caregiver_accounts ca ON cs.account_id = ca.id WHERE cs.token = ? AND cs.expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!sess) return Response.json({ success: false, error: 'Invalid session' }, { status: 401, headers })
          // Get agreement
          const agreement = await env.D1.prepare('SELECT * FROM hire_agreements WHERE agreement_token = ? AND caregiver_id = ?').bind(agreementToken, sess.id).first() as any
          if (!agreement) return Response.json({ success: false, error: 'Agreement not found' }, { status: 404, headers })
          if (agreement.status !== 'pending_caregiver') {
            return Response.json({ success: false, error: 'Agreement already processed' }, { status: 409, headers })
          }
          const now = new Date().toISOString()
          // Caregiver signs first - move to pending_client (client must countersign)
          await env.D1.prepare(
            "UPDATE hire_agreements SET caregiver_signature = ?, caregiver_signed_at = ?, status = 'pending_client' WHERE agreement_token = ?"
          ).bind(caregiverSignature, now, agreementToken).run()
          // Update client_team status
          await env.D1.prepare(
            "UPDATE client_team SET status = 'pending_client' WHERE client_email = ? AND caregiver_id = ?"
          ).bind(agreement.client_email, sess.id).run()
          // Email client to countersign
          try {
            await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                from: 'Carehia <hello@carehia.com>',
                to: agreement.client_email,
                subject: `${sess.name} signed your hire agreement - Your signature needed`,
                html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px"><h2 style="color:#7C5CFF;margin-top:0">Almost there! Your signature is needed.</h2><p><strong>${sess.name}</strong> has reviewed and signed your hire agreement on Carehia.</p><p>Please log in to review and countersign to activate your arrangement.</p><a href="https://app.carehia.com" style="display:inline-block;background:#7C5CFF;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:8px">Review &amp; Countersign</a><p style="margin-top:16px;font-size:13px"><a href="https://gotocare-original.jjioji.workers.dev/api/hire-agreement?token=${agreementToken}&format=html" style="color:#7C5CFF">View &amp; Print Agreement →</a></p><p style="margin-top:32px;font-size:13px;color:#888">Questions? <a href="mailto:support@carehia.com">support@carehia.com</a></p></div>`
              })
            })
          } catch(_) {}
          return Response.json({ success: true, message: 'Agreement signed. Waiting for client countersignature.' }, { headers })
        } catch (e: any) {
          return Response.json({ success: false, error: e.message }, { headers })
        }
      },
    },
    {
      path: '/decline-hire-agreement',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const env = cloudflare.env as any
          const body = await req.json()
          const { token, agreementToken } = body
          if (!token || !agreementToken) return Response.json({ success: false, error: 'Missing fields' }, { status: 400, headers })
          const sess = await env.D1.prepare(
            "SELECT ca.id FROM caregiver_sessions cs JOIN caregiver_accounts ca ON cs.account_id = ca.id WHERE cs.token = ? AND cs.expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!sess) return Response.json({ success: false, error: 'Invalid session' }, { status: 401, headers })
          const agreement = await env.D1.prepare('SELECT * FROM hire_agreements WHERE agreement_token = ? AND caregiver_id = ?').bind(agreementToken, sess.id).first() as any
          if (!agreement) return Response.json({ success: false, error: 'Not found' }, { status: 404, headers })
          await env.D1.prepare("UPDATE hire_agreements SET status = 'declined' WHERE agreement_token = ?").bind(agreementToken).run()
          await env.D1.prepare("UPDATE client_team SET status = 'declined' WHERE client_email = ? AND caregiver_id = ?").bind(agreement.client_email, sess.id).run()
          return Response.json({ success: true }, { headers })
        } catch (e: any) {
          return Response.json({ success: false, error: e.message }, { headers })
        }
      },
    },
    {
      path: '/client-sign-hire-agreement',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const env = cloudflare.env as any
          const body = await req.json()
          const { agreementToken, clientSignature, clientToken } = body
          if (!agreementToken || !clientSignature || !clientToken) {
            return Response.json({ success: false, error: 'Missing required fields' }, { status: 400, headers })
          }
          const sess = await env.D1.prepare(
            "SELECT ca.email, ca.name FROM client_sessions cs JOIN client_accounts ca ON ca.email = cs.email WHERE cs.session_token = ? AND cs.expires_at > datetime('now')"
          ).bind(clientToken).first() as any
          if (!sess) return Response.json({ success: false, error: 'Invalid session' }, { status: 401, headers })
          const agreement = await env.D1.prepare(
            "SELECT * FROM hire_agreements WHERE agreement_token = ? AND client_email = ? AND status = 'pending_client'"
          ).bind(agreementToken, sess.email).first() as any
          if (!agreement) return Response.json({ success: false, error: 'Agreement not found or not ready for your signature' }, { status: 404, headers })
          const now = new Date().toISOString()
          await env.D1.prepare(
            "UPDATE hire_agreements SET client_signature = ?, client_signed_at = ?, status = 'active' WHERE agreement_token = ?"
          ).bind(clientSignature, now, agreementToken).run()
          await env.D1.prepare(
            "UPDATE client_team SET status = 'active' WHERE client_email = ? AND caregiver_id = ?"
          ).bind(sess.email, agreement.caregiver_id).run()
          const cg2 = await env.D1.prepare('SELECT name, email FROM caregiver_accounts WHERE id = ?').bind(agreement.caregiver_id).first() as any
          const careTypesStr = (() => { try { return JSON.parse(agreement.care_types || '[]').join(', ') } catch(e) { return agreement.care_types || '' } })()
          const agreementHtml = `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px 24px"><h2 style="color:#7C5CFF;margin-top:0">Hire Agreement - Now Active</h2><p>Your hire agreement is fully signed and active. Here is a copy for your records.</p><div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:12px;padding:20px;margin:20px 0"><p style="margin:4px 0"><strong>Caregiver:</strong> ${agreement.caregiver_name}</p><p style="margin:4px 0"><strong>Client:</strong> ${agreement.client_name}</p><p style="margin:4px 0"><strong>Rate:</strong> $${agreement.caregiver_rate}/hr</p><p style="margin:4px 0"><strong>Hours/week:</strong> ${(agreement as any).hours_per_week || 'As discussed'}</p>${agreement.start_date ? `<p style="margin:4px 0"><strong>Start Date:</strong> ${agreement.start_date}</p>` : ''}${careTypesStr ? `<p style="margin:4px 0"><strong>Care Services:</strong> ${careTypesStr}</p>` : ''}${agreement.schedule_notes ? `<p style="margin:4px 0"><strong>Schedule Notes:</strong> ${agreement.schedule_notes}</p>` : ''}</div><div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:8px;padding:16px;margin:16px 0"><p style="margin:0;color:#166534;font-size:13px">Caregiver signed: ${agreement.caregiver_name} - ${agreement.caregiver_signed_at}</p><p style="margin:8px 0 0 0;color:#166534;font-size:13px">Client signed: ${agreement.client_name} - ${now}</p></div><p style="margin-top:16px"><a href="https://gotocare-original.jjioji.workers.dev/api/hire-agreement?token=${agreementToken}&format=html" style="display:inline-block;background:#22C55E;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">🖨️ Download / Print Signed Agreement</a></p><p style="margin-top:24px;font-size:13px;color:#888">Questions? <a href="mailto:support@carehia.com">support@carehia.com</a></p></div>`
          try { await fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'Carehia <hello@carehia.com>', to: sess.email, subject: 'Your Hire Agreement is Now Active - Carehia', html: agreementHtml }) }) } catch(_) {}
          if (cg2?.email) { try { await fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'Carehia <hello@carehia.com>', to: cg2.email, subject: 'Your Hire Agreement is Now Active - Carehia', html: agreementHtml }) }) } catch(_) {} }
          // Auto-populate care_schedules + caregiver_private_clients from signed hire agreement
          try {
            const schedNotes = agreement.schedule_notes || ''
            const dayNameMap: Record<string,string> = { 'Monday':'Mon','Tuesday':'Tue','Wednesday':'Wed','Thursday':'Thu','Friday':'Fri','Saturday':'Sat','Sunday':'Sun' }
            const dayMatch = schedNotes.match(/Days:\s*([^\n]+)/)
            const hrMatch = schedNotes.match(/Hours:\s*(\d{1,2}:\d{2})\s*[–-]\s*(\d{1,2}:\d{2})/)
            const parsedDays = dayMatch ? dayMatch[1].split(',').map((d: string) => dayNameMap[d.trim()] || d.trim()).join(',') : ''
            const parsedStart = hrMatch ? hrMatch[1] : ''
            const parsedEnd = hrMatch ? hrMatch[2] : ''
            let careTypesList: string[] = []
            try { careTypesList = JSON.parse(agreement.care_types || '[]') } catch (_) {}
            const careTypeFirst = careTypesList[0] || ''
            const cgEmail2 = cg2?.email || ''
            if (parsedDays && parsedStart && parsedEnd && cgEmail2) {
              const existingSched = await env.D1.prepare('SELECT id FROM care_schedules WHERE client_email = ? AND caregiver_email = ?').bind(agreement.client_email, cgEmail2).first()
              if (!existingSched) {
                await env.D1.prepare('INSERT INTO care_schedules (client_email, caregiver_email, days, start_time, end_time, care_type, notes, is_recurring) VALUES (?, ?, ?, ?, ?, ?, ?, 1)').bind(agreement.client_email, cgEmail2, parsedDays, parsedStart, parsedEnd, careTypeFirst, schedNotes).run()
              }
            }
            if (cgEmail2 && agreement.client_email) {
              const existingPc = await env.D1.prepare('SELECT id FROM caregiver_private_clients WHERE caregiver_email = ? AND email = ?').bind(cgEmail2, agreement.client_email).first()
              if (!existingPc) {
                const cgRate2 = parseFloat(String(agreement.caregiver_rate)) || 25
                await env.D1.prepare("INSERT INTO caregiver_private_clients (caregiver_email, name, email, phone, hourly_rate, care_type, billing_type) VALUES (?, ?, ?, ?, ?, ?, 'hourly')").bind(cgEmail2, agreement.client_name || agreement.client_email.split('@')[0], agreement.client_email, '', cgRate2, careTypeFirst).run()
              }
            }
          } catch (_autoErr: any) { /* non-blocking — don't fail the agreement */ }
          return Response.json({ success: true, agreementToken }, { headers })
        } catch (e: any) {
          return Response.json({ success: false, error: e.message }, { headers })
        }
      },
    },
    {
      path: '/pending-client-agreements',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const env = cloudflare.env as any
          const url = new URL(req.url)
          const clientToken = url.searchParams.get('clientToken') || ''
          if (!clientToken) return Response.json({ success: false, error: 'clientToken required' }, { status: 400, headers })
          const sess = await env.D1.prepare(
            "SELECT ca.email FROM client_sessions cs JOIN client_accounts ca ON ca.email = cs.email WHERE cs.session_token = ? AND cs.expires_at > datetime('now')"
          ).bind(clientToken).first() as any
          if (!sess) return Response.json({ success: false, error: 'Invalid session' }, { status: 401, headers })
          const result = await env.D1.prepare(
            "SELECT * FROM hire_agreements WHERE client_email = ? AND status = 'pending_client' ORDER BY caregiver_signed_at DESC"
          ).bind(sess.email).all()
          return Response.json({ success: true, agreements: result.results || [] }, { headers })
        } catch (e: any) {
          return Response.json({ success: false, error: e.message }, { headers })
        }
      },
    },
    {
      path: '/hire-agreement',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const env = cloudflare.env as any
          const url = new URL(req.url)
          const agreementToken = url.searchParams.get('token') || ''
          if (!agreementToken) return Response.json({ success: false, error: 'Token required' }, { status: 400, headers })
          const agreement = await env.D1.prepare('SELECT * FROM hire_agreements WHERE agreement_token = ?').bind(agreementToken).first() as any
          if (!agreement) return Response.json({ success: false, error: 'Not found' }, { status: 404, headers })

          // ── Printable HTML page ──────────────────────────────────────────────
          const format = url.searchParams.get('format')
          if (format === 'html') {
            const careTypesStr2 = (() => { try { return JSON.parse(agreement.care_types || '[]').join(', ') } catch { return agreement.care_types || '' } })()
            const isFullySigned = agreement.status === 'active'
            const htmlPage = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hire Agreement - Carehia</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#F8FAFC;color:#0F172A;padding:0}.page{max-width:680px;margin:0 auto;background:#fff;min-height:100vh;padding:48px 32px}@media(max-width:640px){.page{padding:32px 20px}}.header{text-align:center;margin-bottom:40px}.logo{font-size:24px;font-weight:900;background:linear-gradient(135deg,#7C5CFF,#4A90E2);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:4px}.badge{display:inline-block;background:${isFullySigned ? '#F0FDF4' : '#FEF9C3'};color:${isFullySigned ? '#166534' : '#92400E'};border:1px solid ${isFullySigned ? '#BBF7D0' : '#FDE68A'};border-radius:20px;padding:4px 14px;font-size:13px;font-weight:700;margin-top:8px}.title{font-size:22px;font-weight:800;margin-top:20px;color:#0F172A}.section{background:#F8FAFC;border:1.5px solid #E2E8F0;border-radius:14px;padding:22px;margin-bottom:20px}.section-title{font-size:12px;font-weight:700;color:#94A3B8;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:14px}.row{display:flex;justify-content:space-between;align-items:baseline;padding:6px 0;border-bottom:1px solid #E2E8F0}.row:last-child{border-bottom:none}.row-label{font-size:13px;color:#64748B}.row-value{font-size:14px;font-weight:600;color:#0F172A}.sig-box{background:#FAFAFA;border:2px solid #E2E8F0;border-radius:10px;padding:16px;margin-top:8px}.sig-name{font-size:20px;font-family:Georgia,serif;font-style:italic;color:#0F172A}.sig-ts{font-size:11px;color:#94A3B8;margin-top:4px}.footer{text-align:center;margin-top:40px;padding-top:24px;border-top:1px solid #E2E8F0;font-size:12px;color:#94A3B8}.print-btn{display:block;width:100%;padding:16px;background:linear-gradient(135deg,#7C5CFF,#4A90E2);color:#fff;border:none;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer;margin-bottom:24px;text-align:center}@media print{.print-btn{display:none}.page{padding:20px}}</style></head><body><div class="page"><div class="header"><div class="logo">Carehia</div><div class="title">Hire Agreement</div><div class="badge">${isFullySigned ? '✅ Fully Executed' : '⏳ Awaiting Signatures'}</div></div><div class="section"><div class="section-title">Agreement Details</div><div class="row"><span class="row-label">Caregiver</span><span class="row-value">${agreement.caregiver_name || 'N/A'}</span></div><div class="row"><span class="row-label">Client</span><span class="row-value">${agreement.client_name || 'N/A'}</span></div><div class="row"><span class="row-label">Hourly Rate</span><span class="row-value" style="color:#7C5CFF">$${agreement.caregiver_rate}/hr</span></div><div class="row"><span class="row-label">Hours / Week</span><span class="row-value">${agreement.hours_per_week || 'As discussed'}</span></div>${agreement.start_date ? `<div class="row"><span class="row-label">Start Date</span><span class="row-value">${agreement.start_date}</span></div>` : ''}${careTypesStr2 ? `<div class="row"><span class="row-label">Care Services</span><span class="row-value">${careTypesStr2}</span></div>` : ''}${agreement.schedule_notes ? `<div class="row"><span class="row-label">Schedule Notes</span><span class="row-value">${agreement.schedule_notes}</span></div>` : ''}</div><div class="section"><div class="section-title">Caregiver Signature</div>${agreement.caregiver_signature ? `<div class="sig-box"><div class="sig-name">${agreement.caregiver_signature}</div><div class="sig-ts">Signed digitally on ${new Date(agreement.caregiver_signed_at).toLocaleString('en-US',{dateStyle:'long',timeStyle:'short'})}</div></div>` : '<div style="color:#94A3B8;font-size:13px;padding:8px 0">Not yet signed</div>'}</div><div class="section"><div class="section-title">Client Signature</div>${agreement.client_signature ? `<div class="sig-box"><div class="sig-name">${agreement.client_signature}</div><div class="sig-ts">Signed digitally on ${new Date(agreement.client_signed_at).toLocaleString('en-US',{dateStyle:'long',timeStyle:'short'})}</div></div>` : '<div style="color:#94A3B8;font-size:13px;padding:8px 0">Not yet signed</div>'}</div><button class="print-btn" onclick="window.print()">🖨️ Print / Save as PDF</button><div class="footer"><p>This document was generated by Carehia and serves as a legally binding digital hire agreement.</p><p style="margin-top:6px">Questions? <a href="mailto:support@carehia.com" style="color:#7C5CFF">support@carehia.com</a></p></div></div></body></html>`
            return new Response(htmlPage, { headers: { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' } })
          }

          return Response.json({ success: true, agreement }, { headers })
        } catch (e: any) {
          return Response.json({ success: false, error: e.message }, { headers })
        }
      },
    },
    {
      path: '/pending-hire-offers',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const env = cloudflare.env as any
          const url = new URL(req.url)
          const token = url.searchParams.get('token') || ''
          if (!token) return Response.json({ success: false, error: 'Token required' }, { status: 401, headers })
          const sess = await env.D1.prepare(
            "SELECT ca.id, ca.name FROM caregiver_sessions cs JOIN caregiver_accounts ca ON cs.account_id = ca.id WHERE cs.token = ? AND cs.expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!sess) return Response.json({ success: false, error: 'Invalid session' }, { status: 401, headers })
          await _ensureCaregiverRequestHideColumns(env.D1)
          const result = await env.D1.prepare(
            "SELECT * FROM hire_agreements WHERE caregiver_id = ? AND status IN ('pending_caregiver', 'pending_client', 'active', 'declined', 'expired', 'cancelled', 'rejected', 'completed') AND COALESCE(caregiver_hidden, 0) = 0 ORDER BY created_at DESC LIMIT 20"
          ).bind(sess.id).all()
          return Response.json({ success: true, offers: result.results || [] }, { headers })
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
          const timerSession = await cloudflare.env.D1.prepare(
            "SELECT ca.email FROM caregiver_sessions cs JOIN caregiver_accounts ca ON cs.account_id = ca.id WHERE cs.token = ? AND cs.expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!timerSession) return Response.json({ timer: null }, { headers })
          const row = await cloudflare.env.D1.prepare(
            'SELECT * FROM caregiver_active_timer WHERE caregiver_email = ?'
          ).bind(timerSession.email).first() as any
          if (!row) return Response.json({ timer: null }, { headers })
          // Reconstruct timer object from individual columns (table has no timer_json)
          const timerObj = {
            clientName: row.client_name || '',
            startTime: row.start_time || new Date().toISOString(),
            hourlyRate: row.hourly_rate || 25,
            billingType: row.billing_type || 'hourly',
            otAfterHrs: row.ot_after_hrs || 8,
            otMultiplier: row.ot_multiplier || 1.5,
            notes: row.notes || '',
          }
          return Response.json({ timer: timerObj }, { headers })
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
          const timerPostSess = await cloudflare.env.D1.prepare(
            "SELECT ca.email FROM caregiver_sessions cs JOIN caregiver_accounts ca ON ca.id = cs.account_id WHERE cs.token = ? AND cs.expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!timerPostSess) return Response.json({ success: false, error: 'Session expired' }, { status: 401, headers })
          if (timer === null) {
            await cloudflare.env.D1.prepare('DELETE FROM caregiver_active_timer WHERE caregiver_email = ?').bind(timerPostSess.email).run()
          } else {
            await cloudflare.env.D1.prepare(
              'INSERT OR REPLACE INTO caregiver_active_timer (caregiver_email, client_name, start_time, hourly_rate, billing_type, ot_after_hrs, ot_multiplier, notes, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)'
            ).bind(
              timerPostSess.email,
              timer.clientName || '',
              timer.startTime || new Date().toISOString(),
              timer.hourlyRate || 25,
              timer.billingType || 'hourly',
              timer.otAfterHrs || 8,
              timer.otMultiplier || 1.5,
              timer.notes || ''
            ).run()
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


    // ====== SEND INVOICE BY EMAIL ======
    {
      path: '/caregiver-invoice-send',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const body = await req.json()
          const { token, cloudId, invoice, caregiverInfo } = body
          if (!token || !cloudId) return Response.json({ success: false, error: 'token and cloudId required' }, { status: 400, headers })
          const env = cloudflare.env as any
          const invSess = await env.D1.prepare(
            "SELECT ca.email, ca.name FROM caregiver_sessions cs JOIN caregiver_accounts ca ON ca.id = cs.account_id WHERE cs.token = ? AND cs.expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!invSess) return Response.json({ success: false, error: 'Session expired' }, { status: 401, headers })
          // Look up the invoice
          const inv = await env.D1.prepare(
            'SELECT * FROM caregiver_personal_invoices WHERE id = ?'
          ).bind(Number(cloudId)).first() as any
          if (!inv) return Response.json({ success: false, error: 'Invoice not found' }, { status: 404, headers })
          // Send via Resend if client email available
          const resendKey = env.RESEND_API_KEY || ''
          const toEmail = invoice?.clientEmail || ''
          const cgName = caregiverInfo?.name || invSess.name || 'Your Caregiver'
          const amount = Number(invoice?.amount || inv.amount || 0).toFixed(2)
          const invNum = inv.invoice_number || cloudId
          if (resendKey && toEmail && toEmail.includes('@')) {
            await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                from: 'hello@carehia.com',
                to: [toEmail],
                subject: 'Invoice from ' + cgName + ' — $' + amount,
                html: '<p>Hi,</p><p>' + cgName + ' has sent you an invoice for <strong>$' + amount + '</strong>.</p><p>Invoice #' + invNum + '</p><p>Due: ' + (inv.due_date || 'Upon receipt') + '</p><p>Thank you,<br/>Carehia</p>',
              }),
            }).catch(() => {})
          }
          // Mark as sent
          await env.D1.prepare(
            "UPDATE caregiver_personal_invoices SET status = 'sent' WHERE id = ?"
          ).bind(Number(cloudId)).run()
          return Response.json({ success: true, message: 'Invoice sent' }, { headers })
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
          const mileSession = await cloudflare.env.D1.prepare(
            "SELECT ca.email FROM caregiver_sessions cs JOIN caregiver_accounts ca ON ca.id = cs.account_id WHERE cs.token = ? AND cs.expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!mileSession) return Response.json({ success: false, error: 'Session expired' }, { status: 401, headers })
          const result = await cloudflare.env.D1.prepare(
            'SELECT * FROM caregiver_mileage WHERE caregiver_email = ? ORDER BY date DESC LIMIT 200'
          ).bind(mileSession.email).all()
          const entries = (result.results || []).map((m: any) => ({
            id: 'cloud_' + m.id,
            cloudId: String(m.id),
            date: m.date,
            clientName: m.client_name,
            miles: m.miles,
            purpose: m.purpose || '',
            notes: '',
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
          const milePostSession = await cloudflare.env.D1.prepare(
            "SELECT ca.email FROM caregiver_sessions cs JOIN caregiver_accounts ca ON ca.id = cs.account_id WHERE cs.token = ? AND cs.expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!milePostSession) return Response.json({ success: false, error: 'Session expired' }, { status: 401, headers })
          const r = await cloudflare.env.D1.prepare(
            'INSERT INTO caregiver_mileage (caregiver_email, date, client_name, miles, purpose) VALUES (?, ?, ?, ?, ?)'
          ).bind(
            milePostSession.email, entry.date || '', entry.clientName || '',
            entry.miles || 0, entry.purpose || ''
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
          const mileDelSession = await cloudflare.env.D1.prepare(
            "SELECT ca.email FROM caregiver_sessions cs JOIN caregiver_accounts ca ON ca.id = cs.account_id WHERE cs.token = ? AND cs.expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!mileDelSession) return Response.json({ success: false, error: 'Session expired' }, { status: 401, headers })
          await cloudflare.env.D1.prepare(
            'DELETE FROM caregiver_mileage WHERE id = ? AND caregiver_email = ?'
          ).bind(Number(cloudId), mileDelSession.email).run()
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

          // AUTHZ-09: Rate limit nudge emails per IP (5/hour) to prevent email spam abuse
          const ip = req.headers?.get('CF-Connecting-IP') || 'unknown'
          const db = (cloudflare as any).env.D1
          const window = Math.floor(Date.now() / (1000 * 3600))  // 1-hour window
          const nudgeKey = 'nudge_' + ip
          const attempt = await db.prepare(
            "SELECT attempts, window_key FROM login_attempts WHERE ip = ? AND endpoint = ? LIMIT 1"
          ).bind(ip, nudgeKey).first() as any
          if (attempt && attempt.window_key === String(window) && attempt.attempts >= 5) {
            return Response.json({ success: false, error: 'Too many nudge requests. Please try again later.' }, { status: 429, headers })
          }
          if (attempt && attempt.window_key === String(window)) {
            await db.prepare("UPDATE login_attempts SET attempts = attempts + 1 WHERE ip = ? AND endpoint = ?").bind(ip, nudgeKey).run()
          } else {
            await db.prepare("INSERT OR REPLACE INTO login_attempts (ip, endpoint, attempts, window_key) VALUES (?, ?, 1, ?)").bind(ip, nudgeKey, String(window)).run()
          }
          // Validate caregiverEmail exists in our system (prevent arbitrary email targeting)
          const cgRow = await db.prepare('SELECT id FROM caregiver_accounts WHERE email = ?').bind(caregiverEmail.toLowerCase()).first()
          if (!cgRow) return Response.json({ success: true }, { headers })  // silently succeed (don't reveal existence)

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
          // Fetch trust score for verified badges
          const trustRow = await db.prepare('SELECT * FROM caregiver_trust_scores WHERE caregiver_id = ?').bind(parseInt(id)).first() as any
          const badges = {
            idVerified: trustRow?.id_verified === 1 || trustRow?.id_verified === true,
            backgroundReviewed: trustRow?.background_checked === 1 || trustRow?.background_checked === true,
            licenseReviewed: trustRow?.cna_verified === 1 || trustRow?.cna_verified === true,
            cprCertified: trustRow?.cpr_certified === 1 || trustRow?.cpr_certified === true,
            trustScore: trustRow?.score || 0,
            trustLevel: trustRow?.level || 'Basic',
          }
          return Response.json({ success: true, profile: { ...(result as any), skills, certifications, badges } }, { headers })
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
          const session = await db.prepare('SELECT account_id FROM caregiver_sessions WHERE token = ?').bind(token).first()
          if (!session) return Response.json({ success: false, error: 'Invalid token' }, { status: 401, headers })
          await db.exec(`CREATE TABLE IF NOT EXISTS caregiver_availability (id INTEGER PRIMARY KEY AUTOINCREMENT, caregiver_id INTEGER NOT NULL UNIQUE, availability_json TEXT, updated_at TEXT DEFAULT (datetime('now')))`)
          const avail = await db.prepare('SELECT availability_json FROM caregiver_availability WHERE caregiver_id = ?').bind((session as any).account_id).first()
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
          const session = await db.prepare('SELECT account_id FROM caregiver_sessions WHERE token = ?').bind(token).first()
          if (!session) return Response.json({ success: false, error: 'Invalid token' }, { status: 401, headers })
          await db.exec(`CREATE TABLE IF NOT EXISTS caregiver_availability (id INTEGER PRIMARY KEY AUTOINCREMENT, caregiver_id INTEGER NOT NULL UNIQUE, availability_json TEXT, updated_at TEXT DEFAULT (datetime('now')))`)
          await db.prepare('INSERT OR REPLACE INTO caregiver_availability (caregiver_id, availability_json, updated_at) VALUES (?, ?, datetime(\'now\'))').bind((session as any).account_id, JSON.stringify(body.availability || {})).run()
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
          const session = await db.prepare('SELECT account_id FROM caregiver_sessions WHERE token = ?').bind(token).first()
          if (!session) return Response.json({ success: false, error: 'Invalid token' }, { status: 401, headers })
          const cgId = (session as any).account_id
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
          return Response.json({ success: true, score, level, idVerified: (idVerif as any)?.status==='verified', backgroundChecked: (bgCheck as any)?.status==='verified', hasCPR, hasCNA, reviewCount: ra?.cnt||0, avgRating: Math.round((ra?.avg||0)*10)/10  /* fastResponder removed Phase-18: internal metric — see Phase 15 rules */ }, { headers })
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
          const session = await db.prepare('SELECT account_id FROM caregiver_sessions WHERE token = ?').bind(token).first()
          if (!session) return Response.json({ success: false, error: 'Invalid token' }, { status: 401, headers })
          const cgId = (session as any).account_id
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
          const session = await db.prepare('SELECT account_id FROM caregiver_sessions WHERE token = ?').bind(token).first()
          if (!session) return Response.json({ success: false, error: 'Invalid token' }, { status: 401, headers })
          const cgId = (session as any).account_id
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
          const session = await db.prepare('SELECT account_id FROM caregiver_sessions WHERE token = ?').bind(token).first()
          if (!session) return Response.json({ success: false, error: 'Invalid token' }, { status: 401, headers })
          const cgId = (session as any).account_id
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
          // AUTHZ-06: Require valid client session — no anonymous reviews allowed
          const authHdr = req.headers?.get('Authorization') || ''
          const resolvedToken = (authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '') || clientToken || ''
          if (!resolvedToken) return Response.json({ success: false, error: 'Authentication required to submit a review' }, { status: 401, headers })
          const reviewSess = await db.prepare('SELECT email FROM client_sessions WHERE session_token = ? AND expires_at > datetime(\'now\')').bind(resolvedToken).first() as any
          if (!reviewSess) return Response.json({ success: false, error: 'Invalid or expired session' }, { status: 401, headers })
          const clientEmail = reviewSess.email
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
          // AUTHZ-08: Require caregiver session + verify caregiverId matches session
          const cgSess = await _requireCgAuth(req)
          if (!cgSess) return Response.json({ success: false, error: 'Caregiver authentication required' }, { status: 401, headers })
          const body = await req.json()
          const { caregiverId, responseMinutes, accepted, completed } = body
          if (!caregiverId) return Response.json({ success: false, error: 'caregiverId required' }, { status: 400, headers })
          const db = (cloudflare as any).env.D1
          const cgId = parseInt(caregiverId)
          // Verify the caregiver can only update their own metrics
          if (cgId !== cgSess.account_id) return Response.json({ success: false, error: 'Forbidden: cannot update another caregiver\'s metrics' }, { status: 403, headers })
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
          const {results:sess}=await db.prepare(`SELECT account_id FROM caregiver_sessions WHERE token=?`).bind(token).all()
          if (!(sess as any[])[0]) return Response.json({ error: 'Unauthorized' }, { status: 401, headers })
          const caregiverId=(sess as any[])[0].account_id
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
          const {results:sess}=await db.prepare(`SELECT account_id FROM caregiver_sessions WHERE token=?`).bind(token).all()
          if (!(sess as any[])[0]) return Response.json({ error: 'Unauthorized' }, { status: 401, headers })
          const caregiverId=(sess as any[])[0].account_id
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
          const {results:sess}=await db.prepare(`SELECT account_id FROM caregiver_sessions WHERE token=?`).bind(token).all()
          if (!(sess as any[])[0]) return Response.json({ error: 'Unauthorized' }, { status: 401, headers })
          const caregiverId=(sess as any[])[0].account_id
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
          const {results:sess}=await db.prepare(`SELECT account_id FROM caregiver_sessions WHERE token=?`).bind(token).all()
          if (!(sess as any[])[0]) return Response.json({ error: 'Unauthorized' }, { status: 401, headers })
          const caregiverId=(sess as any[])[0].account_id
          const {results:cgRows}=await db.prepare(`SELECT zip_code FROM caregiver_accounts WHERE id=?`).bind(caregiverId).all()
          const zip=(cgRows as any[])[0]?.zip_code||''
          await db.prepare(`INSERT OR REPLACE INTO caregiver_online_status (caregiver_id,is_online,zip_code,last_seen,updated_at) VALUES (?,?,?,datetime('now'),datetime('now'))`).bind(caregiverId,is_online?1:0,zip).run()
          return Response.json({ success:true, is_online:!!is_online }, { headers })
        } catch (error) { return Response.json({ error: String(error) }, { status: 500, headers }) }
      },
    },

    // ====== VAPID PUBLIC KEY (safe to expose — public key is meant to be shared) ======
    {
      path: '/vapid-public-key',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        const publicKey = (cloudflare as any).env.VAPID_PUBLIC_KEY
        if (!publicKey) return Response.json({ error: 'VAPID not configured' }, { status: 500, headers })
        return Response.json({ publicKey }, { headers })
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
          const {results:sess}=await db.prepare(`SELECT account_id FROM caregiver_sessions WHERE token=?`).bind(token).all()
          if (!(sess as any[])[0]) return Response.json({ error: 'Unauthorized' }, { status: 401, headers })
          const caregiverId=(sess as any[])[0].account_id
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
          const {results:sess}=await db.prepare(`SELECT account_id FROM caregiver_sessions WHERE token=?`).bind(token).all()
          if (!(sess as any[])[0]) return Response.json({ error: 'Unauthorized' }, { status: 401, headers })
          await db.prepare(`DELETE FROM push_subscriptions WHERE caregiver_id=?`).bind((sess as any[])[0].account_id).run()
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
          const {results:sess}=await db.prepare(`SELECT account_id FROM caregiver_sessions WHERE token=?`).bind(token).all()
          if (!(sess as any[])[0]) return Response.json({ error: 'Unauthorized' }, { status: 401, headers })
          const caregiverId=(sess as any[])[0].account_id
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
          // SECURITY (P18): Accept Authorization: Bearer header OR ?clientToken= query param
          const _authHdrOC = req.headers?.get('Authorization') || ''
          const clientToken = (_authHdrOC.startsWith('Bearer ') ? _authHdrOC.slice(7) : '') ||
            req.headers?.get('x-session-token') || url.searchParams.get('clientToken') || ''
          if (!clientToken) return Response.json({ active: false, error: 'clientToken required' }, { status: 400, headers })

          const db = (cloudflare as any).env.D1

          // Validate token — check client_sessions
          const session = await db.prepare(
            "SELECT email FROM client_sessions WHERE session_token = ? AND expires_at > datetime('now')"
          ).bind(clientToken).first() as any

          if (!session) return Response.json({ active: false, error: 'Invalid or expired token' }, { status: 401, headers })

          const clientEmail = session.email

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
          // SECURITY (P18): Accept Authorization: Bearer header OR ?clientToken= query param
          const _authHdrPR = req.headers?.get('Authorization') || ''
          const token = (_authHdrPR.startsWith('Bearer ') ? _authHdrPR.slice(7) : '') ||
            req.headers?.get('x-session-token') || url.searchParams.get('clientToken') || ''
          if (!token) return Response.json({ error: 'clientToken required' }, { status: 400 })
          const headers = { 'Access-Control-Allow-Origin': '*' }
          const db = (cloudflare.env as any).D1
          // Validate session
          const session = await db.prepare(
            "SELECT email FROM client_sessions WHERE session_token = ? AND expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!session) return Response.json({ error: 'Invalid or expired token' }, { status: 401, headers })
          // Get zip + care_types from client_accounts
          const client = await db.prepare(
            'SELECT zip, care_types, name FROM client_accounts WHERE email = ?'
          ).bind(session.email).first() as any
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
            "SELECT email FROM client_sessions WHERE session_token = ? AND expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!session) return Response.json({ error: 'Invalid or expired token' }, { status: 401, headers })
          const { zip, careNeeds } = body
          await db.prepare(
            'UPDATE client_accounts SET zip = ?, care_types = ? WHERE email = ?'
          ).bind(zip || null, careNeeds ? JSON.stringify(careNeeds) : null, session.email).run()
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
          // SECURITY (P18): Accept Authorization: Bearer header OR ?clientToken= query param
          const _authHdrSL = req.headers?.get('Authorization') || ''
          const token = (_authHdrSL.startsWith('Bearer ') ? _authHdrSL.slice(7) : '') ||
            req.headers?.get('x-session-token') || url.searchParams.get('clientToken') || ''
          if (!token) return Response.json({ error: 'clientToken required' }, { status: 400 })
          const headers = { 'Access-Control-Allow-Origin': '*' }
          const db = (cloudflare.env as any).D1
          const session = await db.prepare(
            "SELECT email FROM client_sessions WHERE session_token = ? AND expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!session) return Response.json({ items: [] }, { headers })
          const result = await db.prepare(
            'SELECT caregiver_id, caregiver_data, saved_at FROM client_shortlist WHERE client_email = ? ORDER BY saved_at DESC'
          ).bind(session.email).all()
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
            "SELECT email FROM client_sessions WHERE session_token = ? AND expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!session) return Response.json({ error: 'Not authenticated' }, { status: 401, headers })
          const { action, caregiverId, caregiverData } = body
          if (action === 'add') {
            await db.prepare(
              'INSERT OR REPLACE INTO client_shortlist (client_email, caregiver_id, caregiver_data) VALUES (?, ?, ?)'
            ).bind(session.email, String(caregiverId), caregiverData ? JSON.stringify(caregiverData) : null).run()
          } else if (action === 'remove') {
            await db.prepare(
              'DELETE FROM client_shortlist WHERE client_email = ? AND caregiver_id = ?'
            ).bind(session.email, String(caregiverId)).run()
          } else if (action === 'clear') {
            await db.prepare(
              'DELETE FROM client_shortlist WHERE client_email = ?'
            ).bind(session.email).run()
          }
          return Response.json({ success: true }, { headers })
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 })
        }
      },
    },

    // ====== GET CAREGIVER SUBSCRIPTION STATUS ======
    {
      path: '/caregiver-subscription',
      method: 'get',
      handler: async (req) => {
        try {
          const url = new URL(req.url)
          const token = url.searchParams.get('token')
          if (!token) return Response.json({ error: 'token required' }, { status: 400 })
          const db = (cloudflare.env as any).D1
          const session = await db.prepare(
            "SELECT account_id FROM caregiver_sessions WHERE token = ? AND expires_at > datetime('now')"
          ).bind(token).first() as any
          if (!session) return Response.json({ error: 'Invalid token' }, { status: 401 })
          const cgId = String(session.account_id)
          const sub = await db.prepare(
            'SELECT * FROM caregiver_subscriptions WHERE caregiver_id = ? ORDER BY created_at DESC LIMIT 1'
          ).bind(cgId).first() as any
          if (!sub || sub.status !== 'active') {
            return Response.json({ subscribed: false, plan: 'free' })
          }
          const now = new Date()
          const expiresAt = sub.expires_at ? new Date(sub.expires_at) : null
          const isValid = !expiresAt || expiresAt > now
          return Response.json({
            subscribed: isValid,
            plan: sub.plan || 'unlimited',
            status: sub.status,
            expiresAt: sub.expires_at,
            stripeSubscriptionId: sub.stripe_subscription_id,
            createdAt: sub.created_at,
          })
        } catch (error) {
          return Response.json({ subscribed: false, error: String(error) }, { status: 500 })
        }
      },
    },

    // ====== SUPER ADMIN — CHECK IS_ADMIN ======
    {
      path: 'admin-check',
      method: 'get',
      handler: async (req: PayloadRequest) => {
        const token = req.query?.token as string;
        if (!token) return Response.json({ error: 'No token' }, { status: 401 });
        const db = cloudflare.env.D1 as D1Database;
        const sess = await db.prepare('SELECT ca.is_admin, ca.email, ca.name FROM client_sessions cs JOIN client_accounts ca ON ca.email = cs.email WHERE cs.session_token = ? LIMIT 1').bind(token).first() as any;
        if (!sess || !sess.is_admin) return Response.json({ error: 'Unauthorized' }, { status: 403 });
        return Response.json({ admin: true, email: sess.email, name: sess.name });
      },
    },

    // ====== SUPER ADMIN — PLATFORM STATS ======
    {
      path: 'admin-stats',
      method: 'get',
      handler: async (req: PayloadRequest) => {
        const token = req.query?.token as string;
        if (!token) return Response.json({ error: 'No token' }, { status: 401 });
        const db = cloudflare.env.D1 as D1Database;
        const sess = await db.prepare('SELECT ca.is_admin FROM client_sessions cs JOIN client_accounts ca ON ca.email = cs.email WHERE cs.session_token = ? LIMIT 1').bind(token).first() as any;
        if (!sess?.is_admin) return Response.json({ error: 'Unauthorized' }, { status: 403 });
        const [clients, caregivers, bookings, unlocked, team] = await Promise.all([
          db.prepare('SELECT COUNT(*) as cnt FROM client_accounts').first() as any,
          db.prepare('SELECT COUNT(*) as cnt FROM caregiver_accounts').first() as any,
          db.prepare('SELECT COUNT(*) as cnt FROM caregiver_bookings').first() as any,
          db.prepare('SELECT COUNT(*) as cnt FROM caregiver_bookings WHERE is_unlocked = 1').first() as any,
          db.prepare('SELECT COUNT(*) as cnt FROM client_team').first() as any,
        ]);
        const pendingB = await db.prepare("SELECT COUNT(*) as cnt FROM caregiver_bookings WHERE status = 'pending'").first() as any;
        await _ensureVerificationTables(db);
        const pendingV = await db.prepare("SELECT COUNT(*) as cnt FROM caregiver_verifications WHERE status = 'pending'").first() as any;
        const revenueUnlocks = (unlocked?.cnt || 0) * 4.99;
        return Response.json({
          totalClients: clients?.cnt || 0,
          totalCaregivers: caregivers?.cnt || 0,
          totalBookings: bookings?.cnt || 0,
          unlockedBookings: unlocked?.cnt || 0,
          pendingBookings: pendingB?.cnt || 0,
          pendingVerifications: pendingV?.cnt || 0,
          totalTeamHires: team?.cnt || 0,
          estimatedRevenue: revenueUnlocks.toFixed(2),
        });
      },
    },

    // ====== SUPER ADMIN — LIST CLIENTS ======
    {
      path: 'admin-clients',
      method: 'get',
      handler: async (req: PayloadRequest) => {
        const token = req.query?.token as string;
        if (!token) return Response.json({ error: 'No token' }, { status: 401 });
        const db = cloudflare.env.D1 as D1Database;
        const sess = await db.prepare('SELECT ca.is_admin FROM client_sessions cs JOIN client_accounts ca ON ca.email = cs.email WHERE cs.session_token = ? LIMIT 1').bind(token).first() as any;
        if (!sess?.is_admin) return Response.json({ error: 'Unauthorized' }, { status: 403 });
        const rows = await db.prepare('SELECT id, name, email, google_id, created_at, is_admin FROM client_accounts ORDER BY created_at DESC LIMIT 200').all();
        return Response.json({ clients: rows.results });
      },
    },

    // ====== SUPER ADMIN — LIST CAREGIVERS ======
    {
      path: 'admin-caregivers',
      method: 'get',
      handler: async (req: PayloadRequest) => {
        const token = req.query?.token as string;
        if (!token) return Response.json({ error: 'No token' }, { status: 401 });
        const db = cloudflare.env.D1 as D1Database;
        const sess = await db.prepare('SELECT ca.is_admin FROM client_sessions cs JOIN client_accounts ca ON ca.email = cs.email WHERE cs.session_token = ? LIMIT 1').bind(token).first() as any;
        if (!sess?.is_admin) return Response.json({ error: 'Unauthorized' }, { status: 403 });
        const rows = await db.prepare('SELECT id, name, email, city, state, hourly_rate, care_types, created_at FROM caregiver_accounts ORDER BY created_at DESC LIMIT 200').all();
        return Response.json({ caregivers: rows.results });
      },
    },

    // ====== SUPER ADMIN — LIST BOOKINGS ======
    {
      path: 'admin-bookings',
      method: 'get',
      handler: async (req: PayloadRequest) => {
        const token = req.query?.token as string;
        if (!token) return Response.json({ error: 'No token' }, { status: 401 });
        const db = cloudflare.env.D1 as D1Database;
        const sess = await db.prepare('SELECT ca.is_admin FROM client_sessions cs JOIN client_accounts ca ON ca.email = cs.email WHERE cs.session_token = ? LIMIT 1').bind(token).first() as any;
        if (!sess?.is_admin) return Response.json({ error: 'Unauthorized' }, { status: 403 });
        const rows = await db.prepare('SELECT cb.id, cb.client_email, cb.caregiver_id, ca.name as caregiver_name, cb.care_needs, cb.preferred_date, cb.preferred_time, cb.status, cb.is_unlocked, cb.created_at FROM caregiver_bookings cb LEFT JOIN caregiver_accounts ca ON ca.id = cb.caregiver_id ORDER BY cb.created_at DESC LIMIT 300').all();
        return Response.json({ bookings: rows.results });
      },
    },

    // ====== SUPER ADMIN — VERIFICATION REVIEW QUEUE ======
    {
      path: 'admin-verifications',
      method: 'get',
      handler: async (req: PayloadRequest) => {
        const admin = await _requireAdminAuth(req)
        if (!admin) return Response.json({ success: false, error: 'Unauthorized' }, { status: 403 })
        const db = cloudflare.env.D1 as D1Database
        await _ensureVerificationTables(db)
        const status = (req.query?.status as string) || 'pending'
        const caregiverId = req.query?.caregiverId ? Number(req.query.caregiverId) : null
        const limit = Math.min(Number(req.query?.limit || 100), 300)
        const where: string[] = []
        const binds: any[] = []
        if (status && status !== 'all') {
          where.push('cv.status = ?')
          binds.push(status)
        }
        if (caregiverId) {
          where.push('cv.caregiver_id = ?')
          binds.push(caregiverId)
        }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
        const rows = await db.prepare(
          `SELECT
             cv.id, cv.caregiver_id, cv.doc_type, cv.status, cv.submitted_at, cv.reviewed_at, cv.approved_at,
             cv.rejection_reason, cv.admin_notes, cv.file_name, cv.mime_type, cv.r2_key, cv.front_url, cv.consent_given, cv.notes,
             ca.name as caregiver_name, ca.email as caregiver_email, ca.city as caregiver_city, ca.state as caregiver_state,
             cts.score as trust_score, cts.level as trust_level
           FROM caregiver_verifications cv
           LEFT JOIN caregiver_accounts ca ON ca.id = cv.caregiver_id
           LEFT JOIN caregiver_trust_scores cts ON cts.caregiver_id = cv.caregiver_id
           ${whereSql}
           ORDER BY COALESCE(cv.submitted_at, '') DESC, cv.id DESC
           LIMIT ?`
        ).bind(...binds, limit).all() as any
        return Response.json({ success: true, verifications: rows.results || [] })
      },
    },

    // ====== SUPER ADMIN — APPROVE / REJECT VERIFICATION ======
    {
      path: 'admin-verifications/review',
      method: 'post',
      handler: async (req: PayloadRequest) => {
        const admin = await _requireAdminAuth(req)
        if (!admin) return Response.json({ success: false, error: 'Unauthorized' }, { status: 403 })
        const db = cloudflare.env.D1 as D1Database
        await _ensureVerificationTables(db)
        const body = await req.json().catch(() => ({})) as any
        const id = Number(body.id || body.verificationId)
        const action = String(body.action || '').toLowerCase()
        const status = action === 'approve' || action === 'approved' || action === 'verified'
          ? 'verified'
          : action === 'reject' || action === 'rejected'
            ? 'rejected'
            : ''
        if (!id || !status) return Response.json({ success: false, error: 'id and action=approve|reject required' }, { status: 400 })
        const row = await db.prepare('SELECT * FROM caregiver_verifications WHERE id = ?').bind(id).first() as any
        if (!row) return Response.json({ success: false, error: 'Verification not found' }, { status: 404 })
        const notes = String(body.notes || body.adminNotes || '')
        const rejectionReason = status === 'rejected' ? String(body.rejectionReason || body.reason || notes || 'Not approved') : null
        await db.prepare(
          `UPDATE caregiver_verifications
           SET status = ?, reviewed_at = datetime('now'), approved_at = CASE WHEN ? = 'verified' THEN datetime('now') ELSE NULL END,
               reviewer_email = ?, rejection_reason = ?, admin_notes = ?
           WHERE id = ?`
        ).bind(status, status, admin.email, rejectionReason, notes, id).run()

        const docType = String(row.doc_type || '')
        if (docType === 'background_check' || docType === 'background_consent') {
          const bgStatus = status === 'verified' ? 'verified' : 'rejected'
          const existingBg = await db.prepare('SELECT caregiver_id FROM caregiver_background_checks WHERE caregiver_id = ?').bind(row.caregiver_id).first() as any
          if (existingBg) {
            await db.prepare(
              `UPDATE caregiver_background_checks
               SET status = ?, completed_at = CASE WHEN ? = 'verified' THEN datetime('now') ELSE completed_at END,
                   reviewed_at = datetime('now'), reviewer_email = ?, notes = ?
               WHERE caregiver_id = ?`
            ).bind(bgStatus, bgStatus, admin.email, notes || rejectionReason || '', row.caregiver_id).run()
          } else {
            await db.prepare(
              `INSERT INTO caregiver_background_checks
               (caregiver_id, status, provider, initiated_at, completed_at, reviewed_at, reviewer_email, notes)
               VALUES (?, ?, 'manual_review', datetime('now'), CASE WHEN ? = 'verified' THEN datetime('now') ELSE NULL END, datetime('now'), ?, ?)`
            ).bind(row.caregiver_id, bgStatus, bgStatus, admin.email, notes || rejectionReason || '').run()
          }
        }

        await db.prepare('INSERT INTO verification_audit_logs (caregiver_id, verification_id, action, actor_email, notes) VALUES (?,?,?,?,?)')
          .bind(row.caregiver_id, id, status, admin.email, notes || rejectionReason || '').run()
        await _refreshCaregiverTrustScore(db, Number(row.caregiver_id))
        const trust = await db.prepare('SELECT * FROM caregiver_trust_scores WHERE caregiver_id = ?').bind(row.caregiver_id).first() as any
        return Response.json({ success: true, id, status, caregiverId: row.caregiver_id, trust })
      },
    },


    // ====== VERIFICATION — STATUS (GET all records for logged-in caregiver) ======
    {
      path: '/verification-status',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const env = cloudflare.env as any
          const url = new URL(req.url)
          const token = url.searchParams.get('token') || ''
          if (!token) return Response.json({ success: false, error: 'token required' }, { status: 400, headers })
          await _ensureVerificationTables(env.D1)
          const sess = await env.D1.prepare('SELECT account_id FROM caregiver_sessions WHERE token = ?').bind(token).first() as any
          if (!sess) return Response.json({ success: false, error: 'Unauthorized' }, { status: 401, headers })
          const cgId = sess.account_id
          const { results: verifications } = await env.D1.prepare(
            'SELECT id, doc_type, status, submitted_at, reviewed_at, approved_at, rejection_reason, admin_notes, file_name, mime_type, consent_given, notes FROM caregiver_verifications WHERE caregiver_id = ? ORDER BY submitted_at DESC'
          ).bind(cgId).all()
          // Also get trust score
          const trust = await env.D1.prepare('SELECT * FROM caregiver_trust_scores WHERE caregiver_id = ?').bind(cgId).first() as any
          // Get background check status
          const bgCheck = await env.D1.prepare('SELECT * FROM caregiver_background_checks WHERE caregiver_id = ?').bind(cgId).first() as any
          return Response.json({ success: true, verifications: verifications || [], trust: trust || null, backgroundCheck: bgCheck || null }, { headers })
        } catch (e: any) {
          return Response.json({ success: false, error: e.message }, { headers })
        }
      },
    },

    // ====== VERIFICATION — UPLOAD DOCUMENT (POST multipart) ======
    {
      path: '/verification-upload',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const env = cloudflare.env as any
          let token: string, docType: string, consentGiven: number, file: File | null, expiry: string
          try {
            const fd = await req.formData()
            token = fd.get('token') || ''
            docType = fd.get('doc_type') || fd.get('cert_type') || 'id_front'
            consentGiven = fd.get('consent_given') === 'true' ? 1 : 0
            expiry = String(fd.get('expiry') || '')
            file = fd.get('file') || null
          } catch {
            const body = await req.json().catch(() => ({})) as any
            token = body.token || ''
            docType = body.doc_type || body.cert_type || 'background_consent'
            consentGiven = body.consent_given ? 1 : 0
            expiry = String(body.expiry || '')
            file = null
          }
          if (!token) return Response.json({ success: false, error: 'token required' }, { status: 400, headers })
          await _ensureVerificationTables(env.D1)
          const sess = await env.D1.prepare('SELECT account_id FROM caregiver_sessions WHERE token = ?').bind(token).first() as any
          if (!sess) return Response.json({ success: false, error: 'Unauthorized' }, { status: 401, headers })
          const cgId = sess.account_id
          let r2Key: string | null = null
          let fileName: string | null = null
          let mimeType: string | null = null
          // Upload file to R2 if provided
          if (file && env.R2) {
            const uuid = crypto.randomUUID()
            fileName = (file as any).name || `doc_${Date.now()}`
            mimeType = (file as any).type || 'application/octet-stream'
            r2Key = `verifications/${cgId}/${uuid}/${fileName}`
            const arrayBuffer = await (file as any).arrayBuffer()
            await env.R2.put(r2Key, arrayBuffer, { httpMetadata: { contentType: mimeType } })
          }
          // Upsert verification record (one per doc_type per caregiver — replace existing pending/rejected)
          const existing = await env.D1.prepare('SELECT id FROM caregiver_verifications WHERE caregiver_id = ? AND doc_type = ? AND status IN (\'pending\', \'rejected\')').bind(cgId, docType).first() as any
          if (existing) {
            await env.D1.prepare(
              'UPDATE caregiver_verifications SET status=\'pending\', r2_key=COALESCE(?,r2_key), file_name=COALESCE(?,file_name), mime_type=COALESCE(?,mime_type), consent_given=?, notes=?, submitted_at=datetime(\'now\'), admin_notes=NULL, rejection_reason=NULL, reviewer_email=NULL, approved_at=NULL WHERE id=?'
            ).bind(r2Key, fileName, mimeType, consentGiven, expiry ? `Expires: ${expiry}` : '', existing.id).run()
            // Audit log
            await env.D1.prepare('INSERT INTO verification_audit_logs (caregiver_id, verification_id, action, notes) VALUES (?,?,?,?)').bind(cgId, existing.id, 'resubmitted', docType).run()
            return Response.json({ success: true, id: existing.id, r2Key, docType, status: 'pending' }, { headers })
          } else {
            const result = await env.D1.prepare(
              'INSERT INTO caregiver_verifications (caregiver_id, doc_type, r2_key, file_name, mime_type, consent_given, status, submitted_at, notes) VALUES (?,?,?,?,?,?,\'pending\',datetime(\'now\'),?)'
            ).bind(cgId, docType, r2Key, fileName, mimeType, consentGiven, expiry ? `Expires: ${expiry}` : '').run() as any
            const newId = result.meta?.last_row_id
            // Audit log
            await env.D1.prepare('INSERT INTO verification_audit_logs (caregiver_id, verification_id, action, notes) VALUES (?,?,?,?)').bind(cgId, newId, 'submitted', docType).run()
            return Response.json({ success: true, id: newId, r2Key, docType, status: 'pending' }, { headers })
          }
        } catch (e: any) {
          return Response.json({ success: false, error: e.message }, { headers })
        }
      },
    },

    // ====== ADMIN DOC VIEW — proxy R2 document for admin (r2Key + adminToken) ======
    {
      path: '/admin-doc-view',
      method: 'get',
      handler: async (req: any) => {
        try {
          const env = cloudflare.env as any
          const url = new URL(req.url)
          const adminToken = url.searchParams.get('adminToken') || ''
          const r2Key = url.searchParams.get('r2Key') || ''
          if (!adminToken || !r2Key) return new Response('Missing params', { status: 400 })
          // Validate admin
          const sess = await env.D1.prepare('SELECT ca.is_admin FROM client_sessions cs JOIN client_accounts ca ON ca.email = cs.email WHERE cs.session_token = ? LIMIT 1').bind(adminToken).first() as any
          if (!sess?.is_admin) return new Response('Unauthorized', { status: 403 })
          // Check key is a verifications/ key (security guard)
          if (!r2Key.startsWith('verifications/')) return new Response('Forbidden', { status: 403 })
          const obj = await env.R2.get(r2Key)
          if (!obj) return new Response('Not found', { status: 404 })
          const contentType = obj.httpMetadata?.contentType || 'application/octet-stream'
          return new Response(obj.body, { headers: { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'private, max-age=900' } })
        } catch (e: any) {
          return new Response(e.message, { status: 500 })
        }
      },
    },

    // ====== CAREGIVER WORK SCHEDULE (from signed hire agreements, read-only) ======
    {
      path: '/caregiver-work-schedule',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const env = cloudflare.env as any
          const url = new URL(req.url)
          const token = url.searchParams.get('token') || ''
          if (!token) return Response.json({ success: false, error: 'token required' }, { status: 400, headers })
          const sess = await env.D1.prepare('SELECT account_id FROM caregiver_sessions WHERE token = ?').bind(token).first() as any
          if (!sess) return Response.json({ success: false, error: 'Unauthorized' }, { status: 401, headers })
          const cgAcc = await env.D1.prepare('SELECT email, name FROM caregiver_accounts WHERE id = ?').bind(sess.account_id).first() as any
          if (!cgAcc) return Response.json({ success: false, error: 'Caregiver not found' }, { status: 404, headers })
          const { results: scheds } = await env.D1.prepare(
            'SELECT cs.*, COALESCE(ca.name, cs.client_email) as client_display_name FROM care_schedules cs LEFT JOIN client_accounts ca ON ca.email = cs.client_email WHERE cs.caregiver_email = ? ORDER BY cs.id DESC'
          ).bind(cgAcc.email).all()
          return Response.json({ success: true, schedules: scheds || [] }, { headers })
        } catch (e: any) {
          return Response.json({ success: false, error: e.message }, { headers })
        }
      },
    },

    // ══════════════════════════════════════════════════════════════════════
    // PHASE 15C: Report a Concern — public endpoint (no auth required)
    // ══════════════════════════════════════════════════════════════════════
    {
      path: '/submit-concern',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const env = cloudflare.env as any
          await env.D1.prepare(`CREATE TABLE IF NOT EXISTS trust_safety_incidents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            reporter_type TEXT DEFAULT 'guest', reporter_user_id TEXT, reporter_name TEXT, reporter_email TEXT,
            related_caregiver_id TEXT, related_client_id TEXT, related_request_id TEXT,
            related_booking_id TEXT, related_shift_id TEXT,
            category TEXT NOT NULL, urgency TEXT DEFAULT 'medium', description TEXT NOT NULL,
            contact_permission INTEGER DEFAULT 0,
            status TEXT DEFAULT 'new', assigned_admin TEXT, internal_notes TEXT, user_facing_note TEXT,
            created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
          )`).run()
          await env.D1.prepare(`CREATE TABLE IF NOT EXISTS trust_safety_audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT, actor_email TEXT, action TEXT,
            target_type TEXT, target_id TEXT, previous_value TEXT, new_value TEXT,
            reason TEXT, ip_address TEXT, created_at TEXT DEFAULT (datetime('now'))
          )`).run()
          const body = await req.json()
          const { reporter_type='guest', reporter_user_id='', reporter_name='', reporter_email='',
                  related_caregiver_id='', related_client_id='', related_request_id='',
                  related_booking_id='', related_shift_id='', category, urgency='medium',
                  description, contact_permission=0 } = body
          if (!category) return Response.json({ error: 'category required' }, { status: 400, headers })
          if (!description || description.trim().length < 10) return Response.json({ error: 'description must be at least 10 characters' }, { status: 400, headers })
          const urgencyNorm = (urgency || 'medium').toLowerCase()
          if (description.trim().length > 3000) return Response.json({ error: 'description too long (max 3000 characters)' }, { status: 400, headers })
          const result = await env.D1.prepare(
            `INSERT INTO trust_safety_incidents (reporter_type,reporter_user_id,reporter_name,reporter_email,related_caregiver_id,related_client_id,related_request_id,related_booking_id,related_shift_id,category,urgency,description,contact_permission)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
          ).bind(reporter_type,reporter_user_id,reporter_name,reporter_email,related_caregiver_id,related_client_id,related_request_id,related_booking_id,related_shift_id,category,urgencyNorm,description.trim(),contact_permission?1:0).run() as any
          const ip = req.headers?.get('CF-Connecting-IP') || 'unknown'
          await env.D1.prepare(`INSERT INTO trust_safety_audit_logs (actor_email,action,target_type,target_id,new_value,ip_address) VALUES (?,?,?,?,?,?)`)
            .bind(reporter_email||'anonymous','incident_submitted','incident',String(result.meta?.last_row_id||''),category,ip).run()
          return Response.json({ success: true, id: result.meta?.last_row_id }, { headers })
        } catch (e: any) { return Response.json({ error: e.message }, { status: 500, headers }) }
      },
    },

    // ══════════════════════════════════════════════════════════════════════
    // PHASE 15D: Admin Incident Queue — list
    // ══════════════════════════════════════════════════════════════════════
    {
      path: '/admin-incidents',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const env = cloudflare.env as any
          const url = new URL(req.url)
          const adminToken = url.searchParams.get('token') || url.searchParams.get('adminToken') || ''
          if (!adminToken) return Response.json({ error: 'Unauthorized' }, { status: 403, headers })
          const sess = await env.D1.prepare('SELECT ca.is_admin FROM client_sessions cs JOIN client_accounts ca ON ca.email = cs.email WHERE cs.session_token = ? LIMIT 1').bind(adminToken).first() as any
          if (!sess?.is_admin) return Response.json({ error: 'Unauthorized' }, { status: 403, headers })
          await env.D1.prepare(`CREATE TABLE IF NOT EXISTS trust_safety_incidents (
            id INTEGER PRIMARY KEY AUTOINCREMENT, reporter_type TEXT DEFAULT 'guest', reporter_user_id TEXT,
            reporter_name TEXT, reporter_email TEXT, related_caregiver_id TEXT, related_client_id TEXT,
            related_request_id TEXT, related_booking_id TEXT, related_shift_id TEXT,
            category TEXT, urgency TEXT DEFAULT 'medium', description TEXT, contact_permission INTEGER DEFAULT 0,
            status TEXT DEFAULT 'new', assigned_admin TEXT, internal_notes TEXT, user_facing_note TEXT,
            created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
          )`).run()
          const filter = url.searchParams.get('filter') || 'all'
          let where = ''
          if (filter === 'new') where = "WHERE status = 'new'"
          else if (filter === 'high') where = "WHERE urgency IN ('high','emergency')"
          else if (filter === 'investigating') where = "WHERE status = 'investigating'"
          else if (filter === 'waiting') where = "WHERE status = 'waiting_on_user'"
          else if (filter === 'closed') where = "WHERE status = 'closed'"
          else if (filter === 'escalated') where = "WHERE status = 'escalated'"
          const { results } = await env.D1.prepare(
            `SELECT id,reporter_type,reporter_name,reporter_email,related_caregiver_id,related_client_id,category,urgency,status,assigned_admin,created_at,updated_at FROM trust_safety_incidents ${where} ORDER BY CASE WHEN LOWER(urgency)='emergency' THEN 0 WHEN LOWER(urgency)='high' THEN 1 ELSE 2 END, created_at DESC LIMIT 200`
          ).all()
          return Response.json({ incidents: results || [] }, { headers })
        } catch (e: any) { return Response.json({ error: e.message }, { status: 500, headers }) }
      },
    },

    // PHASE 15D: Admin Incident — detail
    {
      path: '/admin-incident-detail',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const env = cloudflare.env as any
          const url = new URL(req.url)
          const adminToken = url.searchParams.get('token') || ''
          if (!adminToken) return Response.json({ error: 'Unauthorized' }, { status: 403, headers })
          const sess = await env.D1.prepare('SELECT ca.is_admin, ca.email FROM client_sessions cs JOIN client_accounts ca ON ca.email = cs.email WHERE cs.session_token = ? LIMIT 1').bind(adminToken).first() as any
          if (!sess?.is_admin) return Response.json({ error: 'Unauthorized' }, { status: 403, headers })
          const id = url.searchParams.get('id') || ''
          if (!id) return Response.json({ error: 'id required' }, { status: 400, headers })
          const incident = await env.D1.prepare('SELECT * FROM trust_safety_incidents WHERE id = ?').bind(id).first()
          if (!incident) return Response.json({ error: 'Not found' }, { status: 404, headers })
          try { await env.D1.prepare(`INSERT INTO trust_safety_audit_logs (actor_email,action,target_type,target_id) VALUES (?,?,?,?)`).bind(sess.email,'incident_viewed','incident',id).run() } catch(_) {}
          let auditLogs: any[] = []
          try { const r = await env.D1.prepare('SELECT * FROM trust_safety_audit_logs WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC LIMIT 50').bind('incident',id).all(); auditLogs = r.results || [] } catch(_) {}
          return Response.json({ incident, auditLogs }, { headers })
        } catch (e: any) { return Response.json({ error: e.message }, { status: 500, headers }) }
      },
    },

    // PHASE 15D: Admin Incident — action (update status, notes, assign)
    {
      path: '/admin-incident-action',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const env = cloudflare.env as any
          const url = new URL(req.url)
          const adminToken = url.searchParams.get('token') || ''
          if (!adminToken) return Response.json({ error: 'Unauthorized' }, { status: 403, headers })
          const sess = await env.D1.prepare('SELECT ca.is_admin, ca.email FROM client_sessions cs JOIN client_accounts ca ON ca.email = cs.email WHERE cs.session_token = ? LIMIT 1').bind(adminToken).first() as any
          if (!sess?.is_admin) return Response.json({ error: 'Unauthorized' }, { status: 403, headers })
          const { id, action, new_status, internal_notes, user_facing_note, assigned_admin, reason } = await req.json()
          if (!id) return Response.json({ error: 'id required' }, { status: 400, headers })
          const prev = await env.D1.prepare('SELECT status FROM trust_safety_incidents WHERE id = ?').bind(id).first() as any
          if (!prev) return Response.json({ error: 'Incident not found' }, { status: 404, headers })
          const updates: string[] = ["updated_at = datetime('now')"]
          const binds: any[] = []
          if (new_status) { updates.push('status = ?'); binds.push(new_status) }
          if (internal_notes !== undefined) { updates.push('internal_notes = ?'); binds.push(internal_notes) }
          if (user_facing_note !== undefined) { updates.push('user_facing_note = ?'); binds.push(user_facing_note) }
          if (assigned_admin !== undefined) { updates.push('assigned_admin = ?'); binds.push(assigned_admin) }
          binds.push(id)
          await env.D1.prepare(`UPDATE trust_safety_incidents SET ${updates.join(', ')} WHERE id = ?`).bind(...binds).run()
          const auditAction = action || (new_status ? 'incident_status_changed' : internal_notes !== undefined ? 'incident_note_added' : 'incident_updated')
          try { await env.D1.prepare(`INSERT INTO trust_safety_audit_logs (actor_email,action,target_type,target_id,previous_value,new_value,reason) VALUES (?,?,?,?,?,?,?)`).bind(sess.email,auditAction,'incident',String(id),prev.status||'',new_status||'',reason||'').run() } catch(_) {}
          return Response.json({ success: true }, { headers })
        } catch (e: any) { return Response.json({ error: e.message }, { status: 500, headers }) }
      },
    },

    // ══════════════════════════════════════════════════════════════════════
    // PHASE 15E: Admin — Get/Set user safety status
    // ══════════════════════════════════════════════════════════════════════
    {
      path: '/admin-safety-status',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const env = cloudflare.env as any
          const url = new URL(req.url)
          const adminToken = url.searchParams.get('token') || ''
          if (!adminToken) return Response.json({ error: 'Unauthorized' }, { status: 403, headers })
          const sess = await env.D1.prepare('SELECT ca.is_admin FROM client_sessions cs JOIN client_accounts ca ON ca.email = cs.email WHERE cs.session_token = ? LIMIT 1').bind(adminToken).first() as any
          if (!sess?.is_admin) return Response.json({ error: 'Unauthorized' }, { status: 403, headers })
          await env.D1.prepare(`CREATE TABLE IF NOT EXISTS user_safety_status (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, user_type TEXT NOT NULL, status TEXT DEFAULT 'active', reason TEXT, updated_by TEXT, updated_at TEXT DEFAULT (datetime('now')), UNIQUE(user_id,user_type))`).run()
          const userType = url.searchParams.get('user_type') || ''
          const userId = url.searchParams.get('user_id') || ''
          if (!userType || !userId) return Response.json({ error: 'user_type and user_id required' }, { status: 400, headers })
          const row = await env.D1.prepare('SELECT * FROM user_safety_status WHERE user_id = ? AND user_type = ?').bind(userId,userType).first()
          return Response.json({ status: row || { user_id: userId, user_type: userType, status: 'active' } }, { headers })
        } catch (e: any) { return Response.json({ error: e.message }, { status: 500, headers }) }
      },
    },
    {
      path: '/admin-safety-status',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const env = cloudflare.env as any
          const url = new URL(req.url)
          const adminToken = url.searchParams.get('token') || ''
          if (!adminToken) return Response.json({ error: 'Unauthorized' }, { status: 403, headers })
          const sess = await env.D1.prepare('SELECT ca.is_admin, ca.email FROM client_sessions cs JOIN client_accounts ca ON ca.email = cs.email WHERE cs.session_token = ? LIMIT 1').bind(adminToken).first() as any
          if (!sess?.is_admin) return Response.json({ error: 'Unauthorized' }, { status: 403, headers })
          const { user_id, user_type, status, reason } = await req.json()
          if (!user_id || !user_type || !status) return Response.json({ error: 'user_id, user_type, status required' }, { status: 400, headers })
          const validStatuses = ['active','under_review','limited','suspended','blocked','deactivated']
          if (!validStatuses.includes(status)) return Response.json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` }, { status: 400, headers })
          await env.D1.prepare(`CREATE TABLE IF NOT EXISTS user_safety_status (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, user_type TEXT NOT NULL, status TEXT DEFAULT 'active', reason TEXT, updated_by TEXT, updated_at TEXT DEFAULT (datetime('now')), UNIQUE(user_id,user_type))`).run()
          const prev = await env.D1.prepare('SELECT status FROM user_safety_status WHERE user_id = ? AND user_type = ?').bind(user_id,user_type).first() as any
          await env.D1.prepare(`INSERT INTO user_safety_status (user_id,user_type,status,reason,updated_by,updated_at) VALUES (?,?,?,?,?,datetime('now')) ON CONFLICT(user_id,user_type) DO UPDATE SET status=excluded.status,reason=excluded.reason,updated_by=excluded.updated_by,updated_at=excluded.updated_at`).bind(user_id,user_type,status,reason||'',sess.email).run()
          if (user_type === 'caregiver') {
            try { await env.D1.prepare("ALTER TABLE caregiver_accounts ADD COLUMN safety_status TEXT DEFAULT 'active'").run() } catch(_) {}
            await env.D1.prepare('UPDATE caregiver_accounts SET safety_status = ? WHERE id = ?').bind(status,user_id).run()
          }
          if (user_type === 'client') {
            try { await env.D1.prepare("ALTER TABLE client_accounts ADD COLUMN safety_status TEXT DEFAULT 'active'").run() } catch(_) {}
            await env.D1.prepare('UPDATE client_accounts SET safety_status = ? WHERE id = ?').bind(status,user_id).run()
          }
          try { await env.D1.prepare(`INSERT OR IGNORE INTO trust_safety_audit_logs (actor_email,action,target_type,target_id,previous_value,new_value,reason) VALUES (?,?,?,?,?,?,?)`).bind(sess.email,`${user_type}_status_changed`,user_type,String(user_id),prev?.status||'active',status,reason||'').run() } catch(_) {}
          return Response.json({ success: true }, { headers })
        } catch (e: any) { return Response.json({ error: e.message }, { status: 500, headers }) }
      },
    },

    // ══════════════════════════════════════════════════════════════════════
    // PHASE 15F: Policy Acceptance — record and retrieve
    // ══════════════════════════════════════════════════════════════════════
    {
      path: '/policy-accept',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const env = cloudflare.env as any
          await env.D1.prepare(`CREATE TABLE IF NOT EXISTS policy_acceptance (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, user_type TEXT NOT NULL, policy_type TEXT NOT NULL, version TEXT DEFAULT '1.0', accepted_at TEXT DEFAULT (datetime('now')), ip_address TEXT, user_agent TEXT)`).run()
          const { user_id, user_type, policy_type, version='1.0' } = await req.json()
          if (!user_id || !user_type || !policy_type) return Response.json({ error: 'user_id, user_type, policy_type required' }, { status: 400, headers })
          const ip = req.headers?.get('CF-Connecting-IP') || 'unknown'
          const ua = req.headers?.get('User-Agent') || ''
          await env.D1.prepare('INSERT INTO policy_acceptance (user_id,user_type,policy_type,version,ip_address,user_agent) VALUES (?,?,?,?,?,?)').bind(user_id,user_type,policy_type,version,ip,ua).run()
          return Response.json({ success: true }, { headers })
        } catch (e: any) { return Response.json({ error: e.message }, { status: 500, headers }) }
      },
    },
    {
      path: '/policy-accept',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const env = cloudflare.env as any
          const url = new URL(req.url)
          const user_id = url.searchParams.get('user_id') || ''
          const user_type = url.searchParams.get('user_type') || ''
          if (!user_id || !user_type) return Response.json({ error: 'user_id and user_type required' }, { status: 400, headers })
          try {
            const { results } = await env.D1.prepare('SELECT policy_type,version,accepted_at FROM policy_acceptance WHERE user_id = ? AND user_type = ? ORDER BY accepted_at DESC').bind(user_id,user_type).all()
            return Response.json({ acceptances: results || [] }, { headers })
          } catch(_) { return Response.json({ acceptances: [] }, { headers }) }
        } catch (e: any) { return Response.json({ error: e.message }, { status: 500, headers }) }
      },
    },


    // ══════════════════════════════════════════════════════════════════════
    // PHASE 21A: SUBSCRIPTION PLAN MANAGEMENT
    // ══════════════════════════════════════════════════════════════════════

    // Public endpoint — portals fetch active/public plans (no auth)
    {
      path: '/public-plans',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const db = (cloudflare.env as any).D1 as D1Database
          const url = new URL(req.url)
          const audience = url.searchParams.get('audience') || ''

          // Ensure table exists
          await db.prepare(`CREATE TABLE IF NOT EXISTS subscription_plans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            audience TEXT NOT NULL DEFAULT 'client',
            name TEXT NOT NULL,
            slug TEXT NOT NULL,
            description TEXT,
            short_description TEXT,
            price_cents INTEGER NOT NULL DEFAULT 0,
            currency TEXT NOT NULL DEFAULT 'USD',
            billing_interval TEXT NOT NULL DEFAULT 'monthly',
            trial_days INTEGER DEFAULT 0,
            is_active INTEGER NOT NULL DEFAULT 1,
            is_public INTEGER NOT NULL DEFAULT 1,
            sort_order INTEGER DEFAULT 0,
            features_json TEXT DEFAULT '[]',
            limits_json TEXT DEFAULT '{}',
            stripe_price_id TEXT,
            stripe_product_id TEXT,
            checkout_mode TEXT DEFAULT 'subscription',
            cta_label TEXT DEFAULT 'Choose Plan',
            highlight_label TEXT,
            is_recommended INTEGER DEFAULT 0,
            effective_from TEXT,
            effective_to TEXT,
            created_by TEXT,
            updated_by TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            archived_at TEXT,
            UNIQUE(slug)
          )`).run()

          // Seed default plans if table is empty
          const countRow = await db.prepare('SELECT COUNT(*) as cnt FROM subscription_plans').first() as any
          if (!countRow || Number(countRow.cnt) === 0) {
            const seeds = [
              { audience: 'client', name: 'Essential', slug: 'essential', short_description: 'Perfect for getting started', price_cents: 1500, stripe_price_id: 'price_1TQhO56E8zcVOY4tJyqfoiwi', is_recommended: 0, sort_order: 1, features_json: JSON.stringify(['5 contact unlocks/month','Priority caregiver matching','Interview scheduling','Email support']), cta_label: 'Choose Essential', highlight_label: null, billing_interval: 'monthly' },
              { audience: 'client', name: 'Family', slug: 'family', short_description: 'Best for families with ongoing care needs', price_cents: 2900, stripe_price_id: 'price_1TQhO56E8zcVOY4t4q1gjG7a', is_recommended: 1, sort_order: 2, features_json: JSON.stringify(['Unlimited contact unlocks','2 active caregivers','Family coordination tools','Chat support','Care schedule tracking']), cta_label: 'Choose Family', highlight_label: 'Most Popular', billing_interval: 'monthly' },
              { audience: 'client', name: 'Premium', slug: 'premium', short_description: 'Full-service care coordination', price_cents: 5900, stripe_price_id: 'price_1TQhO66E8zcVOY4tmYqFthdT', is_recommended: 0, sort_order: 3, features_json: JSON.stringify(['Everything in Family','Dedicated care coordinator','24/7 phone support','Background check priority','Personalized care plan']), cta_label: 'Choose Premium', highlight_label: 'Best for Families', billing_interval: 'monthly' },
              { audience: 'caregiver', name: 'Pay-per-Lead', slug: 'pay-per-lead', short_description: 'Unlock individual care requests', price_cents: 499, stripe_price_id: 'price_1TQmae6E8zcVOY4tSunkjW89', is_recommended: 0, sort_order: 1, features_json: JSON.stringify(['Single request unlock','View client contact info','Pay only when needed']), cta_label: 'Unlock $4.99', highlight_label: null, billing_interval: 'one_time' },
              { audience: 'caregiver', name: 'Unlimited', slug: 'caregiver-unlimited', short_description: 'Unlimited access to all care requests', price_cents: 1999, stripe_price_id: 'price_1TQmcY6E8zcVOY4tSOJ9E3X2', is_recommended: 1, sort_order: 2, features_json: JSON.stringify(['Unlimited request unlocks','Priority profile placement','All client contact info','Trust Passport visibility']), cta_label: 'Go Unlimited $19.99/mo', highlight_label: 'Best Value', billing_interval: 'monthly' },
            ]
            for (const s of seeds) {
              try {
                await db.prepare(`INSERT OR IGNORE INTO subscription_plans (audience,name,slug,short_description,price_cents,stripe_price_id,is_recommended,sort_order,features_json,cta_label,highlight_label,billing_interval,is_active,is_public) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,1)`).bind(s.audience,s.name,s.slug,s.short_description,s.price_cents,s.stripe_price_id,s.is_recommended,s.sort_order,s.features_json,s.cta_label,s.highlight_label||null,s.billing_interval).run()
              } catch(_) {}
            }
          }

          let query = `SELECT * FROM subscription_plans WHERE is_active = 1 AND is_public = 1 AND archived_at IS NULL`
          const binds: any[] = []
          if (audience && ['client','caregiver'].includes(audience)) {
            query += ` AND (audience = ? OR audience = 'both')`
            binds.push(audience)
          }
          query += ` AND (effective_from IS NULL OR effective_from <= datetime('now'))`
          query += ` AND (effective_to IS NULL OR effective_to >= datetime('now'))`
          query += ` ORDER BY sort_order ASC, price_cents ASC, created_at ASC`

          const { results } = binds.length ? await db.prepare(query).bind(...binds).all() : await db.prepare(query).all()
          const plans = (results || []).map((p: any) => ({
            id: p.id,
            audience: p.audience,
            name: p.name,
            slug: p.slug,
            description: p.description || '',
            shortDescription: p.short_description || '',
            priceCents: p.price_cents,
            currency: p.currency || 'USD',
            billingInterval: p.billing_interval || 'monthly',
            trialDays: p.trial_days || 0,
            features: (() => { try { return JSON.parse(p.features_json || '[]') } catch { return [] } })(),
            limits: (() => { try { return JSON.parse(p.limits_json || '{}') } catch { return {} } })(),
            stripePriceId: p.stripe_price_id || null,
            ctaLabel: p.cta_label || 'Choose Plan',
            highlightLabel: p.highlight_label || null,
            isRecommended: !!p.is_recommended,
            sortOrder: p.sort_order || 0,
          }))
          return Response.json({ plans }, { headers })
        } catch (e: any) {
          return Response.json({ plans: [], error: e.message }, { headers })
        }
      },
    },

    // Admin: list all plans
    {
      path: '/admin-plans',
      method: 'get',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const db = (cloudflare.env as any).D1 as D1Database
          const url = new URL(req.url)
          const token = url.searchParams.get('token') || ''
          if (!token) return Response.json({ error: 'token required' }, { status: 401, headers })
          const sess = await db.prepare('SELECT ca.is_admin, ca.email FROM client_sessions cs JOIN client_accounts ca ON ca.email = cs.email WHERE cs.session_token = ? LIMIT 1').bind(token).first() as any
          if (!sess?.is_admin) return Response.json({ error: 'Unauthorized' }, { status: 403, headers })

          await db.prepare(`CREATE TABLE IF NOT EXISTS subscription_plans (id INTEGER PRIMARY KEY AUTOINCREMENT, audience TEXT NOT NULL DEFAULT 'client', name TEXT NOT NULL, slug TEXT NOT NULL, description TEXT, short_description TEXT, price_cents INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD', billing_interval TEXT NOT NULL DEFAULT 'monthly', trial_days INTEGER DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1, is_public INTEGER NOT NULL DEFAULT 1, sort_order INTEGER DEFAULT 0, features_json TEXT DEFAULT '[]', limits_json TEXT DEFAULT '{}', stripe_price_id TEXT, stripe_product_id TEXT, checkout_mode TEXT DEFAULT 'subscription', cta_label TEXT DEFAULT 'Choose Plan', highlight_label TEXT, is_recommended INTEGER DEFAULT 0, effective_from TEXT, effective_to TEXT, created_by TEXT, updated_by TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), archived_at TEXT, UNIQUE(slug))`).run()

          const audience = url.searchParams.get('audience') || ''
          const { results } = audience
            ? await db.prepare('SELECT * FROM subscription_plans WHERE audience = ? ORDER BY audience ASC, sort_order ASC, price_cents ASC').bind(audience).all()
            : await db.prepare('SELECT * FROM subscription_plans ORDER BY audience ASC, sort_order ASC, price_cents ASC').all()
          return Response.json({ plans: results || [] }, { headers })
        } catch (e: any) {
          return Response.json({ plans: [], error: e.message }, { headers })
        }
      },
    },

    // Admin: create plan
    {
      path: '/admin-plans',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const db = (cloudflare.env as any).D1 as D1Database
          const body = await req.json()
          const { token, audience, name, slug, description='', short_description='', price_cents=0, currency='USD', billing_interval='monthly', trial_days=0, is_active=1, is_public=1, sort_order=0, features_json='[]', limits_json='{}', stripe_price_id='', stripe_product_id='', checkout_mode='subscription', cta_label='Choose Plan', highlight_label='', is_recommended=0, effective_from=null, effective_to=null } = body
          if (!token) return Response.json({ error: 'token required' }, { status: 401, headers })
          const sess = await db.prepare('SELECT ca.is_admin, ca.email FROM client_sessions cs JOIN client_accounts ca ON ca.email = cs.email WHERE cs.session_token = ? LIMIT 1').bind(token).first() as any
          if (!sess?.is_admin) return Response.json({ error: 'Unauthorized' }, { status: 403, headers })
          if (!audience || !name || !slug) return Response.json({ error: 'audience, name, slug required' }, { status: 400, headers })

          await db.prepare(`INSERT INTO subscription_plans (audience,name,slug,description,short_description,price_cents,currency,billing_interval,trial_days,is_active,is_public,sort_order,features_json,limits_json,stripe_price_id,stripe_product_id,checkout_mode,cta_label,highlight_label,is_recommended,effective_from,effective_to,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(audience,name,slug,description,short_description,Number(price_cents),currency,billing_interval,Number(trial_days),is_active?1:0,is_public?1:0,Number(sort_order),features_json,limits_json,stripe_price_id||null,stripe_product_id||null,checkout_mode,cta_label,highlight_label||null,is_recommended?1:0,effective_from||null,effective_to||null,sess.email).run()

          try { await db.prepare(`INSERT OR IGNORE INTO trust_safety_audit_logs (actor_email,action,target_type,target_id,new_value) VALUES (?,?,?,?,?)`).bind(sess.email,'subscription_plan_created','subscription_plan',slug,JSON.stringify({name,audience,price_cents})).run() } catch(_) {}
          return Response.json({ success: true }, { headers })
        } catch (e: any) {
          return Response.json({ error: e.message }, { status: 500, headers })
        }
      },
    },

    // Admin: update plan
    {
      path: '/admin-plans',
      method: 'put',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
        try {
          const db = (cloudflare.env as any).D1 as D1Database
          const body = await req.json()
          const { token, id, audience, name, slug, description, short_description, price_cents, currency, billing_interval, trial_days, is_active, is_public, sort_order, features_json, limits_json, stripe_price_id, stripe_product_id, checkout_mode, cta_label, highlight_label, is_recommended, effective_from, effective_to, archived_at } = body
          if (!token) return Response.json({ error: 'token required' }, { status: 401, headers })
          if (!id) return Response.json({ error: 'id required' }, { status: 400, headers })
          const sess = await db.prepare('SELECT ca.is_admin, ca.email FROM client_sessions cs JOIN client_accounts ca ON ca.email = cs.email WHERE cs.session_token = ? LIMIT 1').bind(token).first() as any
          if (!sess?.is_admin) return Response.json({ error: 'Unauthorized' }, { status: 403, headers })

          const existing = await db.prepare('SELECT * FROM subscription_plans WHERE id = ?').bind(Number(id)).first() as any
          if (!existing) return Response.json({ error: 'Plan not found' }, { status: 404, headers })

          const upd = {
            audience: audience ?? existing.audience,
            name: name ?? existing.name,
            slug: slug ?? existing.slug,
            description: description ?? existing.description ?? '',
            short_description: short_description ?? existing.short_description ?? '',
            price_cents: price_cents !== undefined ? Number(price_cents) : Number(existing.price_cents),
            currency: currency ?? existing.currency ?? 'USD',
            billing_interval: billing_interval ?? existing.billing_interval ?? 'monthly',
            trial_days: trial_days !== undefined ? Number(trial_days) : Number(existing.trial_days ?? 0),
            is_active: is_active !== undefined ? (is_active ? 1 : 0) : existing.is_active,
            is_public: is_public !== undefined ? (is_public ? 1 : 0) : existing.is_public,
            sort_order: sort_order !== undefined ? Number(sort_order) : Number(existing.sort_order ?? 0),
            features_json: features_json ?? existing.features_json ?? '[]',
            limits_json: limits_json ?? existing.limits_json ?? '{}',
            stripe_price_id: stripe_price_id !== undefined ? (stripe_price_id || null) : existing.stripe_price_id,
            stripe_product_id: stripe_product_id !== undefined ? (stripe_product_id || null) : existing.stripe_product_id,
            checkout_mode: checkout_mode ?? existing.checkout_mode ?? 'subscription',
            cta_label: cta_label ?? existing.cta_label ?? 'Choose Plan',
            highlight_label: highlight_label !== undefined ? (highlight_label || null) : existing.highlight_label,
            is_recommended: is_recommended !== undefined ? (is_recommended ? 1 : 0) : existing.is_recommended,
            effective_from: effective_from !== undefined ? (effective_from || null) : existing.effective_from,
            effective_to: effective_to !== undefined ? (effective_to || null) : existing.effective_to,
            archived_at: archived_at !== undefined ? (archived_at || null) : existing.archived_at,
          }

          await db.prepare(`UPDATE subscription_plans SET audience=?,name=?,slug=?,description=?,short_description=?,price_cents=?,currency=?,billing_interval=?,trial_days=?,is_active=?,is_public=?,sort_order=?,features_json=?,limits_json=?,stripe_price_id=?,stripe_product_id=?,checkout_mode=?,cta_label=?,highlight_label=?,is_recommended=?,effective_from=?,effective_to=?,archived_at=?,updated_by=?,updated_at=datetime('now') WHERE id=?`).bind(upd.audience,upd.name,upd.slug,upd.description,upd.short_description,upd.price_cents,upd.currency,upd.billing_interval,upd.trial_days,upd.is_active,upd.is_public,upd.sort_order,upd.features_json,upd.limits_json,upd.stripe_price_id,upd.stripe_product_id,upd.checkout_mode,upd.cta_label,upd.highlight_label,upd.is_recommended,upd.effective_from,upd.effective_to,upd.archived_at,sess.email,Number(id)).run()

          if (upd.price_cents !== Number(existing.price_cents)) {
            try { await db.prepare(`INSERT OR IGNORE INTO trust_safety_audit_logs (actor_email,action,target_type,target_id,previous_value,new_value) VALUES (?,?,?,?,?,?)`).bind(sess.email,'subscription_plan_price_changed','subscription_plan',String(id),String(existing.price_cents),String(upd.price_cents)).run() } catch(_) {}
          }
          try { await db.prepare(`INSERT OR IGNORE INTO trust_safety_audit_logs (actor_email,action,target_type,target_id,new_value) VALUES (?,?,?,?,?)`).bind(sess.email,'subscription_plan_updated','subscription_plan',String(id),JSON.stringify({name:upd.name,price_cents:upd.price_cents})).run() } catch(_) {}

          return Response.json({ success: true }, { headers })
        } catch (e: any) {
          return Response.json({ error: e.message }, { status: 500, headers })
        }
      },
    },


    // ══════════════════════════════════════════════════════════════════════
    // PHASE 21A: Admin Kai — Read-Only AI Copilot
    // POST /api/admin-kai  { token, prompt, pageContext }
    // ══════════════════════════════════════════════════════════════════════
    {
      path: '/admin-kai',
      method: 'post',
      handler: async (req: any) => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
        try {
          const env = cloudflare.env as any;
          const body = await req.json();
          const token = (body.token || '').trim();
          if (!token) return Response.json({ error: 'Unauthorized' }, { status: 403, headers });
          // Phase 22B: page-aware item context
          const itemType = (body.itemType || '').trim();
          const itemId   = (body.itemId   || '').trim();

          // Auth check
          const sess = await env.D1.prepare(
            'SELECT ca.is_admin, ca.email, ca.name FROM client_sessions cs JOIN client_accounts ca ON ca.email = cs.email WHERE cs.session_token = ? LIMIT 1'
          ).bind(token).first() as any;
          if (!sess?.is_admin) return Response.json({ error: 'Unauthorized' }, { status: 403, headers });

          // Get admin role from admin_users
          let role = 'super_admin';
          try {
            const au = await env.D1.prepare('SELECT role FROM admin_users WHERE email = ? LIMIT 1').bind(sess.email).first() as any;
            if (au?.role) role = au.role;
          } catch(_) {}

          const prompt = (body.prompt || '').slice(0, 600).trim();
          const pageContext = (body.pageContext || '').slice(0, 300);
          if (!prompt) return Response.json({ error: 'prompt required' }, { status: 400, headers });

          // RBAC scope map
          const ROLE_SCOPES: Record<string, string[]> = {
            super_admin:           ['incidents','product_logs','trust','caregivers','clients','subscriptions','safety'],
            admin_manager:         ['incidents','product_logs','caregivers','clients','trust'],
            verification_reviewer: ['trust','caregivers'],
            support_agent:         ['caregivers','clients','incidents'],
            finance_admin:         ['subscriptions','clients'],
            read_only_auditor:     ['product_logs','caregivers','clients'],
          };
          const allowedScopes = ROLE_SCOPES[role] ?? ROLE_SCOPES['read_only_auditor'];

          const contextParts: string[] = [];
          const sourceAreasUsed: string[] = [];
          // Phase 22B: hold raw rows for action generation
          let _kaiIncidents: any[] = [], _kaiPlogs: any[] = [], _kaiCaregivers: any[] = [];
          let _kaiPlans: any[] = [], _kaiPlanIssues: string[] = [], _kaiSafetyRows: any[] = [];

          // ── Incidents ─────────────────────────────────────────────────
          if (allowedScopes.includes('incidents')) {
            try {
              await env.D1.prepare(`CREATE TABLE IF NOT EXISTS trust_safety_incidents (
                id INTEGER PRIMARY KEY AUTOINCREMENT, reporter_type TEXT DEFAULT 'guest',
                reporter_name TEXT, reporter_email TEXT, related_caregiver_id TEXT,
                related_client_id TEXT, category TEXT, urgency TEXT DEFAULT 'medium',
                description TEXT, status TEXT DEFAULT 'new', assigned_admin TEXT,
                internal_notes TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
              )`).run();
              const { results: incidents } = await env.D1.prepare(
                `SELECT id, category, urgency, status, assigned_admin, created_at FROM trust_safety_incidents
                 ORDER BY CASE WHEN LOWER(urgency)='emergency' THEN 0 WHEN LOWER(urgency)='high' THEN 1 ELSE 2 END, created_at DESC LIMIT 20`
              ).all();
              if (incidents?.length) {
                _kaiIncidents = incidents as any[];
                sourceAreasUsed.push('Incidents');
                contextParts.push(`INCIDENTS (recent ${incidents.length}):\n` + (incidents as any[]).map(i =>
                  `- [#${i.id}] ${i.category||'Unknown'} | urgency:${i.urgency} | status:${i.status} | assigned:${i.assigned_admin||'unassigned'} | ${i.created_at}`
                ).join('\n'));
              } else {
                contextParts.push('INCIDENTS: No incidents on record.');
              }
            } catch(_) {}
          }

          // ── Product Logs ───────────────────────────────────────────────
          if (allowedScopes.includes('product_logs')) {
            try {
              const { results: plogs } = await env.D1.prepare(
                `SELECT title, type, priority, status, app_area, phase, updated_at FROM product_logs
                 WHERE status NOT IN ('Closed','Verified')
                 ORDER BY CASE WHEN priority='Critical' THEN 0 WHEN priority='High' THEN 1 WHEN priority='Medium' THEN 2 ELSE 3 END LIMIT 20`
              ).all();
              if (plogs?.length) {
                _kaiPlogs = plogs as any[];
                sourceAreasUsed.push('Product Logs');
                contextParts.push(`OPEN PRODUCT LOGS (${plogs.length}):\n` + (plogs as any[]).map(p =>
                  `- [${p.priority}] ${p.title} | ${p.type} | ${p.status} | area:${p.app_area||'—'} | phase:${p.phase||'—'}`
                ).join('\n'));
              } else {
                contextParts.push('PRODUCT LOGS: No open logs found.');
              }
            } catch(_) { contextParts.push('PRODUCT LOGS: Data not available.'); }
          }

          // ── Caregivers + Trust ─────────────────────────────────────────
          if (allowedScopes.includes('caregivers') || allowedScopes.includes('trust')) {
            try {
              const { results: cgs } = await env.D1.prepare(
                `SELECT ca.id, ca.name, ca.city, ca.state, ca.created_at, ca.safety_status,
                        cts.score, cts.level, cts.id_verified, cts.background_checked, cts.cpr_certified, cts.updated_at as trust_updated
                 FROM caregiver_accounts ca
                 LEFT JOIN caregiver_trust_scores cts ON cts.caregiver_id = ca.id
                 ORDER BY ca.created_at DESC LIMIT 50`
              ).all();
              if (cgs?.length) {
                _kaiCaregivers = cgs as any[];
                sourceAreasUsed.push('Caregivers');
                const total = cgs.length;
                const suspended = (cgs as any[]).filter(c => c.safety_status && c.safety_status !== 'active').length;
                const needsTrust = (cgs as any[]).filter(c => !c.score || (c.score as number) < 40).length;
                contextParts.push(`CAREGIVERS: ${total} total | ${suspended} non-active safety status | ${needsTrust} with low/no trust score`);
                if (allowedScopes.includes('trust')) {
                  sourceAreasUsed.push('Trust Review');
                  const needsReview = (cgs as any[]).filter(c => !c.id_verified || !c.background_checked).slice(0, 10);
                  if (needsReview.length) {
                    contextParts.push(`TRUST REVIEW NEEDED (${needsReview.length} caregivers):\n` + needsReview.map((c: any) =>
                      `- [ID:${c.id}] ${c.name||'Unknown'} | score:${c.score||0} | level:${c.level||'Getting Started'} | id_verified:${c.id_verified?'yes':'no'} | bg_checked:${c.background_checked?'yes':'no'}`
                    ).join('\n'));
                  }
                  // Proof documents summary (safe - no URLs or content)
                  try {
                    const { results: proofDocs } = await env.D1.prepare(
                      `SELECT status, COUNT(*) as cnt FROM caregiver_documents GROUP BY status`
                    ).all();
                    if (proofDocs?.length) {
                      const docSummary = (proofDocs as any[]).map(d => `${d.status||'unknown'}:${d.cnt}`).join(', ');
                      contextParts.push(`PROOF DOCUMENTS: ${docSummary}`);
                      sourceAreasUsed.push('Documents');
                    }
                  } catch(_) {}
                }
              }
            } catch(_) {}
          }

          // ── Clients ────────────────────────────────────────────────────
          if (allowedScopes.includes('clients')) {
            try {
              const clientCount = await env.D1.prepare('SELECT COUNT(*) as total FROM client_accounts').first() as any;
              sourceAreasUsed.push('Clients');
              contextParts.push(`CLIENTS: ${clientCount?.total || 0} total registered`);
            } catch(_) {}
          }

          // ── Subscriptions ──────────────────────────────────────────────
          if (allowedScopes.includes('subscriptions')) {
            try {
              const { results: subs } = await env.D1.prepare(
                "SELECT plan, COUNT(*) as cnt FROM client_subscriptions WHERE status='active' GROUP BY plan"
              ).all();
              const { results: cgSubs } = await env.D1.prepare(
                "SELECT plan, COUNT(*) as cnt FROM caregiver_subscriptions WHERE status='active' GROUP BY plan"
              ).all();
              sourceAreasUsed.push('Subscriptions');
              const subSummary = (subs as any[]).map(s => `${s.plan}:${s.cnt}`).join(', ') || 'none';
              const cgSubSummary = (cgSubs as any[]).map(s => `${s.plan}:${s.cnt}`).join(', ') || 'none';
              contextParts.push(`SUBSCRIPTIONS — Client active plans: ${subSummary}\nCaregiver active plans: ${cgSubSummary}`);

              // ── Subscription plan health check (from admin-managed plan table) ──
              try {
                const { results: plans } = await env.D1.prepare(
                  `SELECT id, name, slug, audience, price, stripe_price_id, is_active, is_public, is_recommended,
                          (SELECT COUNT(*) FROM json_each(features) LIMIT 1) as has_features
                   FROM subscription_plans ORDER BY audience, price`
                ).all();
                if (plans?.length) {
                  sourceAreasUsed.push('Plan Health');
                  const issues: string[] = [];
                  _kaiPlans = plans as any[];
                  for (const p of plans as any[]) {
                    if (!p.stripe_price_id && p.price > 0) issues.push(`[${p.audience}] "${p.name}" (${p.slug}) — missing Stripe Price ID`);
                    if (p.is_recommended && !p.is_active) issues.push(`[${p.audience}] "${p.name}" — marked recommended but inactive`);
                    if (!p.is_public && p.is_active) issues.push(`[${p.audience}] "${p.name}" — active but hidden from public`);
                    if (p.price === 0 && p.slug !== 'free' && p.slug !== 'free-client' && p.slug !== 'caregiver-free') {
                      issues.push(`[${p.audience}] "${p.name}" — price is 0 but slug is not a free tier`);
                    }
                  }
                  _kaiPlanIssues = issues;
                  const totalPlans = plans.length;
                  const activePlans = (plans as any[]).filter(p => p.is_active && p.is_public).length;
                  if (issues.length) {
                    contextParts.push(`SUBSCRIPTION PLAN HEALTH (${totalPlans} plans, ${activePlans} active+public):\nISSUES FOUND:\n` + issues.map(i => `- ${i}`).join('\n'));
                  } else {
                    contextParts.push(`SUBSCRIPTION PLAN HEALTH: ${totalPlans} plans, ${activePlans} active+public. No issues detected.`);
                  }
                }
              } catch(_) {}
            } catch(_) {}
          }

          // ── Safety Status ──────────────────────────────────────────────
          if (allowedScopes.includes('safety')) {
            try {
              const { results: safetyRows } = await env.D1.prepare(
                "SELECT user_type, status, COUNT(*) as cnt FROM user_safety_status WHERE status != 'active' GROUP BY user_type, status"
              ).all();
              if (safetyRows?.length) {
                _kaiSafetyRows = safetyRows as any[];
                sourceAreasUsed.push('Safety Status');
                contextParts.push('NON-ACTIVE SAFETY STATUSES:\n' + (safetyRows as any[]).map(r =>
                  `- ${r.user_type} ${r.status}: ${r.cnt}`
                ).join('\n'));
              }
            } catch(_) {}
          }

          // ── Build system prompt ────────────────────────────────────────
          const systemPrompt = `You are Kai, the Carehia Admin Copilot — an intelligent assistant for the Carehia home care marketplace.
Your job: help admins understand platform operations AND recommend safe next actions they should take manually.
You SUGGEST actions — you never execute them. If asked to perform an action directly, say: "I can suggest the next step and prepare the details, but I cannot perform admin actions automatically. Please review and confirm using the admin controls."
You MUST NOT reveal: SSNs, ITINs, DOB, exact addresses, background report details, payment card info, or private internal admin notes.
You MUST NOT invent or guess data. If unavailable: say "I do not have that data available yet."
If results are empty: say "No matching items found." If item is resolved: say "This item appears resolved. No action recommended."
Be concise, professional, and action-oriented. Use bullet points for lists.
When asked "What should I review next?" or "What should I do next?" rank by: (1) emergency/high urgency incidents, (2) safety status under_review, (3) Trust Passport proof submissions needing review, (4) Critical/High Product Logs not yet closed, (5) subscription plan issues, (6) other QA items.
When asked about subscription plan issues, check SUBSCRIPTION PLAN HEALTH data and report any issues found.
When asked about launch blockers, focus on Critical/High Product Logs that are Bug, Known Issue, or Security type.
When asked about caregivers needing review, highlight those with id_verified:no or bg_checked:no.
When asked about a specific incident, suggest: status to move to, urgency assessment, and draft internal note text.
When asked about a specific Product Log, suggest: QA next step, whether to defer or retest, and draft QA note text.
When asked about Trust Review, suggest: approve, request document fix, or keep pending — and draft a caregiver-safe message.
When asked about subscription plans, suggest: hide until connected, add Stripe Price ID, or verify audience.
When asked about user safety, suggest: keep under review, check related incidents, or escalate.
Always end with a concise "Recommended Next Action" line.
Note: Suggested Actions panel is shown separately in the UI — your answer should provide the reasoning and context.

Admin role: ${role}
Admin email: ${sess.email}
Allowed scopes: ${allowedScopes.join(', ')}
${pageContext ? `Page context: ${pageContext}\n` : ''}
--- PLATFORM DATA ---
${contextParts.length ? contextParts.join('\n\n') : 'No platform data available for allowed scopes.'}`;

          // ── OpenAI call ────────────────────────────────────────────────
          const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'gpt-4o-mini',
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: prompt }
              ],
              max_tokens: 900,
              temperature: 0.25
            })
          });

          if (!openaiRes.ok) {
            return Response.json({ error: 'AI service unavailable. Please try again shortly.' }, { status: 503, headers });
          }
          const openaiData = await openaiRes.json() as any;
          const answer = openaiData.choices?.[0]?.message?.content?.trim() || 'I could not generate a response. Please try again.';

          // ── Suggest navigation links ───────────────────────────────────
          const suggestedLinks: Array<{label: string, tab: string}> = [];
          const al = answer.toLowerCase();
          if (al.includes('incident'))                           suggestedLinks.push({ label: 'View Incidents', tab: 'incidents' });
          if (al.includes('trust') || al.includes('passport'))  suggestedLinks.push({ label: 'Trust Review', tab: 'trust' });
          if (al.includes('product log') || al.includes('plog')) suggestedLinks.push({ label: 'Product Logs', tab: 'plogs' });
          if (al.includes('caregiver'))                          suggestedLinks.push({ label: 'Caregivers', tab: 'caregivers' });
          if (al.includes('subscription') || al.includes('plan')) suggestedLinks.push({ label: 'Plans', tab: 'plans' });
          if (al.includes('client'))                             suggestedLinks.push({ label: 'Clients', tab: 'clients' });

          // ── Phase 22B: Generate suggested actions (deterministic, no hallucination) ──
          interface KaiSuggestedAction {
            type: string; label: string; reason: string; riskLevel: 'Low'|'Medium'|'High';
            relatedItemType: string; relatedItemId: string;
            draftNote: string; suggestedLink: string; canUserPerform: boolean;
          }
          const isReadOnly = role === 'read_only_auditor';
          const suggestedActions: KaiSuggestedAction[] = [];

          // Incidents → suggest review/investigate
          if (allowedScopes.includes('incidents') && _kaiIncidents.length) {
            const highNew = _kaiIncidents.filter((i: any) => i.status === 'new' && (i.urgency === 'emergency' || i.urgency === 'high'));
            for (const inc of highNew.slice(0, 2)) {
              suggestedActions.push({
                type: 'incident_investigate',
                label: 'Move to Investigating',
                reason: `Incident #${inc.id} is ${inc.urgency} urgency and still in "new" status — it should not wait.`,
                riskLevel: 'High',
                relatedItemType: 'incident', relatedItemId: String(inc.id),
                draftNote: `Admin review started on incident #${inc.id}. Checking related caregiver/client history and safety status before taking further action.`,
                suggestedLink: '#incidents',
                canUserPerform: !isReadOnly && (role === 'super_admin' || role === 'admin_manager' || role === 'support_agent'),
              });
            }
            const unassigned = _kaiIncidents.filter((i: any) => !i.assigned_admin && i.status !== 'resolved').slice(0, 1);
            for (const inc of unassigned) {
              suggestedActions.push({
                type: 'incident_assign',
                label: 'Assign Incident to Admin',
                reason: `Incident #${inc.id} (${inc.category || 'Unknown'}) has no assigned admin.`,
                riskLevel: 'Medium',
                relatedItemType: 'incident', relatedItemId: String(inc.id),
                draftNote: `Assigning incident #${inc.id} for triage. Category: ${inc.category || 'Unknown'}. Please review and update status.`,
                suggestedLink: '#incidents',
                canUserPerform: !isReadOnly && (role === 'super_admin' || role === 'admin_manager'),
              });
            }
          }

          // Product Logs → suggest retest or review
          if (allowedScopes.includes('product_logs') && _kaiPlogs.length) {
            const highInProgress = _kaiPlogs.filter((p: any) => (p.priority === 'High' || p.priority === 'Critical') && p.status === 'In Progress');
            for (const p of highInProgress.slice(0, 2)) {
              suggestedActions.push({
                type: 'product_log_retest',
                label: 'Move to Needs Retest',
                reason: `"${p.title}" is ${p.priority} priority and In Progress — verify the fix was deployed.`,
                riskLevel: 'Medium',
                relatedItemType: 'product_log', relatedItemId: String(p.id || ''),
                draftNote: `Fix deployed for "${p.title}". Needs live retest on caregiver mobile and desktop before closing.`,
                suggestedLink: '#product-logs',
                canUserPerform: !isReadOnly,
              });
            }
            const openLogs = _kaiPlogs.filter((p: any) => p.status === 'Open').slice(0, 1);
            for (const p of openLogs) {
              suggestedActions.push({
                type: 'product_log_review',
                label: 'Review Open Log Status',
                reason: `"${p.title}" (${p.priority} priority, ${p.app_area || 'Unknown area'}) is still open — determine if it needs escalation.`,
                riskLevel: 'Low',
                relatedItemType: 'product_log', relatedItemId: String(p.id || ''),
                draftNote: `Reviewing status of "${p.title}". Determine if fix is ready for QA, should be escalated, or deferred to post-beta.`,
                suggestedLink: '#product-logs',
                canUserPerform: !isReadOnly,
              });
            }
          }

          // Trust Review → suggest document request
          if (allowedScopes.includes('trust') && _kaiCaregivers.length) {
            const noId = _kaiCaregivers.filter((c: any) => !c.id_verified).slice(0, 2);
            for (const c of noId) {
              suggestedActions.push({
                type: 'trust_request_id',
                label: 'Request Government ID',
                reason: `Caregiver ${c.name || 'ID:'+c.id} has not uploaded a verified government ID — required for Trust Passport.`,
                riskLevel: 'High',
                relatedItemType: 'caregiver', relatedItemId: String(c.id),
                draftNote: `Please upload a clear image of your government-issued ID so Carehia can complete your Trust Passport review and activate your profile.`,
                suggestedLink: '#trust-review',
                canUserPerform: !isReadOnly && (role === 'super_admin' || role === 'admin_manager' || role === 'verification_reviewer'),
              });
            }
            const noBg = _kaiCaregivers.filter((c: any) => c.id_verified && !c.background_checked).slice(0, 1);
            for (const c of noBg) {
              suggestedActions.push({
                type: 'trust_request_background',
                label: 'Request Background Check Authorization',
                reason: `Caregiver ${c.name || 'ID:'+c.id} has ID verified but background check is not authorized.`,
                riskLevel: 'High',
                relatedItemType: 'caregiver', relatedItemId: String(c.id),
                draftNote: `Please authorize the background check consent so Carehia can complete your Trust Passport review and activate your profile for client matches.`,
                suggestedLink: '#trust-review',
                canUserPerform: !isReadOnly && (role === 'super_admin' || role === 'admin_manager' || role === 'verification_reviewer'),
              });
            }
          }

          // Subscription Plans → suggest fixes
          if (allowedScopes.includes('subscriptions') && _kaiPlanIssues.length && _kaiPlans.length) {
            const publicNoStripe = _kaiPlans.filter((p: any) => !p.stripe_price_id && p.price > 0 && p.is_public && p.is_active);
            for (const p of publicNoStripe.slice(0, 2)) {
              suggestedActions.push({
                type: 'plan_hide_until_connected',
                label: 'Hide Plan Until Checkout Configured',
                reason: `Plan "${p.name}" is public but has no Stripe Price ID — users hitting checkout will see an error.`,
                riskLevel: 'High',
                relatedItemType: 'subscription_plan', relatedItemId: String(p.id),
                draftNote: `Plan "${p.name}" is currently public but checkout is not configured. Hide it until the Stripe Price ID is connected to prevent checkout errors.`,
                suggestedLink: '#subscription-plans',
                canUserPerform: !isReadOnly && (role === 'super_admin' || role === 'finance_admin'),
              });
            }
            const inactiveRecommended = _kaiPlans.filter((p: any) => p.is_recommended && !p.is_active);
            for (const p of inactiveRecommended.slice(0, 1)) {
              suggestedActions.push({
                type: 'plan_review_recommended',
                label: 'Review Recommended Plan Status',
                reason: `Plan "${p.name}" is marked as recommended but is inactive — users cannot subscribe.`,
                riskLevel: 'Medium',
                relatedItemType: 'subscription_plan', relatedItemId: String(p.id),
                draftNote: `Plan "${p.name}" is recommended but inactive. Either activate it with a valid Stripe Price ID or remove the recommended flag to avoid confusion.`,
                suggestedLink: '#subscription-plans',
                canUserPerform: !isReadOnly && (role === 'super_admin' || role === 'finance_admin'),
              });
            }
          }

          // Safety Status → suggest review before reactivation
          if (allowedScopes.includes('safety') && _kaiSafetyRows.length) {
            for (const row of (_kaiSafetyRows as any[]).slice(0, 1)) {
              suggestedActions.push({
                type: 'user_safety_review',
                label: 'Review Before Reactivation',
                reason: `${row.cnt} ${row.user_type}(s) have safety status "${row.status}" — review all related incidents before reactivating.`,
                riskLevel: 'High',
                relatedItemType: 'user', relatedItemId: '',
                draftNote: `Do not reactivate users with "${row.status}" status until all related incidents are resolved and a full safety review is complete.`,
                suggestedLink: '#caregivers',
                canUserPerform: !isReadOnly && role === 'super_admin',
              });
            }
          }

          // RBAC: mark canUserPerform=false for read_only_auditor
          if (isReadOnly) suggestedActions.forEach(a => a.canUserPerform = false);

          return Response.json({ answer, sourceAreasUsed, suggestedLinks, suggestedActions }, { headers });
        } catch(e: any) {
          return Response.json({ error: 'I could not load that admin data right now. Please try again.' }, { status: 500, headers });
        }
      },
    },

  ],
})
