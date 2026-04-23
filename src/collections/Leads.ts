// @ts-nocheck
import type { CollectionConfig } from 'payload'

export const Leads: CollectionConfig = {
  slug: 'leads',
  admin: {
    useAsTitle: 'firstName',
  },
  fields: [
    {
      name: 'agency',
      type: 'relationship',
      relationTo: 'agencies',
      admin: { description: 'Agency this lead belongs to' },
    },
    {
      name: 'firstName',
      type: 'text',
      required: true,
    },
    {
      name: 'lastName',
      type: 'text',
      required: true,
    },
    {
      name: 'email',
      type: 'email',
      required: true,
    },
    {
      name: 'phone',
      type: 'text',
    },
    {
      name: 'careType',
      type: 'select',
      options: [
        { label: 'Home Care', value: 'home_care' },
        { label: 'Senior Care', value: 'senior_care' },
        { label: 'Private Duty', value: 'private_duty' },
        { label: 'Companionship', value: 'companionship' },
        { label: 'Respite Care', value: 'respite_care' },
      ],
    },
    {
      name: 'message',
      type: 'textarea',
    },
    {
      name: 'source',
      type: 'select',
      defaultValue: 'website',
      options: [
        { label: 'Website', value: 'website' },
        { label: 'Referral', value: 'referral' },
        { label: 'Phone', value: 'phone' },
        { label: 'Landing Page', value: 'landing_page' },
        { label: 'Other', value: 'other' },
      ],
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'new',
      options: [
        { label: 'New', value: 'new' },
        { label: 'Contacted', value: 'contacted' },
        { label: 'Qualified', value: 'qualified' },
        { label: 'Converted', value: 'converted' },
        { label: 'Lost', value: 'lost' },
      ],
    },
    {
      name: 'assignedTo',
      type: 'text',
      admin: { description: 'Staff member handling this lead' },
    },
    {
      name: 'followUpDate',
      type: 'date',
      admin: { description: 'Next follow-up date' },
    },
    {
      name: 'convertedClientId',
      type: 'number',
      admin: { description: 'Client ID if converted (auto-set)' },
    },
    {
      name: 'notes',
      type: 'textarea',
    },
  ],
  access: {
    create: () => true,
    read: ({ req: { user } }) => {
      if (!user) return false
      if (user.role === 'admin') return true
      if (user.agency) {
        const agencyId = typeof user.agency === 'object' ? user.agency.id : user.agency
        return { agency: { equals: agencyId } }
      }
      return true
    },
    update: ({ req: { user } }) => !!user,
    delete: ({ req: { user } }) => user?.role === 'admin' || user?.role === 'agency_owner',
  },
}
