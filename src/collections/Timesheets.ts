// @ts-nocheck
import type { CollectionConfig } from 'payload'

export const Timesheets: CollectionConfig = {
  slug: 'timesheets',
  admin: {
    useAsTitle: 'date',
  },
  fields: [
    {
      name: 'agency',
      type: 'relationship',
      relationTo: 'agencies',
      admin: { description: 'Agency this timesheet belongs to' },
    },
    {
      name: 'shift',
      type: 'relationship',
      relationTo: 'shifts',
    },
    {
      name: 'caregiver',
      type: 'relationship',
      relationTo: 'caregivers',
      required: true,
    },
    {
      name: 'client',
      type: 'relationship',
      relationTo: 'clients',
      admin: { description: 'Client for this timesheet entry' },
    },
    {
      name: 'date',
      type: 'date',
      required: true,
    },
    {
      name: 'clockIn',
      type: 'date',
      required: true,
      admin: { description: 'Clock in timestamp' },
    },
    {
      name: 'clockOut',
      type: 'date',
      admin: { description: 'Clock out timestamp' },
    },
    {
      name: 'hoursWorked',
      type: 'number',
    },
    {
      name: 'hourlyRate',
      type: 'number',
    },
    {
      name: 'totalPay',
      type: 'number',
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'clocked_in',
      options: [
        { label: 'Clocked In', value: 'clocked_in' },
        { label: 'Pending', value: 'pending' },
        { label: 'Approved', value: 'approved' },
        { label: 'Rejected', value: 'rejected' },
      ],
    },
    {
      name: 'approvedBy',
      type: 'text',
      admin: { description: 'Name/ID of person who approved' },
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
    update: ({ req: { user } }) => !!user,
    delete: ({ req: { user } }) => user?.role === 'admin' || user?.role === 'agency_owner',
  },
}
