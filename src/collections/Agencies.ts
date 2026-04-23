// @ts-nocheck
import type { CollectionConfig } from 'payload'

export const Agencies: CollectionConfig = {
  slug: 'agencies',
  admin: {
    useAsTitle: 'name',
  },
  fields: [
    {
      name: 'name',
      type: 'text',
      required: true,
    },
    {
      name: 'slug',
      type: 'text',
      required: true,
      unique: true,
      admin: { description: 'URL-safe identifier (e.g. sunrise-home-care)' },
    },
    {
      name: 'ownerEmail',
      type: 'email',
      required: true,
    },
    {
      name: 'phone',
      type: 'text',
    },
    {
      name: 'addressStreet',
      type: 'text',
    },
    {
      name: 'addressCity',
      type: 'text',
    },
    {
      name: 'addressState',
      type: 'text',
    },
    {
      name: 'addressZip',
      type: 'text',
    },
    {
      name: 'website',
      type: 'text',
    },
    {
      name: 'licenseNumber',
      type: 'text',
      admin: { description: 'State license or NPI number' },
    },
    {
      name: 'plan',
      type: 'select',
      defaultValue: 'starter',
      options: [
        { label: 'Starter ($99/mo)', value: 'starter' },
        { label: 'Growth ($149/mo)', value: 'growth' },
        { label: 'Enterprise ($249/mo)', value: 'enterprise' },
      ],
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'active',
      options: [
        { label: 'Active', value: 'active' },
        { label: 'Trial', value: 'trial' },
        { label: 'Suspended', value: 'suspended' },
        { label: 'Cancelled', value: 'cancelled' },
      ],
    },
    {
      name: 'trialEndsAt',
      type: 'date',
    },
    {
      name: 'maxCaregivers',
      type: 'number',
      defaultValue: 10,
      admin: { description: 'Caregiver limit based on plan' },
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
        return { id: { equals: agencyId } }
      }
      return true
    },
    create: ({ req: { user } }) => user?.role === 'admin' || user?.role === 'agency_owner',
    update: ({ req: { user } }) => {
      if (!user) return false
      if (user.role === 'admin') return true
      if (user.agency) {
        const agencyId = typeof user.agency === 'object' ? user.agency.id : user.agency
        return { id: { equals: agencyId } }
      }
      return false
    },
    delete: ({ req: { user } }) => user?.role === 'admin',
  },
}
