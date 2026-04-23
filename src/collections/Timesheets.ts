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
      name: 'client',
      type: 'relationship',
      relationTo: 'clients',
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
      admin: {
        description: 'Auto-calculated on clock-out',
      },
    },
    {
      name: 'hourlyRate',
      type: 'number',
      admin: {
        description: 'Rate at time of shift',
      },
    },
    {
      name: 'totalPay',
      type: 'number',
      admin: {
        description: 'hoursWorked * hourlyRate',
      },
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'pending',
      options: [
        { label: 'Clocked In', value: 'clocked_in' },
        { label: 'Pending Review', value: 'pending' },
        { label: 'Approved', value: 'approved' },
        { label: 'Rejected', value: 'rejected' },
      ],
    },
    {
      name: 'approvedBy',
      type: 'relationship',
      relationTo: 'users',
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
