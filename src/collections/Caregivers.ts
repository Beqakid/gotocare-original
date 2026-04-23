// @ts-nocheck
import type { CollectionConfig } from 'payload'

export const Caregivers: CollectionConfig = {
  slug: 'caregivers',
  admin: {
    useAsTitle: 'firstName',
  },
  fields: [
    {
      name: 'agency',
      type: 'relationship',
      relationTo: 'agencies',
      admin: { description: 'Agency this caregiver belongs to' },
    },
    {
      name: 'location',
      type: 'relationship',
      relationTo: 'locations',
      admin: { description: 'Branch/location this caregiver works from' },
    },
    {
      name: 'linkedUser',
      type: 'relationship',
      relationTo: 'users',
      admin: { description: 'User account for caregiver portal access' },
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
      name: 'certifications',
      type: 'textarea',
    },
    {
      name: 'hourlyRate',
      type: 'number',
    },
    {
      name: 'experienceYears',
      type: 'number',
      admin: { description: 'Years of caregiving experience' },
    },
    {
      name: 'languages',
      type: 'text',
      admin: { description: 'Languages spoken (comma-separated)' },
    },
    {
      name: 'availability',
      type: 'textarea',
      admin: { description: 'Available days/times' },
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'pending',
      options: [
        { label: 'Active', value: 'active' },
        { label: 'Inactive', value: 'inactive' },
        { label: 'Pending', value: 'pending' },
      ],
    },
    {
      name: 'hireDate',
      type: 'date',
    },
    {
      name: 'specialties',
      type: 'text',
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
