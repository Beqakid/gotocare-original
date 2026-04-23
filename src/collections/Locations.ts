// @ts-nocheck
import type { CollectionConfig } from 'payload'

export const Locations: CollectionConfig = {
  slug: 'locations',
  admin: {
    useAsTitle: 'name',
  },
  fields: [
    {
      name: 'agency',
      type: 'relationship',
      relationTo: 'agencies',
      required: true,
      admin: { description: 'Parent agency' },
    },
    {
      name: 'name',
      type: 'text',
      required: true,
      admin: { description: 'Location name (e.g. Atlanta Office, Main HQ)' },
    },
    {
      name: 'slug',
      type: 'text',
      required: true,
      admin: { description: 'URL-safe identifier (e.g. atlanta-office)' },
    },
    {
      name: 'addressStreet',
      type: 'text',
    },
    {
      name: 'addressCity',
      type: 'text',
      required: true,
    },
    {
      name: 'addressState',
      type: 'text',
      required: true,
      admin: { description: 'State code (e.g. GA, AL, TN)' },
    },
    {
      name: 'addressZip',
      type: 'text',
    },
    {
      name: 'phone',
      type: 'text',
    },
    {
      name: 'email',
      type: 'email',
    },
    {
      name: 'licenseNumber',
      type: 'text',
      admin: { description: 'State-specific license number for this location' },
    },
    {
      name: 'licenseExpiry',
      type: 'date',
      admin: { description: 'License expiration date' },
    },
    {
      name: 'serviceRadius',
      type: 'number',
      admin: { description: 'Service radius in miles' },
    },
    {
      name: 'manager',
      type: 'relationship',
      relationTo: 'users',
      admin: { description: 'Location manager' },
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'active',
      options: [
        { label: 'Active', value: 'active' },
        { label: 'Inactive', value: 'inactive' },
      ],
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
    create: ({ req: { user } }) => user?.role === 'admin' || user?.role === 'agency_owner',
    update: ({ req: { user } }) => {
      if (!user) return false
      if (user.role === 'admin') return true
      if (user.agency) {
        const agencyId = typeof user.agency === 'object' ? user.agency.id : user.agency
        return { agency: { equals: agencyId } }
      }
      return false
    },
    delete: ({ req: { user } }) => user?.role === 'admin' || user?.role === 'agency_owner',
  },
}
