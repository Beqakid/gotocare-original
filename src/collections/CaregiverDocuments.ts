// @ts-nocheck
import type { CollectionConfig } from 'payload'

export const CaregiverDocuments: CollectionConfig = {
  slug: 'caregiver-documents',
  admin: {
    useAsTitle: 'documentName',
  },
  fields: [
    {
      name: 'caregiver',
      type: 'relationship',
      relationTo: 'caregivers',
      required: true,
      admin: { description: 'Caregiver who uploaded this document' },
    },
    {
      name: 'agency',
      type: 'relationship',
      relationTo: 'agencies',
      admin: { description: 'Agency this document belongs to' },
    },
    {
      name: 'documentType',
      type: 'select',
      required: true,
      options: [
        { label: 'CNA Certification', value: 'cna_cert' },
        { label: 'HHA Certification', value: 'hha_cert' },
        { label: 'CPR/First Aid', value: 'cpr_first_aid' },
        { label: 'TB Test', value: 'tb_test' },
        { label: 'Background Check', value: 'background_check' },
        { label: 'Drug Screening', value: 'drug_screening' },
        { label: 'Driver License', value: 'drivers_license' },
        { label: 'Auto Insurance', value: 'auto_insurance' },
        { label: 'Physical Exam', value: 'physical_exam' },
        { label: 'Covid Vaccination', value: 'covid_vax' },
        { label: 'Professional Reference', value: 'reference' },
        { label: 'W-4 Form', value: 'w4_form' },
        { label: 'I-9 Form', value: 'i9_form' },
        { label: 'HIPAA Training', value: 'hipaa_training' },
        { label: 'Other', value: 'other' },
      ],
    },
    {
      name: 'documentName',
      type: 'text',
      required: true,
      admin: { description: 'Friendly name (e.g. "CPR Card - 2024")' },
    },
    {
      name: 'fileUrl',
      type: 'text',
      admin: { description: 'URL to uploaded file' },
    },
    {
      name: 'file',
      type: 'relationship',
      relationTo: 'media',
      admin: { description: 'Uploaded file in media library' },
    },
    {
      name: 'issuedAt',
      type: 'date',
      admin: { description: 'Date document was issued' },
    },
    {
      name: 'expiresAt',
      type: 'date',
      admin: { description: 'Expiration date (null = no expiry)' },
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'pending',
      options: [
        { label: 'Pending Review', value: 'pending' },
        { label: 'Verified', value: 'verified' },
        { label: 'Expired', value: 'expired' },
        { label: 'Rejected', value: 'rejected' },
      ],
    },
    {
      name: 'verifiedBy',
      type: 'relationship',
      relationTo: 'users',
      admin: { description: 'Staff who verified this document' },
    },
    {
      name: 'verifiedAt',
      type: 'date',
    },
    {
      name: 'rejectionReason',
      type: 'text',
      admin: { description: 'Reason for rejection (if rejected)' },
    },
    {
      name: 'notes',
      type: 'textarea',
    },
  ],
  access: {
    read: ({ req: { user } }) => {
      if (!user) return false
      if (user.role === 'admin') return true
      if (user.agency) {
        const agencyId = typeof user.agency === 'object' ? user.agency.id : user.agency
        return { agency: { equals: agencyId } }
      }
      return true
    },
    create: ({ req: { user } }) => !!user,
    update: ({ req: { user } }) => {
      if (!user) return false
      if (user.role === 'admin') return true
      if (user.agency) {
        const agencyId = typeof user.agency === 'object' ? user.agency.id : user.agency
        return { agency: { equals: agencyId } }
      }
      return true
    },
    delete: ({ req: { user } }) => user?.role === 'admin' || user?.role === 'agency_owner',
  },
}
