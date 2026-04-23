// @ts-nocheck
import type { CollectionConfig } from 'payload'

export const Users: CollectionConfig = {
  slug: 'users',
  admin: {
    useAsTitle: 'email',
  },
  auth: true,
  fields: [
    {
      name: 'name',
      type: 'text',
    },
    {
      name: 'phone',
      type: 'text',
    },
    {
      name: 'role',
      type: 'select',
      required: true,
      defaultValue: 'agency_owner',
      saveToJWT: true,
      options: [
        { label: 'Admin', value: 'admin' },
        { label: 'Agency Owner', value: 'agency_owner' },
        { label: 'Scheduler', value: 'scheduler' },
        { label: 'Caregiver', value: 'caregiver' },
        { label: 'Client', value: 'client' },
      ],
      access: {
        update: ({ req: { user } }) => Boolean(user?.role === 'admin' || user?.role === 'agency_owner'),
      },
    },
    {
      name: 'agency',
      type: 'relationship',
      relationTo: 'agencies',
      saveToJWT: true,
      admin: { description: 'Agency this user belongs to' },
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
      return { id: { equals: user.id } }
    },
    update: ({ req: { user } }) => {
      if (!user) return false
      if (user.role === 'admin') return true
      return { id: { equals: user.id } }
    },
    delete: ({ req: { user } }) => user?.role === 'admin',
  },
}
