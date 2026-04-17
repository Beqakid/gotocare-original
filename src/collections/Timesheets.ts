// @ts-nocheck
import type { CollectionConfig } from 'payload'

export const Timesheets: CollectionConfig = {
  slug: 'timesheets',
  admin: {
    useAsTitle: 'status',
  },
  fields: [
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
      name: 'clockIn',
      type: 'date',
      required: true,
      admin: {
        date: {
          pickerAppearance: 'dayAndTime',
        },
      },
    },
    {
      name: 'clockOut',
      type: 'date',
      admin: {
        date: {
          pickerAppearance: 'dayAndTime',
        },
      },
    },
    {
      name: 'hoursWorked',
      type: 'number',
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'pending',
      options: [
        { label: 'Pending', value: 'pending' },
        { label: 'Approved', value: 'approved' },
        { label: 'Rejected', value: 'rejected' },
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
      return true
    },
    create: ({ req: { user } }) => !!user,
    update: ({ req: { user } }) => !!user,
    delete: ({ req: { user } }) => user?.role === 'admin',
  },
}
